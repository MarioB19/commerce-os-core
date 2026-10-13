import {ensureDefaultReceiptPolicy} from './receipt-policies.js';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {putRecord,encrypt,decrypt,stableJson,appendEvent} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {marketRecordVersionHash,validateMarketConfiguration,marketDraftHash} from './market-variants.js';
import {marketReleaseHash,snapshotMarketJourney} from '../../domain/src/catalog/market-variants.js';
import {marketReleaseSchema} from '../../contracts/src/market-variants.js';
import {marketDraftFieldsSchema} from '../../contracts/src/market-variant-store.js';
import {variantDocumentSchema,variantSectionInputSchema,variantCreateInputSchema,variantDuplicateInputSchema,variantPublishInputSchema,
 variantReviewInputSchema,variantLifecycleInputSchema,productCreateInputSchema,productEditInputSchema,productLifecycleInputSchema,
 variantListQuerySchema,productListQuerySchema,variantStateLabels,variantMissingLabels,type VariantDocument,type CollectionInput} from '../../contracts/src/variants.js';
import {baseVariantDocument,duplicateVariantDocument,variantDocumentHash,variantMissing,variantState,conversationSaleWorkflow,
 guidedSaleWorkflow,guidedRecipeDefinition,disabledRemarketingPolicy,variantMaterialIds,sellerLanguageInstruction} from '../../domain/src/catalog/variant-document.js';
import {validateOffer} from '../../domain/src/catalog/validation.js';
import type {Body} from '../../contracts/src/index.js';
import {issueCommercialContinuity,applyContinuousHumanCommand} from './continuous-authorization.js';
import type {ProfileAuthority} from '../../domain/src/core/profile-authorization.js';

/** V7 F4 variant workspace (ADR-V7-05, ADR-V7-06). Every function runs inside the caller's
 * authorized profile transaction (withProfileRequest); nothing here selects a
 * profile, sends a message or grants commercial authority by itself. */
export type Environment='REAL'|'SIMULATION';
export class VariantError extends Error{constructor(readonly code:string,readonly statusCode=409,readonly details?:unknown){super(code);}}
function need(value:unknown,code:string,status=409,details?:unknown):asserts value{if(!value)throw new VariantError(code,status,details);}
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const sha=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
const QUOTA_LOCK=743912014;
interface Actor {id:string;kind:'human'|'personal_api'}
async function audit(db:ProfileExecutor,environment:Environment,actor:Actor,type:string,aggregate:string,payload:Body){
 await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:type,aggregate_id:aggregate,actor:{type:actor.kind,id:actor.id},payload});
}

interface VariantRow {id:string;family_id:string;version:number;draft:Body;document:Body|null;collection_ciphertext:string|null;collection_revision:number;
 materialized:Body;published_document_sha256:string|null;archived_at:string|null;current_release_id:string|null;release_revision:number;source_release_id:string|null;created_at:string;updated_at:string}
