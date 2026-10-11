import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const [packagePath,tokenFile,baselineFile,output]=process.argv.slice(2);
const client=new Client({name:'continuity-read-only-verification',version:'1.0.0'});
const report={at:new Date().toISOString(),transport:'STDIO_TO_HTTPS',mutations:0,accounts:[]};
try{
 await client.connect(new StdioClientTransport({command:join(packagePath,'node'),args:[join(packagePath,'mcp.mjs')],env:{COMMERCE_API_ORIGIN:'https://commerce-os.inovaris.online',COMMERCE_MCP_TOKEN_FILE:tokenFile},stderr:'pipe'}));
 const list=await client.listTools();report.tool_count=list.tools.length;
 report.continuity_tools=['channel_session_get','channel_session_configure','channel_primary_usage','channel_session_recovery','channel_command','command_get'];
 for(const name of report.continuity_tools)assert(list.tools.some(v=>v.name===name));
 const baseline=JSON.parse(readFileSync(baselineFile,'utf8'));
 for(const account of baseline.accounts){const result=await client.callTool({name:'channel_session_get',arguments:{account_id:account.id,environment:'REAL'}});assert(!result.isError);const text=result.content.find(v=>v.type==='text')?.text;const decoded=JSON.parse(text),data=decoded.data??decoded;assert.equal(data.recovery_enabled,false);assert.equal(data.sending_enabled,false);report.accounts.push({account_id:account.id,desired_state:data.desired_state,recovery_enabled:data.recovery_enabled,sending_enabled:data.sending_enabled});}
 report.status='VERIFIED';
}catch{report.status='FAILED';process.exitCode=1;}finally{await client.close();writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));}
