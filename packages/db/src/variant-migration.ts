import {randomUUID,createHash} from 'node:crypto';
import type {QueryExecutor} from './index.js';
import {stableJson} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {marketRecordVersionHash} from './market-variants.js';
import {marketReleaseHash} from '../../domain/src/catalog/market-variants.js';
import {marketReleaseSchema} from '../../contracts/src/market-variants.js';
import {marketDraftFieldsSchema} from '../../contracts/src/market-variant-store.js';
import {variantDocumentSchema,type VariantDocument} from '../../contracts/src/variants.js';
import {salesRouteAliasSchema,salesFlowContentSchema,remarketingPolicySchema} from '../../contracts/src/sales-flow.js';
import {fulfillmentSchema} from '../../contracts/src/index.js';
import {baseVariantDocument,variantDocumentHash,variantMaterialIds} from '../../domain/src/catalog/variant-document.js';
import type {Body} from '../../contracts/src/index.js';

/** V7 F4 RF-05.e / RF-08.d: each existing product becomes one parent with one
 * Mexico variant whose first release pins exactly the records it sells with
 * today (offer, flow, seller, bank profile, materials). Nothing is rewritten:
 * historical conversations keep their references, active assignments of that
 * offer start following the variant without a new revision (their grants stay
 * valid), and anything that cannot be mapped exactly is reported as an
 * exception and left as a draft. Identifiers and reason codes only. */
const sha=(value:unknown)=>createHash('sha256').update(stableJson(value)).digest('hex');
type Environment='REAL'|'SIMULATION';
export interface MigrationCandidate {workspaceId:string;productId:string;offerId:string|null;flowId:string|null;sellerId:string|null;collectionId:string|null;
 currency:string|null;assignments:string[];exceptions:string[];checksums:Record<string,string>}
export interface MigrationPlan {schema_version:1;profiles:string[];candidates:MigrationCandidate[];already_adopted:number}

async function recordRow(db:QueryExecutor,workspace:string,environment:Environment,kind:string,id:unknown){
 if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return undefined;
 return(await db.query(`SELECT id AS record_id,workspace_id,environment,kind,version,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND id=$4`,[workspace,environment,kind,id])).rows[0] as
  {record_id:string;workspace_id:string;environment:string;kind:string;version:number;body:Body}|undefined;
}
/** The offer a product sells today: the one most active assignments pin, else
 * its latest published offer. */
async function currentOffer(db:QueryExecutor,workspace:string,environment:Environment,productId:string){
 const pinned=(await db.query(`SELECT b.body->>'offer_version_id' AS offer_id,count(*)::int n,max(a.updated_at) AS at FROM commercial_assignments a
  JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.product_id=$3 AND a.state='ACTIVE' AND a.variant_id IS NULL GROUP BY 1 ORDER BY n DESC,at DESC LIMIT 1`,[workspace,environment,productId])).rows[0];
 if(pinned?.offer_id)return pinned.offer_id as string;
 const latest=(await db.query(`SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='offer' AND body->>'product_id'=$3 AND body->>'status'='PUBLISHED'
  AND NOT (body ? 'archived_at') ORDER BY created_at DESC,id DESC LIMIT 1`,[workspace,environment,productId])).rows[0];
 return latest?.id as string|undefined;
}
export async function migrationCandidate(db:QueryExecutor,workspace:string,environment:Environment,productId:string):Promise<MigrationCandidate>{
 const c:MigrationCandidate={workspaceId:workspace,productId,offerId:null,flowId:null,sellerId:null,collectionId:null,currency:null,assignments:[],exceptions:[],checksums:{}};
 const offerId=await currentOffer(db,workspace,environment,productId);
 if(!offerId){c.exceptions.push('NO_PUBLISHED_OFFER');return c;}
 const offer=(await recordRow(db,workspace,environment,'offer',offerId))!;c.offerId=offer.record_id;c.currency=offer.body.currency??null;c.checksums.offer=marketRecordVersionHash(offer);
 if(offer.body.status!=='PUBLISHED')c.exceptions.push('OFFER_NOT_PUBLISHED');
 if(offer.body.currency!=='MXN')c.exceptions.push('CURRENCY_NOT_MXN');
 const flow=await recordRow(db,workspace,environment,'workflow',offer.body.workflow_version_id);
 if(flow&&flow.body.status==='PUBLISHED'&&(!flow.body.product_id||flow.body.product_id===productId)){c.flowId=flow.record_id;c.checksums.flow=marketRecordVersionHash(flow);}else c.exceptions.push('FLOW_NOT_PUBLISHED');
 const seller=await recordRow(db,workspace,environment,'agent',offer.body.agent_version_id);
 if(seller&&(!seller.body.product_id||seller.body.product_id===productId)){c.sellerId=seller.record_id;c.checksums.seller=marketRecordVersionHash(seller);}else c.exceptions.push('SELLER_MISSING');
 const bank=await recordRow(db,workspace,environment,'bank_profile',offer.body.payment_profile_version_id);
 if(bank&&bank.body.currency===offer.body.currency&&!bank.body.archived_at){c.collectionId=bank.record_id;c.checksums.collection=marketRecordVersionHash(bank);}else c.exceptions.push('COLLECTION_MISSING');
 for(const item of Array.isArray(offer.body.fulfillment)?offer.body.fulfillment:[]){
  const asset=await recordRow(db,workspace,environment,'asset',item.asset_id);
  if(asset)c.checksums['asset:'+asset.record_id]=marketRecordVersionHash(asset);else c.exceptions.push('MATERIAL_MISSING');
 }
 c.assignments=(await db.query(`SELECT a.id FROM commercial_assignments a JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.product_id=$3 AND a.state='ACTIVE' AND a.variant_id IS NULL AND b.body->>'offer_version_id'=$4 ORDER BY a.id`,[workspace,environment,productId,offer.record_id])).rows.map(r=>r.id);
 const others=(await db.query(`SELECT count(*)::int n FROM commercial_assignments a JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.product_id=$3 AND a.state='ACTIVE' AND a.variant_id IS NULL AND b.body->>'offer_version_id' IS DISTINCT FROM $4`,[workspace,environment,productId,offer.record_id])).rows[0].n;
 if(others)c.exceptions.push('OTHER_OFFER_ASSIGNMENTS_KEEP_PINNED');
 return c;
}