const columns='id,family_id,version,draft,document,collection_ciphertext,collection_revision,materialized,published_document_sha256,archived_at,current_release_id,release_revision,source_release_id,created_at,updated_at';
async function variantRow(db:ProfileExecutor,environment:Environment,id:string,lock=false):Promise<VariantRow>{
 const row=(await db.query<VariantRow>(`SELECT ${columns} FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND id=$3${lock?' FOR UPDATE':''}`,[db.workspaceId,environment,uuid.parse(id)])).rows[0];
 need(row&&row.document,'VARIANT_NOT_FOUND',404);return row;
}
async function productRecord(db:ProfileExecutor,environment:Environment,id:string,lock=false){
 const row=(await db.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='product' AND id=$3${lock?' FOR UPDATE':''}`,[db.workspaceId,environment,uuid.parse(id)])).rows[0];
 need(row,'PRODUCT_NOT_FOUND',404);return row as {id:string;version:number;body:Body;created_at:string};
}
const archivedProduct=(body:Body)=>!!body.archived_at||body.status==='ARCHIVED';

/** Collection secret: SPEI holder/CLABE and payment URLs, never returned. */
interface CollectionSecret {spei?:{holder:string;clabe:string};links:{id:string;url:string}[]}
function readSecret(row:VariantRow):CollectionSecret{
 if(!row.collection_ciphertext)return{links:[]};
 const value=JSON.parse(decrypt(row.collection_ciphertext));return{spei:value.spei,links:Array.isArray(value.links)?value.links:[]};
}
function collectionPresence(document:VariantDocument){return{spei:!!document.collection.spei,links:document.collection.links.length};}

async function sellingNumbers(db:ProfileExecutor,environment:Environment,variantId:string){
 return(await db.query(`SELECT a.id,a.account_id,a.revision,a.binding_id,n.body->>'name' AS name,n.body->>'masked_number' AS masked
  FROM commercial_assignments a JOIN records n ON n.id=a.account_id AND n.workspace_id=a.workspace_id AND n.environment=a.environment AND n.kind='channel_account'
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.variant_id=$3 AND a.state='ACTIVE' AND NOT (n.body ? 'deleted_at') ORDER BY n.body->>'name',a.account_id`,[db.workspaceId,environment,variantId])).rows;
}
function view(row:VariantRow,product:{id:string;body:Body},selling:{account_id:string;name:string|null;masked:string|null}[]){
 const document=variantDocumentSchema.parse(row.document),hash=variantDocumentHash(document);
 const missing=variantMissing(document,collectionPresence(document));
 if(!row.current_release_id)missing.push('publish');
 const state=variantState({archived:!!row.archived_at||archivedProduct(product.body),published:!!row.current_release_id,missing,selling:selling.length>0});
 return{id:row.id,product:{id:product.id,name:String(product.body.name??'Producto')},version:row.version,document,document_sha256:hash,
  state,state_label:variantStateLabels[state],missing:missing.map(code=>({code,label:code==='publish'?'Falta publicar la variante':variantMissingLabels[code]??code})),
  published:row.current_release_id?{release_id:row.current_release_id,revision:row.release_revision}:null,
  unpublished_changes:row.published_document_sha256!==hash,archived:!!row.archived_at,
  numbers:selling.map(n=>({account_id:n.account_id,name:n.name??'Número',masked:n.masked??null})),
  copied_from_release_id:row.source_release_id,updated_at:new Date(row.updated_at).toISOString()};
}
export type VariantView=ReturnType<typeof view>;
async function viewOf(db:ProfileExecutor,environment:Environment,row:VariantRow){
 return view(row,await productRecord(db,environment,row.family_id),await sellingNumbers(db,environment,row.id));
}
async function variantEvent(db:ProfileExecutor,environment:Environment,row:{id:string;version:number},actor:Actor,event:string,detail:Body={},releaseId:string|null=null){
 await db.query(`INSERT INTO market_variant_events(workspace_id,environment,variant_id,version,event,actor_id,release_id,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
  [db.workspaceId,environment,row.id,row.version,event,actor.id,releaseId,detail]);
}

// ---------------------------------------------------------------- products
async function family(db:ProfileExecutor,environment:Environment,productId:string){
 await db.query('INSERT INTO market_families(workspace_id,environment,id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[db.workspaceId,environment,productId]);
}
export async function listProducts(db:ProfileExecutor,environment:Environment,input:unknown){
 const q=productListQuerySchema.parse(input??{});
 const products=(await db.query(`SELECT id,version,body,created_at FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='product'
  AND ($3::text IS NULL OR body->>'name' ILIKE '%'||$3||'%') ORDER BY lower(body->>'name'),id LIMIT 500`,[db.workspaceId,environment,q.q?q.q.replace(/[%_\\]/g,m=>'\\'+m):null])).rows;
 const variants=(await db.query<VariantRow>(`SELECT ${columns} FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND document IS NOT NULL ORDER BY created_at,id`,[db.workspaceId,environment])).rows;
 const selling=(await db.query(`SELECT a.variant_id,count(*)::int n FROM commercial_assignments a WHERE a.workspace_id=$1 AND a.environment=$2 AND a.variant_id IS NOT NULL AND a.state='ACTIVE' GROUP BY a.variant_id`,[db.workspaceId,environment])).rows;
 const count=new Map(selling.map(r=>[r.variant_id,r.n]));
 return products.filter(p=>q.include==='all'||!archivedProduct(p.body)).map(p=>({id:p.id,version:p.version,name:String(p.body.name??'Producto'),
  description:String(p.body.description??''),archived:archivedProduct(p.body),
  variants:variants.filter(v=>v.family_id===p.id&&(q.include==='all'||!v.archived_at)).map(v=>{const x=view(v,p,Array.from({length:count.get(v.id)??0},()=>({account_id:'',name:null,masked:null})));
   return{id:v.id,name:x.document.name,locale:x.document.locale,state:x.state,state_label:x.state_label,numbers:count.get(v.id)??0,unpublished_changes:x.unpublished_changes};})}));
}
export async function createProduct(db:ProfileExecutor,environment:Environment,input:unknown,actor:Actor){
 const q=productCreateInputSchema.parse(input);
 await ensureDefaultReceiptPolicy(db,environment,actor.id);
 // Product quota is enforced by trigger; wait for the global quota turn instead of failing as busy.
 await db.query('SELECT pg_advisory_xact_lock($1)',[QUOTA_LOCK]);
 const product=await putRecord(db,{workspaceId:db.workspaceId,environment,kind:'product',body:{name:q.name,description:q.description,knowledge:[],asset_ids:[],references:[],status:'PUBLISHED',source:'v7_product'}});
 await family(db,environment,product.id);
 const variant=await insertVariant(db,environment,product.id,baseVariantDocument({productName:q.name,name:q.variant.name,locale:q.variant.locale}),actor,null,'DRAFT_CREATED');
 await audit(db,environment,actor,'product.created',product.id,{variant_id:variant.id});
 return{product:{id:product.id,version:product.version,name:q.name},variant};
}
export async function editProduct(db:ProfileExecutor,environment:Environment,id:string,input:unknown,actor:Actor){
 const q=productEditInputSchema.parse(input),old=await productRecord(db,environment,id,true);
 need(old.version===q.expected_version,'VERSION_CONFLICT');need(!archivedProduct(old.body),'PRODUCT_ARCHIVED');
 const row=await putRecord(db,{id:old.id,workspaceId:db.workspaceId,environment,kind:'product',version:old.version,body:{...old.body,name:q.name,description:q.description}});
 await audit(db,environment,actor,'product.edited',old.id,{version:row.version});return{id:row.id,version:row.version,name:q.name,description:q.description};
}
export async function productDependencies(db:ProfileExecutor,environment:Environment,id:string){
 const p=await productRecord(db,environment,id);
 const r=(await db.query(`SELECT
  (SELECT count(*)::int FROM market_variants v WHERE v.workspace_id=$1 AND v.environment=$2 AND v.family_id=$3 AND v.document IS NOT NULL AND v.archived_at IS NULL) AS variants,
  (SELECT count(*)::int FROM commercial_assignments a WHERE a.workspace_id=$1 AND a.environment=$2 AND a.product_id=$3 AND a.state='ACTIVE') AS numbers,
  (SELECT count(*)::int FROM records c WHERE c.workspace_id=$1 AND c.environment=$2 AND c.kind='conversation' AND c.body->>'product_id'=$3::text AND c.body->>'status'='OPEN') AS open_conversations`,
 [db.workspaceId,environment,p.id])).rows[0];
 return{id:p.id,variants:r.variants,numbers:r.numbers,open_conversations:r.open_conversations,can_archive:r.numbers===0};
}
export async function setProductArchived(db:ProfileExecutor,environment:Environment,id:string,input:unknown,archived:boolean,actor:Actor){
 const q=productLifecycleInputSchema.parse(input),old=await productRecord(db,environment,id,true);need(old.version===q.expected_version,'VERSION_CONFLICT');
 need(archivedProduct(old.body)!==archived,archived?'PRODUCT_ARCHIVED':'PRODUCT_ACTIVE');
 if(archived)need((await productDependencies(db,environment,id)).numbers===0,'PRODUCT_HAS_ACTIVE_NUMBERS');
 const {archived_at:_omit,...rest}=old.body;
 const body=archived?{...rest,status:'ARCHIVED',archived_at:new Date().toISOString()}:{...rest,status:'PUBLISHED'};
 const row=await putRecord(db,{id:old.id,workspaceId:db.workspaceId,environment,kind:'product',version:old.version,body});
 await audit(db,environment,actor,archived?'product.archived':'product.restored',old.id,{version:row.version});return{id:row.id,version:row.version,archived};
}

// ---------------------------------------------------------------- variants
async function insertVariant(db:ProfileExecutor,environment:Environment,familyId:string,document:VariantDocument,actor:Actor,sourceReleaseId:string|null,event:string,detail:Body={}){
 const id=randomUUID(),doc=variantDocumentSchema.parse(document);
 const row=(await db.query<VariantRow>(`INSERT INTO market_variants(workspace_id,environment,id,family_id,draft,document,source_release_id)
  VALUES($1,$2,$3,$4,'{}'::jsonb,$5,$6) RETURNING ${columns}`,[db.workspaceId,environment,id,familyId,doc,sourceReleaseId])).rows[0]!;
 await variantEvent(db,environment,row,actor,event,detail);
 return viewOf(db,environment,row);
}
export async function createVariant(db:ProfileExecutor,environment:Environment,input:unknown,actor:Actor){
 const q=variantCreateInputSchema.parse(input),product=await productRecord(db,environment,q.product_id,true);
 await ensureDefaultReceiptPolicy(db,environment,actor.id);
 need(!archivedProduct(product.body),'PRODUCT_ARCHIVED');await family(db,environment,product.id);
 const result=await insertVariant(db,environment,product.id,baseVariantDocument({productName:String(product.body.name??'Producto'),name:q.name,locale:q.locale}),actor,null,'DRAFT_CREATED');
 await audit(db,environment,actor,'variant.created',result.id,{product_id:product.id});return result;
}
export async function readVariant(db:ProfileExecutor,environment:Environment,id:string){return viewOf(db,environment,await variantRow(db,environment,id));}
export async function listVariants(db:ProfileExecutor,environment:Environment,input:unknown){
 const q=variantListQuerySchema.parse(input??{});
 const rows=(await db.query<VariantRow>(`SELECT ${columns} FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND document IS NOT NULL
  AND ($3::uuid IS NULL OR family_id=$3) AND ($4 OR archived_at IS NULL) ORDER BY created_at,id LIMIT 500`,[db.workspaceId,environment,q.product_id??null,q.include==='all'])).rows;
 const result=[];for(const row of rows)result.push(await viewOf(db,environment,row));return result;
}
async function assetCheck(db:ProfileExecutor,environment:Environment,ids:readonly string[],forPublication:boolean){
 const problems:string[]=[];
 if(!ids.length)return problems;
 const rows=(await db.query(`SELECT id,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='asset' AND id=ANY($3::uuid[])`,[db.workspaceId,environment,ids])).rows;
 const found=new Map(rows.map(r=>[r.id,r.body]));
 for(const id of ids){const body=found.get(id);
  if(!body){problems.push(`Material no encontrado: ${id}`);continue;}
  if(body.archived_at||body.status==='ARCHIVED')problems.push(`Restaura el material «${body.name??id}» antes de usarlo.`);
  if(body.delivery_eligible===false||body.usage==='MARKETING_REFERENCE')problems.push(`«${body.name??id}» es sólo una referencia de marketing y no puede entregarse.`);
  if(forPublication&&body.status!=='READY')problems.push(`Termina de subir «${body.name??id}».`);
 }
 return problems;
}
async function workflowCheck(db:ProfileExecutor,environment:Environment,id:string,familyId:string){
 const row=(await db.query(`SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='workflow' AND id=$3`,[db.workspaceId,environment,id])).rows[0];
 need(row&&row.body.status==='PUBLISHED'&&!row.body.archived_at,'VARIANT_FLOW_NOT_PUBLISHED',400);
 need(!row.body.product_id||row.body.product_id===familyId,'VARIANT_FLOW_OTHER_PRODUCT',400);
}
function mergeCollection(document:VariantDocument,previous:CollectionSecret,input:CollectionInput){
 const secret:CollectionSecret={links:[]};let spei:VariantDocument['collection']['spei']=null;
 if(input.spei==='keep'){need(previous.spei&&document.collection.spei,'COLLECTION_SPEI_MISSING',400);secret.spei=previous.spei;spei=document.collection.spei;}
 else if(input.spei){secret.spei={holder:input.spei.holder,clabe:input.spei.clabe};spei={bank:input.spei.bank,last4:input.spei.clabe.slice(-4)};}
 const links:VariantDocument['collection']['links']=[];const ids=new Set<string>();
 for(const[index,link]of input.links.entries()){
  const id=link.id??`link-${index+1}-${randomUUID().slice(0,8)}`;need(!ids.has(id),'COLLECTION_LINK_DUPLICATE',400);ids.add(id);
  const url=link.url==='keep'?previous.links.find(l=>l.id===id)?.url:link.url;need(url,'COLLECTION_LINK_MISSING',400);
  secret.links.push({id,url});links.push({id,label:link.label,provider:link.provider,host:new URL(url).hostname});
 }
 return{secret,collection:{spei,links,instructions:input.instructions,legacy_profile_id:null}};
}
export async function saveVariantSection(db:ProfileExecutor,environment:Environment,id:string,input:unknown,actor:Actor){
 const q=variantSectionInputSchema.parse(input),old=await variantRow(db,environment,id,true);
 need(old.version===q.expected_version,'VERSION_CONFLICT');need(!old.archived_at,'VARIANT_ARCHIVED');
 const document=variantDocumentSchema.parse(old.document);let next:VariantDocument=document,ciphertext=old.collection_ciphertext,collectionRevision=old.collection_revision;
 switch(q.section){
 case'sale':{
  if(q.value.base==='existing')await workflowCheck(db,environment,q.value.existing_workflow_id!,old.family_id);
  if(q.value.base==='guided')need(q.value.guided,'VARIANT_GUIDED_CONTENT_REQUIRED',400);
  if(q.value.base==='conversation')need(q.value.conversation,'VARIANT_SALE_MESSAGES_REQUIRED',400);
  if(q.value.guided){const problems=await assetCheck(db,environment,[q.value.guided.presentation.audio_asset_id,q.value.guided.presentation.pack_image_asset_id,q.value.guided.agreement.audio_asset_id,q.value.guided.collection.audio_asset_id],false);need(!problems.length,'VARIANT_MATERIAL_INVALID',400,problems);}
  next={...document,sale:q.value};break;}
 case'offer':{const problems=await assetCheck(db,environment,[...new Set(q.value.fulfillment.map(f=>f.asset_id))],false);need(!problems.length,'VARIANT_MATERIAL_INVALID',400,problems);
  try{validateOffer({currency:document.locale.currency,base_amount_minor:q.value.price_minor,fulfillment:q.value.fulfillment,madrina:q.value.legacy.madrina});}catch(e){throw new VariantError(e instanceof Error?e.message:'INVALID_OFFER',400);}
  next={...document,offer:q.value};break;}
 case'collection':{const merged=mergeCollection(document,readSecret(old),q.value);
  need(merged.collection.spei||merged.collection.links.length,'COLLECTION_METHOD_REQUIRED',400);
  if(merged.collection.spei)need(document.locale.currency==='MXN','COLLECTION_SPEI_REQUIRES_MXN',400);
  ciphertext=encrypt({spei:merged.secret.spei,links:merged.secret.links});collectionRevision+=1;next={...document,collection:merged.collection};break;}
 case'remarketing':{if(q.value){const ids=q.value.slots.flatMap(s=>[s.stages.awaiting_agreement.asset_id,s.stages.awaiting_payment.asset_id]).filter((x):x is string=>!!x);const problems=await assetCheck(db,environment,[...new Set(ids)],false);need(!problems.length,'VARIANT_MATERIAL_INVALID',400,problems);}
  next={...document,remarketing:q.value};break;}
 case'ai':next={...document,ai:q.value};break;
 case'locale':{
  // Changing the market of a published variant would reinterpret open money; duplicate instead.
  need(!old.current_release_id||q.value.locale.currency===document.locale.currency,'VARIANT_CURRENCY_LOCKED',409);
  if(document.collection.spei)need(q.value.locale.currency==='MXN','COLLECTION_SPEI_REQUIRES_MXN',400);
  next={...document,name:q.value.name,locale:q.value.locale};break;}
 }
 next=variantDocumentSchema.parse(next);
 const row=(await db.query<VariantRow>(`UPDATE market_variants SET document=$4,collection_ciphertext=$5,collection_revision=$6,version=version+1,updated_at=clock_timestamp()
  WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$7 RETURNING ${columns}`,[db.workspaceId,environment,old.id,next,ciphertext,collectionRevision,old.version])).rows[0];
 need(row,'VERSION_CONFLICT');await variantEvent(db,environment,row,actor,'SECTION_SAVED',{section:q.section});
 await audit(db,environment,actor,'variant.section_saved',row.id,{section:q.section,version:row.version});
 return viewOf(db,environment,row);
}
export async function reviewVariant(db:ProfileExecutor,environment:Environment,id:string,input:unknown,actor:Actor){
 const q=variantReviewInputSchema.parse(input),old=await variantRow(db,environment,id,true);need(old.version===q.expected_version,'VERSION_CONFLICT');need(!old.archived_at,'VARIANT_ARCHIVED');
 const document=variantDocumentSchema.parse(old.document);
 const next={...document,pending_review:document.pending_review.filter(f=>!q.reviewed.includes(f))};
 const row=(await db.query<VariantRow>(`UPDATE market_variants SET document=$4,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$5 RETURNING ${columns}`,
  [db.workspaceId,environment,old.id,next,old.version])).rows[0];need(row,'VERSION_CONFLICT');
 await variantEvent(db,environment,row,actor,'REVIEWED',{reviewed:q.reviewed});return viewOf(db,environment,row);
}
export async function duplicateVariant(db:ProfileExecutor,environment:Environment,id:string,input:unknown,actor:Actor){
 const q=variantDuplicateInputSchema.parse(input),source=await variantRow(db,environment,id);
 const product=await productRecord(db,environment,source.family_id);need(!archivedProduct(product.body),'PRODUCT_ARCHIVED');
 const copy=duplicateVariantDocument(variantDocumentSchema.parse(source.document),q);
 const result=await insertVariant(db,environment,source.family_id,copy,actor,source.current_release_id,'DUPLICATED',{source_variant_id:source.id});
 await audit(db,environment,actor,'variant.duplicated',result.id,{source_variant_id:source.id});
 return{...result,source_variant_id:source.id,numbers_copied:0 as const,publication_authorized:false as const};
}
export async function setVariantArchived(db:ProfileExecutor,environment:Environment,id:string,input:unknown,archived:boolean,actor:Actor){
 const q=variantLifecycleInputSchema.parse(input),old=await variantRow(db,environment,id,true);need(old.version===q.expected_version,'VERSION_CONFLICT');
 need(!!old.archived_at!==archived,archived?'VARIANT_ARCHIVED':'VARIANT_ACTIVE');
 if(archived)need((await sellingNumbers(db,environment,old.id)).length===0,'VARIANT_HAS_ACTIVE_NUMBERS');
 const row=(await db.query<VariantRow>(`UPDATE market_variants SET archived_at=${archived?'clock_timestamp()':'NULL'},version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$4 RETURNING ${columns}`,
  [db.workspaceId,environment,old.id,old.version])).rows[0];need(row,'VERSION_CONFLICT');
 await variantEvent(db,environment,row,actor,archived?'ARCHIVED':'RESTORED');await audit(db,environment,actor,archived?'variant.archived':'variant.restored',row.id,{version:row.version});
 return viewOf(db,environment,row);
}
export async function variantHistory(db:ProfileExecutor,environment:Environment,id:string){
 const row=await variantRow(db,environment,id);
 const events=(await db.query(`SELECT version,event,actor_id,release_id,detail,recorded_at FROM market_variant_events WHERE workspace_id=$1 AND environment=$2 AND variant_id=$3 ORDER BY version DESC LIMIT 200`,[db.workspaceId,environment,row.id])).rows;
 const releases=(await db.query(`SELECT id,revision,created_at FROM market_releases WHERE workspace_id=$1 AND environment=$2 AND variant_id=$3 ORDER BY revision DESC LIMIT 100`,[db.workspaceId,environment,row.id])).rows;
 const labels:Record<string,string>={DRAFT_CREATED:'Variante creada',SECTION_SAVED:'Cambios guardados',RELEASE_PUBLISHED:'Publicada',REVIEWED:'Campos revisados',ARCHIVED:'Archivada',RESTORED:'Restaurada',DUPLICATED:'Creada como copia',MIGRATED:'Migrada desde el producto anterior',DRAFT_REPLACED:'Configuración preparada'};
 return{events:events.map(e=>({version:e.version,event:e.event,label:labels[e.event]??e.event,section:e.detail?.section??null,actor_id:e.actor_id,release_id:e.release_id,at:new Date(e.recorded_at).toISOString()})),
  releases:releases.map(r=>({id:r.id,revision:r.revision,at:new Date(r.created_at).toISOString()}))};
}

// ---------------------------------------------------------------- publication
interface Materialized {offer?:{id:string;hash:string;series_id:string};flow?:{id:string;hash:string};seller?:{id:string;hash:string};collection?:{id:string;hash:string};
 seller_mode?:Body;migrated?:boolean}
async function versionRef(db:ProfileExecutor,environment:Environment,kind:string,id:string){
 const row=(await db.query(`SELECT v.record_id,v.workspace_id,v.environment,v.kind,v.version,v.body FROM record_versions v JOIN records r ON r.id=v.record_id AND r.version=v.version
  WHERE v.workspace_id=$1 AND v.environment=$2 AND v.kind=$3 AND v.record_id=$4`,[db.workspaceId,environment,kind,id])).rows[0];
 need(row,'VARIANT_CONFIGURATION_CHANGED');return{id:row.record_id as string,revision:row.version as number,sha256:marketRecordVersionHash(row)};
}
async function create(db:ProfileExecutor,environment:Environment,kind:string,body:Body){
 return putRecord(db,{workspaceId:db.workspaceId,environment,kind,body});
}
/** RF-06.f: a publication creates new immutable versions only for changed parts
 * and a new release; assignments following the variant use it for new
 * conversations only. No binding, grant, campaign or message is created. */
export async function publishVariant(db:ProfileExecutor,environment:Environment,id:string,input:unknown,actor:Actor){
 const q=variantPublishInputSchema.parse(input),old=await variantRow(db,environment,id,true);
 need(old.version===q.expected_version,'VERSION_CONFLICT');need(!old.archived_at,'VARIANT_ARCHIVED');
 const doc=variantDocumentSchema.parse(old.document),hash=variantDocumentHash(doc);need(hash===q.document_sha256,'VERSION_CONFLICT');
 const product=await productRecord(db,environment,old.family_id,true);need(!archivedProduct(product.body),'PRODUCT_ARCHIVED');
 const missing=variantMissing(doc,collectionPresence(doc));need(!missing.length,'VARIANT_INCOMPLETE',409,missing.map(code=>({code,label:variantMissingLabels[code]??code})));
 const materials=variantMaterialIds(doc),problems=await assetCheck(db,environment,materials,true);need(!problems.length,'VARIANT_MATERIAL_INVALID',409,problems);
 const m:Materialized=structuredClone(old.materialized??{}),familyId=old.family_id,productName=String(product.body.name??'Producto');
 const currency=doc.locale.currency,language=doc.locale.language,now=new Date().toISOString();
 // Collection.
 let collectionId:string;
 if(doc.collection.legacy_profile_id){
  const legacy=(await db.query(`SELECT id,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='bank_profile' AND id=$3`,[db.workspaceId,environment,doc.collection.legacy_profile_id])).rows[0];
  need(legacy&&legacy.body.currency===currency&&!legacy.body.archived_at,'VARIANT_COLLECTION_CHANGED');collectionId=legacy.id;
 }else{
  const collectionHash=sha({collection:doc.collection,revision:old.collection_revision,currency});
  if(m.collection?.hash===collectionHash)collectionId=m.collection.id;
  else{
   const secret=readSecret(old);need(secret.spei||secret.links.length,'COLLECTION_METHOD_REQUIRED');
   const c=doc.collection;
   const row=await create(db,environment,'bank_profile',{name:`Cobro · ${productName} · ${doc.name}`,bank:c.spei?.bank??c.links[0]?.label??'Pago en línea',spei_bank:c.spei?.bank??null,currency,
    methods:{spei:!!c.spei,links:c.links.map(l=>({id:l.id,label:l.label,provider:l.provider}))},last4:c.spei?.last4??null,variant_id:old.id,status:'PUBLISHED',
    secret_ciphertext:encrypt({spei:secret.spei?{holder:secret.spei.holder,clabe:secret.spei.clabe}:undefined,links:secret.links,instructions:c.instructions})});
   collectionId=row.id;m.collection={id:row.id,hash:collectionHash};
  }
 }
 // Seller (language from the variant; model from the variant or the profile default).
 const sellerHash=sha({seller:doc.sale.seller,ai:doc.ai,language,familyId,mode:m.seller_mode??null});
 let sellerId:string;
 if(m.seller?.hash===sellerHash)sellerId=m.seller.id;
 else{
  const s=doc.sale.seller,mode=!doc.ai.primary&&m.seller_mode?m.seller_mode:{provider:'profile',model:null,max_cost_minor:0};
  const row=await create(db,environment,'agent',{...mode,name:s.name,product_id:familyId,knowledge:s.knowledge,
   instructions:[s.instructions,s.limits?`Límites: ${s.limits}`:''].filter(Boolean).join('\n\n'),
   style:{language:sellerLanguageInstruction(language),tone:'Claro, amable y breve',length:'brief',goal:'Ayudar a elegir la oferta con información comprobable',examples:'',handoff:''},
   timeout_ms:10000,max_tokens:500,variant_id:old.id,language,ai:doc.ai,status:'PUBLISHED'});
  sellerId=row.id;m.seller={id:row.id,hash:sellerHash};
 }
 // Flow.
 let flowId:string;
 if(doc.sale.base==='existing'){await workflowCheck(db,environment,doc.sale.existing_workflow_id!,familyId);flowId=doc.sale.existing_workflow_id!;}
 else{
  const flowHash=sha({base:doc.sale.base,conversation:doc.sale.conversation,guided:doc.sale.base==='guided'?doc.sale.guided:null,language,familyId});
  if(m.flow?.hash===flowHash)flowId=m.flow.id;
  else{
   const name=`Venta · ${productName} · ${doc.name}`;
   const definition=doc.sale.base==='conversation'?conversationSaleWorkflow({name,language,sale:doc.sale.conversation!}):guidedSaleWorkflow({name,content:doc.sale.guided!});
   const row=await create(db,environment,'workflow',{...definition,product_id:familyId,status:'PUBLISHED',published_at:now,published_by:actor.id,version_action:'publish',variant_id:old.id});
   flowId=row.id;m.flow={id:row.id,hash:flowHash};
  }
 }
 // Offer: the hub the engine reads (price, delivery, sale copy, reminders, links).
 const aliases=doc.sale.aliases.length?doc.sale.aliases:[productName];
 const salesFlow=doc.sale.guided||doc.remarketing?{entry_aliases:aliases,recipe:guidedRecipeDefinition(),remarketing:doc.remarketing??disabledRemarketingPolicy(),...(doc.sale.guided?{content:doc.sale.guided}:{})}:undefined;
 const o=doc.offer;
 const offerBody:Body={name:o.name,currency,base_amount_minor:o.price_minor,payment_method:'bank_transfer_receipt',payment_profile_version_id:collectionId,
  ...(o.legacy.receipt_policy_version_id?{receipt_policy_version_id:o.legacy.receipt_policy_version_id}:{}),fulfillment:o.fulfillment,
  positive_payment_unlocks_all:o.positive_payment_unlocks_all,workflow_version_id:flowId,agent_version_id:sellerId,...(salesFlow?{sales_flow:salesFlow}:{}),
  billing_delay_seconds:o.billing_delay_seconds,...(o.tiers.length?{tiers:o.tiers}:{}),...(o.legacy.tier_policy?{tier_policy:o.legacy.tier_policy}:{}),
  ...(o.legacy.madrina?{madrina:o.legacy.madrina}:{}),product_id:familyId,variant_id:old.id,language,entry_aliases:aliases,
  // RF-09.i: which methods the customer was offered (the register shows the method from this, never a guess).
  ...(doc.collection.legacy_profile_id?{}:{collection_methods:[...(doc.collection.spei?['spei']:[]),...(doc.collection.links.length?['link']:[])]})};
 try{validateOffer(offerBody);}catch(e){throw new VariantError(e instanceof Error?e.message:'INVALID_OFFER',409);}
 const offerHash=sha(offerBody);let offerId:string;
 if(m.offer?.hash===offerHash)offerId=m.offer.id;
 else{
  const seriesId=m.offer?.series_id;
  const row=await create(db,environment,'offer',{...offerBody,status:'PUBLISHED',...(seriesId?{series_id:seriesId,source_version_id:m.offer!.id}:{})});
  offerId=row.id;m.offer={id:row.id,hash:offerHash,series_id:seriesId??row.id};
 }
 // Release: references with immutable version hashes, validated by the market store.
 const offerRef=await versionRef(db,environment,'offer',offerId);
 const fields=marketDraftFieldsSchema.parse({locale:{market:doc.locale.market,currency,language,timezone:doc.locale.timezone},amount_minor:o.price_minor,
  configuration:{offer:offerRef,flow:await versionRef(db,environment,'workflow',flowId),seller:await versionRef(db,environment,'agent',sellerId),
   collection:await versionRef(db,environment,'bank_profile',collectionId),remarketing:offerRef,materials:await Promise.all(materials.map(a=>versionRef(db,environment,'asset',a)))}});
 await validateMarketConfiguration(db,environment,familyId,fields);
 let row=(await db.query<VariantRow>(`UPDATE market_variants SET draft=$4,materialized=$5,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$6 RETURNING ${columns}`,
  [db.workspaceId,environment,old.id,fields,m,old.version])).rows[0];need(row,'VERSION_CONFLICT');
 const release=marketReleaseSchema.parse({id:randomUUID(),scope:{workspace_id:db.workspaceId,environment},family_id:familyId,variant_id:old.id,revision:old.release_revision+1,...fields});
 const digest=marketReleaseHash(release);
 await db.query(`INSERT INTO market_releases(workspace_id,environment,id,variant_id,revision,body,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`,[db.workspaceId,environment,release.id,old.id,release.revision,release,digest]);
 row=(await db.query<VariantRow>(`UPDATE market_variants SET current_release_id=$4,release_revision=$5,published_document_sha256=$6,version=version+1,updated_at=clock_timestamp()
  WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$7 RETURNING ${columns}`,[db.workspaceId,environment,old.id,release.id,release.revision,hash,row.version])).rows[0];
 need(row,'VERSION_CONFLICT');
 await variantEvent(db,environment,row,actor,'RELEASE_PUBLISHED',{revision:release.revision,draft_sha256:marketDraftHash(fields)},release.id);
 await audit(db,environment,actor,'variant.published',row.id,{release_id:release.id,revision:release.revision,offer_id:offerId,flow_id:flowId,seller_id:sellerId,collection_id:collectionId});
 return{variant:await viewOf(db,environment,row),release:{id:release.id,revision:release.revision,sha256:digest},
  applies_to:'NEW_CONVERSATIONS' as const,numbers_following:(await sellingNumbers(db,environment,row.id)).length,effects_authorized:false as const};
}

/** The engine side: the release a variant-following assignment uses for a new conversation. */
export async function currentVariantRelease(db:ProfileExecutor,environment:Environment,variantId:string){
 const row=(await db.query(`SELECT v.id,v.family_id,v.archived_at,r.id AS release_id,r.body,r.sha256 FROM market_variants v JOIN market_releases r
  ON r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.id=v.current_release_id WHERE v.workspace_id=$1 AND v.environment=$2 AND v.id=$3`,[db.workspaceId,environment,variantId])).rows[0];
 if(!row||row.archived_at)return undefined;
 const release=marketReleaseSchema.parse(row.body);
 if(release.id!==row.release_id||release.variant_id!==variantId||marketReleaseHash(release)!==row.sha256)throw new VariantError('MARKET_RELEASE_CORRUPT');
 return release;
}
/** Pins the release of a new conversation (RF-06.f). Idempotent per journey. */
export async function captureVariantJourney(db:ProfileExecutor,environment:Environment,input:{journeyId:string;accountId:string;contactId:string;bindingId:string;release:ReturnType<typeof marketReleaseSchema.parse>}){
 const binding=(await db.query(`SELECT id AS record_id,workspace_id,environment,kind,version,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='binding' AND id=$3`,[db.workspaceId,environment,input.bindingId])).rows[0];
 need(binding,'VARIANT_BINDING_NOT_FOUND');
 const snapshot=snapshotMarketJourney({journey_id:input.journeyId,chat:{workspace_id:db.workspaceId,environment,account_id:input.accountId,contact_id:input.contactId},
  release:input.release,binding:{id:binding.record_id,revision:binding.version,sha256:marketRecordVersionHash(binding)}});
 await db.query(`INSERT INTO market_journey_snapshots(workspace_id,environment,journey_id,release_id,body) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
  [db.workspaceId,environment,input.journeyId,input.release.id,snapshot]);
 return snapshot;
}

// ---------------------------------------------------------------- numbers (RF-06.d)
interface NumberRow {id:string;name:string|null;masked:string|null;status:string|null}
async function profileNumbers(db:ProfileExecutor,environment:Environment):Promise<NumberRow[]>{
 return(await db.query(`SELECT id,body->>'name' AS name,body->>'masked_number' AS masked,body->>'status' AS status FROM records
  WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT (body ? 'deleted_at') ORDER BY body->>'name',id`,[db.workspaceId,environment])).rows;
}
async function activeAssignments(db:ProfileExecutor,environment:Environment){
 return(await db.query(`SELECT a.id,a.account_id,a.product_id,a.variant_id,a.revision,a.binding_id,p.body->>'name' AS product_name,v.document->>'name' AS variant_name,
  r.body->'configuration'->'offer'->>'id' AS release_offer_id,b.body->>'offer_version_id' AS pinned_offer_id
  FROM commercial_assignments a JOIN records p ON p.id=a.product_id AND p.workspace_id=a.workspace_id AND p.environment=a.environment AND p.kind='product'
  JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
  LEFT JOIN market_variants v ON v.workspace_id=a.workspace_id AND v.environment=a.environment AND v.id=a.variant_id
  LEFT JOIN market_releases r ON r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.id=v.current_release_id
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.state='ACTIVE' ORDER BY p.body->>'name',a.id`,[db.workspaceId,environment])).rows;
}
/** Variant → numbers: which sell it, which sell something else of the same product. */
export async function variantNumbers(db:ProfileExecutor,environment:Environment,id:string){
 const row=await variantRow(db,environment,id),numbers=await profileNumbers(db,environment),assignments=await activeAssignments(db,environment);
 return numbers.map(n=>{
  const mine=assignments.filter(a=>a.account_id===n.id);
  const same=mine.find(a=>a.product_id===row.family_id);
  return{account_id:n.id,name:n.name??'Número',masked:n.masked,status:n.status,
   sells_this:!!same&&same.variant_id===row.id,
   same_product:same&&same.variant_id!==row.id?{variant_id:same.variant_id,label:same.variant_id?String(same.variant_name??'Otra variante'):'Configuración anterior del producto'}:null,
   others:mine.filter(a=>a.product_id!==row.family_id).map(a=>({product:String(a.product_name??'Producto'),variant:a.variant_id?String(a.variant_name??'Variante'):'Configuración anterior'}))};
 });
}
/** Inverse view (RF-06.d): number → variants → offer used. Optional offer filter. */
export async function numberVariantsView(db:ProfileExecutor,environment:Environment,input:{offer_id?:string}){
 const numbers=await profileNumbers(db,environment),assignments=await activeAssignments(db,environment);
 const offerFilter=input.offer_id?uuid.parse(input.offer_id):null;
 return numbers.map(n=>({account_id:n.id,name:n.name??'Número',masked:n.masked,status:n.status,
  sells:assignments.filter(a=>a.account_id===n.id).map(a=>({product_id:a.product_id,product:String(a.product_name??'Producto'),variant_id:a.variant_id,
   variant:a.variant_id?String(a.variant_name??'Variante'):'Configuración anterior',offer_id:(a.variant_id?a.release_offer_id:null)??a.pinned_offer_id}))
   .filter(s=>!offerFilter||s.offer_id===offerFilter)})).filter(n=>!offerFilter||n.sells.length>0);
}
/** What removing the relation does, before the human confirms it. */
export async function variantNumberImpact(db:ProfileExecutor,environment:Environment,id:string,accountId:string){
 const row=await variantRow(db,environment,id);accountId=uuid.parse(accountId);
 const a=(await db.query(`SELECT id FROM commercial_assignments WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND product_id=$4 AND variant_id=$5 AND state='ACTIVE'`,[db.workspaceId,environment,accountId,row.family_id,row.id])).rows[0];
 need(a,'VARIANT_NUMBER_NOT_ASSIGNED',404);
 const r=(await db.query(`SELECT
  (SELECT count(*)::int FROM records c WHERE c.workspace_id=$1 AND c.environment=$2 AND c.kind='conversation' AND c.body->>'assignment_id'=$3::text AND c.body->>'status'='OPEN') AS open_conversations,
  (SELECT count(*)::int FROM timers t WHERE t.workspace_id=$1 AND t.environment=$2 AND t.status='PENDING' AND t.conversation_id IN(SELECT id::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'assignment_id'=$3::text)) AS pending_followups,
  (SELECT count(*)::int FROM outbox o WHERE o.workspace_id=$1 AND o.environment=$2 AND o.payload->>'assignment_id'=$3::text AND o.status IN('READY','BLOCKED') AND o.attempts=0 AND NOT o.payload ? 'fulfillment_id' AND o.payload->>'kind' IS DISTINCT FROM 'grant') AS unsent_messages`,
 [db.workspaceId,environment,a.id])).rows[0];
 return{assignment_id:a.id,open_conversations:r.open_conversations,pending_followups:r.pending_followups,unsent_messages:r.unsent_messages,
  effect:'Las conversaciones nuevas de este número dejarán de usar esta variante. Las abiertas conservan su historia; sus seguimientos y mensajes aún no enviados se cancelan con registro y pasan a atención de una persona.'};
}
export interface AssignmentAuthority {authority:ProfileAuthority;operationId:string}
/** One human act persists the relation (D-01): new or adopted assignment plus
 * its permanent commercial continuity; removing it retires both. */
export async function setVariantNumber(db:ProfileExecutor,environment:Environment,id:string,input:unknown,actor:Actor,grant:AssignmentAuthority){
 const q=z.object({account_id:uuid,sell:z.boolean()}).strict().parse(input);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${db.workspaceId}:catalog-lifecycle`]);
 const row=await variantRow(db,environment,id,true);
 const account=(await db.query(`SELECT id,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND id=$3 FOR UPDATE`,[db.workspaceId,environment,q.account_id])).rows[0];
 need(account&&!account.body.deleted_at,'NUMBER_NOT_FOUND',404);
 const existing=(await db.query(`SELECT * FROM commercial_assignments WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND product_id=$4 FOR UPDATE`,[db.workspaceId,environment,account.id,row.family_id])).rows[0];
 if(!q.sell){
  need(existing&&existing.state==='ACTIVE'&&existing.variant_id===row.id,'VARIANT_NUMBER_NOT_ASSIGNED',404);
  if(existing.authorization_id)await db.query('UPDATE operation_authorizations SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,environment,existing.authorization_id]);
  await db.query(`UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND environment=$2 AND status='PENDING' AND conversation_id IN(SELECT id::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'assignment_id'=$3::text)`,[db.workspaceId,environment,existing.id]);
  await db.query(`UPDATE outbox SET status='CANCELLED',result=result||'{"reason":"ASSIGNMENT_CHANGED","superseded_before_send":true}'::jsonb,updated_at=now() WHERE workspace_id=$1 AND environment=$2 AND payload->>'assignment_id'=$3::text AND status IN('READY','BLOCKED') AND attempts=0 AND NOT payload ? 'fulfillment_id' AND payload->>'kind' IS DISTINCT FROM 'grant'`,[db.workspaceId,environment,existing.id]);
  const grants=(await db.query(`SELECT id,state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2 AND assignment_id=$3 AND state->'revokedAt'='null'::jsonb ORDER BY id`,[db.workspaceId,environment,existing.id])).rows;
  for(const[index,g]of grants.entries())await applyContinuousHumanCommand(db,environment,g.id,'COMMERCIAL_ASSIGNMENT',{operationId:index===0?grant.operationId:randomUUID(),expectedVersion:g.state.version,action:'revoke'},grant.authority);
  await db.query(`UPDATE commercial_assignments SET state='RETIRED',revision=revision+1,authorization_id=NULL,updated_at=now() WHERE id=$1`,[existing.id]);
  await db.query(`INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,$2,$3,'RETIRED',$4,$5)`,[existing.id,existing.revision+1,existing.binding_id,actor.id,'Variante retirada del número desde Productos']);
  await audit(db,environment,actor,'variant.number_removed',row.id,{account_id:account.id,assignment_id:existing.id});
  return{account_id:account.id,sells:false,assignment_id:existing.id};
 }
 need(row.current_release_id&&!row.archived_at,'VARIANT_NOT_PUBLISHED');
 const product=await productRecord(db,environment,row.family_id);need(!archivedProduct(product.body),'PRODUCT_ARCHIVED');
 if(existing?.state==='ACTIVE'&&existing.variant_id===row.id)return{account_id:account.id,sells:true,assignment_id:existing.id,unchanged:true};
 need(!(existing?.state==='ACTIVE'&&existing.variant_id),'NUMBER_SELLS_OTHER_VARIANT',409);
 const release=(await currentVariantRelease(db,environment,row.id))!;const c=release.configuration;
 let assignmentId:string,revision:number;
 if(existing?.state==='ACTIVE'){
  // A previous product configuration on this number now follows the variant.
  await db.query('UPDATE commercial_assignments SET variant_id=$2,updated_at=now() WHERE id=$1',[existing.id,row.id]);
  assignmentId=existing.id;revision=existing.revision;
 }else{
  assignmentId=existing?.id??randomUUID();revision=(existing?.revision??0)+1;
  const binding=await putRecord(db,{workspaceId:db.workspaceId,environment,kind:'binding',body:{account_id:account.id,product_id:row.family_id,variant_id:row.id,
   offer_version_id:c.offer.id,workflow_version_id:c.flow.id,agent_version_id:c.seller.id,entry_rules:[],assignment_id:assignmentId,assignment_revision:revision,
   valid_from:new Date().toISOString(),source:'v7_variant_assignment',evidence:'Asignación humana desde la variante',confidence:'confirmed'}});
  await db.query(`INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision,variant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT(workspace_id,environment,account_id,product_id) DO UPDATE SET binding_id=EXCLUDED.binding_id,revision=EXCLUDED.revision,state='ACTIVE',authorization_id=NULL,variant_id=EXCLUDED.variant_id,updated_at=now()`,
   [assignmentId,db.workspaceId,environment,account.id,row.family_id,binding.id,revision,row.id]);
  await db.query(`INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,$2,$3,'ACTIVE',$4,$5)`,[assignmentId,revision,binding.id,actor.id,'Variante asignada al número desde Productos']);
 }
 const continuity=await issueCommercialContinuity(db,environment,{operationId:grant.operationId,assignmentId,expectedRevision:revision},grant.authority);
 await audit(db,environment,actor,'variant.number_assigned',row.id,{account_id:account.id,assignment_id:assignmentId,revision,continuity_id:continuity.id,adopted:existing?.state==='ACTIVE'});
 return{account_id:account.id,sells:true,assignment_id:assignmentId,continuity_id:continuity.id,paused:continuity.humanPaused};
}
/** Assignment history of one number: which product/variant it sold and when. */
export async function numberAssignmentHistory(db:ProfileExecutor,environment:Environment,accountId:string){
 accountId=uuid.parse(accountId);
 const n=(await db.query(`SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND id=$3`,[db.workspaceId,environment,accountId])).rows[0];need(n,'NUMBER_NOT_FOUND',404);
 const rows=(await db.query(`SELECT h.revision,h.state,h.actor_id,h.reason,h.recorded_at,a.product_id,p.body->>'name' AS product,b.body->>'variant_id' AS variant_id,v.document->>'name' AS variant
  FROM commercial_assignment_history h JOIN commercial_assignments a ON a.id=h.assignment_id
  JOIN records p ON p.id=a.product_id AND p.workspace_id=a.workspace_id AND p.environment=a.environment AND p.kind='product'
  JOIN records b ON b.id=h.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
  LEFT JOIN market_variants v ON v.workspace_id=a.workspace_id AND v.environment=a.environment AND v.id::text=b.body->>'variant_id'
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.account_id=$3 ORDER BY h.recorded_at DESC,h.revision DESC LIMIT 200`,[db.workspaceId,environment,accountId])).rows;
 const labels:Record<string,string>={ACTIVE:'Vende',RETIRED:'Dejó de vender',DRAFT:'En preparación'};
 return rows.map(r=>({at:new Date(r.recorded_at).toISOString(),state:r.state,label:labels[r.state]??r.state,product_id:r.product_id,product:String(r.product??'Producto'),
  variant_id:r.variant_id,variant:r.variant_id?String(r.variant??'Variante'):'Configuración anterior',actor_id:r.actor_id,reason:r.reason}));
}
