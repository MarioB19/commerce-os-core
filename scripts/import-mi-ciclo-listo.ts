import {mclV5Messages,mclRetiredMaterialReview} from './mcl-v5-materials.js';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {z} from 'zod';
import {mclWorkflow,mclOffer,mclSeller,type MclAssets,type EditorialMessages} from './mcl-catalog.js';

const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export const MCL_AD_VOICE_SHA256='f28bf3cd446f83bda3178e8a0865387d915ac162a6045deb820f7d9dc525892c';
const canonicalValue=(value:any):any=>Array.isArray(value)?value.map(item=>item===undefined?null:canonicalValue(item)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonicalValue(item)])):value;
const canonical=(value:any):string=>JSON.stringify(canonicalValue(value));
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sourceShaSchema=z.string().regex(/^[a-f0-9]{40}$/);
const compilerFiles=[
 'package.json','pnpm-lock.yaml','scripts/import-mi-ciclo-listo.ts','scripts/mcl-catalog.ts','scripts/mcl-v5-materials.ts',
 'packages/contracts/src/index.ts','packages/contracts/src/sales-flow.ts','packages/contracts/src/seller.ts',
 'packages/domain/src/catalog/validation.ts','packages/domain/src/sales/remarketing.ts','packages/domain/src/sales/sales-flow-configuration.ts',
 'packages/domain/src/sales/sales-recipe-v2.ts','packages/domain/src/sales/variables.ts','packages/domain/src/sales/workflow.ts',
] as const;
const corePdfRoles=['pdf1','pdf2','pdf3','pdf4','pdf5','pdf6','pdf7','pdf8','pdf9'] as const;
const publicationRoles=['product','pitch','agreement','collection','followup1','followup2','mockup','calendar',...corePdfRoles,'core','kit','bank','policy','workflow','agent'] as const;
type PublicationRole=typeof publicationRoles[number];
type PublicationIds=Record<PublicationRole,string>;
const symbolicIds=Object.fromEntries(publicationRoles.map((role,index)=>[role,`00000000-0000-4000-8000-${String(index+1).padStart(12,'0')}`])) as PublicationIds;