/** Document equivalent to what the product sells today. Invalid legacy values
 * are dropped (aliases) or reported, never invented. */
function migratedDocument(product:Body,offer:Body,seller:Body|undefined,timezone:string,flowId:string|null,collectionId:string|null):VariantDocument{
 const currency=typeof offer.currency==='string'?offer.currency:'MXN';
 const base=baseVariantDocument({productName:String(product.name??'Producto'),name:'México',locale:{market:'México',country:'MX',currency,language:'es-MX',timezone}});
 const rawAliases=[...(Array.isArray(offer.sales_flow?.entry_aliases)?offer.sales_flow.entry_aliases:[]),...(Array.isArray(offer.entry_aliases)?offer.entry_aliases:[])];
 const aliases=[...new Set(rawAliases.filter(a=>salesRouteAliasSchema.safeParse(a).success).map(String))].slice(0,30);
 const guided=salesFlowContentSchema.safeParse(offer.sales_flow?.content);
 const remarketing=remarketingPolicySchema.safeParse(offer.sales_flow?.remarketing);
 const fulfillment=(Array.isArray(offer.fulfillment)?offer.fulfillment:[]).filter((f:unknown)=>fulfillmentSchema.safeParse(f).success);
 return variantDocumentSchema.parse({...base,
  sale:{base:flowId?'existing':'conversation',aliases,conversation:flowId?null:base.sale.conversation,guided:guided.success?guided.data:null,existing_workflow_id:flowId,
   seller:{name:String(seller?.name??base.sale.seller.name).slice(0,160)||base.sale.seller.name,instructions:String(seller?.instructions??'').slice(0,8000),knowledge:String(seller?.knowledge??'').slice(0,20000),limits:''}},
  offer:{name:String(offer.name??product.name??'Producto').slice(0,160),price_minor:Number(offer.base_amount_minor??0),tiers:Array.isArray(offer.tiers)?offer.tiers:[],fulfillment,
   billing_delay_seconds:Number.isInteger(offer.billing_delay_seconds)?offer.billing_delay_seconds:1800,positive_payment_unlocks_all:offer.positive_payment_unlocks_all===true,
   legacy:{...(offer.tier_policy?{tier_policy:offer.tier_policy}:{}),...(offer.madrina?{madrina:offer.madrina}:{}),...(offer.receipt_policy_version_id?{receipt_policy_version_id:offer.receipt_policy_version_id}:{})}},
  collection:{spei:null,links:[],instructions:'',legacy_profile_id:collectionId},
  remarketing:remarketing.success?remarketing.data:null,pending_review:[]});
}

