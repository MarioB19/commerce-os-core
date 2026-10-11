import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {readFile,lstat} from 'node:fs/promises';
import {CommerceApi} from '../../../packages/commerce-client/src/index.js';
import {createCommerceMcp} from './server.js';
async function main(){const origin=process.env.COMMERCE_API_ORIGIN,tokenFile=process.env.COMMERCE_MCP_TOKEN_FILE;if(!origin||!tokenFile)throw Error('MCP_CONFIGURATION_REQUIRED');const s=await lstat(tokenFile);if(s.isSymbolicLink()||!s.isFile()||(process.platform!=='win32'&&(s.mode&0o077)!==0))throw Error('MCP_TOKEN_PERMISSIONS');const token=(await readFile(tokenFile,'utf8')).trim();if(token.length<16||token.length>4096)throw Error('MCP_TOKEN_INVALID');const server=createCommerceMcp(new CommerceApi(origin,token));await server.connect(new StdioServerTransport());}
main().catch(e=>{process.stderr.write((/^[A-Z0-9_]+$/.test(e.message)?e.message:'MCP_START_FAILED')+'\n');process.exitCode=1;});