function productChanges(release:{product:any},ids:PublicationIds){
 return{name:release.product.displayName,slug:'mi-ciclo-listo-preescolar-primaria',description:`Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones. ${release.product.productVersion}`,asset_ids:['pitch','agreement','collection','followup1','followup2','mockup','calendar',...corePdfRoles,'core','kit'].map(key=>ids[key as keyof PublicationIds]),workflow_template_version_id:ids.workflow,agent_version_id:ids.agent};
}
function publicationBodies(release:{product:any;messages:EditorialMessages;knowledge:any},ids:PublicationIds){
 const seller=mclSeller(ids.product,release.knowledge);
 const workflow={...mclWorkflow(ids as unknown as MclAssets,release.messages),product_id:ids.product,agent_version_id:ids.agent};
 const offer=mclOffer({...ids,pdfs:corePdfRoles.map(key=>ids[key])},release.messages);
 return{seller,workflow,offer,product:productChanges(release,ids)};
}
export function compileMclPublicationPlan(release:{product:any;messages:EditorialMessages;knowledge:any;media:{assets:any[]}}){
 const bodies=publicationBodies(release,symbolicIds);
 const assets=[...release.media.assets.map(asset=>({key:asset.key,name:'Mi Ciclo Listo · '+asset.key,mime_type:asset.mime,size_bytes:asset.bytes??null,sha256:asset.sha256,kind:'file',adapter:'private_file'})),...release.product.corePdfs.map((asset:any,index:number)=>({key:corePdfRoles[index],name:'Mi Ciclo Listo · '+basename(String(asset.sourcePath)),mime_type:'application/pdf',size_bytes:asset.bytes??null,sha256:asset.sha256,kind:'file',adapter:'private_file'})),{key:'calendar',name:'Mi Ciclo Listo · '+basename(String(release.product.calendarPdf.sourcePath)),mime_type:'application/pdf',size_bytes:release.product.calendarPdf.bytes??null,sha256:release.product.calendarPdf.sha256,kind:'file',adapter:'private_file'}].sort((a,b)=>a.key.localeCompare(b.key));
 const plan={schema_version:1,asset_uploads:assets,seller:bodies.seller,workflow:bodies.workflow,offer:{product_id:symbolicIds.product,body:bodies.offer},product_version:{product_id:symbolicIds.product,changes:bodies.product},publication_order:['assets','seller','seller-publish','workflow','workflow-publish','offer','offer-publish','product-version','product-publish'],guards:{account_assignment:false,sending_enabled:false,real_messages:0,provider_evaluated:false}};
 const component_sha256={assets:digest(canonical(plan.asset_uploads)),seller:digest(canonical(plan.seller)),workflow:digest(canonical(plan.workflow)),offer:digest(canonical(plan.offer)),product:digest(canonical(plan.product_version))};
 return{plan,summary:{schema_version:1,sha256:digest(canonical(plan)),component_sha256,operation_count:assets.length*3+8,account_assignment:false,sending_enabled:false,real_messages:0}};
}
async function compilerProvenance(root=repoRoot){
 const files=[];for(const path of compilerFiles){const bytes=await readFile(join(root,path));files.push({path,sha256:digest(bytes)});}
 return{sha256:digest(canonical(files)),files};
}
function currentSourceSha(root=repoRoot){return sourceShaSchema.parse(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim());}
/** Fixed length, stable across retries, and distinct for every approved run/action. */
export type MclIdempotencyBinding={release_sha256:string;private_configuration_sha256:string;source_sha:string;compiler_sha256:string;compiled_plan_sha256:string;audio_review_sha256:string;approval_sha256:string};
export function mclImportIdempotencyKey(binding:MclIdempotencyBinding,environment:'REAL'|'SIMULATION',operation:string){
 return 'mcl-nine-grades:'+digest(canonical([binding.release_sha256,binding.private_configuration_sha256,binding.source_sha,binding.compiler_sha256,binding.compiled_plan_sha256,binding.audio_review_sha256,binding.approval_sha256,environment,operation]));
}
const mediaKeys=['pitch','agreement','collection','followup1','followup2','mockup'] as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const mediaSchema=z.object({version:z.literal(1),assets:z.array(z.object({key:z.enum(mediaKeys),path:z.string().nullable(),sha256:sha.nullable(),mime:z.enum(['audio/mpeg','audio/ogg','image/png','image/jpeg']),approval:z.enum(['PENDING','APPROVED']),approved_by:z.string().optional(),approved_at:z.iso.datetime().optional()}))});
export const mclPublicationAuthorizationSchema=z.object({release_sha256:sha,private_configuration_sha256:sha,source_sha:sourceShaSchema,compiler_sha256:sha,compiled_plan_sha256:sha,audio_review_sha256:sha,approved_origin:z.string().url(),approved_by:z.string().min(2),approved_at:z.iso.datetime(),environment:z.enum(['REAL','SIMULATION']),catalog_publication_approved:z.literal(true),review_kind:z.enum(['AI_ASSISTED','HUMAN']),reviewed_by:z.string().min(2),portal_verification:z.enum(['VERIFIED','PENDING']),privacy_verification:z.enum(['VERIFIED','PENDING'])}).strict();