/** Creates the variant and, when the mapping is exact, its first release. */
export async function adoptLegacyProduct(db:ProfileExecutor,environment:Environment,productId:string,actorId:string){
 const existing=(await db.query(`SELECT id FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND family_id=$3 AND document IS NOT NULL ORDER BY created_at LIMIT 1`,[db.workspaceId,environment,productId])).rows[0];
 if(existing)return{product_id:productId,variant_id:existing.id as string,already_adopted:true,released:null as string|null,exceptions:[] as string[],assignments_following:0};
 const product=await recordRow(db,db.workspaceId,environment,'product',productId);
 if(!product)throw Object.assign(new Error('PRODUCT_NOT_FOUND'),{statusCode:404});
 const timezone=(await db.query('SELECT timezone FROM profiles WHERE id=$1',[db.workspaceId])).rows[0]?.timezone??'America/Mexico_City';
 const candidate=await migrationCandidate(db,db.workspaceId,environment,productId);
 await db.query('INSERT INTO market_families(workspace_id,environment,id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[db.workspaceId,environment,productId]);
 const offer=candidate.offerId?(await recordRow(db,db.workspaceId,environment,'offer',candidate.offerId))!:undefined;
 const seller=candidate.sellerId?(await recordRow(db,db.workspaceId,environment,'agent',candidate.sellerId))!:undefined;
 const document=offer?migratedDocument(product.body,offer.body,seller?.body,timezone,candidate.flowId,candidate.collectionId)
  :baseVariantDocument({productName:String(product.body.name??'Producto'),name:'México',locale:{market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone}});
 const variantId=randomUUID(),hash=variantDocumentHash(document);
 const mode=seller?Object.fromEntries(['provider','model','max_cost_minor','input_cost_per_million_minor','output_cost_per_million_minor','timeout_ms','max_tokens','style'].filter(k=>k in seller.body).map(k=>[k,seller.body[k]])):undefined;
 const sellerHash=sha({seller:document.sale.seller,ai:document.ai,language:document.locale.language,familyId:productId,mode:mode??null});
 const materialized={migrated:true,...(mode?{seller_mode:mode}:{}),...(seller?{seller:{id:seller.record_id,hash:sellerHash}}:{}),...(offer?{offer:{id:offer.record_id,hash:'migrated',series_id:offer.body.series_id??offer.record_id}}:{})};
 await db.query(`INSERT INTO market_variants(workspace_id,environment,id,family_id,draft,document,materialized) VALUES($1,$2,$3,$4,'{}'::jsonb,$5,$6)`,[db.workspaceId,environment,variantId,productId,document,materialized]);
 await db.query(`INSERT INTO market_variant_events(workspace_id,environment,variant_id,version,event,actor_id,detail) VALUES($1,$2,$3,1,'MIGRATED',$4,$5)`,
  [db.workspaceId,environment,variantId,actorId,{product_id:productId,offer_id:candidate.offerId,exceptions:candidate.exceptions}]);
 const exact=offer&&candidate.flowId&&candidate.sellerId&&candidate.collectionId&&!candidate.exceptions.some(e=>['OFFER_NOT_PUBLISHED','MATERIAL_MISSING'].includes(e));
 if(!exact)return{product_id:productId,variant_id:variantId,already_adopted:false,released:null,exceptions:candidate.exceptions,assignments_following:0};
 const ref=async(kind:string,id:string)=>{const row=(await recordRow(db,db.workspaceId,environment,kind,id))!;return{id:row.record_id,revision:row.version,sha256:marketRecordVersionHash(row)};};
 const offerRef=await ref('offer',offer!.record_id);
 const fields=marketDraftFieldsSchema.parse({locale:{market:document.locale.market,currency:document.locale.currency,language:document.locale.language,timezone:document.locale.timezone},
  amount_minor:document.offer.price_minor,configuration:{offer:offerRef,flow:await ref('workflow',candidate.flowId!),seller:await ref('agent',candidate.sellerId!),
   collection:await ref('bank_profile',candidate.collectionId!),remarketing:offerRef,materials:await Promise.all(variantMaterialIds(document).map(a=>ref('asset',a)))}});
 await db.query(`UPDATE market_variants SET draft=$4,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND id=$3`,[db.workspaceId,environment,variantId,fields]);
 const release=marketReleaseSchema.parse({id:randomUUID(),scope:{workspace_id:db.workspaceId,environment},family_id:productId,variant_id:variantId,revision:1,...fields});
 await db.query(`INSERT INTO market_releases(workspace_id,environment,id,variant_id,revision,body,sha256) VALUES($1,$2,$3,$4,1,$5,$6)`,[db.workspaceId,environment,release.id,variantId,release,marketReleaseHash(release)]);
 await db.query(`UPDATE market_variants SET current_release_id=$4,release_revision=1,published_document_sha256=$5,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND environment=$2 AND id=$3`,[db.workspaceId,environment,variantId,release.id,hash]);
 await db.query(`INSERT INTO market_variant_events(workspace_id,environment,variant_id,version,event,actor_id,release_id,detail) VALUES($1,$2,$3,3,'RELEASE_PUBLISHED',$4,$5,$6)`,[db.workspaceId,environment,variantId,actorId,release.id,{revision:1,migrated:true}]);
 for(const assignment of candidate.assignments)await db.query(`UPDATE commercial_assignments SET variant_id=$4,updated_at=now() WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND variant_id IS NULL AND state='ACTIVE'`,[db.workspaceId,environment,assignment,variantId]);
 return{product_id:productId,variant_id:variantId,already_adopted:false,released:release.id,exceptions:candidate.exceptions,assignments_following:candidate.assignments.length};
}

async function bind(db:QueryExecutor,workspaceId:string,environment:Environment){
 const row=(await db.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true) AS workspace,pg_catalog.set_config('app.environment',$2,true) AS environment",[workspaceId,environment])).rows[0];
 if(row?.workspace!==workspaceId||row?.environment!==environment)throw new Error('VARIANT_MIGRATION_PROFILE_CONTEXT_REQUIRED');
}
async function requireOwner(db:QueryExecutor){
 const row=(await db.query("SELECT current_user=pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid='public.market_variants'::regclass")).rows[0];
 if(row?.owner!==true)throw new Error('VARIANT_MIGRATION_OWNER_REQUIRED');
}
export async function planVariantMigration(db:QueryExecutor,environment:Environment='REAL'):Promise<MigrationPlan>{
 await requireOwner(db);
 const plan:MigrationPlan={schema_version:1,profiles:[],candidates:[],already_adopted:0};
 for(const profile of (await db.query('SELECT id FROM profiles ORDER BY id')).rows as {id:string}[]){
  await bind(db,profile.id,environment);
  const products=(await db.query(`SELECT r.id,EXISTS(SELECT 1 FROM market_variants v WHERE v.workspace_id=r.workspace_id AND v.environment=r.environment AND v.family_id=r.id AND v.document IS NOT NULL) AS adopted
   FROM records r WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='product' AND NOT (r.body ? 'archived_at') AND COALESCE(r.body->>'status','')<>'ARCHIVED' ORDER BY r.created_at,r.id`,[profile.id,environment])).rows;
  if(!products.length)continue;plan.profiles.push(profile.id);
  for(const p of products){if(p.adopted){plan.already_adopted++;continue;}plan.candidates.push(await migrationCandidate(db,profile.id,environment,p.id));}
 }
 return plan;
}
export function variantMigrationDigest(plan:MigrationPlan){return sha(plan);}
export async function applyVariantMigration(db:QueryExecutor,reviewed:string,environment:Environment='REAL'){
 const plan=await planVariantMigration(db,environment);
 if(variantMigrationDigest(plan)!==reviewed)throw new Error('VARIANT_MIGRATION_PLAN_CHANGED');
 const results=[];
 for(const candidate of plan.candidates){
  await bind(db,candidate.workspaceId,environment);
  results.push({workspace_id:candidate.workspaceId,...await adoptLegacyProduct({workspaceId:candidate.workspaceId,query:db.query.bind(db)} as ProfileExecutor,environment,candidate.productId,'migration-v7')});
 }
 return{plan_sha256:reviewed,adopted:results.filter(r=>!r.already_adopted).length,released:results.filter(r=>r.released).length,
  drafts_with_exceptions:results.filter(r=>!r.released).length,assignments_following:results.reduce((n,r)=>n+r.assignments_following,0),uuid_map:results.map(r=>({workspace_id:r.workspace_id,product_id:r.product_id,variant_id:r.variant_id,release_id:r.released,exceptions:r.exceptions}))};
}
