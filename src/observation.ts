import {randomUUID} from 'node:crypto';
import type {MemoryStore} from './memory.js';
import {page} from './memory.js';
export type Observation={id?:string;operation:string;actor?:'ai'|'human'|'system';client?:string;session?:string;turn?:string;object_id?:string;entity?:string;revision?:number;offset?:number;length?:number;duration_ms?:number;status?:string;error_code?:string;prompt_hash?:string;prompt_version?:string;event?:string;count?:number};
export function recordEvent(store:MemoryStore,event:Observation){
  if(store.readOnly)return {recorded:false,reason:'read_only'};
  const id=event.id||randomUUID(),data:Record<string,string|number>={};
  for(const key of ['operation','actor','client','session','turn','object_id','entity','status','error_code','prompt_hash','prompt_version','event'] as const){const value=event[key];if(typeof value==='string')data[key]=value.slice(0,512);}
  for(const key of ['revision','offset','length','duration_ms','count'] as const){const value=event[key];if(typeof value==='number'&&Number.isFinite(value))data[key]=value;}
  data.operation=String(data.operation||'unknown');data.actor=['ai','human','system'].includes(String(data.actor))?String(data.actor):'system';
  const at=Date.now();store.db.prepare('INSERT OR IGNORE INTO memory_events VALUES(?,?,?,?,?)').run(id,at,data.operation,data.actor,JSON.stringify(data));return {recorded:true,id};
}
export function listEvents(store:MemoryStore,offset=0,filter:Record<string,string>={}){
  const start=page(offset);if(!store.table('memory_events'))return {events:[],next_offset:null};const where:string[]=[],params:string[]=[];
  for(const key of ['operation','actor','client','object_id','entity'])if(filter[key]){where.push(['operation','actor'].includes(key)?`${key}=?`:`json_extract(data,'$.${key}')=?`);params.push(filter[key]);}
  const rows=store.db.prepare(`SELECT id,at,data FROM memory_events ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY at DESC,id DESC LIMIT 51 OFFSET ?`).all(...params,start);
  return {events:rows.slice(0,50).map(row=>({id:row.id,at:row.at,...JSON.parse(String(row.data))})),next_offset:rows.length>50?start+50:null};
}
export function usageStats(store:MemoryStore){if(!store.table('memory_events'))return {ai_body_reads:[],operations:[]};
  return {ai_body_reads:store.db.prepare(`SELECT json_extract(data,'$.entity') AS entity,json_extract(data,'$.object_id') AS id,count(*) AS reads,max(at) AS last_read FROM memory_events WHERE operation='body_returned' AND actor='ai' AND json_extract(data,'$.status')='success' GROUP BY json_extract(data,'$.entity'),json_extract(data,'$.object_id') ORDER BY reads DESC,json_extract(data,'$.object_id') LIMIT 100`).all(),operations:store.db.prepare('SELECT operation,actor,count(*) AS count FROM memory_events GROUP BY operation,actor ORDER BY operation,actor').all()};}
