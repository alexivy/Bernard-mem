import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,realpathSync,existsSync} from 'node:fs';
import {join,relative,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {failure} from './errors.js';
import {ownedPath} from './tool-paths.js';
import {topicPattern,compileTopicExpression} from './query.js';
import {saveMatter,searchMatters,readMatter,type MatterWrite} from './matters.js';
import {saveAsset,searchAssets,readAsset,type AssetWrite} from './assets.js';
import {recordEvent,listEvents,usageStats,type Observation} from './observation.js';
export type DocumentKind='knowledge'|'notebook';
export type MemoryTopic={name:string;introduction:string|null};
export type MemoryWrite={id:string;kind:DocumentKind;title:string;topics:string[];introduction:string;body:string;source_ids?:string[]};
export type Revision=Omit<MemoryWrite,'source_ids'>&{source_ids:string[];revision:number;updated:number};
export type SourceReference={session_file?:string;entry_id?:string;tool_name?:string;tool_call_id?:string};
export type OpenOptions={mode?:'read-only'|'read-write';create?:boolean};
export type SearchOptions={kind?:DocumentKind;expression?:string;limit?:number};
export const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function within(root:string,target:string){const path=relative(root,target);return path!=='..'&&!path.startsWith('../')&&!isAbsolute(path);}
export function text(value:unknown,field:string,limit:number){
  if(typeof value!=='string'||!value.trim())failure('MEMORY_MISSING_FIELDS',`${field}不得为空。`,{field});
  if(value.length>limit)failure('MEMORY_FIELD_TOO_LONG',`${field}长度${value.length}超过上限${limit}字符。`,{field,actual:value.length,expected:limit});
  return value;
}
export function documentId(id:unknown):asserts id is string {if(typeof id!=='string'||!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(id))failure('MEMORY_ID_INVALID','知识ID只能含小写字母、数字、连字符和下划线。');}
export function page(value:unknown=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||Number(value)<0||Number(value)>max)failure('MEMORY_PAGINATION_INVALID','分页参数无效。');return Number(value);}
export function checkedPath(root:string,filename:string){
  const target=ownedPath(root,root,filename);
  if(!target)failure('MEMORY_PATH_INVALID','目标路径越界或经过符号链接。');
  return target;
}
export class MemoryStore {
  readonly db:DatabaseSync;
  readonly root:string;
  readonly readOnly:boolean;
  static open(root:string,options:OpenOptions={}){return new MemoryStore(root,options);}
  constructor(root:string,options:OpenOptions={}){
    if(!isAbsolute(root))failure('MEMORY_ROOT_INVALID','记忆根必须是显式绝对路径。');
    this.readOnly=options.mode==='read-only';
    if(!existsSync(root)){if(this.readOnly||options.create===false)failure('MEMORY_NOT_INITIALIZED','记忆根尚未初始化。');mkdirSync(root,{recursive:true,mode:0o700});}
    this.root=realpathSync(root);
    const filename=checkedPath(this.root,join(this.root,'memory.sqlite'));
    for(const file of [filename,filename+'-wal',filename+'-shm',filename+'-journal'])if(existsSync(file)){
      const stat=lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink!==1)failure('MEMORY_PATH_INVALID','记忆数据库或辅助文件不是独占普通文件。');
    }
    if(!existsSync(filename)&&(this.readOnly||options.create===false))failure('MEMORY_NOT_INITIALIZED','记忆库尚未初始化。');
    this.db=new DatabaseSync(filename,{readOnly:this.readOnly});
    this.db.exec('PRAGMA busy_timeout=5000');
    this.db.function('bernard_lower',{deterministic:true},value=>String(value??'').toLowerCase());
    if(this.readOnly)return;
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,session TEXT,role TEXT,text TEXT,created INTEGER,valid INTEGER);
      CREATE TABLE IF NOT EXISTS source_refs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_topics(name TEXT PRIMARY KEY,introduction TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id TEXT,revision INTEGER,data TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,response TEXT);
      CREATE TABLE IF NOT EXISTS request_payloads(id TEXT PRIMARY KEY,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metrics(id INTEGER PRIMARY KEY,data TEXT);
      CREATE TABLE IF NOT EXISTS matters(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,operation TEXT NOT NULL,actor TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_events_at ON memory_events(at);
    `);
  }
  writable(){if(this.readOnly)failure('MEMORY_READ_ONLY','当前记忆接入只读。');}
  table(name:string){return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  transact<T>(receipt:string,payload:unknown,write:()=>T):T {
    this.writable();text(receipt,'request_id',512);const hash=sha(payload);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const prior=this.db.prepare('SELECT response FROM receipts WHERE id=?').get(receipt);
      if(prior){const known=this.db.prepare('SELECT hash FROM request_payloads WHERE id=?').get(receipt);if(!known||known.hash!==hash)failure('IDEMPOTENCY_CONFLICT','同一请求ID不能用于不同内容。');this.db.exec('COMMIT');return JSON.parse(String(prior.response)) as T;}
      const response=write();
      this.db.prepare('INSERT INTO receipts VALUES(?,?)').run(receipt,JSON.stringify(response));
      this.db.prepare('INSERT INTO request_payloads VALUES(?,?)').run(receipt,hash);
      this.db.exec('COMMIT');return response;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  receipt(id:string){const row=this.db.prepare('SELECT response FROM receipts WHERE id=?').get(id);return row?{found:true,response:JSON.parse(String(row.response))}:{found:false};}
  source(session:string,role:string,content:string,timestamp:number,valid=true,reference:SourceReference={}){
    this.writable();const id=sha([session,role,content,timestamp]);
    this.db.prepare('INSERT OR IGNORE INTO sources VALUES(?,?,?,?,?,?)').run(id,session,role,'',timestamp,Number(valid));
    const metadata={id,session,role,created:timestamp,valid:Number(valid),fingerprint:sha(content),...reference};
    this.db.prepare('INSERT INTO source_refs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id,JSON.stringify(metadata));return id;
  }
  sourceMetadata(id:string){const source=this.db.prepare('SELECT id,session,role,created,valid FROM sources WHERE id=?').get(id);if(!source)failure('MEMORY_SOURCE_NOT_FOUND','来源不存在。');
    const row=this.table('source_refs')?this.db.prepare('SELECT data FROM source_refs WHERE id=?').get(id):undefined;return row?JSON.parse(String(row.data)):source;}
  topics():MemoryTopic[]{
    const definitions=new Map<string,string>();if(this.table('memory_topics'))for(const row of this.db.prepare('SELECT name,introduction FROM memory_topics ORDER BY name').all())definitions.set(String(row.name),String(row.introduction));
    const names=new Set(definitions.keys());for(const table of ['memories','matters','assets'])if(this.table(table))for(const row of this.db.prepare(`SELECT DISTINCT topic.value AS name FROM ${table} AS m,json_each(m.data,'$.topics') AS topic WHERE topic.type='text'`).all())names.add(String(row.name));
    return [...names].sort().map(name=>({name,introduction:definitions.get(name)??null}));
  }
  saveTopic(name:string,introduction:string,receipt:string=randomUUID()){this.writable();if(typeof name!=='string'||name.length>200||!topicPattern.test(name))failure('MEMORY_TOPIC_INVALID','Topic名称必须形如system#bernard且最多200字符。',{field:'topic'});
    if(typeof introduction!=='string'||!introduction.trim()||/[\r\n]/.test(introduction)||introduction.trim().length>600)failure('MEMORY_TOPIC_INTRODUCTION_REQUIRED','Topic介绍必须是非空单行，最多600字符。',{field:'introduction'});
    const value=introduction.trim();
    return this.transact(receipt,{op:'save_topic',name,introduction:value},()=>{this.db.prepare('INSERT INTO memory_topics VALUES(?,?) ON CONFLICT(name) DO UPDATE SET introduction=excluded.introduction').run(name,value);return {name,introduction:value,saved:true};});}
  checkDocument(input:{id:string;title:string;introduction:string;body:string;topics:string[]}){
    documentId(input.id);text(input.title,'title',200);text(input.introduction,'introduction',600);text(input.body,'body',80000);
    if(/[\r\n]/.test(input.introduction))failure('MEMORY_METADATA_FORMAT','introduction必须为单行，不能包含换行。',{field:'introduction'});
    if(!Array.isArray(input.topics)||!input.topics.length||input.topics.length>20||input.topics.some(topic=>typeof topic!=='string'||topic.length>200||!topicPattern.test(topic)))failure('MEMORY_TOPIC_INVALID','Topic必须形如system#bernard。');
    const lookup=this.db.prepare("SELECT introduction FROM memory_topics WHERE name=? AND length(trim(introduction))>0");
    const missing=input.topics.filter(topic=>!lookup.get(topic));
    if(missing.length)failure('MEMORY_TOPIC_INTRODUCTION_REQUIRED','Topic缺少介绍：'+missing.join('、')+'。先用save_topic填写介绍，再写知识。',{field:'topics',recovery:'先调用topics阅读已有标签介绍，再用save_topic填写缺失介绍。'});
  }
  search(query='',topics:string[]=[],offset=0,options:SearchOptions={}){
    const expression=options.expression||topics.map(topic=>{if(!topicPattern.test(topic))failure('MEMORY_TOPIC_INVALID','查询Topic格式无效。');return topic;}).join(' & ');
    const compiled=compileTopicExpression(expression),words=textQuery(query),where=[compiled.sql,...words.map(()=>"instr(bernard_lower(m.id || ' ' || json_extract(m.data,'$.title') || ' ' || json_extract(m.data,'$.introduction') || ' ' || json_extract(m.data,'$.topics')),?)>0")];
    const params:(string|number)[]=[...compiled.params,...words];
    if(options.kind){if(!['knowledge','notebook'].includes(options.kind))failure('MEMORY_KIND_INVALID','知识分层无效。');where.push("json_extract(m.data,'$.kind')=?");params.push(options.kind);}
    const clause=where.join(' AND '),total=Number(this.db.prepare(`SELECT count(*) AS n FROM memories m WHERE ${clause}`).get(...params)!.n),start=page(offset),limit=page(options.limit??20,100);
    if(!limit)failure('MEMORY_PAGINATION_INVALID','limit必须大于零。');
    const rows=this.db.prepare(`SELECT data FROM memories m WHERE ${clause} ORDER BY CASE json_extract(data,'$.kind') WHEN 'knowledge' THEN 0 ELSE 1 END,id LIMIT ? OFFSET ?`).all(...params,limit,start);
    return {total,documents:rows.map(row=>{const value=JSON.parse(String(row.data));return {id:value.id,kind:value.kind,title:value.title,topics:value.topics,introduction:value.introduction,revision:value.revision,read_only:this.readOnly};}),next_offset:start+limit<total?start+limit:null};
  }
  read(id:string,offset=0,limit=10000){documentId(id);page(offset);if(!page(limit,20000))failure('MEMORY_PAGINATION_INVALID','limit必须大于零。');
    const row=this.db.prepare('SELECT data FROM memories WHERE id=?').get(id);if(!row)failure('MEMORY_NOT_FOUND','知识不存在，请先检索。');const value:Revision=JSON.parse(String(row.data));return {...value,body:unicodeSlice(value.body,offset,limit),next_offset:offset+limit<value.body.length?offset+unicodeSlice(value.body,offset,limit).length:null};}
  remember(input:MemoryWrite,receipt:string=randomUUID()){
    this.writable();this.checkDocument(input);if(!['knowledge','notebook'].includes(input.kind))failure('MEMORY_KIND_INVALID','知识分层无效。');
    return this.transact(receipt,{op:'remember',input},()=>{
      const previous=this.db.prepare('SELECT revision,data FROM memories WHERE id=?').get(input.id),old:Revision|undefined=previous?JSON.parse(String(previous.data)):undefined;
      if(old&&old.kind!==input.kind)failure('MEMORY_KIND_MISMATCH','已有知识的分层不可隐式迁移。');
      const value:Revision={...input,topics:[...new Set(input.topics)].sort(),source_ids:[...new Set(input.source_ids??old?.source_ids??[])],revision:Number(previous?.revision||0)+1,updated:Date.now()};
      const data=JSON.stringify(value);if(Buffer.byteLength(data)>1024*1024)failure('MEMORY_RECORD_TOO_LARGE','单条记忆序列化总大小超过1MiB读取上限。');this.db.prepare('INSERT INTO memories VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(input.id,value.revision,data);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(input.id,value.revision,data);return {id:value.id,revision:value.revision,saved:true};
    });
  }
  revisions(id:string):Revision[]{documentId(id);return this.db.prepare('SELECT data FROM revisions WHERE id=? ORDER BY revision').all(id).map(row=>JSON.parse(String(row.data)));}
  restore(id:string,revision:number,receipt:string=randomUUID()){
    this.writable();documentId(id);const row=this.db.prepare('SELECT data FROM revisions WHERE id=? AND revision=?').get(id,revision);if(!row)failure('MEMORY_REVISION_NOT_FOUND','历史版本不存在。');
    const old=JSON.parse(String(row.data)) as Revision;
    return this.transact(receipt,{op:'restore',id,revision},()=>{
      const next=Number(this.db.prepare('SELECT revision FROM memories WHERE id=?').get(id)?.revision||0)+1,value={...old,revision:next,updated:Date.now()},data=JSON.stringify(value);
      this.db.prepare('INSERT INTO memories VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data').run(id,next,data);this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(id,next,data);return {id,revision:next,saved:true};
    });
  }
  exportMarkdown(id:string){documentId(id);const row=this.db.prepare('SELECT data FROM memories WHERE id=?').get(id);if(!row)failure('MEMORY_NOT_FOUND','知识不存在，请先检索。');const full:Revision=JSON.parse(String(row.data));
    const content=`---\ntopics: ${full.topics.join('|')}\nintroduction: ${full.introduction}\nrevision: ${full.revision}\nsource_ids: ${JSON.stringify(full.source_ids)}\n---\n\n# ${full.title}\n\n${full.body}\n`;
    return {id:full.id,content};}
  saveMatter(input:MatterWrite,receipt?:string){return saveMatter(this,input,receipt);}
  searchMatters(query='',topics:string[]=[],offset=0,options:{expression?:string;status?:string}={}){return searchMatters(this,query,topics,offset,options);}
  readMatter(id:string,offset=0){return readMatter(this,id,offset);}
  saveAsset(input:AssetWrite,receipt?:string){return saveAsset(this,input,receipt);}
  searchAssets(query='',topics:string[]=[],offset=0,expression=''){return searchAssets(this,query,topics,offset,expression);}
  readAsset(id:string,file?:string,offset=0){return readAsset(this,id,file,offset);}
  recordEvent(event:Observation){return recordEvent(this,event);}
  listEvents(offset=0,filter:Record<string,string>={}){return listEvents(this,offset,filter);}
  usageStats(){return usageStats(this);}
  metric(value:unknown){this.writable();this.db.prepare('INSERT INTO metrics(data) VALUES(?)').run(JSON.stringify(value));}
  close(){this.db.close();}
}
export function textQuery(query:string){if(typeof query!=='string'||query.length>1024)failure('MEMORY_QUERY_INVALID','检索关键词过长或无效。');return query.trim().toLowerCase().split(/\s+/).filter(Boolean);}
export function unicodeSlice(content:string,offset:number,limit:number){
  if(offset>0&&/[\uDC00-\uDFFF]/.test(content[offset]||''))failure('MEMORY_PAGINATION_INVALID','offset不能位于字符代理对中间。');
  let end=Math.min(content.length,offset+limit);if(end<content.length&&/[\uDC00-\uDFFF]/.test(content[end]||''))end--;
  if(end<=offset&&offset<content.length)failure('MEMORY_PAGINATION_INVALID','页长度无法容纳一个完整字符，请增加limit。');
  return content.slice(offset,end);
}
