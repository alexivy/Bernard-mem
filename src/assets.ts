import {mkdirSync,writeFileSync,renameSync,readFileSync,lstatSync,existsSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {join,dirname,isAbsolute} from 'node:path';
import {checkedPath,documentId,page,unicodeSlice,type MemoryStore} from './memory.js';
import {searchRecords} from './matters.js';
import {failure} from './errors.js';
export type AssetFile={path:string;content:string;encoding?:'utf8'|'base64';executable?:boolean};
export type AssetWrite={id:string;type:'script'|'template'|'skill';title:string;topics:string[];introduction:string;body:string;files:AssetFile[];verification?:string;refs?:string[]};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function relativeFile(value:string){if(typeof value!=='string'||!value||isAbsolute(value)||value.includes('\\')||value.includes('\0')||value.split('/').some(part=>!part||part==='.'||part==='..'||part==='.git'))failure('MEMORY_ASSET_PATH_INVALID','工具文件必须使用无越界的相对路径。');return value;}
export function saveAsset(store:MemoryStore,input:AssetWrite,receipt:string=randomUUID()){
  store.writable();store.checkDocument(input);
  if(!['script','template','skill'].includes(input.type)||!Array.isArray(input.files)||!input.files.length||input.files.length>128)failure('MEMORY_ASSET_INVALID','工具类型或文件列表无效。');
  const names=new Set<string>();let total=0;
  const files=input.files.map(file=>{const path=relativeFile(file.path);if(names.has(path))failure('MEMORY_ASSET_INVALID','工具文件路径重复。');names.add(path);
    if(typeof file.content!=='string'||file.encoding&&!['utf8','base64'].includes(file.encoding))failure('MEMORY_ASSET_INVALID','工具文件内容或编码无效。');
    const bytes=Buffer.from(file.content,file.encoding==='base64'?'base64':'utf8');total+=bytes.length;if(total>2*1024*1024)failure('MEMORY_ASSET_TOO_LARGE','单个工具资产最多2MiB。');return {path,bytes,sha256:digest(bytes),executable:file.executable===true};});
  if(input.type==='skill'&&!names.has('SKILL.md'))failure('MEMORY_ASSET_INVALID','Skill必须包含SKILL.md及必要辅助文件。');
  return store.transact(receipt,{op:'asset',input},()=>{
    const previous=store.db.prepare('SELECT data FROM assets WHERE id=?').get(input.id),old=previous?JSON.parse(String(previous.data)):undefined;
    const version=digest(Buffer.from(JSON.stringify(files.map(({path,sha256,executable})=>({path,sha256,executable})))));
    const directory=checkedPath(store.root,join(store.root,'tools',input.id,version));mkdirSync(directory,{recursive:true,mode:0o700});
    for(const file of files){const filename=checkedPath(store.root,join(directory,file.path));mkdirSync(dirname(filename),{recursive:true,mode:0o700});
      if(existsSync(filename)){if(!lstatSync(filename).isFile()||digest(readFileSync(filename))!==file.sha256)failure('MEMORY_ASSET_INTEGRITY','已保存的工具文件完整性异常。');continue;}
      const tmp=filename+'.'+randomUUID()+'.tmp';writeFileSync(tmp,file.bytes,{mode:file.executable?0o700:0o600});renameSync(tmp,filename);}
    const value={id:input.id,type:input.type,title:input.title,introduction:input.introduction,body:input.body,topics:[...new Set(input.topics)].sort(),verification:input.verification||'',refs:input.refs||[],revision:(old?.revision||0)+1,updated:Date.now(),directory:join('tools',input.id,version),files:files.map(({path,sha256,bytes,executable})=>({path,sha256,size:bytes.length,executable}))};
    store.db.prepare('INSERT INTO assets VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(input.id,JSON.stringify(value));return {id:input.id,revision:value.revision,saved:true,directory};
  });
}
export function searchAssets(store:MemoryStore,query='',topics:string[]=[],offset=0,expression=''){return searchRecords(store,'assets',query,topics,offset,{expression});}
export function readAsset(store:MemoryStore,id:string,file?:string,offset=0){documentId(id);page(offset);if(!store.table('assets'))failure('MEMORY_NOT_FOUND','工具资产不存在。');const row=store.db.prepare('SELECT data FROM assets WHERE id=?').get(id);if(!row)failure('MEMORY_NOT_FOUND','工具资产不存在。');const value=JSON.parse(String(row.data));
  if(!file){const body=unicodeSlice(value.body,offset,10000);return {...value,body,directory:checkedPath(store.root,join(store.root,value.directory)),next_offset:offset+body.length<value.body.length?offset+body.length:null};}
  relativeFile(file);const entry=value.files.find((item:{path:string})=>item.path===file);if(!entry)failure('MEMORY_NOT_FOUND','工具文件不存在。');
  const filename=checkedPath(store.root,join(store.root,value.directory,file));if(!lstatSync(filename).isFile())failure('MEMORY_ASSET_INTEGRITY','工具文件不是普通文件。');const bytes=readFileSync(filename);if(digest(bytes)!==entry.sha256)failure('MEMORY_ASSET_INTEGRITY','工具文件内容与索引不符。');
  const decoded=bytes.toString('utf8'),binary=bytes.includes(0)||!Buffer.from(decoded,'utf8').equals(bytes),content=binary?bytes.toString('base64'):decoded,body=unicodeSlice(content,offset,10000);return {id,revision:value.revision,file,encoding:binary?'base64':'utf8',body,next_offset:offset+body.length<content.length?offset+body.length:null};
}
