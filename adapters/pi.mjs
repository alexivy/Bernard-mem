import {randomUUID} from 'node:crypto';
import {loadKernel,openStore,adapterError,normalizeError,observePrompt} from './runtime.mjs';

const sectionKey='bernard_mem';
const sessionId=ctx=>ctx?.sessionManager?.getSessionId?.();
const failureResult=error=>{const value={error:normalizeError(error)};return {isError:true,content:[{type:'text',text:JSON.stringify(value)}],details:value,structuredContent:value};};

/** Pi public extension only: no Pi runtime imports, monkey patches, model calls or review loop. */
export function createPiAdapter(options={}){
  return async pi=>{
    const core=await loadKernel();
    let store,config,connectionId=randomUUID(),failure;
    const required=()=>{if(!store)throw adapterError('MEMORY_NOT_INITIALIZED','Bernard-mem 会话尚未成功打开。');return store;};
    const stop=()=>{const current=store;store=undefined;config=undefined;current?.close();};
    const report=(ctx,error)=>{
      const value=normalizeError(error);failure=value;
      ctx?.ui?.notify?.('Bernard-mem: '+JSON.stringify(value),'error');
      return Object.assign(new Error(JSON.stringify({error:value})),{code:value.code,context:value});
    };
    pi.on('session_start',async(_event,ctx)=>{
      stop();connectionId=randomUUID();
      try{const opened=await openStore(options,false);store=opened.store;config=opened.config;
        core.assemblePrompt({root:config.root});failure=undefined;
        ctx?.ui?.setStatus?.('bernard-mem','Bernard-mem · '+(config.readOnly?'只读':'共享记忆'));
      }catch(error){throw report(ctx,error);}
    });
    pi.on('session_shutdown',()=>{stop();});
    pi.on('input',(_event,ctx)=>{
      try{required();core.assemblePrompt({root:config.root});failure=undefined;return {action:'continue'};}
      catch(error){report(ctx,error);return {action:'handled'};}
    });
    pi.on('tool_call',()=>failure?{block:true,reason:'Bernard-mem基础提示未就绪：'+failure.code}:undefined);
    pi.on('before_agent_start',(event,ctx)=>{
      try{
        const current=required();
        const sections=event?.systemPromptOptions?.sections;
        if(!sections||typeof sections!=='object'||Array.isArray(sections))throw adapterError('MEMORY_PI_SECTIONS_UNSUPPORTED','当前 Pi 未提供公开 systemPromptOptions.sections；无法安全替换提示段。');
        const bundle=core.assemblePrompt({root:config.root});
        // Pi diffs sections by key. Replacing this key does not append another full prompt each turn.
        sections[sectionKey]=bundle.text;failure=undefined;
        const observation=observePrompt(current,bundle,{client:'pi',session:sessionId(ctx),event:'before_agent_start'});
        if(!observation?.recorded)ctx?.ui?.setStatus?.('bernard-mem','Bernard-mem · 提示已装配；观测未记录');
      }catch(error){
        const sections=event?.systemPromptOptions?.sections;
        if(sections&&typeof sections==='object')sections[sectionKey]='Bernard-mem基础提示装配失败；本轮只报告加载错误，禁止执行实质任务或工具。';
        throw report(ctx,error);
      }
    });
    for(const definition of core.toolCatalog){
      pi.registerTool({name:definition.name,label:definition.name==='bernard_mem_memory'?'Bernard-mem 记忆':'Bernard-mem 状态',
        description:definition.description,parameters:definition.inputSchema,annotations:definition.annotations,
        async execute(callId,args,signal,_onUpdate,ctx){
          try{
            if(failure)throw adapterError('MEMORY_PROMPT_UNAVAILABLE','基础提示未就绪，工具未执行。');
            const value=core.dispatch(required(),definition.name,args,{actor:'ai',client:'pi',session:sessionId(ctx),
              requestId:connectionId+':'+callId,signal});
            return {content:[{type:'text',text:JSON.stringify(value)}],details:value,structuredContent:value};
          }catch(error){return failureResult(error);}
        }});
    }
  };
}

export default createPiAdapter();
