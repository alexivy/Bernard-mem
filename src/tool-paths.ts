import {lstatSync,realpathSync} from 'node:fs';
import {join,relative,resolve,dirname,sep,isAbsolute} from 'node:path';
export function ownedPath(directory:string,cwd:string,value:unknown):string|undefined {
  if(typeof value!=='string'||!isAbsolute(value)||value.includes('\0')||/[  -   　]/.test(value))return;
  if(lstatSync(directory).isSymbolicLink())return;
  directory=realpathSync(directory);
  const target=resolve(cwd,value);
  let ancestor=target,base:string|undefined;
  while(true){
    try{if(realpathSync(ancestor)===directory)base=ancestor;}
    catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code||''))throw error;}
    const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;
  }
  if(!base||base===target||lstatSync(base).isSymbolicLink())return;
  let current=base;
  for(const part of relative(base,target).split(sep)){
    current=join(current,part);
    try{if(lstatSync(current).isSymbolicLink())return;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  return join(directory,relative(base,target));
}
export function reviewToolWrite(directory:string,cwd:string,value:unknown){return ownedPath(directory,cwd,value)!==undefined;}
