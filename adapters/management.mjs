import {createHash} from 'node:crypto';
import {adapterError} from './runtime.mjs';

/** Management export via public reads, never SQL or files from a database directory. */
export function exportDocument(core,store,{id,entity='knowledge'},context={}){
  const readAll=args=>{
    let offset=0,first,body='';
    for(let page=0;page<1024;page++){
      const value=core.dispatch(store,'bernard_mem_memory',{op:'read',entity,id,...args,offset},context);
      if(!first)first=value;
      if(value.revision!==first.revision)throw adapterError('MEMORY_EXPORT_CHANGED','分页读取期间内容已变化；请重新导出。');
      body+=value.body;
      if(value.next_offset===null||value.next_offset===undefined)return {...first,body};
      if(!Number.isSafeInteger(value.next_offset)||value.next_offset<=offset)throw adapterError('MEMORY_EXPORT_PAGINATION_INVALID','内核返回了无效的续页位置。');
      offset=value.next_offset;
    }
    throw adapterError('MEMORY_EXPORT_TOO_LARGE','导出超出最大页数。');
  };
  const value=readAll({});
  const output={entity,id:value.id,title:value.title,introduction:value.introduction,topics:value.topics,body:value.body};
  if(entity==='knowledge')return {...output,kind:value.kind,source_ids:value.source_ids||[]};
  if(entity==='matter')return {...output,status:value.status,refs:value.refs||[]};
  if(entity!=='tool')throw adapterError('MEMORY_ENTITY_INVALID','entity 必须为 knowledge、matter 或 tool。');
  const files=value.files.map(file=>{
    const exported=readAll({file:file.path});
    if(exported.revision!==value.revision)throw adapterError('MEMORY_EXPORT_CHANGED','读取工具文件期间资产已变化；请重新导出。');
    const bytes=Buffer.from(exported.body,exported.encoding==='base64'?'base64':'utf8');
    const hash=createHash('sha256').update(bytes).digest('hex');
    if(hash!==file.sha256)throw adapterError('MEMORY_ASSET_EXPORT_UNSAFE','公开读取结果无法无损导出工具文件。',{field:file.path,recovery:'保留原资产，不要将当前导出写回；核对内核对该文件编码与分页的支持。'});
    return {path:file.path,content:exported.body,encoding:exported.encoding,executable:file.executable===true};
  });
  return {...output,type:value.type,verification:value.verification||'',refs:value.refs||[],files};
}
