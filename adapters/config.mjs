import {fileURLToPath} from 'node:url';
import {adapterError,connectionOptions} from './runtime.mjs';

const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
const toml=value=>JSON.stringify(value);

/** Return artifacts only. Never discover or edit a client's HOME/config/trust files. */
export function generateConfig(options={}){
  const {root,readOnly}=connectionOptions(options),client=options.client||'both',section=options.section||'all';
  if(!['codex','claude','both'].includes(client))throw adapterError('MEMORY_CLIENT_INVALID','config --client 必须为 codex、claude 或 both。');
  if(!['mcp','hooks','all'].includes(section))throw adapterError('MEMORY_CONFIG_SECTION_INVALID','config --section 必须为 mcp、hooks 或 all。');
  const cli=fileURLToPath(new URL('../bin/bernard-mem.mjs',import.meta.url));
  const base=['--root',root,...(readOnly?['--read-only']:[])];
  const hookCommand=target=>[process.execPath,cli,'hook',...base,'--client',target].map(quote).join(' ');
  const hook=target=>({hooks:[{type:'command',command:hookCommand(target),timeout:10}]});
  const mcpServers={'bernard-mem':{type:'stdio',command:process.execPath,args:[cli,'mcp',...base,'--client','claude'],
    env:{BERNARD_MEM_MEMORY_ROOT:root,BERNARD_MEM_READ_ONLY:String(readOnly)}}};
  const hooks={SessionStart:[hook('claude')],SubagentStart:[hook('claude')]};
  // Claude uses separate native MCP (--mcp-config/.mcp.json) and hook settings files.
  // "all" is a sections export, not a single installable native settings document.
  const claude={...(section!=='hooks'?{mcpServers}:{}),...(section!=='mcp'?{hooks}:{})};
  const codex=[
    '# Bernard-mem generated artifact: merge only the desired sections into your selected native config.',
    '# No hook trust hashes are enrolled. The client/user must approve hooks through its native flow.',
    '# Hook commands below use POSIX shell quoting; regenerate/adapt explicitly for other shells.',
    ...(section!=='mcp'?['[features]','hooks = true','']:[]),
    ...(section!=='hooks'?['[mcp_servers.bernard-mem]',`command = ${toml(process.execPath)}`,`args = ${toml([cli,'mcp',...base,'--client','codex'])}`,'',
      '[mcp_servers.bernard-mem.env]',`BERNARD_MEM_MEMORY_ROOT = ${toml(root)}`,`BERNARD_MEM_READ_ONLY = ${toml(String(readOnly))}`,'']:[]),
    ...(section!=='mcp'?['SessionStart','SubagentStart'].flatMap(event=>[`[[hooks.${event}]]`,`[[hooks.${event}.hooks]]`,'type = "command"',`command = ${toml(hookCommand('codex'))}`,'timeout = 10','']):[])
  ].join('\n');
  if(client==='codex')return {format:'toml',content:codex};
  if(client==='claude')return {format:section==='all'?'json-sections':'json',content:JSON.stringify(claude,null,2)+'\n'};
  return {format:'json-bundle',content:JSON.stringify({memory_root:root,read_only:readOnly,section,
    note:'This is an export bundle, not a native config file. Export --client codex for TOML sections. For Claude use --section mcp for MCP JSON and --section hooks for settings JSON. Both use this exact root; hook trust is unchanged.',
    codex:{format:'toml',content:codex},claude:{format:section==='all'?'json-sections':'json',content:claude}},null,2)+'\n'};
}
