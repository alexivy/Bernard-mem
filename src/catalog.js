import {DatabaseSync} from 'node:sqlite';
import {lstatSync,realpathSync} from 'node:fs';
import {isAbsolute,join,resolve,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {compileTopicExpression,validTopicName} from './query.js';

const idPattern = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_TOPICS = 50, MAX_TOPIC_NAME = 200, MAX_ROW_BYTES = 1024 * 1024;
const failure = (code,message) => Object.assign(new Error(message),{code});
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24);
const encode = value => Buffer.from(JSON.stringify({v:1,...value})).toString('base64url');
function decode(input) {
  try {
    if (typeof input !== 'string' || input.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input)) throw Error();
    const value = JSON.parse(Buffer.from(input,'base64url').toString('utf8'));
    if (!value || value.v !== 1 || Array.isArray(value)) throw Error();
    return value;
  } catch {throw failure('MEMORY_CATALOG_CURSOR_INVALID','分页位置无效，请重新读取。');}
}
function queryText(value) {
  if (typeof value !== 'string' || value.length > 120) throw failure('MEMORY_CATALOG_QUERY_INVALID','关键词最多 120 字符。');
  return value.trim();
}
function pageLimit(value,maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw failure('MEMORY_CATALOG_LIMIT_INVALID',`每页数量须为 1 到 ${maximum}。`);
  return value;
}
function searchClauses(query,expression,params) {
  return query.toLowerCase().split(/\s+/).filter(Boolean).map(word => {
    params.push('%'+word.replace(/[\\%_]/g,char=>'\\'+char)+'%');
    return `bernard_lower(${expression}) LIKE ? ESCAPE '\\'`;
  });
}
const metadata = `m.id,m.revision,json_extract(m.data,'$.kind') AS kind,
  substr(json_extract(m.data,'$.title'),1,200) AS title,
  substr(json_extract(m.data,'$.introduction'),1,600) AS introduction,
  json_extract(m.data,'$.updated') AS updated,
  json_array_length(m.data,'$.topics') AS topics_total,
  (SELECT json_group_array(value) FROM (SELECT value FROM json_each(m.data,'$.topics') LIMIT ${MAX_TOPICS})) AS topics_json`;
function document(row) {
  let topics;try {topics=JSON.parse(row.topics_json);} catch {throw failure('MEMORY_CATALOG_FORMAT_INVALID','记忆元数据格式无效。');}
  if (!idPattern.test(row.id) || !['knowledge','notebook'].includes(row.kind) || typeof row.title !== 'string' || typeof row.introduction !== 'string' ||
      !Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.updated) || row.updated < 0 || !Array.isArray(topics) || topics.some(value=>!validTopicName(value)))
    throw failure('MEMORY_CATALOG_FORMAT_INVALID','记忆元数据格式无效。');
  if (topics.some(value=>value.length>MAX_TOPIC_NAME)) throw failure('MEMORY_CATALOG_METADATA_LIMIT','Topic 名称超过 200 字符读取上限。');
  return {id:row.id,kind:row.kind,title:row.title.slice(0,200),introduction:row.introduction.slice(0,600),topics,revision:row.revision,updated:row.updated,
    ...(row.topics_total>MAX_TOPICS?{topics_truncated:true,topics_total:row.topics_total}:{})};
}

/**
 * Read current memory rows from an explicit absolute memory root.
 * No MemoryStore, initialization, projection repair, or usage recording occurs.
 * Methods return null while the database is absent, without creating its directory.
 */
