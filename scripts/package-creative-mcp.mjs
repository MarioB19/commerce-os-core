// Build-only: an independent private MCP package. Does not edit the installed desktop runtime.
import {build} from 'esbuild';
import {createHash,sign,verify} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,lstat,readFile,writeFile,copyFile,chmod,readdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const flags=Object.fromEntries(process.argv.slice(2).reduce((out,value,i,all)=>i%2===0?[...out,[value.replace(/^--/,''),all[i+1]]]:out,[]));
const platform=`${process.platform}-${process.arch}`,expectedNode={'darwin-arm64':'9d050fd455b56426e25d4d603c7c501cbb2630348e836cf221dcce748e90588a','win32-x64':'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'}[platform];
if(!expectedNode||!process.versions.node.startsWith('24.'))throw Error('MCP_NATIVE_NODE_24_REQUIRED');
for(const key of ['output','base-package','private-key-file','public-key-file'])if(!flags[key]||!path.isAbsolute(flags[key]))throw Error('MCP_ABSOLUTE_BUILD_PATH_REQUIRED');
const relevant=['apps/commerce-mcp','packages/commerce-client','scripts/package-creative-mcp.mjs','pnpm-lock.yaml'];
if(execFileSync('git',['status','--porcelain','--',...relevant],{cwd:repo,encoding:'utf8'}).trim())throw Error('MCP_COMMITTED_SOURCE_REQUIRED');
const sourceSha=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
if(!/^[a-f0-9]{40}$/.test(sourceSha))throw Error('MCP_SOURCE_SHA_REQUIRED');
const declaredSdk=JSON.parse(await readFile(path.join(repo,'apps/commerce-mcp/package.json'),'utf8')).dependencies?.['@modelcontextprotocol/sdk'];
const installedSdk=JSON.parse(await readFile(path.join(repo,'apps/commerce-mcp/node_modules/@modelcontextprotocol/sdk/package.json'),'utf8'));
if(installedSdk.name!=='@modelcontextprotocol/sdk'||!/^\d+\.\d+\.\d+$/.test(installedSdk.version??'')||installedSdk.version!==declaredSdk)throw Error('MCP_SDK_VERSION_MISMATCH');
const target=flags.output,base=flags['base-package'],nodeName=process.platform==='win32'?'node.exe':'node';
async function hash(file){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
const node=path.join(base,nodeName);if(!(await lstat(node)).isFile()||(await lstat(node)).isSymbolicLink()||await hash(node)!==expectedNode)throw Error('MCP_BASE_NODE_HASH_INVALID');
const keyStat=await lstat(flags['private-key-file']);if(!keyStat.isFile()||keyStat.isSymbolicLink()||(process.platform!=='win32'&&(keyStat.mode&0o077)))throw Error('MCP_SIGNING_KEY_PERMISSIONS');
const privateKey=await readFile(flags['private-key-file'],'utf8'),publicKey=await readFile(flags['public-key-file'],'utf8');
await mkdir(target,{recursive:false,mode:0o700});
await copyFile(node,path.join(target,nodeName));await chmod(path.join(target,nodeName),0o700);
await build({entryPoints:[path.join(repo,'apps/commerce-mcp/src/index.ts')],outfile:path.join(target,'mcp.mjs'),bundle:true,platform:'node',target:'node24',format:'esm',sourcemap:false,banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"}});
await copyFile(path.join(base,'LICENSE-node.txt'),path.join(target,'LICENSE-node.txt'));
await copyFile(path.join(repo,'apps/commerce-mcp/node_modules/@modelcontextprotocol/sdk/LICENSE'),path.join(target,'LICENSE-mcp-sdk.txt'));
await writeFile(path.join(target,'release-public.pem'),publicKey,{mode:0o600});
await writeFile(path.join(target,'README.txt'),'Private Commerce OS MCP over STDIO. Use the included Node executable and mcp.mjs with COMMERCE_API_ORIGIN=https://commerce-os.inovaris.online and COMMERCE_MCP_TOKEN_FILE pointing to a private 0600 scoped token file. No Chromium, FFmpeg, render runtime or provider credentials are included. Verify mcp-release.json and mcp-release.sig against the previously trusted public key before installing. The MCP signing manifest is distinct from desktop update manifests.\n',{mode:0o600});
const files=[];for(const name of (await readdir(target)).sort()){await chmod(path.join(target,name),name===nodeName?0o700:0o600);files.push({path:name,sha256:await hash(path.join(target,name))});}
const manifest={schema_version:1,kind:'COMMERCE_MCP_STDIO',version:'5.0.0',platform,sourceSha,apiMin:1,apiMax:1,distribution:'PRIVATE_INTERNAL',node:{version:'24.20.0',sha256:expectedNode},sdk:installedSdk.version,engineIncluded:false,files};
const raw=JSON.stringify(manifest,null,2)+'\n',signature=sign(null,Buffer.from(raw),privateKey);if(!verify(null,Buffer.from(raw),publicKey,signature))throw Error('MCP_SIGNATURE_VERIFY_FAILED');
await writeFile(path.join(target,'mcp-release.json'),raw,{mode:0o600});await writeFile(path.join(target,'mcp-release.sig'),signature.toString('base64'),{mode:0o600});
for(const file of files)if(await hash(path.join(target,file.path))!==file.sha256)throw Error('MCP_FINAL_HASH_MISMATCH');
console.log(JSON.stringify({status:'SIGNED_PACKAGE_PREPARED',source_sha:sourceSha,platform,files:files.length,manifest_sha256:createHash('sha256').update(raw).digest('hex'),node_sha256:expectedNode,mcp_sha256:files.find(f=>f.path==='mcp.mjs').sha256,desktop_modified:false}));
