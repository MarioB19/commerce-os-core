import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,verify} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {chmod,copyFile,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {createReadStream,existsSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const pinnedNode={'darwin-arm64':'9d050fd455b56426e25d4d603c7c501cbb2630348e836cf221dcce748e90588a','win32-x64':'5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5'}[`${process.platform}-${process.arch}`];
async function hash(file){const sum=createHash('sha256');for await(const bytes of createReadStream(file))sum.update(bytes);return sum.digest('hex');}

test('native MCP package signs the installed SDK version and all six files; mismatch emits no package',
 {skip:!pinnedNode||!process.versions.node.startsWith('24.')?'Requires a supported native MCP platform and Node24':false,timeout:60000},async()=>{
  assert.equal(await hash(process.execPath),pinnedNode,'Run with the repository-pinned official Node24.20.0 binary');
  const directory=await mkdtemp(path.join(os.tmpdir(),'commerce-mcp-package-test-'));
  const repo=path.join(directory,'fixture-repo'),base=path.join(directory,'base'),output=path.join(directory,'package');
  const privatePath=path.join(directory,'synthetic-private.pem'),publicPath=path.join(directory,'synthetic-public.pem');
  const command=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'}).toString().trim();
  try{
   await mkdir(path.join(repo,'scripts'),{recursive:true});await mkdir(path.join(repo,'apps/commerce-mcp/src'),{recursive:true});await mkdir(base);
   await copyFile(path.join(root,'scripts/package-creative-mcp.mjs'),path.join(repo,'scripts/package-creative-mcp.mjs'));
   await symlink(path.join(root,'node_modules'),path.join(repo,'node_modules'),process.platform==='win32'?'junction':'dir');
   await symlink(path.join(root,'apps/commerce-mcp/node_modules'),path.join(repo,'apps/commerce-mcp/node_modules'),process.platform==='win32'?'junction':'dir');
   const declared=JSON.parse(await readFile(path.join(root,'apps/commerce-mcp/package.json'),'utf8'));
   const installed=JSON.parse(await readFile(path.join(root,'apps/commerce-mcp/node_modules/@modelcontextprotocol/sdk/package.json'),'utf8'));
   await writeFile(path.join(repo,'apps/commerce-mcp/package.json'),JSON.stringify(declared));
   // A real SDK import exercises esbuild's installed dependency resolution.
   // No token, network transport or tool action exists in this isolated source.
   await writeFile(path.join(repo,'apps/commerce-mcp/src/index.ts'),"import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'; export const fixture=new McpServer({name:'synthetic-package',version:'1.0.0'});\n");
   await writeFile(path.join(repo,'.gitignore'),'node_modules/\n');
   await writeFile(path.join(repo,'package.json'),'{"type":"module"}\n');
   await writeFile(path.join(repo,'pnpm-lock.yaml'),'# Synthetic packaging fixture; no installation performed.\n');
   command('init','--quiet');command('add','.');command('-c','user.name=Packaging fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic package source');
   const source=command('rev-parse','HEAD');
   await copyFile(process.execPath,path.join(base,process.platform==='win32'?'node.exe':'node'));await writeFile(path.join(base,'LICENSE-node.txt'),'Synthetic fixture license marker; not a distribution.\n');
   const keys=generateKeyPairSync('ed25519');
   await writeFile(privatePath,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await chmod(privatePath,0o600);
   await writeFile(publicPath,keys.publicKey.export({type:'spki',format:'pem'}),{mode:0o600});
   const args=['scripts/package-creative-mcp.mjs','--output',output,'--base-package',base,'--private-key-file',privatePath,'--public-key-file',publicPath];
   const built=spawnSync(process.execPath,args,{cwd:repo,encoding:'utf8',timeout:30000});
   assert.equal(built.status,0,built.stderr);
   const manifestRaw=await readFile(path.join(output,'mcp-release.json')),manifest=JSON.parse(manifestRaw);
   assert.equal(manifest.sdk,installed.version);assert.equal(manifest.sdk,declared.dependencies['@modelcontextprotocol/sdk']);assert.equal(manifest.sourceSha,source);
   assert.equal(manifest.files.length,6);assert.deepEqual(manifest.files.map(file=>file.path).sort(),['LICENSE-mcp-sdk.txt','LICENSE-node.txt','README.txt','mcp.mjs',process.platform==='win32'?'node.exe':'node','release-public.pem'].sort());
   assert.equal(verify(null,manifestRaw,keys.publicKey,Buffer.from(await readFile(path.join(output,'mcp-release.sig'),'utf8'),'base64')),true);
   for(const file of manifest.files)assert.equal(await hash(path.join(output,file.path)),file.sha256,file.path);
   const negative=path.join(directory,'rejected-package');
   declared.dependencies['@modelcontextprotocol/sdk']='0.0.0';await writeFile(path.join(repo,'apps/commerce-mcp/package.json'),JSON.stringify(declared));
   command('add','apps/commerce-mcp/package.json');command('-c','user.name=Packaging fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m','Synthetic mismatch');
   const mismatch=spawnSync(process.execPath,args.map(value=>value===output?negative:value),{cwd:repo,encoding:'utf8',timeout:30000});
   assert.notEqual(mismatch.status,0);assert.match(mismatch.stderr,/MCP_SDK_VERSION_MISMATCH/);assert.equal(existsSync(negative),false);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
