import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {readFile,lstat} from 'node:fs/promises';
import {createProfileMcp} from './profile-server.js';
import {createPlatformMcp} from './platform-server.js';
/** V7 MCP entrypoint (RF-15). A personal access token (cos_pat_) opens the
 * composed profile server; a platform token (cos_plt_) the platform server.
 * The historical service-token server was retired in F8: any other token is
 * rejected before a tool is registered. */
async function main(){
 const origin=process.env.COMMERCE_API_ORIGIN,tokenFile=process.env.COMMERCE_MCP_TOKEN_FILE;if(!origin||!tokenFile)throw Error('MCP_CONFIGURATION_REQUIRED');
 const s=await lstat(tokenFile);if(s.isSymbolicLink()||!s.isFile()||(process.platform!=='win32'&&(s.mode&0o077)!==0))throw Error('MCP_TOKEN_PERMISSIONS');
 const token=(await readFile(tokenFile,'utf8')).trim();if(token.length<16||token.length>4096)throw Error('MCP_TOKEN_INVALID');
 const server=token.startsWith('cos_pat_')?createProfileMcp(origin,token):token.startsWith('cos_plt_')?createPlatformMcp(origin,token):undefined;
 if(!server)throw Error('MCP_PROFILE_TOKEN_REQUIRED');
 await server.connect(new StdioServerTransport());
}
main().catch(e=>{process.stderr.write((/^[A-Z0-9_]+$/.test(e.message)?e.message:'MCP_START_FAILED')+'\n');process.exitCode=1;});
