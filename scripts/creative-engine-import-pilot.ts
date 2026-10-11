/** Explicit local import for the authorized internal pilot. Never runs providers or modifies Vibe sources. */
import { readFile,writeFile,mkdir,copyFile,realpath } from 'node:fs/promises';
import { dirname,resolve,extname } from 'node:path';
import { compileRecipe,inspectRecipe,alignmentSha256,PACKAGED_FONT,sha256File,confinedPath } from '../packages/creative-engine/src/index.js';
import type { CreativeRecipe,AssetAttestation } from '../packages/creative-contracts/src/index.js';
const args=Object.fromEntries(process.argv.slice(2).reduce<string[][]>((a,v,i,all)=>{if(v.startsWith('--'))a.push([v.slice(2),all[i+1]]);return a;},[]));
for(const key of ['source-plan','brief','output','source-root','product-id','offer-id','authorization-source'])if(!args[key])throw new Error(`MISSING_ARGUMENT:${key}`);
const sourceRoot=await realpath(args['source-root']),planPath=await confinedPath(sourceRoot,resolve(args['source-plan'])),briefPath=await confinedPath(sourceRoot,resolve(args.brief));
const source=JSON.parse(await readFile(planPath,'utf8')),brief=JSON.parse(await readFile(briefPath,'utf8'));
const qaPath=resolve(dirname(planPath),'qa-remotion.json'),qa=JSON.parse(await readFile(qaPath,'utf8'));
if(qa.captionSync?.passed!==true)throw new Error('SOURCE_WORD_ALIGNMENT_NOT_VERIFIED');
if(source.format!=='faceless-narrative'||source.width!==1080||source.height!==1920||source.fps!==30)throw new Error('SOURCE_FORMAT_UNSUPPORTED');
if(source.scenes.some((s:any)=>!['video','image','screen-recording'].includes(s.kind)))throw new Error('SOURCE_SCENES_REQUIRE_REVIEW');
const suppliedCopy=args['ad-copy']?JSON.parse(await readFile(resolve(args['ad-copy']),'utf8')):null;
const [bodyId,hookId]=source.id.split('-'),ad=brief.ads?.find((a:any)=>a.bodyId===bodyId&&a.hookId===hookId)??(suppliedCopy?{primaryText:suppliedCopy.primary_text,headline:suppliedCopy.headline,description:suppliedCopy.description,claimsUsed:suppliedCopy.claims_used??[]}:null);if(!ad)throw new Error('SOURCE_AD_COPY_MISSING');
const output=resolve(args.output);await mkdir(output,{recursive:true,mode:0o700});const assetRoot=resolve(output,'assets');await mkdir(assetRoot,{recursive:true});
const sources=[{source_id:'source-render-plan',sha256:await sha256File(planPath),locator:`render-plan:${source.id}`},{source_id:'source-brief',sha256:await sha256File(briefPath),locator:`brief:${brief.launchId}`},{source_id:'source-alignment-qa',sha256:await sha256File(qaPath),locator:'captionSync.passed and captions.words'}];
if(suppliedCopy)sources.push({source_id:'source-ad-copy',sha256:await sha256File(resolve(args['ad-copy'])),locator:suppliedCopy.source_locator??'explicit supplied approved advertising copy'});
const assets:CreativeRecipe['assets']=[],attestations:AssetAttestation[]=[],paths=new Map<string,string>();
const mime:Record<string,CreativeRecipe['assets'][number]['media_type']>={'.mp4':'video/mp4','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4'};
for(const original of [...new Set<string>([...source.scenes.map((s:any)=>s.src),source.audio.narrationSrc])]){
 const path=await confinedPath(sourceRoot,resolve(original)),sha=await sha256File(path),assetId=`asset-${sha.slice(0,40)}`;
 const decision=source.assets.find((a:any)=>a.sourcePath===original);
 if(original!==source.audio.narrationSrc&&(decision?.permissionStatus!=='allowed'||!decision?.sourceReference))throw new Error('SOURCE_ASSET_PERMISSION_MISSING');
 const media_type=mime[extname(path).toLowerCase()];if(!media_type)throw new Error('SOURCE_MEDIA_UNSUPPORTED');
 paths.set(original,assetId);if(assets.some(a=>a.asset_id===assetId))continue;
 const bytes=(await import('node:fs/promises')).stat(path).then(s=>s.size);assets.push({asset_id:assetId,sha256:sha,media_type,bytes:await bytes});
 attestations.push({asset_id:assetId,sha256:sha,state:'READY',permission:'ALLOWED',source_reference:decision?.sourceReference??'Authorized supplied narration; source alignment QA; internal evaluation',media_type});
 try{await copyFile(path,resolve(assetRoot,assetId),1);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||await sha256File(resolve(assetRoot,assetId))!==sha)throw error;}
}
const voiceAsset=assets.find(a=>a.asset_id===paths.get(source.audio.narrationSrc))!;
const recipe:CreativeRecipe={id:`pilot-${args['product-id']}-${source.id}`,recipe_version:1,engine_version:'1.0.0',product_id:args['product-id'],offer_id:args['offer-id'],offer_version:1,language:'es-MX',format:'faceless-narrative',width:1080,height:1920,fps:30,duration_frames:source.durationInFrames,
 content:{product_name:brief.productName,audience:'Público documentado en playbook fuente',angle:ad.mecanismo??bodyId,hook:source.overlays.hook.text,body:source.captions.words.slice(0).map((w:any)=>w.text).join(' '),cta:source.overlays.cta.buttonLabel,ad_copy:{primary_text:ad.primaryText,headline:ad.headline,description:ad.description,whatsapp_message:brief.expectedCta},source_ids:['source-render-plan','source-brief',...(suppliedCopy?['source-ad-copy']:[])]},
 scenes:source.scenes.map((s:any)=>({id:s.id,asset_id:paths.get(s.src),kind:s.kind==='image'?'image':'video',start_frame:s.startFrame,duration_frames:s.durationInFrames,trim_before_frames:s.trimBeforeFrames,role:s.narrativeRole,fit:s.fit,motion:s.motion.type,source_ids:['source-render-plan']})),
 voice:{mode:'supplied',asset:voiceAsset,transcript:source.captions.words.map((w:any)=>w.text).join(' '),alignment_sha256:alignmentSha256(source.captions.words),alignment_status:'VERIFIED',alignment_source:sources[2]},captions:{words:source.captions.words,max_words_per_card:source.captions.maxWordsPerCard,style:source.captions.style},font:PACKAGED_FONT,
 palette:{background:source.backgroundColor,foreground:source.palette.light,accent:source.palette.accent},assets,claims:brief.claims.filter((c:any)=>ad.claimsUsed.includes(c.id)).map((c:any)=>{if(c.evidenceStatus!=='verified')throw new Error('SOURCE_CLAIM_UNVERIFIED');return {id:c.id,text:c.usableClaim??c.label,status:'VERIFIED',source_ids:['source-brief']};}),sources,excluded_claims:brief.excludedClaims??[]};
