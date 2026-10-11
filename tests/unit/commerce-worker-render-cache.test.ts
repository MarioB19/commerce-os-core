import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,readdir,realpath,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {WorkerRuntime} from '../../apps/commerce-worker/src/runtime.js';
import {configure} from '../../apps/commerce-worker/src/config.js';
import {Journal,type LocalAttempt} from '../../apps/commerce-worker/src/journal.js';
import {hashFile} from '../../apps/commerce-worker/src/materialize.js';
import {maintainCache,cacheHints} from '../../apps/commerce-worker/src/cache.js';
import {restoreRenderCache} from '../../apps/commerce-worker/src/render-cache.js';
import {compileRecipe,sha256Value,alignmentSha256} from '../../packages/creative-engine/src/recipe.js';
import {renderRecipe} from '../../packages/creative-engine/src/render.js';
import {PACKAGED_FONT} from '../../packages/creative-engine/src/font.js';
import type {CreativeRecipe,RenderPlan,RenderResult,RenderOutput,TechnicalQa} from '../../packages/creative-contracts/src/index.js';

const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
const qa:TechnicalQa={status:'PASS',checks:['VIDEO_CODEC','AUDIO_CODEC','GEOMETRY','FRAME_RATE','DURATION','AUDIO_SAMPLE_RATE','AUDIO_PRESENT','AUDIO_VIDEO_PTS','BLACK_FRAMES','LONG_SILENCE','AUDIO_PEAK','EXPORTED_AUDIO_ALIGNMENT'].map(code=>({code,passed:true,actual:code==='EXPORTED_AUDIO_ALIGNMENT'?{method:'reference-output-waveform-pearson-prominence-1000hz-v1'}:'IDENTIFIED_FIXTURE',expected:'IDENTIFIED_FIXTURE'})),editorial_review:'PENDING',production_approval:'PENDING',checked_at:new Date().toISOString()};
function recipe():CreativeRecipe{
 const words=[{text:'Material',startFrame:0,endFrame:15,chunkId:'c1'},{text:'propio',startFrame:16,endFrame:29,chunkId:'c1'}],image={asset_id:'image-one',sha256:hash('image'),media_type:'image/png' as const,bytes:5},voice={asset_id:'voice-one',sha256:hash('voice'),media_type:'audio/wav' as const,bytes:5};
 return{id:'recipe-one',recipe_version:1,engine_version:'1.0.0',product_id:'product-one',offer_id:'offer-one',offer_version:1,language:'es-MX',format:'faceless-narrative',width:1080,height:1920,fps:30,duration_frames:900,content:{product_name:'Producto fixture',audience:'Docentes',angle:'Organización',hook:'Material propio',body:'Material propio',cta:'Solicita información',ad_copy:{primary_text:'Material propio',headline:'Material propio',description:'Material propio',whatsapp_message:'Información'},source_ids:['source-one']},scenes:[{id:'scene-one',asset_id:image.asset_id,kind:'image',start_frame:0,duration_frames:900,trim_before_frames:0,role:'product',fit:'contain',motion:'none',source_ids:['source-one']}],voice:{mode:'supplied',asset:voice,transcript:'Material propio',alignment_sha256:alignmentSha256(words),alignment_status:'VERIFIED',alignment_source:{source_id:'source-one',sha256:hash('source'),locator:'fixture alignment'}},captions:{words,max_words_per_card:4,style:'kinetic-pop'},font:PACKAGED_FONT,palette:{background:'#111111',foreground:'#ffffff',accent:'#ffcc00'},assets:[image,voice],claims:[],sources:[{source_id:'source-one',sha256:hash('source'),locator:'fixture'}],excluded_claims:[]};
}
function plan(r:CreativeRecipe):RenderPlan{const sha=sha256Value(r);return compileRecipe(r,{platform:`${process.platform}-${process.arch}`,inputApproval:{status:'APPROVED',recipe_sha256:sha,actor_id:'fixture-owner',authority:'DELEGATED_PILOT',source_reference:'Isolated cache test',approved_at:new Date(Date.now()-1000).toISOString()},authorization:{authorization_id:randomUUID(),recipe_sha256:sha,recipe_version:r.recipe_version,authority:'DELEGATED_PILOT',source_reference:'Isolated cache test',expires_at:new Date(Date.now()+3600000).toISOString()},assets:r.assets.map(a=>({...a,state:'READY' as const,permission:'ALLOWED' as const,source_reference:'Isolated fixture bytes'}))});}
async function setup(){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'worker-derivatives-')));roots.push(root);vi.stubEnv('COMMERCE_WORKER_PRIVATE_DIR',path.join(root,'private'));vi.stubEnv('COMMERCE_RUNTIME_RESOURCES',root);
 const config=await configure('https://fixture.example',path.join(root,'data'));config.deviceId='device-one';config.workspaceId='workspace-one';
 await mkdir(path.join(config.dataRoot,'cache'));for(const text of ['image','voice','other-image','other-voice'])await writeFile(path.join(config.dataRoot,'cache',hash(text)),text);
 await writeFile(path.join(root,'engine-resources.json'),JSON.stringify({browser:'fixture-browser',ffmpeg:'fixture-ffmpeg',ffprobe:'fixture-ffprobe'}));
 const calls:any[]=[],workRoots:string[]=[],results:RenderResult[]=[];let computed=0;
 // Only expensive media computation is a named fixture. The second attempt uses
 // the real engine cache/gates/QA/hash/copy/manifest implementation, via WorkerRuntime.
 const engine=async(p:RenderPlan,o:any):Promise<RenderResult>=>{
  compileRecipe(p.recipe,{platform:p.platform,inputApproval:p.input_approval,authorization:p.authorization,assets:p.asset_attestations});workRoots.push(o.workRoot);
  if((await readdir(path.join(o.workRoot,'cache')).catch(():string[]=>[])).includes(`render-${p.fingerprints.render}.json`)){const result=await renderRecipe(p,o);results.push(result);return result;}
  computed++;const outputRoot=path.join(o.workRoot,'jobs',randomUUID());await mkdir(outputRoot,{recursive:true});const files:RenderOutput[]=[];
  for(const kind of ['master','preview','captions','copy','manifest'] as const){const file=path.join(outputRoot,kind),bytes=kind==='manifest'?JSON.stringify({recipe_sha256:p.recipe_sha256,reused_render:false}):kind==='copy'?JSON.stringify(p.recipe.content.ad_copy):`IDENTIFIED_MEDIA_FIXTURE:${kind}:${p.fingerprints.render}`;await writeFile(file,bytes);files.push({kind,path:file,sha256:hash(bytes),sizeBytes:Buffer.byteLength(bytes),contentType:['master','preview'].includes(kind)?'video/mp4':'application/json'});}
  o.onProgress?.({step:'render',progress:1});const result:RenderResult={files,qa,recipe_sha256:p.recipe_sha256,fingerprints:p.fingerprints,reused:false,elapsed_ms:1};results.push(result);return result;
 };
 const worker=new WorkerRuntime(engine,{resources:async()=>({blockers:[]}) as any,memory:async()=>({memoryBytes:8*1024**3,freeMemoryBytes:4*1024**3,availableMemoryBytes:4*1024**3,memoryPressure:'NORMAL',memoryStatusSource:'IDENTIFIED_FIXTURE'})}) as any;worker.config=config;worker.journal=new Journal(config.dataRoot);worker.api={call:async(route:string,body:any)=>{calls.push({route,body});if(route==='/creative-device/v1/uploads')return{status:'READY',assetId:randomUUID()};if(route.includes('/assets/'))throw Error('FIXTURE_INPUT_NOT_AVAILABLE');return{status:'REVIEW'};}};
 async function execute(p:RenderPlan){const attempt:LocalAttempt={jobId:randomUUID(),attemptId:randomUUID(),fence:1,leaseExpiresAt:new Date(Date.now()+90000).toISOString(),phase:'MATERIALIZING',claim:{plan:p,assets:p.recipe.assets.map(a=>({assetId:a.asset_id,sha256:a.sha256,sizeBytes:a.bytes,contentType:a.media_type}))},updatedAt:''};await worker.execute(attempt);return attempt;}
 return{root,config,calls,results,workRoots,execute,computed:()=>computed};
}
describe('One device reuses pure raster derivatives across distinct WorkerRuntime attempts',()=>{
 it('copy-only change reuses verified master/preview and regenerates copy/manifest under the new attempt',async()=>{
  const f=await setup(),r=recipe(),first=await f.execute(plan(r));const changed=structuredClone(r);changed.recipe_version++;changed.content.ad_copy.headline='Otro titular';const second=await f.execute(plan(changed));
  expect([first.phase,second.phase]).toEqual(['DONE','DONE']);expect(first.attemptId).not.toBe(second.attemptId);expect(f.workRoots[0]).not.toBe(f.workRoots[1]);expect(f.computed()).toBe(1);expect(f.results.map(r=>r.reused)).toEqual([false,true]);
  for(const kind of ['master','preview']){const a=first.outputs!.find(f=>f.kind===kind)!,b=second.outputs!.find(f=>f.kind===kind)!;expect(a.sha256).toBe(b.sha256);expect(a.path).not.toBe(b.path);expect(b.path.startsWith(f.workRoots[1]+path.sep)).toBe(true);expect(await hashFile(a.path)).toBe(a.sha256);}
  expect(first.outputs!.find(f=>f.kind==='copy')!.sha256).not.toBe(second.outputs!.find(f=>f.kind==='copy')!.sha256);expect(second.manifest).toMatchObject({recipe_version:2,reused_render:true,editorial_review:'PENDING',production_approval:'PENDING',provider_consumption:{new_operations:0}});
  expect(f.calls.filter(c=>c.route==='/creative-device/v1/complete')).toHaveLength(2);expect(f.calls.some(c=>c.route==='/creative-device/v1/step'&&c.body.step==='reuse-render'&&c.body.status==='COMPLETED')).toBe(true);expect(await cacheHints(f.config.dataRoot)).not.toContain(first.outputs![0].sha256);
 });
 it.each(['image','voice'])('%s change invalidates raster reuse across two attempts',async kind=>{
  const f=await setup(),r=recipe();await f.execute(plan(r));const changed=structuredClone(r);changed.recipe_version++;const asset=changed.assets.find(a=>a.asset_id===kind+'-one')!;asset.sha256=hash('other-'+kind);asset.bytes=Buffer.byteLength('other-'+kind);if(kind==='voice')changed.voice.asset={...asset};const next=await f.execute(plan(changed));expect(next.phase).toBe('DONE');expect(f.computed()).toBe(2);expect(f.results[1].reused).toBe(false);expect(f.results[0].files[0].sha256).not.toBe(f.results[1].files[0].sha256);
 });
 it('invalid input approval cannot seed or use cached rasters',async()=>{
  const f=await setup(),r=recipe();await f.execute(plan(r));r.recipe_version++;const p=plan(r);p.input_approval.recipe_sha256='0'.repeat(64);const next=await f.execute(p);expect(next.error).toBe('RECIPE_BLOCKED');expect(f.computed()).toBe(1);expect(f.calls.filter(c=>c.route==='/creative-device/v1/complete')).toHaveLength(1);
 });
 it.each(['bytes','qa','scope'])('a corrupt or mismatched %s cache misses without reusing it',async fault=>{
  const f=await setup(),r=recipe(),first=await f.execute(plan(r)),cache=path.join(f.config.dataRoot,'cache');
  if(fault==='bytes')await writeFile(path.join(cache,'derived-'+first.outputs![0].sha256),'CORRUPTED');
  if(fault==='qa'){const index=(await readdir(cache)).find(n=>n.startsWith('render-'))!,entry=JSON.parse(await readFile(path.join(cache,index),'utf8'));entry.qa.checks[0].passed=false;await writeFile(path.join(cache,index),JSON.stringify(entry));}
  if(fault==='scope')f.config.deviceId='another-device';
  r.recipe_version++;r.content.ad_copy.headline='Changed copy';const next=await f.execute(plan(r));expect(next.phase).toBe('DONE');expect(f.computed()).toBe(2);expect(f.results[1].reused).toBe(false);
 });
 it('quota eviction removes only cache copies and indexes, preserving both attempts and downloaded source protection',async()=>{
  const f=await setup(),r=recipe(),first=await f.execute(plan(r));r.recipe_version++;r.content.ad_copy.headline='Changed copy';const second=await f.execute(plan(r)),usage=await maintainCache(f.config.dataRoot,10,[hash('image'),hash('voice')]);expect(usage.bytes).toBe(10);
  for(const attempt of [first,second])for(const file of attempt.outputs!)expect(await hashFile(file.path)).toBe(file.sha256);expect(await readdir(path.join(f.config.dataRoot,'cache'))).toEqual(expect.arrayContaining([hash('image'),hash('voice')]));
  f.config.cacheBytes=10;r.recipe_version++;await f.execute(plan(r));expect((await maintainCache(f.config.dataRoot,10,[hash('image'),hash('voice')])).bytes).toBe(10);
 });
 it('refuses a symlinked cache before reading or writing outside the data root',async()=>{
  const f=await setup(),p=plan(recipe());await f.execute(p);await rm(path.join(f.config.dataRoot,'cache'),{recursive:true});const outside=path.join(f.root,'outside');await mkdir(outside);await symlink(outside,path.join(f.config.dataRoot,'cache'),process.platform==='win32'?'junction':'dir');await expect(restoreRenderCache(f.config,p,path.join(f.config.dataRoot,'jobs',randomUUID()))).rejects.toThrow('RENDER_CACHE_UNSAFE_PATH');expect(await readdir(outside)).toEqual([]);
 });
 it('preserves a live cache lock and recovers a lock left by a dead process',async()=>{
  const f=await setup(),p=plan(recipe());await f.execute(p);const lock=path.join(f.config.dataRoot,'.render-cache.lock');await writeFile(lock,JSON.stringify({pid:process.pid}));expect(await restoreRenderCache(f.config,p,path.join(f.config.dataRoot,'jobs',randomUUID()))).toBe(false);expect(JSON.parse(await readFile(lock,'utf8')).pid).toBe(process.pid);await writeFile(lock,JSON.stringify({pid:2147483647}));expect(await restoreRenderCache(f.config,p,path.join(f.config.dataRoot,'jobs',randomUUID()))).toBe(true);await expect(readFile(lock)).rejects.toMatchObject({code:'ENOENT'});
 });
});
