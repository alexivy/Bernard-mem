import {isAbsolute,dirname,basename,join,resolve,relative} from 'node:path';
import {readFile,writeFile,rename,unlink,lstat,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export const MAX_INPUT_BYTES=4*1024*1024;
let kernel;
export async function loadKernel(){
  if(!kernel){
    try{kernel=await import('../dist/index.js');}
    catch(error){
      if(error.code==='ERR_MODULE_NOT_FOUND')throw adapterError('MEMORY_CORE_UNAVAILABLE','编译后的内核不可用；请由安装/构建流程生成 dist/index.js。');
      throw error;
    }
  }
  return kernel;
}
export function adapterError(code,message,context={}){
  return Object.assign(new Error(message),{code,context:{effect:'none',retryable:false,...context}});
}
export function normalizeError(error,{effect='none'}={}){
  const context=error?.context||{};
  return {code:typeof error?.code==='string'?error.code:'MEMORY_ADAPTER_ERROR',
    message:typeof error?.message==='string'?error.message.slice(0,1800):'Bernard-mem 接入失败。',
    effect:context.effect||effect,retryable:context.retryable===true,
    recovery:context.recovery||'核对参数、显式记忆根与接入状态；结果不明的写入先查询 receipt，不要盲目重试。',
    ...Object.fromEntries(['field','actual','expected'].filter(key=>context[key]!==undefined).map(key=>[key,context[key]]))};
}
export function connectionOptions(options={},env=process.env){
  const root=options.root??env.BERNARD_MEM_MEMORY_ROOT;
  if(typeof root!=='string'||!isAbsolute(root)||/[\0\r\n]/.test(root))throw adapterError('MEMORY_ROOT_INVALID','必须通过 --root 或 BERNARD_MEM_MEMORY_ROOT 显式指定绝对记忆根。');
  const value=options.readOnly??env.BERNARD_MEM_READ_ONLY??false;
  if(![true,false,'true','false','1','0'].includes(value))throw adapterError('MEMORY_READ_ONLY_INVALID','只读设置必须为 true/false 或 1/0。');
  return {root,readOnly:value===true||value==='true'||value==='1'};
}
export async function openStore(options={},create=false){
  const config=connectionOptions(options);
  const core=await loadKernel();
  return {core,config,store:core.MemoryStore.open(config.root,{mode:config.readOnly?'read-only':'read-write',create})};
}
export function jsonObject(text,label='JSON'){
  let value;
  try{value=JSON.parse(text);}catch{throw adapterError('MEMORY_INVALID_JSON',label+' 不是有效 JSON。');}
  if(!value||typeof value!=='object'||Array.isArray(value))throw adapterError('MEMORY_INVALID_ARGUMENTS',label+' 必须是 JSON 对象。');
  return value;
}
export async function readInput(stream=process.stdin,limit=MAX_INPUT_BYTES){
  const parts=[];let length=0;
  for await(const part of stream){const bytes=Buffer.isBuffer(part)?part:Buffer.from(part);length+=bytes.length;
    if(length>limit)throw adapterError('MEMORY_INPUT_TOO_LARGE','输入超过 '+limit+' 字节上限。');parts.push(bytes);}
  return Buffer.concat(parts).toString('utf8');
}
export async function readJsonFile(path){
  const info=await lstat(path);
  if(!info.isFile()||info.size>MAX_INPUT_BYTES)throw adapterError('MEMORY_INPUT_TOO_LARGE','输入必须为不超过 4MiB 的普通 JSON 文件。');
  const content=await readFile(path,'utf8');
  if(Buffer.byteLength(content)>MAX_INPUT_BYTES)throw adapterError('MEMORY_INPUT_TOO_LARGE','输入文件超过 4MiB。');
  return jsonObject(content,path);
}
/** Do not let a management export/config artifact replace the live store or tool assets. */
export async function protectOutput(path,root){
  const parent=await realpath(dirname(resolve(path)));
  const target=join(parent,basename(path));
  let canonicalRoot;
  try{canonicalRoot=await realpath(root);}catch(error){if(error.code==='ENOENT')canonicalRoot=resolve(root);else throw error;}
  const name=relative(canonicalRoot,target);
  if(['memory.sqlite','memory.sqlite-wal','memory.sqlite-shm','memory.sqlite-journal'].includes(name)||name==='tools'||name.startsWith('tools/')||name.startsWith('tools\\'))throw adapterError('MEMORY_OUTPUT_INVALID','输出不能覆盖记忆数据库、辅助文件或已保存的工具资产。');
}
/** No implicit output directory, no default/global configuration location. */
export async function writeOutput(path,content,{force=false}={}){
  if(typeof path!=='string'||!path||path==='-')throw adapterError('MEMORY_OUTPUT_REQUIRED','必须显式指定 --output 文件路径。');
  if(!force){await writeFile(path,content,{encoding:'utf8',flag:'wx',mode:0o600});return;}
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw adapterError('MEMORY_OUTPUT_INVALID','输出目标必须是独占普通文件。');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary=join(dirname(path),'.'+basename(path)+'.'+randomUUID()+'.tmp');
  try{await writeFile(temporary,content,{encoding:'utf8',flag:'wx',mode:0o600});await rename(temporary,path);}
  finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
export function emitJson(stream,value){
  return new Promise((resolve,reject)=>{
    const failed=error=>{stream.off('error',failed);reject(error);};
    stream.once('error',failed);
    stream.write(JSON.stringify(value)+'\n',error=>{
      // Writable emits its error after the write callback. Keep the once-listener
      // on failure so EPIPE is not turned into an uncaught process exception.
      if(error)reject(error);else{stream.off('error',failed);resolve();}
    });
  });
}
export function warn(value,stream=process.stderr){void emitJson(stream,{warning:value}).catch(()=>{});}
export function observePrompt(store,bundle,context={}){
  try{
    const observation=store.recordEvent({operation:'prompt_emitted',actor:'system',...context,prompt_hash:bundle.hash,prompt_version:bundle.version,status:'emitted'});
    if(!observation?.recorded)warn({code:'MEMORY_OBSERVATION_UNAVAILABLE',operation:'prompt_emitted',...observation});
    return observation;
  }catch(error){const observation={recorded:false,error:normalizeError(error)};warn({code:'MEMORY_OBSERVATION_UNAVAILABLE',operation:'prompt_emitted',...observation});return observation;}
}
export function exitCode(error){
  const code=error?.code||'';
  if(code==='MEMORY_READ_ONLY')return 3;
  if(/(?:INVALID|MISSING|REQUIRED|UNKNOWN|TOO_LARGE|FIELD_TOO_LONG|PAGINATION)/.test(code))return 2;
  if(/(?:NOT_FOUND|NOT_INITIALIZED)/.test(code)||code==='ENOENT')return 4;
  return 1;
}