export async function prepareMclRelease(productPath:string,editorialDir:string,mediaPath:string,options:{sourceSha?:string;repoRoot?:string}={}){
 const productBytes=await readFile(productPath),product=JSON.parse(productBytes.toString()),messageBytes=await readFile(join(editorialDir,'wa-mensajes.json')),knowledgeBytes=await readFile(join(editorialDir,'seller-knowledge.json')),media=mediaSchema.parse(JSON.parse(await readFile(mediaPath,'utf8')));
 const messages=JSON.parse(messageBytes.toString()) as EditorialMessages;
 if(messages.messages.length!==34||new Set(messages.messages.map(m=>m.id)).size!==34)throw new Error('EDITORIAL_34_UNIQUE_MESSAGES_REQUIRED');
 for(const m of messages.messages as (EditorialMessages['messages'][number]&{sha256:string})[])if(digest(m.text)!==m.sha256)throw new Error('EDITORIAL_TEXT_HASH_MISMATCH');
 if(product.counts?.grades!==9||product.corePdfs?.length!==9||product.calendarPdf?.exposedInPortal!==false||product.portal?.thirdCode!==false)throw new Error('PRODUCT_MANIFEST_INCOMPLETE');
 const files=[];for(const asset of [product.catalog,...product.corePdfs,product.calendarPdf]){const bytes=await readFile(asset.sourcePath);if(digest(bytes)!==asset.sha256||bytes.length>20971520)throw new Error('PRODUCT_FILE_HASH_MISMATCH');asset.bytes=bytes.length;files.push({sha256:asset.sha256,bytes:bytes.length});}
 const blockers:string[]=[],inventory:Array<{key:typeof mediaKeys[number];sha256?:string;bytes?:number;status:'PENDING'|'APPROVED'}>=[];for(const key of mediaKeys){const found=media.assets.filter(a=>a.key===key);if(found.length!==1)throw new Error('UNIQUE_MEDIA_KEY_REQUIRED_'+key);const asset=found[0]!;
  if(key==='mockup'?!asset.mime.startsWith('image/'):!asset.mime.startsWith('audio/'))throw new Error('MEDIA_ROLE_MISMATCH_'+key);
  if(!asset.path||!asset.sha256){blockers.push('MEDIA_MISSING_'+key);inventory.push({key,status:'PENDING'});continue;}
  const bytes=await readFile(asset.path);if(!bytes.length||bytes.length>20971520||digest(bytes)!==asset.sha256)throw new Error('MEDIA_BYTES_OR_HASH_INVALID_'+key);
  if(asset.approval!=='APPROVED'||!asset.approved_by||!asset.approved_at)blockers.push('MEDIA_REVIEW_PENDING_'+key);
  inventory.push({key,sha256:asset.sha256,bytes:bytes.length,status:asset.approval});
 }
 const audioReviewPath=product.evidence?.sales_flow_audio_review;if(typeof audioReviewPath!=='string'||!audioReviewPath)throw new Error('AUDIO_REVIEW_REQUIRED');
 const audioReviewBytes=await readFile(resolve(dirname(productPath),audioReviewPath)),audioReview=JSON.parse(audioReviewBytes.toString());
 if(audioReview.schema_version!==1||audioReview.status!=='PASS_AI_ASSISTED'||!Array.isArray(audioReview.tracks))throw new Error('AUDIO_REVIEW_NOT_APPROVED');
 if(audioReview.voice_id_sha256!==MCL_AD_VOICE_SHA256)throw new Error('MCL_AD_VOICE_MISMATCH');
 for(const key of ['agreement','collection','followup1','followup2']){const approved=audioReview.tracks.filter((track:any)=>track.key===key&&track.approval==='APPROVED'&&track.review?.review_kind==='AI_ASSISTED');const expected=media.assets.find(asset=>asset.key===key);if(approved.length!==1||approved[0].sha256!==expected?.sha256)throw new Error('AUDIO_REVIEW_HASH_MISMATCH_'+key.toUpperCase());}
 const preparedMedia={...media,assets:media.assets.map(asset=>({...asset,bytes:(inventory.find(item=>item.key===asset.key) as any)?.bytes??null}))};
 const prepared={product,messages,knowledge:JSON.parse(knowledgeBytes.toString()),media:preparedMedia};
 const root=options.repoRoot??repoRoot,source_sha=currentSourceSha(root);if(options.sourceSha&&sourceShaSchema.parse(options.sourceSha)!==source_sha)throw new Error('SOURCE_SHA_NOT_CURRENT_HEAD');
 const compiler=await compilerProvenance(root),compiled=compileMclPublicationPlan(prepared);
 const hashes={product_manifest:digest(productBytes),messages:digest(messageBytes),seller_knowledge:digest(knowledgeBytes),media_manifest:digest(canonical(media)),audio_review:digest(audioReviewBytes),product_files:files};
 const releaseHash=digest(canonical({hashes,source_sha,compiler_sha256:compiler.sha256,compiled_plan_sha256:compiled.summary.sha256}));
 return {...prepared,review:{version:5,release_sha256:releaseHash,source_sha,compiler,compiled_plan:compiled.summary,hashes,product:{name:product.displayName,counts:product.counts,revision:product.productVersion},prices:{currency:'MXN',base_amount_minor:9700,positive_payment_unlocks_all:true},workflow:{message_count:mclV5Messages(messages.messages).length,retired_material_review:mclRetiredMaterialReview(messages.messages),required_asset_roles:[...mediaKeys,'calendar',...corePdfRoles,'core','kit'],billing_anchor:'PAYMENT_INSTRUCTIONS_TRANSPORT_ACK',billing_delay_seconds:0,recipe_id:'sales-agreement-10-step'},assets:inventory,blockers,configuration_publication_independent_of_connections:true,connections:{numbers:'DEFERRED_BY_OWNER',sales_ai:'PENDING',model:null},account_assignment:false,sending_enabled:false,real_messages:0}};
}

