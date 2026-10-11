import {constants} from 'node:fs';
import {copyFile,lstat,mkdir,open,readFile,realpath,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,compileRecipe,sha256Value} from '../../../packages/creative-engine/src/recipe.js';
import type {RenderPlan,RenderOutput,TechnicalQa} from '../../../packages/creative-contracts/src/index.js';
import {atomicJson,checkDataRoot,type WorkerConfig} from './config.js';
import {hashFile,MAX_ASSET_BYTES} from './materialize.js';
import {maintainCache} from './cache.js';

const qaCodes=['VIDEO_CODEC','AUDIO_CODEC','GEOMETRY','FRAME_RATE','DURATION','AUDIO_SAMPLE_RATE','AUDIO_PRESENT','AUDIO_VIDEO_PTS','BLACK_FRAMES','LONG_SILENCE','AUDIO_PEAK','EXPORTED_AUDIO_ALIGNMENT'];
type Raster=Omit<RenderOutput,'path'>;
interface Entry {schema_version:1;identity:string;files:Raster[];qa:TechnicalQa;}
const sha=/^[a-f0-9]{64}$/;
function currentQa(qa:TechnicalQa){return qa?.status==='PASS'&&Array.isArray(qa.checks)&&qa.checks.length===qaCodes.length&&qaCodes.every(code=>qa.checks.some(c=>c?.code===code&&c.passed===true))&&qa.checks.some(c=>c?.code==='EXPORTED_AUDIO_ALIGNMENT'&&(c.actual as {method?:string})?.method==='reference-output-waveform-pearson-prominence-1000hz-v1');}
function identity(config:WorkerConfig,plan:RenderPlan){
 // An optional cache cannot authorize a plan. The engine repeats this full gate.
 if(!config.deviceId||!config.workspaceId||plan?.platform!==`${process.platform}-${process.arch}`)return null;
 try{const checked=compileRecipe(plan.recipe,{platform:plan.platform,inputApproval:plan.input_approval,authorization:plan.authorization,assets:plan.asset_attestations,playbookIntake:plan.playbook_intake});if(canonicalJson(checked)!==canonicalJson(plan))return null;}catch{return null;}
 return sha256Value({origin:config.apiOrigin,workspace:config.workspaceId,device:config.deviceId,platform:plan.platform,engine:plan.engine_version,remotion:plan.remotion_version,render:plan.fingerprints.render});
}
async function directory(root:string,...parts:string[]){let current=root;if(await realpath(root)!==root)throw Error('RENDER_CACHE_UNSAFE_ROOT');for(const part of parts){current=path.join(current,part);await mkdir(current,{mode:0o700}).catch((e:any)=>{if(e.code!=='EEXIST')throw e;});const s=await lstat(current);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(current)!==current)throw Error('RENDER_CACHE_UNSAFE_PATH');}return current;}
async function regular(root:string,file:string){const relative=path.relative(root,file);if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||await realpath(file)!==file)throw Error('RENDER_CACHE_UNSAFE_PATH');const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('RENDER_CACHE_UNSAFE_PATH');return s;}
async function verified(root:string,file:string,expected:Raster){try{const s=await regular(root,file);return s.size===expected.sizeBytes&&await hashFile(file)===expected.sha256;}catch(e:any){if(e.code==='ENOENT')return false;throw e;}}
async function clone(root:string,source:string,target:string,expected:Raster){
 if(!await verified(root,source,expected))return false;
 try{if(await verified(root,target,expected))return true;await lstat(target);return false;}catch(e:any){if(e.code!=='ENOENT')throw e;}
 const temp=target+'.'+randomUUID()+'.tmp';
 try{await copyFile(source,temp,constants.COPYFILE_EXCL);if(!await verified(root,temp,expected))return false;await rename(temp,target);return await verified(root,target,expected);}finally{await unlink(temp).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});}
}
async function locked<T>(config:WorkerConfig,operation:()=>Promise<T>):Promise<T|false>{
 await checkDataRoot(config);const lockPath=path.join(config.dataRoot,'.render-cache.lock');let lock;
 try{lock=await open(lockPath,'wx',0o600);}catch(e:any){if(e.code!=='EEXIST')throw e;const s=await lstat(lockPath);if(!s.isFile()||s.isSymbolicLink()||s.size>256)throw Error('RENDER_CACHE_UNSAFE_LOCK',{cause:e});const old=JSON.parse(await readFile(lockPath,'utf8'));if(!Number.isInteger(old.pid)||old.pid<1)throw Error('RENDER_CACHE_UNSAFE_LOCK',{cause:e});try{process.kill(old.pid,0);return false;}catch(stopped:any){if(stopped.code!=='ESRCH')return false;}await unlink(lockPath);try{lock=await open(lockPath,'wx',0o600);}catch(race:any){if(race.code==='EEXIST')return false;throw race;}}
 try{await lock.writeFile(JSON.stringify({pid:process.pid}));return await operation();}finally{await lock.close();await unlink(lockPath);}
}
/** Cache entries contain disposable copies, never paths to prior job outputs or R2 objects. */
export async function restoreRenderCache(config:WorkerConfig,plan:RenderPlan,workRoot:string){
 const key=identity(config,plan);if(!key)return false;
 return locked(config,async()=>{
  const cache=await directory(config.dataRoot,'cache'),index=path.join(cache,`render-${key}.json`);let entry:Entry;
  try{if((await regular(config.dataRoot,index)).size>65536)return false;entry=JSON.parse(await readFile(index,'utf8'));}catch(e:any){if(e.code==='ENOENT'||e instanceof SyntaxError)return false;throw e;}
  if(!entry||entry.schema_version!==1||entry.identity!==key||!currentQa(entry.qa)||!Array.isArray(entry.files)||entry.files.length!==2||entry.files.some(f=>!f||!['master','preview'].includes(f.kind)||!sha.test(f.sha256)||f.contentType!=='video/mp4'||!Number.isSafeInteger(f.sizeBytes)||f.sizeBytes<1||f.sizeBytes>MAX_ASSET_BYTES)||new Set(entry.files.map(f=>f.kind)).size!==2)return false;
  for(const file of entry.files)if(!await verified(config.dataRoot,path.join(cache,`derived-${file.sha256}`),file))return false;
  const free=(await checkDataRoot(config)).freeBytes,bytes=entry.files.reduce((n,f)=>n+f.sizeBytes,0);if(free<config.reserveBytes+2*bytes)return false;
  const relative=path.relative(config.dataRoot,workRoot).split(path.sep);if(relative.length!==2||relative[0]!=='jobs'||relative[1].startsWith('.')||!relative[1])throw Error('RENDER_CACHE_UNSAFE_ATTEMPT');
  await directory(config.dataRoot,...relative);const local=await directory(config.dataRoot,...relative,'cache');const files:RenderOutput[]=[];
  for(const file of entry.files){const target=path.join(local,`derived-${file.sha256}`);if(!await clone(config.dataRoot,path.join(cache,`derived-${file.sha256}`),target,file))return false;files.push({...file,path:target});}
  await atomicJson(path.join(local,`render-${plan.fingerprints.render}.json`),{files,qa:entry.qa});return true;
 });
}
export async function rememberRenderCache(config:WorkerConfig,plan:RenderPlan,workRoot:string,output:{files:RenderOutput[];qa:TechnicalQa}){
 const key=identity(config,plan);if(!key||!currentQa(output.qa))return false;
 const rasters=output.files.filter(f=>f.kind==='master'||f.kind==='preview');if(rasters.length!==2||new Set(rasters.map(f=>f.kind)).size!==2)return false;
 return locked(config,async()=>{
  const cache=await directory(config.dataRoot,'cache');for(const file of rasters){if(!sha.test(file.sha256)||!Number.isSafeInteger(file.sizeBytes)||file.sizeBytes<1||file.sizeBytes>MAX_ASSET_BYTES||file.contentType!=='video/mp4'||!await verified(workRoot,file.path,file))return false;}
  const entry:Entry={schema_version:1,identity:key,files:rasters.map(({path:_path,...file})=>file),qa:output.qa};const bytes=rasters.reduce((n,f)=>n+f.sizeBytes,0)+Buffer.byteLength(JSON.stringify(entry,null,2));
  if(bytes>config.cacheBytes||(await checkDataRoot(config)).freeBytes<config.reserveBytes+2*bytes)return false;
  // Input blobs, raster copies and indexes share the same configured cache quota.
  const usage=await maintainCache(config.dataRoot,config.cacheBytes-bytes,plan.recipe.assets.map(a=>a.sha256));if(usage.bytes>config.cacheBytes-bytes)return false;
  for(const file of rasters)if(!await clone(config.dataRoot,file.path,path.join(cache,`derived-${file.sha256}`),file))return false;
  await atomicJson(path.join(cache,`render-${key}.json`),entry);await maintainCache(config.dataRoot,config.cacheBytes,plan.recipe.assets.map(a=>a.sha256));return true;
 });
}
