import {randomUUID} from 'node:crypto';
import type {MemoryStore} from './memory.js';
import {documentId,page,textQuery,unicodeSlice} from './memory.js';
import {compileTopicExpression,validTopicName} from './query.js';
import {failure} from './errors.js';
export type MatterWrite={id:string;title:string;topics:string[];introduction:string;body:string;status:'pending'|'processing'|'paused'|'blocked'|'completed'|'cancelled'|'failed';refs?:string[]};
export function saveMatter(store:MemoryStore,input:MatterWrite,receipt:string=randomUUID()){
  store.writable();store.checkDocument(input);
  if(!['pending','processing','paused','blocked','completed','cancelled','failed'].includes(input.status))failure('MEMORY_STATUS_INVALID','事项状态无效。');
  if(input.refs&&(!Array.isArray(input.refs)||input.refs.some(ref=>typeof ref!=='string'||ref.length>2048)))failure('MEMORY_REFS_INVALID','事项引用需要有效字符串数组。');
  return store.transact(receipt,{op:'matter',input},()=>{const previous=store.db.prepare('SELECT data FROM matters WHERE id=?').get(input.id),old=previous?JSON.parse(String(previous.data)):undefined;
    const value={...input,topics:[...new Set(input.topics)].sort(),refs:input.refs||[],created:old?.created??Date.now(),updated:Date.now(),revision:(old?.revision||0)+1};
    store.db.prepare('INSERT INTO matters VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(input.id,JSON.stringify(value));return {id:input.id,revision:value.revision,saved:true};});
}
export function searchMatters(store:MemoryStore,query='',topics:string[]=[],offset=0,options:{expression?:string;status?:string}={}){return searchRecords(store,'matters',query,topics,offset,options);}
export function searchRecords(store:MemoryStore,table:'matters'|'assets',query:string,topics:string[],offset:number,options:{expression?:string;status?:string}={}){
  if(!Array.isArray(topics)||topics.some(topic=>!validTopicName(topic)))failure('MEMORY_TOPIC_INVALID','查询Topic必须是完整标签；布尔条件请使用expression。');
  if(!store.table(table))return {total:0,documents:[],next_offset:null};
  const parsed=compileTopicExpression(options.expression||topics.join(' & ')),words=textQuery(query),clauses=[parsed.sql,...words.map(()=>"instr(bernard_lower(m.id || ' ' || json_extract(m.data,'$.title') || ' ' || json_extract(m.data,'$.introduction') || ' ' || json_extract(m.data,'$.topics')),?)>0")];
  const params:(string|number)[]=[...parsed.params,...words];if(options.status){clauses.push("json_extract(m.data,'$.status')=?");params.push(options.status);}
  const where=clauses.join(' AND '),start=page(offset),total=Number(store.db.prepare(`SELECT count(*) AS n FROM ${table} m WHERE ${where}`).get(...params)!.n);
    const order=table==='matters'?"json_extract(m.data,'$.updated') DESC,m.id":"m.id";
    const documents=store.db.prepare(`SELECT data FROM ${table} m WHERE ${where} ORDER BY ${order} LIMIT 20 OFFSET ?`).all(...params,start).map(row=>{const {body,files,...metadata}=JSON.parse(String(row.data));return metadata;});
  return {total,documents,next_offset:start+20<total?start+20:null};
}
export function readMatter(store:MemoryStore,id:string,offset=0){documentId(id);page(offset);if(!store.table('matters'))failure('MEMORY_NOT_FOUND','事项记忆不存在。');const row=store.db.prepare('SELECT data FROM matters WHERE id=?').get(id);if(!row)failure('MEMORY_NOT_FOUND','事项记忆不存在。');const value=JSON.parse(String(row.data)),body=unicodeSlice(value.body,offset,10000);return {...value,body,next_offset:offset+body.length<value.body.length?offset+body.length:null};}