export type MclApi=(path:string,body?:unknown,method?:string,key?:string)=>Promise<any>;
export type MclImportState={release_sha256:string;configuration_sha256:string;source_sha:string;compiler_sha256:string;compiled_plan_sha256:string;audio_review_sha256:string;approval_sha256:string;environment:'REAL'|'SIMULATION';product_id:string;initial_product_version:number;steps:Record<string,any>;status:string};
/** Uses only public authenticated catalog endpoints. Every step has stable input,
 * persists its real returned ID and can replay the server's idempotent response. */
export async function applyMclRelease(release:Awaited<ReturnType<typeof prepareMclRelease>>,state:MclImportState,api:MclApi,save:(state:MclImportState)=>Promise<void>,references:{core:string;kit:string;bank:string;policy:string}){
 const compiled=compileMclPublicationPlan(release);
 if(state.release_sha256!==release.review.release_sha256||state.source_sha!==release.review.source_sha||state.compiler_sha256!==release.review.compiler.sha256||state.compiled_plan_sha256!==release.review.compiled_plan.sha256||state.audio_review_sha256!==release.review.hashes.audio_review||compiled.summary.sha256!==state.compiled_plan_sha256)throw new Error('RELEASE_STATE_BINDING_MISMATCH');
 const ids:Record<string,string>={product:state.product_id,...references};
 async function step(key:string,path:string,body:unknown,method='POST'){
  if(state.steps[key])return state.steps[key];
  const result=await api(path,body,method,key);state.steps[key]=result;await save(state);return result;
 }
 const canonical=await api('/products/'+ids.product);
 if(canonical.archived_at||canonical.status==='ARCHIVED')throw new Error('CANONICAL_PRODUCT_ARCHIVED');
 for(const tier of ['core','kit']){const asset=await api('/assets/'+ids[tier]);if(asset.kind!=='access'||asset.status!=='READY'||asset.archived_at)throw new Error('EXISTING_ACCESS_NOT_READY');}
 if(ids.core===ids.kit)throw new Error('TWO_DISTINCT_EXISTING_ACCESSES_REQUIRED');
 try{
  for(const asset of [...release.media.assets,...release.product.corePdfs.map((pdf:any,index:number)=>({key:corePdfRoles[index]!,path:pdf.sourcePath,sha256:pdf.sha256,mime:'application/pdf'})),{key:'calendar',path:release.product.calendarPdf.sourcePath,sha256:release.product.calendarPdf.sha256,mime:'application/pdf'}]){
   const bytes=await readFile(asset.path!);if(digest(bytes)!==asset.sha256)throw new Error('MEDIA_CHANGED_AFTER_REVIEW');
   const row=await step('asset:'+asset.key,'/assets/upload-intents',{name:'Mi Ciclo Listo · '+(asset.mime==='application/pdf'?basename(asset.path!):asset.key),kind:'file',adapter:'private_file',mime_type:asset.mime,size_bytes:bytes.length,sha256:asset.sha256});ids[asset.key]=row.id;
   await step('upload:'+asset.key,'/assets/'+row.id+'/content',{base64:bytes.toString('base64')},'PUT');
   const ready=await step('complete:'+asset.key,'/assets/'+row.id+'/complete',{});if(ready.sha256!==asset.sha256)throw new Error('UPLOADED_ASSET_HASH_MISMATCH');
  }
  const seller=await step('seller','/agents',mclSeller(ids.product!,release.knowledge));
  const agent=await step('seller-publish','/agents/'+seller.id+'/publish',{expected_version:seller.version});ids.agent=agent.id;
  const flow=await step('workflow','/workflows',{...mclWorkflow(ids as unknown as MclAssets,release.messages),product_id:ids.product,agent_version_id:ids.agent});
  const workflow=await step('workflow-publish','/workflows/'+flow.id+'/publish',{expected_version:flow.version});ids.workflow=workflow.id;
  const offer=await step('offer','/products/'+ids.product+'/offers',mclOffer({...ids,pdfs:corePdfRoles.map(key=>ids[key]!) } as Parameters<typeof mclOffer>[0],release.messages));
  const publishedOffer=await step('offer-publish','/offers/'+offer.id+'/publish',{expected_version:offer.version});ids.offer=publishedOffer.id;
  const product=await step('product-version','/products/'+ids.product+'/versions',{expected_version:state.initial_product_version,changes:productChanges(release,ids as PublicationIds)});
  await step('product-publish','/products/'+ids.product+'/transition',{expected_version:product.version,status:'PUBLISHED'});
  const [readProduct,readOffer,readFlow,readSeller]=await Promise.all([api('/products/'+ids.product),api('/offers/'+ids.offer),api('/workflows/'+ids.workflow),api('/agents/'+ids.agent)]);
  if(readProduct.id!==state.product_id||readProduct.status!=='PUBLISHED'||readProduct.workflow_template_version_id!==ids.workflow||readProduct.agent_version_id!==ids.agent||!corePdfRoles.every(key=>readProduct.asset_ids?.includes(ids[key]))||readOffer.product_id!==ids.product||readOffer.agent_version_id!==ids.agent||readOffer.workflow_version_id!==ids.workflow||readOffer.positive_payment_unlocks_all!==true||readOffer.billing_delay_seconds!==0||readOffer.sales_flow?.recipe?.recipe_id!=='sales-agreement-10-step'||readOffer.sales_flow?.remarketing?.slots?.length!==3||!readOffer.sales_flow?.content?.presentation?.audio_asset_id||!readOffer.sales_flow?.content?.agreement?.audio_asset_id||!readOffer.sales_flow?.content?.collection?.audio_asset_id||!corePdfRoles.every(key=>readOffer.fulfillment?.some((item:{asset_id:string;release_on:string})=>item.asset_id===ids[key]&&item.release_on==='commitment_accepted'))||readFlow.recipe_id!=='sales-agreement-10-step'||readFlow.message_library?.length!==mclV5Messages(release.messages.messages).length||readSeller.provider!=='workspace'||readSeller.model!==null||readSeller.status!=='PUBLISHED')throw new Error('CATALOG_READBACK_MISMATCH');
  state.status='CATALOG_PUBLISHED_CONNECTIONS_PENDING';await save(state);
  return{status:state.status,ids,revisions:{product:readProduct.version,offer:readOffer.version,workflow:readFlow.version,seller:readSeller.version},account_assignment:false,sending_enabled:false,real_messages:0,provider_evaluated:false,phone_verified:false};
 }catch(error){state.status='PARTIAL_RESUMABLE';await save(state);throw error;}
}

