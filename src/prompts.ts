import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {failure} from './errors.js';

export type PromptBundle={text:string;hash:string;version:string;files:{path:string;sha256:string}[]};
const version='1';
const paths=['charter/principles.md','charter/evolution-policy.md','bindings.md'] as const;
const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

/** Load only the charter and bindings shipped with this package, never instance files. */
export function loadPromptBundle({root}:{root:string}):PromptBundle {
  if(typeof root!=='string'||!isAbsolute(root)||root.includes('\0')||/[\r\n]/.test(root))failure('MEMORY_ROOT_INVALID','记忆根必须是显式绝对路径，且不得包含换行或空字符。');
  const sources=paths.map(path=>{
    try{
      const bytes=readFileSync(new URL('../prompts/'+path,import.meta.url));
      if(!bytes.length||!bytes.toString('utf8').trim())failure('MEMORY_PROMPT_INVALID','随包提示文件为空。',{field:'prompts/'+path});
      return {path:'prompts/'+path,sha256:digest(bytes),text:bytes.toString('utf8')};
    }catch(error){
      if((error as {code?:string}).code==='MEMORY_PROMPT_INVALID')throw error;
      failure('MEMORY_PROMPT_UNAVAILABLE','无法读取随包提示文件。',{field:'prompts/'+path,recovery:'检查 Bernard-mem 安装包是否完整包含 prompts/charter 与 prompts/bindings.md。'});
    }
  });
  const text=`[Bernard-mem 基础方法论；原始 charter 与公共 API 绑定]\n提示版本：${version}\n共享记忆根（JSON 字符串）：${JSON.stringify(root)}\n此路径由接入配置确定，不随客户端、AI、HOME 或任务目录变化。\n\n`+
    sources.map(source=>`[随包文件：${source.path}]\n${source.text}`).join('\n\n');
  return {text,hash:digest(text),version,files:sources.map(({path,sha256})=>({path,sha256}))};
}

export function assemblePrompt(options:{root:string}):PromptBundle {return loadPromptBundle(options);}
