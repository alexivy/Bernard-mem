import {randomUUID} from 'node:crypto';
import {MemoryStore,type MemoryWrite} from './memory.js';
import {failure} from './errors.js';
import type {MatterWrite} from './matters.js';
import type {AssetWrite} from './assets.js';
export const API_VERSION=1;
export type AccessContext={actor?:'ai'|'human'|'system';client?:string;session?:string;turn?:string;requestId?:string;signal?:AbortSignal};
type Schema={type?:string;enum?:unknown[];properties?:Record<string,Schema>;required?:string[];additionalProperties?:boolean;items?:Schema;minimum?:number;maximum?:number;maxItems?:number;description?:string};
const str:Schema={type:'string'},integer:Schema={type:'integer',minimum:0},array:Schema={type:'array',items:str};
const object=(properties:Record<string,Schema>,required:string[]):Schema=>({type:'object',properties,required,additionalProperties:false});
export const toolCatalog=[
  {name:'bernard_mem_memory',description:'个人共享记忆。先topics阅读标签介绍，search元数据，再read正文；entity可选knowledge、matter、tool。remember保存完整内容；事项不调度任务，工具只保存不执行。source_ids可选，不要求预期版本。',inputSchema:object({
    op:{enum:['topics','save_topic','search','read','remember','revisions','restore','receipt']},entity:{enum:['knowledge','matter','tool']},id:str,topic:str,query:str,topics:{...array,maxItems:20},expression:str,offset:integer,kind:{enum:['knowledge','notebook']},title:str,introduction:str,body:str,source_ids:array,revision:{type:'integer',minimum:1},status:{enum:['pending','processing','paused','blocked','completed','cancelled','failed']},refs:array,type:{enum:['script','template','skill']},verification:str,file:str,
    files:{type:'array',maxItems:128,items:object({path:str,content:str,encoding:{enum:['utf8','base64']},executable:{type:'boolean'}},['path','content'])},request_id:str
  },['op']),annotations:{readOnlyHint:false,destructiveHint:true,openWorldHint:false}},
  {name:'bernard_mem_context',description:'共享记忆状态与观测。status不依赖Bernard；stats查看AI正文读取频率，events分页看操作。正文返回不等于模型采纳。',inputSchema:object({op:{enum:['status','stats','events','prepare']},offset:integer,operation:str,actor:{enum:['ai','human','system']},client:str,id:str},['op']),annotations:{readOnlyHint:true,openWorldHint:false}}
];
export function validate(schema:Schema,value:unknown,label='arguments'):void {
  if(value===null||value===undefined)failure('MEMORY_INVALID_ARGUMENTS',label+'不能为空。',{field:label});
  if(schema.enum&&!schema.enum.includes(value))failure('MEMORY_INVALID_ARGUMENTS',label+'取值无效。',{field:label});
  if(schema.type==='object'){
    if(typeof value!=='object'||Array.isArray(value))failure('MEMORY_INVALID_ARGUMENTS',label+'必须是对象。');
    const input=value as Record<string,unknown>,properties=schema.properties||{};
    if(schema.required?.some(key=>input[key]===undefined)||schema.additionalProperties===false&&Object.keys(input).some(key=>!Object.hasOwn(properties,key)))failure('MEMORY_INVALID_ARGUMENTS',label+'字段不符合工具契约。');
    for(const [key,item] of Object.entries(input))if(properties[key])validate(properties[key],item,label+'.'+key);
  }else if(schema.type==='array'){
    if(!Array.isArray(value)||value.length>(schema.maxItems??Infinity))failure('MEMORY_INVALID_ARGUMENTS',label+'必须是有效数组。');
    for(const item of value)validate(schema.items||{},item,label+'[]');
  }else if(schema.type==='string'&&(typeof value!=='string'||value.length>3*1024*1024)||schema.type==='boolean'&&typeof value!=='boolean'||schema.type==='integer'&&(!Number.isSafeInteger(value)||Number(value)<(schema.minimum??0)||Number(value)>(schema.maximum??Number.MAX_SAFE_INTEGER)))failure('MEMORY_INVALID_ARGUMENTS',label+'类型或范围无效。');
}
export function dispatch(store:MemoryStore,toolName:string,input:Record<string,unknown>,context:AccessContext={}):unknown {
  const definition=toolCatalog.find(tool=>tool.name===toolName);if(!definition)failure('MEMORY_UNKNOWN_TOOL','未知记忆工具。');
  const args=Object.fromEntries(Object.entries(input).filter(([,value])=>value!==null));validate(definition.inputSchema,args);
  const p=args as Record<string,any>,entity=p.entity||'knowledge',started=performance.now();let response:any;
  const event={actor:context.actor||'system' as const,client:context.client,session:context.session,turn:context.turn,object_id:p.id,entity};
  const observe=(value:Record<string,unknown>)=>{try{return store.recordEvent({...event,...value,operation:String(value.operation),duration_ms:performance.now()-started});}catch(error){return {recorded:false,reason:(error as {code?:string}).code||'observation_write_failed'};}};
  try{
    context.signal?.throwIfAborted();
    if(toolName==='bernard_mem_context'){
      if(p.op==='prepare')failure('CHECKPOINT_UNSUPPORTED_ROLE','Bernard-mem不管理会话检查点。');
      if(p.op==='status')return {api_version:API_VERSION,memory_root:store.root,read_only:store.readOnly,context_manager:'host-native'};
      if(p.op==='stats')return store.usageStats();
      return store.listEvents(p.offset,{operation:p.operation,actor:p.actor,client:p.client,object_id:p.id});
    }
    const receipt=p.request_id||context.requestId||randomUUID();
    if(p.op==='topics')response={topics:store.topics()};
    else if(p.op==='save_topic')response=store.saveTopic(p.topic,p.introduction,receipt);
    else if(p.op==='receipt'){if(!p.request_id)failure('MEMORY_MISSING_FIELDS','receipt需要request_id。');response=store.receipt(p.request_id);}
    else if(p.op==='search')response=entity==='matter'?store.searchMatters(p.query,p.topics,p.offset,{expression:p.expression,status:p.status}):entity==='tool'?store.searchAssets(p.query,p.topics,p.offset,p.expression):store.search(p.query,p.topics,p.offset,{expression:p.expression,kind:p.kind});
    else{
      if(!p.id)failure('MEMORY_MISSING_ID',`${p.op}需要id。`,{field:'id'});
      if(p.op==='read')response=entity==='matter'?store.readMatter(p.id,p.offset):entity==='tool'?store.readAsset(p.id,p.file,p.offset):store.read(p.id,p.offset);
      else if(p.op==='revisions'){if(entity!=='knowledge')failure('MEMORY_UNSUPPORTED_OPERATION','仅知识支持修订查询。');response={revisions:store.revisions(p.id).map(row=>({id:row.id,revision:row.revision,updated:row.updated,source_ids:row.source_ids}))};}
      else if(p.op==='restore'){if(entity!=='knowledge'||!p.revision)failure('MEMORY_MISSING_FIELDS','恢复知识需要revision。');response=store.restore(p.id,p.revision,receipt);}
      else{const missing=['title','introduction','body','topics',...(entity==='matter'?['status']:entity==='tool'?['type','files']:['kind'])].filter(key=>p[key]===undefined||p[key]===''||Array.isArray(p[key])&&!p[key].length);
        if(missing.length)failure('MEMORY_MISSING_FIELDS','remember缺少字段：'+missing.join('、'),{field:missing.join(',')});
        response=entity==='matter'?store.saveMatter({id:p.id,title:p.title,introduction:p.introduction,body:p.body,topics:p.topics,status:p.status,refs:p.refs} as MatterWrite,receipt):entity==='tool'?store.saveAsset({id:p.id,title:p.title,introduction:p.introduction,body:p.body,topics:p.topics,type:p.type,files:p.files,verification:p.verification,refs:p.refs} as AssetWrite,receipt):store.remember({id:p.id,kind:p.kind,title:p.title,introduction:p.introduction,body:p.body,topics:p.topics,source_ids:p.source_ids} as MemoryWrite,receipt);
      }
    }
    const operation=p.op==='read'?'body_returned':p.op==='search'?'metadata_hit':p.op;
    const observation=observe({operation,status:'success',revision:response?.revision,offset:p.offset||0,length:typeof response?.body==='string'?response.body.length:undefined,count:response?.documents?.length});
    return {...response,observation};
  }catch(error){observe({operation:p.op,status:context.signal?.aborted?'cancelled':'error',error_code:(error as {code?:string}).code||'MEMORY_OPERATION_FAILED'});throw error;}
}
