#!/usr/bin/env node
import {pathToFileURL} from 'node:url';
import {existsSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import {loadKernel,openStore,connectionOptions,adapterError,normalizeError,jsonObject,readJsonFile,writeOutput,protectOutput,emitJson,exitCode} from '../adapters/runtime.mjs';

const help=`Bernard-mem — shared, explicit-root memory (Node >=22.19)

Usage: bernard-mem <command> [arguments] --root /absolute/memory [options]
Root: --root or BERNARD_MEM_MEMORY_ROOT; never inferred from AI, cwd or HOME.
Read-only: --read-only or BERNARD_MEM_READ_ONLY=true. Existing stores only unless init.

Commands:
  init                         Explicitly create/open the shared memory store
  call <tool-name> [JSON]       Dispatch a public tool; alternatively --file args.json
  export <id> --output FILE    Export editable entity JSON; --entity knowledge|matter|tool
                               --format json (default) or markdown (knowledge only)
  save --file FILE             Save complete editable JSON through remember
  stats                        AI body-read/operation statistics
  events                       Paged observations; --offset N --operation OP --actor ACTOR
                               --client CLIENT --id ID filters
  doctor                       Check package prompt and existing store without creating it
  prompt                       Print complete charter + bindings; --format json for manifest
                               Optional --output FILE
  mcp                          Run newline-delimited MCP stdio server
  hook                         Read one Codex/Claude hook JSON from stdin; --client codex|claude
                               SessionStart startup/resume/clear/compact and SubagentStart only
  config --output FILE         Export MCP + hooks sections; --client codex|claude|both
                               --section mcp|hooks|all (default all)
                               both is a JSON bundle, NOT a native config file
                               Claude: export mcp JSON and hooks settings JSON separately
                               Hook commands use POSIX shell quoting; trust is not enrolled

Options:
  --request-id ID               Stable write receipt ID (call/save); args.request_id wins
  --actor ai|human|system       Access actor (CLI default human; MCP tools always ai)
  --client NAME                Observation/client label (or native config/hook target)
  --force                      Replace an explicitly selected output file; default refuses overwrite
  --help, -h                   Show help without opening memory or requiring a build

GUI workflow: export ID --entity knowledge --output note.json -> edit in your GUI editor
              -> save --file note.json. No direct database editing. No global config writes.
Config artifacts do not install hooks, enroll trust, or guarantee host context injection.
PostCompact output is not assumed injectable; use native SessionStart source=compact.
Write fallback request IDs from MCP are connection-local; retain explicit IDs across reconnects.
Exit codes: 0 success; 1 operational/build/I/O failure; 2 invalid input; 3 read-only;
            4 missing store/entity/file. Errors are JSON on stderr, MCP errors stay on stdout.
Hook failure: stdout continue:false is a native stop request; exit 0 means envelope delivered,
              NOT prompt loaded or permission to continue. Failed delivery exits nonzero.
`;

const common=['root','read-only','help'];
const allowed={
  init:[],call:['file','request-id','actor','client'],export:['output','entity','format','force','actor','client'],
  save:['file','request-id','actor','client'],stats:['actor','client'],events:['offset','operation','actor','client','id'],
  doctor:[],prompt:['output','format','force'],mcp:['client'],hook:['client'],config:['output','client','section','force']
};
const booleans=new Set(['read-only','help','force']);
function parse(argv){
  const flags={},positionals=[];
  for(let index=0;index<argv.length;index++){
    const value=argv[index];
    if(value==='--'){positionals.push(...argv.slice(index+1));break;}
    if(value==='-h'){flags.help=true;continue;}
    if(!value.startsWith('--')){positionals.push(value);continue;}
    const equal=value.indexOf('='),name=value.slice(2,equal<0?undefined:equal);
    if(!Object.values(allowed).flat().concat(common).includes(name))throw adapterError('MEMORY_OPTION_INVALID','未知选项：--'+name);
    if(Object.hasOwn(flags,name))throw adapterError('MEMORY_OPTION_INVALID','选项重复：--'+name);
    if(booleans.has(name)){
      if(equal>=0)throw adapterError('MEMORY_OPTION_INVALID','布尔选项不接受值：--'+name);
      flags[name]=true;
    }else{
      const item=equal>=0?value.slice(equal+1):argv[++index];
      if(!item||item.startsWith('--'))throw adapterError('MEMORY_OPTION_INVALID','选项缺少值：--'+name);
      flags[name]=item;
    }
  }
  const command=positionals.shift();
  if(flags.help||command==='help'||!command)return {help:true};
  if(!Object.hasOwn(allowed,command))throw adapterError('MEMORY_COMMAND_INVALID','未知命令：'+command);
  for(const key of Object.keys(flags))if(!common.concat(allowed[command]).includes(key))throw adapterError('MEMORY_OPTION_INVALID',command+' 不接受 --'+key);
  const expected=command==='call'?2:command==='export'?1:0;
  if(positionals.length>expected||['call','export'].includes(command)&&!positionals.length)throw adapterError('MEMORY_ARGUMENTS_INVALID',command+' 的位置参数不正确；请用 --help。');
  return {command,flags,positionals};
}
const outputPath=flags=>{
  if(!flags.output||flags.output==='-')throw adapterError('MEMORY_OUTPUT_REQUIRED','此命令必须显式给出 --output 文件路径。');
  return flags.output;
};
function context(flags){
  const actor=flags.actor||'human';
  if(!['ai','human','system'].includes(actor))throw adapterError('MEMORY_ACTOR_INVALID','actor 必须为 ai、human 或 system。');
  return {actor,client:flags.client||'cli',requestId:flags['request-id']};
}
async function printText(text){
  await new Promise((done,reject)=>{process.stdout.once('error',reject);process.stdout.write(text,error=>{
    if(!error){process.stdout.off('error',reject);done();}else reject(error);
  });});
}

export async function main(argv=process.argv.slice(2)){
  const parsed=parse(argv);
  if(parsed.help){await printText(help);return;}
  const {command,flags,positionals}=parsed;
  const config=connectionOptions({root:flags.root,readOnly:flags['read-only']});
  const options={...config,client:flags.client};
  const saveOutput=async(path,content)=>{await protectOutput(path,config.root);await writeOutput(path,content,{force:flags.force});};
  if(command==='config'){
    const path=outputPath(flags);
    const {generateConfig}=await import('../adapters/config.mjs');
    const artifact=generateConfig({...options,section:flags.section});
    await saveOutput(path,artifact.content);
    await emitJson(process.stdout,{saved:true,output:resolve(path),format:artifact.format,memory_root:config.root,installed:false,hook_trust_changed:false});return;
  }
  if(command==='mcp'){
    const {startMcp}=await import('../adapters/mcp.mjs');await startMcp(options);return;
  }
  if(command==='hook'){
    const {runHook}=await import('../adapters/hooks.mjs');await runHook(options);return;
  }
  if(command==='prompt'){
    const core=await loadKernel(),bundle=core.assemblePrompt({root:config.root});
    if(flags.format&&!['json','text'].includes(flags.format))throw adapterError('MEMORY_FORMAT_INVALID','prompt --format 必须为 text 或 json。');
    const content=flags.format==='json'?JSON.stringify(bundle,null,2)+'\n':bundle.text+'\n';
    if(flags.output){await saveOutput(outputPath(flags),content);await emitJson(process.stdout,{saved:true,output:resolve(flags.output),hash:bundle.hash,version:bundle.version});}
    else await printText(content);
    return;
  }
  if(command==='init'&&config.readOnly)throw adapterError('MEMORY_READ_ONLY','init 需要显式可写接入。');
  // Read/management commands never initialize a missing store. doctor never writes schema/observations.
  const opened=await openStore({...options,...(command==='doctor'?{readOnly:true}:{})},command==='init');
  const {core,store}=opened;
  try{
    const access=context(flags);
    if(command==='init'){
      await emitJson(process.stdout,{initialized:true,...core.dispatch(store,'bernard_mem_context',{op:'status'},access)});return;
    }
    if(command==='doctor'){
      const bundle=core.loadPromptBundle({root:config.root});
      // A readable SQLite file alone is not proof of a usable memory store.
      core.dispatch(store,'bernard_mem_memory',{op:'search',entity:'knowledge'},access);
      await emitJson(process.stdout,{ok:true,api_version:core.API_VERSION,memory_root:store.root,
        configured_read_only:config.readOnly,checked_read_only:true,prompt:{hash:bundle.hash,version:bundle.version,files:bundle.files},
        tools:core.toolCatalog.map(tool=>tool.name),context_manager:'host-native',model_verified:false});return;
    }
    if(command==='call'){
      if(flags.file&&positionals[1]!==undefined)throw adapterError('MEMORY_ARGUMENTS_INVALID','call 的 JSON 参数与 --file 不能同时提供。');
      const args=flags.file?await readJsonFile(flags.file):jsonObject(positionals[1]||'{}','tool arguments');
      await emitJson(process.stdout,core.dispatch(store,positionals[0],args,access));return;
    }
    if(command==='save'){
      if(!flags.file)throw adapterError('MEMORY_FILE_REQUIRED','save 必须提供 --file。');
      const args=await readJsonFile(flags.file);
      if(args.op!==undefined&&args.op!=='remember')throw adapterError('MEMORY_ARGUMENTS_INVALID','save 仅接受 remember 内容。');
      await emitJson(process.stdout,core.dispatch(store,'bernard_mem_memory',{...args,op:'remember'},access));return;
    }
    if(command==='export'){
      const path=outputPath(flags),entity=flags.entity||'knowledge',format=flags.format||'json';
      if(!['knowledge','matter','tool'].includes(entity)||!['json','markdown'].includes(format)||format==='markdown'&&entity!=='knowledge')throw adapterError('MEMORY_FORMAT_INVALID','export 支持三类实体 JSON，或仅 knowledge 的 markdown。');
      const {exportDocument}=await import('../adapters/management.mjs');
      const document=exportDocument(core,store,{id:positionals[0],entity},access);
      const content=format==='markdown'?store.exportMarkdown(document.id).content:JSON.stringify(document,null,2)+'\n';
      await saveOutput(path,content);
      await emitJson(process.stdout,{exported:true,id:document.id,entity,format,output:resolve(path)});return;
    }
    const args={op:command};
    if(command==='events'){
      for(const key of ['operation','actor','client','id'])if(flags[key]!==undefined)args[key]=flags[key];
      if(flags.offset!==undefined){if(!/^\d+$/.test(flags.offset)||!Number.isSafeInteger(Number(flags.offset)))throw adapterError('MEMORY_PAGINATION_INVALID','offset 必须是非负安全整数。');args.offset=Number(flags.offset);}
    }
    await emitJson(process.stdout,core.dispatch(store,'bernard_mem_context',args,access));
  }finally{store.close();}
}

if(process.argv[1]&&existsSync(process.argv[1])&&import.meta.url===pathToFileURL(realpathSync(process.argv[1])).href){
  main().catch(async error=>{
    if(error.hookFailure||process.argv[2]==='hook'){
      const reason='Bernard-mem基础提示不可用：'+normalizeError(error).code+'；本轮停止，不绕过加载失败。';
      try{await emitJson(process.stdout,{continue:false,stopReason:reason,systemMessage:reason});process.exitCode=0;}
      catch{process.exitCode=exitCode(error);}
    }else process.exitCode=exitCode(error);
    await emitJson(process.stderr,{error:normalizeError(error,{effect:['EPIPE','ERR_STREAM_DESTROYED'].includes(error.code)?'unknown':'none'})}).catch(()=>{});
  });
}