export function createMemoryCatalog(memoryRoot) {
  if(typeof memoryRoot!=='string'||!isAbsolute(memoryRoot))throw failure('MEMORY_CATALOG_UNSAFE_SOURCE','记忆根必须是显式绝对路径。');
  let root=resolve(memoryRoot);
  try{root=join(realpathSync(dirname(root)),basename(root));}catch(error){if(error.code!=='ENOENT')throw error;}
  const filename=join(root,'memory.sqlite');
  let db,initial,closed=false;
  function paths() {
    try {
      const folder=lstatSync(root);
      if (folder.isSymbolicLink() || !folder.isDirectory() || realpathSync(root)!==root) throw failure('MEMORY_CATALOG_UNSAFE_SOURCE','记忆根必须是不经过符号链接的普通目录。');
      const file=lstatSync(filename);
      if (file.isSymbolicLink() || !file.isFile() || file.nlink!==1 || realpathSync(filename)!==filename) throw failure('MEMORY_CATALOG_UNSAFE_SOURCE','记忆数据库必须是无链接的独占普通文件。');
      for (const suffix of ['-wal','-shm']) {
        try {const sidecar=lstatSync(filename+suffix);if (sidecar.isSymbolicLink()||!sidecar.isFile()||sidecar.nlink!==1)throw failure('MEMORY_CATALOG_UNSAFE_SOURCE','记忆数据库的辅助文件不安全。');}
        catch(error){if(error.code!=='ENOENT')throw error;}
      }
      return file;
    } catch(error){if(error.code==='ENOENT')return null;throw error.code?.startsWith('MEMORY_CATALOG_')?error:failure('MEMORY_CATALOG_NOT_CONNECTED','记忆数据库暂时不可读取。');}
  }
  function openDatabase() {
    if (closed) throw failure('MEMORY_CATALOG_CLOSED','记忆读取连接已关闭。');
    const current=paths();
    if (!current) {
      if (db) throw failure('MEMORY_CATALOG_SOURCE_CHANGED','记忆数据库已移走，请重新创建读取连接。');
      return null;
    }
    if (initial&&(current.dev!==initial.dev||current.ino!==initial.ino)) throw failure('MEMORY_CATALOG_SOURCE_CHANGED','记忆数据库已被替换，请重新创建读取连接。');
    if (!db) {
      let candidate;
      try {
        candidate=new DatabaseSync(filename,{readOnly:true});candidate.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
        candidate.function('bernard_lower',{deterministic:true},value=>String(value??'').toLowerCase());
        candidate.prepare('SELECT id,revision,data FROM memories LIMIT 0').all();
        db=candidate;initial=current;
      } catch {candidate?.close();throw failure('MEMORY_CATALOG_INCOMPATIBLE_SOURCE','记忆数据库结构不可读取；只读目录不会初始化或迁移它。');}
    }
    return db;
  }
  function read(operation) {
    const connection=openDatabase();if(!connection)return null;
    try {
      // Bound invalid or oversized JSON rows before JSON extraction. No raw data is loaded into JS.
      const bad=connection.prepare(`SELECT id FROM memories WHERE CASE WHEN length(CAST(data AS BLOB))>${MAX_ROW_BYTES} THEN 1 WHEN NOT json_valid(data) THEN 1
        WHEN json_type(data,'$.topics') IS NOT 'array' OR json_type(data,'$.body') IS NOT 'text'
          OR json_type(data,'$.title') IS NOT 'text' OR json_type(data,'$.introduction') IS NOT 'text' THEN 1 ELSE 0 END LIMIT 1`).get();
      if(bad)throw failure('MEMORY_CATALOG_FORMAT_INVALID','存在无效或超过 1 MiB 读取上限的记忆记录。');
      return operation(connection);
    } catch(error){
      if(error.code?.startsWith('MEMORY_CATALOG_'))throw error;
      if(/busy|locked/i.test(error.message||''))throw failure('MEMORY_CATALOG_BUSY','记忆数据库暂时忙，请稍后重试。');
      if(/json/i.test(error.message||''))throw failure('MEMORY_CATALOG_FORMAT_INVALID','记忆记录包含无效 JSON 或元数据。');
      throw failure('MEMORY_CATALOG_READ_FAILED','暂时无法读取当前记忆。');
    }
  }
  return {
    root,
    listDocuments({query='',kind='',topics='',cursor=null,limit=20}={}) {
      query=queryText(query);pageLimit(limit,20);
      if(!['','knowledge','notebook'].includes(kind))throw failure('MEMORY_CATALOG_KIND_INVALID','记忆类型只能是 knowledge 或 notebook。');
      const topicCondition=compileTopicExpression(topics),filter=digest([query,kind,topics.trim()]);
      const after=cursor===null?null:decode(cursor);
      if(after&&(after.type!=='documents'||after.filter!==filter||!idPattern.test(after.id)||!Number.isSafeInteger(after.updated)||after.updated<0))throw failure('MEMORY_CATALOG_CURSOR_INVALID','筛选或分页位置已改变，请重新读取列表。');
      return read(connection=>{
        const clauses=[topicCondition.sql],params=[...topicCondition.params];
        if(kind){clauses.push("json_extract(m.data,'$.kind')=?");params.push(kind);}
        clauses.push(...searchClauses(query,"m.id || ' ' || json_extract(m.data,'$.title') || ' ' || json_extract(m.data,'$.introduction') || ' ' || json_extract(m.data,'$.topics')",params));
        if(after){clauses.push("(json_extract(m.data,'$.updated') < ? OR (json_extract(m.data,'$.updated') = ? AND m.id > ?))");params.push(after.updated,after.updated,after.id);}
        const rows=connection.prepare(`SELECT ${metadata} FROM memories m WHERE ${clauses.join(' AND ')} ORDER BY updated DESC,m.id ASC LIMIT ?`).all(...params,limit+1);
        const values=rows.slice(0,limit).map(document),last=values.at(-1);
        return {documents:values,next_cursor:rows.length>limit?encode({type:'documents',filter,id:last.id,updated:last.updated}):null};
      });
    },
    listTopics({query='',cursor=null,limit=20}={}) {
      query=queryText(query);pageLimit(limit,20);const filter=digest(query),after=cursor===null?null:decode(cursor);
      if(after&&(after.type!=='topics'||after.filter!==filter||!validTopicName(after.name)))throw failure('MEMORY_CATALOG_CURSOR_INVALID','Topic 筛选或分页位置已改变，请重新读取。');
      return read(connection=>{
        const definitions=connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_topics'").get();
        const known=definitions?'SELECT name,substr(introduction,1,600) AS introduction FROM memory_topics':'SELECT NULL AS name,NULL AS introduction WHERE 0';
        const params=[],clauses=searchClauses(query,"name || ' ' || coalesce(introduction,'')",params);
        if(after){clauses.push('name>?');params.push(after.name);}
        const rows=connection.prepare(`WITH definitions AS (${known}), names AS (SELECT name FROM definitions UNION SELECT topic.value FROM memories m,json_each(m.data,'$.topics') topic WHERE topic.type='text'),
          topic_rows AS (SELECT names.name,definitions.introduction FROM names LEFT JOIN definitions ON definitions.name=names.name)
          SELECT name,introduction FROM topic_rows ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY name LIMIT ?`).all(...params,limit+1);
        const values=rows.slice(0,limit).map(row=>{
          if(!validTopicName(row.name)||row.name.length>MAX_TOPIC_NAME)throw failure('MEMORY_CATALOG_METADATA_LIMIT','Topic 名称无效或超过 200 字符读取上限。');
          return {name:row.name,introduction:row.introduction};
        });
        return {topics:values,next_cursor:rows.length>limit?encode({type:'topics',filter,name:values.at(-1).name}):null};
      });
    },
    readDocument(id,{cursor=null,limit=16000}={}) {
      if(typeof id!=='string'||!idPattern.test(id))throw failure('MEMORY_CATALOG_ID_INVALID','记忆文档编号无效。');
      pageLimit(limit,16000);const after=cursor===null?null:decode(cursor);
      if(after&&(after.type!=='body'||after.id!==id||!Number.isSafeInteger(after.revision)||after.revision<1||!Number.isSafeInteger(after.offset)||after.offset<0))throw failure('MEMORY_CATALOG_CURSOR_INVALID','正文分页位置无效。');
      return read(connection=>{
        const offset=after?.offset||0;
        const row=connection.prepare(`SELECT ${metadata},substr(json_extract(m.data,'$.body'),?,?) AS body,length(json_extract(m.data,'$.body')) AS total_chars FROM memories m WHERE m.id=?`).get(offset+1,limit,id);
        if(!row)throw failure('MEMORY_CATALOG_NOT_FOUND','没有找到这份当前记忆。');
        const value=document(row);
        if(after&&after.revision!==row.revision)throw failure('MEMORY_CATALOG_CHANGED','记忆已更新，请从正文第一页重新读取。');
        if(offset>row.total_chars)throw failure('MEMORY_CATALOG_CURSOR_INVALID','正文分页位置已超出当前文档。');
        let body=row.body.slice(0,limit);
        if(body&&/[\uD800-\uDBFF]/.test(body.at(-1)))body=body.slice(0,-1);
        // A budget of one UTF-16 unit cannot carry an astral character. Advance
        // only when a complete code point fits, rather than looping forever.
        if(!body&&row.body)throw failure('MEMORY_CATALOG_LIMIT_INVALID','正文页长度过小，请至少使用 2 个字符单位。');
        const next=offset+Array.from(body).length;
        return {...value,body,offset,total_chars:row.total_chars,char_units:'unicode-codepoints',next_cursor:next<row.total_chars?encode({type:'body',id,revision:row.revision,offset:next}):null};
      });
    },
    close(){if(!closed){closed=true;db?.close();}},
  };
}