async function main(){
 const args=process.argv.slice(2),option=(name:string)=>{const at=args.indexOf(name);return at<0?undefined:args[at+1];};
 if(args.includes('--help')){console.log('Prepare: --product-manifest PATH --editorial-dir PATH --media-manifest PATH --output PATH [--source-sha CURRENT_HEAD]. Apply: add --apply --approval PRIVATE_JSON --private-env PRIVATE_ENV --report PRIVATE_JSON. Review and approval bind source/compiler/audio/compiled plan. Updates the existing MCL_PRODUCT_ID via API; reuses protected access/payment references. Sales provider and numbers stay pending.');return;}
 const required=(name:string)=>{const value=option(name);if(!value||value.startsWith('--'))throw new Error('REQUIRED_'+name.slice(2).toUpperCase().replaceAll('-','_'));return resolve(value);};
 const release=await prepareMclRelease(required('--product-manifest'),required('--editorial-dir'),required('--media-manifest'),{sourceSha:option('--source-sha')}),output=required('--output');
 await mkdir(dirname(output),{recursive:true});const reviewTemporary=output+'.tmp';await writeFile(reviewTemporary,JSON.stringify(release.review,null,2)+'\n',{mode:0o600});await rename(reviewTemporary,output);
 if(!args.includes('--apply')){console.log(JSON.stringify({mode:'PREPARED',review:output,release_sha256:release.review.release_sha256,source_sha:release.review.source_sha,compiler_sha256:release.review.compiler.sha256,compiled_plan_sha256:release.review.compiled_plan.sha256,audio_review_sha256:release.review.hashes.audio_review,blockers:release.review.blockers,network_calls:0}));return;}
 // V7 F8-D retired the /v1 catalog CRUD this publication wrote to (products,
 // offers, workflows, agents, assets, bank profiles). Preparing a review still
 // works; publishing goes through the V7 product/variant editor (/v2).
 throw new Error('MCL_IMPORT_V5_API_RETIRED');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{const code=error instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'MCL_IMPORT_FAILED_REVIEW_PRIVATE_STATE';console.error(code);process.exitCode=1;});
