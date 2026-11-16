import {randomUUID} from 'node:crypto';
import {MAX_INPUT_BYTES,openStore,adapterError,normalizeError,emitJson} from './runtime.mjs';

const protocols=['2025-11-25','2025-06-18','2025-03-26','2024-11-05'];
const promptUri='bernard-mem://prompt';
const manifestUri='bernard-mem://prompt/manifest';
const MAX_CONCURRENT=16;
const MAX_RESPONSE_BYTES=8*1024*1024;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validId=value=>value===null||typeof value==='string'&&value.length<=256||typeof value==='number'&&Number.isFinite(value);

/** Public newline-delimited MCP stdio transport. No task or host/broker dependencies. */
export async function startMcp(options={}){
  const input=options.input||process.stdin,output=options.output||process.stdout;
  const connectionId=randomUUID(),pending=new Map();
  let state='new',store,core,config,bundle,closed=false,outputFailed;
  const send=async value=>{
    if(outputFailed)throw outputFailed;
    if(Buffer.byteLength(JSON.stringify(value))>MAX_RESPONSE_BYTES)value={jsonrpc:'2.0',id:value.id??null,error:{code:-32001,message:'响应过大，请缩小查询或分页读取。'}};
    try{await emitJson(output,value);}catch(error){outputFailed=error;for(const controller of pending.values())controller.abort();input.destroy?.();throw error;}
  };
  const fail=(id,code,message,data)=>send({jsonrpc:'2.0',id,error:{code,message,...(data?{data}:{})}});
  const result=(id,value)=>send({jsonrpc:'2.0',id,result:value});
  const close=()=>{if(closed)return;closed=true;for(const controller of pending.values())controller.abort();store?.close();store=undefined;};

  async function route(message,controller){
    const {id,method}=message,params=message.params||{};
    if(method==='initialize'){
      if(state!=='new')return fail(id,-32600,'Already initialized or initialization in progress');
      if(typeof params.protocolVersion!=='string'||!object(params.capabilities)||!object(params.clientInfo)||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string')return fail(id,-32602,'Invalid initialize parameters');
      state='initializing';
      try{
        const opened=await openStore(options,false);core=opened.core;config=opened.config;store=opened.store;
        controller.signal.throwIfAborted();
        bundle=core.loadPromptBundle({root:config.root});
        await result(id,{protocolVersion:protocols.includes(params.protocolVersion)?params.protocolVersion:protocols[0],
          capabilities:{tools:{},resources:{}},serverInfo:{name:'bernard-mem',version:'0.1.0'},instructions:bundle.text});
        state='ready';
      }catch(error){store?.close();store=undefined;state='new';throw error;}
      return;
    }
    if(method==='ping')return result(id,{});
    if(state!=='ready')return fail(id,-32002,'Server not initialized');
    if(method==='tools/list')return result(id,{tools:core.toolCatalog});
    if(method==='resources/list')return result(id,{resources:[
      {uri:promptUri,name:'Bernard-mem base prompt',mimeType:'text/markdown',description:'随包 charter、API 绑定与本连接共享根'},
      {uri:manifestUri,name:'Bernard-mem prompt manifest',mimeType:'application/json',description:'提示 hash、版本与随包文件指纹，不含记忆正文'}]});
    if(method==='resources/templates/list')return result(id,{resourceTemplates:[]});
    if(method==='resources/read'){
      if(![promptUri,manifestUri].includes(params.uri))return fail(id,-32602,'Unknown resource');
      const current=core.loadPromptBundle({root:config.root});
      const {text,...manifest}=current;
      return result(id,{contents:[{uri:params.uri,mimeType:params.uri===promptUri?'text/markdown':'application/json',text:params.uri===promptUri?text:JSON.stringify(manifest)}]});
    }
    if(method!=='tools/call')return fail(id,-32601,'Method not found');
    if(typeof params.name!=='string'||!core.toolCatalog.some(tool=>tool.name===params.name)||params.arguments!==undefined&&!object(params.arguments))return fail(id,-32602,'Unknown tool or invalid arguments');
    try{
      const args=params.arguments||{};
      // Explicit request_id wins inside dispatch. This fallback is stable ONLY in this connection.
      const value=core.dispatch(store,params.name,args,{actor:'ai',client:options.client||'mcp',
        requestId:connectionId+':'+JSON.stringify(id),signal:controller.signal});
      await result(id,{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value,isError:false});
    }catch(error){
      await result(id,{content:[{type:'text',text:JSON.stringify({error:normalizeError(error,{effect:'unknown'})})}],isError:true});
    }
  }

  async function handle(message){
    if(!object(message)||message.jsonrpc!=='2.0'||typeof message.method!=='string'||
      Object.hasOwn(message,'id')&&!validId(message.id)||message.params!==undefined&&!object(message.params))return fail(null,-32600,'Invalid Request');
    const hasId=Object.hasOwn(message,'id');
    if(!hasId){
      if(message.method==='notifications/cancelled')pending.get(message.params?.requestId)?.abort();
      // Other notifications, including notifications/initialized, receive no response.
      return;
    }
    const id=message.id;
    if(pending.has(id)||pending.size>=MAX_CONCURRENT)return fail(id,-32000,'Too many or duplicate pending requests');
    const controller=new AbortController();pending.set(id,controller);
    try{await route(message,controller);}
    catch(error){if(!outputFailed)await fail(id,-32603,'Request failed',{error:normalizeError(error)});}
    finally{pending.delete(id);}
  }

  const running=new Set();
  const launch=line=>{
    let message;
    try{message=JSON.parse(line.toString('utf8'));}
    catch{const task=fail(null,-32700,'Parse error');running.add(task);task.finally(()=>running.delete(task)).catch(()=>{});return;}
    const task=handle(message);running.add(task);task.finally(()=>running.delete(task)).catch(()=>{});
  };
  let buffer=Buffer.alloc(0);
  try{
    for await(const chunk of input){
      if(outputFailed)throw outputFailed;
      buffer=Buffer.concat([buffer,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);
      let index;
      while((index=buffer.indexOf(10))>=0){
        if(index>MAX_INPUT_BYTES)throw adapterError('MEMORY_INPUT_TOO_LARGE','单条 MCP 输入超过 4MiB。');
        const line=buffer.subarray(0,index);buffer=buffer.subarray(index+1);
        if(line.toString('utf8').trim()){
          if(running.size>=MAX_CONCURRENT)await Promise.race(running).catch(()=>{});
          launch(line);
        }
        // Yield to completed handlers; enforce limits on concurrent work, not chunk grouping.
        await Promise.resolve();
      }
      if(buffer.length>MAX_INPUT_BYTES)throw adapterError('MEMORY_INPUT_TOO_LARGE','单条 MCP 输入超过 4MiB。');
    }
    if(buffer.toString('utf8').trim()){
      // stdio MCP requires one complete JSON-RPC message per newline.
      await fail(null,-32700,'Incomplete message: missing newline');
    }
    await Promise.allSettled([...running]);
    if(outputFailed)throw outputFailed;
  }catch(error){
    if(!outputFailed)await fail(null,-32000,'Stdio transport failed',{error:normalizeError(error)}).catch(()=>{});
    throw error;
  }finally{close();}
}

export default startMcp;
