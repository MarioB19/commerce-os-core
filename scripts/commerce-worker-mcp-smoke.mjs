import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(process.env.COMMERCE_MCP_PACKAGE||`dist/commerce-mcp/${process.platform}-${process.arch}`);
if(!process.env.COMMERCE_MCP_TOKEN_FILE)throw Error('TOKEN_FILE_REQUIRED');
const transport=new StdioClientTransport({command:path.join(root,process.platform==='win32'?'node.exe':'node'),args:[path.join(root,'mcp.mjs')],env:{COMMERCE_API_ORIGIN:process.env.COMMERCE_API_ORIGIN||'https://commerce-os.inovaris.online',COMMERCE_MCP_TOKEN_FILE:process.env.COMMERCE_MCP_TOKEN_FILE},stderr:'pipe'});
const client=new Client({name:'commerce-release-stdio-acceptance',version:'1.0.0'});await client.connect(transport);const tools=await client.listTools();if(tools.tools.length!==8)throw Error('MCP_TOOL_COUNT');
let api='NOT_CALLED';if(process.env.COMMERCE_MCP_SMOKE_QUERY){const result=await client.callTool({name:'intelligence_search',arguments:{q:process.env.COMMERCE_MCP_SMOKE_QUERY,country:'MX'}});if(result.isError)throw Error('MCP_API_REQUEST_FAILED');api='LIVE_CACHE_SEARCH_PASSED';}
await client.close();const evidence={at:new Date().toISOString(),transport:'STDIO',client:'MCP SDK 1.30.0',platform:`${process.platform}-${process.arch}`,privateNode:true,tools:tools.tools.map(t=>t.name),api,desktopClient:'NOT_TESTED_BY_THIS_SCRIPT'};if(process.env.COMMERCE_MCP_EVIDENCE)await writeFile(process.env.COMMERCE_MCP_EVIDENCE,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