const check=inspectRecipe(recipe,`${process.platform}-${process.arch}`);if(!check.ok)throw new Error(JSON.stringify(check.issues));
const now=new Date(),hash=check.fingerprints!.recipe;
const plan=compileRecipe(recipe,{platform:`${process.platform}-${process.arch}`,inputApproval:{status:'APPROVED',recipe_sha256:hash,actor_id:'codex-delegated-pilot',authority:'DELEGATED_PILOT',source_reference:args['authorization-source'],approved_at:now.toISOString()},authorization:{authorization_id:`pilot-${args['product-id']}-20260908`,recipe_sha256:hash,recipe_version:1,authority:'DELEGATED_PILOT',source_reference:args['authorization-source'],expires_at:new Date(now.getTime()+24*3600_000).toISOString()},assets:attestations});
await writeFile(resolve(output,'recipe.json'),JSON.stringify(recipe,null,2)+'\n');await writeFile(resolve(output,'plan.json'),JSON.stringify(plan,null,2)+'\n');await writeFile(resolve(output,'import-receipt.json'),JSON.stringify({purpose:'EVALUATION_ONLY',source_sha256:sources,recipe_sha256:hash,input_conformance:'PASSED',authority:'DELEGATED_PILOT',originals_modified:false,paid_provider_operations:0,editorial_review:'PENDING',production_approval:'PENDING',publication_allowed:false,imported_at:now.toISOString()},null,2)+'\n');
console.log(JSON.stringify({recipe_sha256:hash,assets:assets.length,words:recipe.captions.words.length,duration_seconds:recipe.duration_frames/30,output}));
