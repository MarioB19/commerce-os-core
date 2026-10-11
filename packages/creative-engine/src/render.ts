import {ENGINE_SOURCE_SHA256} from './engine-source.js';
import {writeBundleProvenance,verifyBundleProvenance} from './bundle-provenance.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RenderPlan, RenderResult, RenderOutput, TechnicalQa } from '../../creative-contracts/src/index.js';
import { compileRecipe, canonicalJson } from './recipe.js';
import { assetExtension, materializeAsset, sha256File, confinedPath } from './assets.js';
import { serveMaterials } from './media-server.js';
import { runMediaProcess } from './process.js';
import { captionsSrt, probeMedia, technicalQa, isCurrentTechnicalQa } from './qa.js';
import { PACKAGED_FONT } from './font.js';

export interface RenderOptions {assetRoot:string;workRoot:string;assetPathsById?:Record<string,string>;browserExecutable?:string;ffmpegPath:string;ffprobePath:string;bundlePath?:string;fontPath?:string;signal?:AbortSignal;onProgress?:(event:{step:string;progress?:number})=>void}
export async function buildCreativeBundle(outDir:string):Promise<string>{const {bundle}=await import('@remotion/bundler');const result=await bundle({entryPoint:fileURLToPath(new URL('./remotion/index.tsx',import.meta.url)),outDir,webpackOverride:config=>({...config,cache:false})});await writeBundleProvenance(result);return result;}
async function output(kind:RenderOutput['kind'],path:string,contentType:string):Promise<RenderOutput>{return {kind,path,contentType,sha256:await sha256File(path),sizeBytes:(await stat(path)).size};}
async function verifiedFiles(files:RenderOutput[],root:string):Promise<boolean>{return files.length>0&&Promise.all(files.map(async f=>{try{return await sha256File(await confinedPath(root,f.path))===f.sha256&&(await stat(f.path)).size===f.sizeBytes;}catch{return false;}})).then(values=>values.every(Boolean));}
async function refreshCachedQa(plan:RenderPlan,options:RenderOptions,files:RenderOutput[],qa:TechnicalQa):Promise<TechnicalQa>{if(isCurrentTechnicalQa(qa,plan.recipe))return qa;if(plan.recipe.engine_version==='1.1.0')throw new Error('CACHED_RENDER_GUARDS_STALE');const asset=plan.recipe.voice.asset;const voice=await confinedPath(options.assetRoot,options.assetPathsById?.[asset.asset_id]??resolve(options.assetRoot,asset.asset_id));if(await sha256File(voice)!==asset.sha256)throw new Error('VOICE_HASH_MISMATCH');const current=await technicalQa(files.find(f=>f.kind==='master')!.path,plan.recipe,{...options,referenceAudioPath:voice});if(current.status!=='PASS')throw new Error('CACHED_MASTER_QA_FAILED');return current;}
async function finishRender(plan:RenderPlan,workRoot:string,work:string,rasters:RenderOutput[],qa:TechnicalQa,start:number,reused:boolean):Promise<RenderResult>{
  const captions=resolve(work,'captions.srt'),copy=resolve(work,'copy.json');await writeFile(captions,captionsSrt(plan.recipe));await writeFile(copy,JSON.stringify(plan.recipe.content.ad_copy,null,2)+'\n');
  const files=[...rasters,...await Promise.all([output('captions',captions,'application/x-subrip'),output('copy',copy,'application/json')])];
  const manifest=resolve(work,'manifest.json');await writeFile(manifest,JSON.stringify({schema_version:1,recipe_sha256:plan.recipe_sha256,recipe_version:plan.recipe.recipe_version,engine_version:plan.engine_version,remotion_version:plan.remotion_version,platform:plan.platform,fingerprints:plan.fingerprints,font:PACKAGED_FONT,assets:plan.recipe.assets,authorization:{authorization_id:plan.authorization.authorization_id,authority:plan.authorization.authority},input_conformance:'PASSED',technical_qa:qa,editorial_review:'PENDING',production_approval:'PENDING',publication_allowed:false,reused_render:reused,...(plan.recipe.engine_version==='1.1.0'?{engine_source_sha256:ENGINE_SOURCE_SHA256,policy_source:plan.recipe.presentation!.policy_source,playbook_intake_sha256:(plan.playbook_intake as any).receipt_sha256}:{}),provider_consumption:{new_operations:0,voice_receipt_id:plan.recipe.voice.provider_receipt_id??null},files:files.map(({path:_path,...f})=>f),created_at:new Date().toISOString()},null,2)+'\n');files.push(await output('manifest',manifest,'application/json'));
  const result:RenderResult={files,qa,recipe_sha256:plan.recipe_sha256,fingerprints:plan.fingerprints,reused,elapsed_ms:Date.now()-start};const cachedPath=resolve(workRoot,'cache',`${plan.fingerprints.render}-${plan.fingerprints.copy}.json`);await mkdir(dirname(cachedPath),{recursive:true});await writeFile(cachedPath,JSON.stringify(result,null,2));await writeFile(resolve(workRoot,'cache',`render-${plan.fingerprints.render}.json`),JSON.stringify({files:rasters,qa}));return result;
}
/** Only this complete gate may enter rendering; the legacy low-level renderer is not exposed. */
export async function renderRecipe(plan:RenderPlan,options:RenderOptions):Promise<RenderResult>{
  options.signal?.throwIfAborted();
  const start=Date.now();const checked=compileRecipe(plan.recipe,{platform:plan.platform,authorization:plan.authorization,inputApproval:plan.input_approval,assets:plan.asset_attestations,playbookIntake:plan.playbook_intake});
  if(canonicalJson(checked)!==canonicalJson(plan))throw new Error('RENDER_PLAN_TAMPERED');
  if(!isAbsolute(options.workRoot)||await realpath(options.workRoot)!==resolve(options.workRoot))throw new Error('WORK_ROOT_MUST_EXIST_WITHOUT_SYMLINKS');
  if(plan.platform!==`${process.platform}-${process.arch}`)throw new Error('RENDER_PLATFORM_MISMATCH');
  if(!options.browserExecutable||!isAbsolute(options.browserExecutable))throw new Error('PACKAGED_BROWSER_EXECUTABLE_REQUIRED');
  if(plan.recipe.font.sha256!==PACKAGED_FONT.sha256)throw new Error('PACKAGED_FONT_HASH_MISMATCH');
  const lockPath=resolve(options.workRoot,'.creative-render.lock');let lock;
  try{lock=await open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));}catch{throw new Error('RENDER_BUSY_OR_RECOVERY_REQUIRED');}
  let server:Awaited<ReturnType<typeof serveMaterials>>|undefined;
  try{
    const cachedPath=resolve(options.workRoot,'cache',`${plan.fingerprints.render}-${plan.fingerprints.copy}.json`);
    try{const cache=JSON.parse(await readFile(cachedPath,'utf8')) as RenderResult;if(cache.qa.status==='PASS'&&isCurrentTechnicalQa(cache.qa,plan.recipe)&&cache.recipe_sha256===plan.recipe_sha256&&await verifiedFiles(cache.files,options.workRoot)){const rasters=cache.files.filter(f=>['master','preview'].includes(f.kind));await writeFile(resolve(options.workRoot,'cache',`render-${plan.fingerprints.render}.json`),JSON.stringify({files:rasters,qa:cache.qa}));return {...cache,reused:true,elapsed_ms:Date.now()-start};}}catch{/* A missing or corrupt cache never substitutes unverified bytes. */}
    const work=resolve(options.workRoot,'jobs',randomUUID());await mkdir(work,{recursive:true});
    let rendered:{files:RenderOutput[];qa:TechnicalQa}|undefined;try{rendered=JSON.parse(await readFile(resolve(options.workRoot,'cache',`render-${plan.fingerprints.render}.json`),'utf8'));}catch{/* Missing raster cache is an ordinary first run. */}
    if(rendered?.qa.status==='PASS'&&rendered.files.length===2&&rendered.files.some(f=>f.kind==='master')&&rendered.files.some(f=>f.kind==='preview')&&await verifiedFiles(rendered.files,options.workRoot)){options.onProgress?.({step:'reuse-render'});return finishRender(plan,options.workRoot,work,rendered.files,await refreshCachedQa(plan,options,rendered.files,rendered.qa),start,true);}
    const inputs=resolve(work,'inputs');await mkdir(inputs);
    const materials=new Map<string,{path:string;type:string}>();options.onProgress?.({step:'prepare'});
    for(const asset of plan.recipe.assets){options.signal?.throwIfAborted();const path=resolve(inputs,`${asset.asset_id}${assetExtension(asset)}`);await materializeAsset(asset,{assetRoot:options.assetRoot,sourcePath:options.assetPathsById?.[asset.asset_id],destination:path});materials.set(asset.asset_id,{path,type:asset.media_type??'application/octet-stream'});}
    const voice=materials.get(plan.recipe.voice.asset.asset_id)!;const voiceProbe=await probeMedia(voice.path,options.ffprobePath,options.signal);const voiceDuration=Number(voiceProbe.format.duration);
    if(!voiceProbe.streams.some(s=>s.codec_type==='audio')||voiceDuration<plan.recipe.duration_frames/30-2||voiceDuration>plan.recipe.duration_frames/30+.5)throw new Error('VOICE_DURATION_OR_MEDIA_INVALID');
    if(plan.recipe.voice.body_asset){const p=await probeMedia(materials.get(plan.recipe.voice.body_asset.asset_id)!.path,options.ffprobePath,options.signal);if(!p.streams.some(s=>s.codec_type==='audio')||Math.abs(Number(p.format.duration)-(plan.recipe.duration_frames-90)/30)>.5)throw new Error('BODY_VOICE_DURATION_INVALID');}
    for(const scene of plan.recipe.scenes)if(scene.kind==='video'){const p=await probeMedia(materials.get(scene.asset_id)!.path,options.ffprobePath,options.signal);if(!p.streams.some(s=>s.codec_type==='video')||Number(p.format.duration)+.05<(scene.trim_before_frames+scene.duration_frames)/30)throw new Error(`SCENE_MEDIA_TOO_SHORT:${scene.id}`);}
    const fontPath=options.fontPath??fileURLToPath(new URL('../resources/bricolage-grotesque-latin-700-normal.woff2',import.meta.url));if(await sha256File(fontPath)!==PACKAGED_FONT.sha256)throw new Error('FONT_BYTES_CHANGED');materials.set('packaged-font',{path:fontPath,type:'font/woff2'});
    server=await serveMaterials(materials);const media=Object.fromEntries(plan.recipe.assets.map(a=>[a.asset_id,server!.url(a.asset_id)]));
    options.onProgress?.({step:'assemble'});const bundlePath=options.bundlePath??await buildCreativeBundle(resolve(options.workRoot,'bundles',`engine-${plan.engine_version}`));
    if(plan.recipe.engine_version==='1.1.0')await verifyBundleProvenance(bundlePath);
    const {selectComposition,renderMedia,makeCancelSignal}=await import('@remotion/renderer');const inputProps={recipe:plan.recipe,media,fontUrl:server.url('packaged-font')};const composition=await selectComposition({serveUrl:bundlePath,id:'CommerceStudioFaceless',inputProps,browserExecutable:options.browserExecutable});
    options.signal?.throwIfAborted();
    const raw=resolve(work,'raw.mp4'),master=resolve(work,'master.mp4');const {cancel,cancelSignal}=makeCancelSignal();const abort=()=>cancel();options.signal?.addEventListener('abort',abort,{once:true});
    try{options.onProgress?.({step:'render',progress:0});await renderMedia({composition,serveUrl:bundlePath,inputProps,codec:'h264',audioCodec:'aac',outputLocation:raw,concurrency:1,crf:18,pixelFormat:'yuv420p',browserExecutable:options.browserExecutable,cancelSignal,onProgress:p=>options.onProgress?.({step:'render',progress:p.progress})});}finally{options.signal?.removeEventListener('abort',abort);}
    await runMediaProcess(options.ffmpegPath,['-hide_banner','-nostdin','-y','-threads','2','-filter_threads','2','-i',raw,'-c:v','copy','-af',plan.recipe.engine_version==='1.1.0'?'loudnorm=I=-15:TP=-1.2:LRA=11':'loudnorm=I=-16:TP=-1.5:LRA=11','-c:a','aac','-ar','48000','-b:a','192k','-movflags','+faststart',master],{signal:options.signal});
    options.onProgress?.({step:'qa'});const qa=await technicalQa(master,plan.recipe,{...options,referenceAudioPath:voice.path});
    if(plan.recipe.engine_version==='1.1.0')qa.checks.push({code:'RENDERED_SAFE_ZONE_GEOMETRY',passed:true,actual:{frames:plan.recipe.duration_frames,method:'font-loaded-dom-every-frame-v1'},expected:'all overlays and glyphs in safe zone; caption exception only1536'});
    if(qa.status!=='PASS'){await writeFile(resolve(work,'failed-qa.json'),JSON.stringify(qa,null,2));throw new Error(`TECHNICAL_QA_FAILED: ${qa.checks.filter(c=>!c.passed).map(c=>c.code).join(',')}`);}
    const preview=resolve(work,'preview-540p.mp4');await runMediaProcess(options.ffmpegPath,['-hide_banner','-nostdin','-y','-threads','2','-filter_threads','2','-i',master,'-vf','scale=540:960','-c:v','libx264','-threads','2','-preset','fast','-crf','25','-c:a','aac','-ar','48000','-b:a','96k','-movflags','+faststart',preview],{signal:options.signal});
    const rasters=await Promise.all([output('master',master,'video/mp4'),output('preview',preview,'video/mp4')]);const result=await finishRender(plan,options.workRoot,work,rasters,qa,start,false);options.onProgress?.({step:'review'});return result;
  }finally{try{await server?.close();}finally{await lock.close();await unlink(lockPath);}}
}
