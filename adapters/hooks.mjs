import {openStore,jsonObject,readInput,emitJson,observePrompt,adapterError,normalizeError,exitCode} from './runtime.mjs';

const sources=new Set(['startup','resume','clear','compact']);
export function supportsHook(event){
  return event.hook_event_name==='SubagentStart'||event.hook_event_name==='SessionStart'&&sources.has(event.source??'startup');
}

/** Build context without reading transcript paths, credentials, cwd or root from hook payloads. */
export async function prepareHook(event,options={}){
  if(!event||typeof event!=='object'||Array.isArray(event))throw adapterError('MEMORY_INVALID_ARGUMENTS','Hook 输入必须是 JSON 对象。');
  if(!supportsHook(event))return {output:{},close(){}};
  const client=options.client||'claude';
  if(!['codex','claude'].includes(client))throw adapterError('MEMORY_CLIENT_INVALID','Hook 客户端只支持 codex 或 claude。');
  const {core,config,store}=await openStore(options,false);
  try{
    const bundle=core.assemblePrompt({root:config.root});
    return {output:{hookSpecificOutput:{hookEventName:event.hook_event_name,additionalContext:bundle.text}},
      // Called only after the output stream acknowledges the complete JSON line.
      emitted:()=>observePrompt(store,bundle,{client,event:event.hook_event_name+(event.hook_event_name==='SessionStart'?':'+(event.source??'startup'):''),
        session:typeof event.session_id==='string'?event.session_id:undefined}),
      close:()=>store.close()};
  }catch(error){store.close();throw error;}
}

export async function runHook(options={}){
  let prepared;
  try{
    const event=jsonObject(await readInput(options.input||process.stdin),'hook stdin');
    prepared=await prepareHook(event,options);
    await emitJson(options.output||process.stdout,prepared.output);
    prepared.emitted?.();
    return {emitted:!!prepared.emitted};
  }catch(error){
    // Never output a success/"loaded" marker on assembly, database or stdout failure.
    throw Object.assign(error,{hookFailure:true});
  }finally{prepared?.close();}
}

export async function hookMain(options={}){
  try{await runHook(options);return 0;}
  catch(error){
    const reason='Bernard-mem基础提示不可用：'+normalizeError(error).code+'；本轮停止。';
    try{await emitJson(options.output||process.stdout,{continue:false,stopReason:reason,systemMessage:reason});}
    catch{return exitCode(error);}
    await emitJson(process.stderr,{error:normalizeError(error)}).catch(()=>{});return 0;
  }
}

export default runHook;
