import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {hash,stableJson} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {marketScopeSchema,marketReleaseSchema,marketVersionRefSchema,marketJourneySnapshotSchema,
 type MarketRelease,type MarketJourneySnapshot} from '../../contracts/src/market-variants.js';
import {marketDraftFieldsSchema,marketDraftReplaceSchema,marketPublishSchema,marketFamilyCreateSchema,
 marketDraftCreateSchema,marketCopySchema,marketVariantListSchema,type MarketEnvironment} from '../../contracts/src/market-variant-store.js';
import {marketReleaseHash,duplicateMarketDraft,snapshotMarketJourney} from '../../domain/src/catalog/market-variants.js';

export class MarketStoreError extends Error{
 constructor(readonly code:string,readonly statusCode=409){super(code);}
}
function need(value:unknown,code:string,status=409):asserts value{if(!value)throw new MarketStoreError(code,status);}
function scope(db:ProfileExecutor,environment:MarketEnvironment){return marketScopeSchema.parse({workspace_id:db.workspaceId,environment});}
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
/** A durable result shares the transaction with all catalog writes. Retrying
 * the same explicit operation key cannot create another variant or release.
 */
export async function marketOperation<T extends object>(db:ProfileExecutor,environment:MarketEnvironment,actorId:string,operationId:string,request:unknown,work:()=>Promise<T>):Promise<T>{
 scope(db,environment);operationId=uuid.parse(operationId);need(actorId.length>0,'MARKET_ACTOR_REQUIRED',400);
 const key=JSON.stringify(['market-operation',db.workspaceId,environment,actorId,operationId]);
 need((await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0]?.acquired===true,'MARKET_OPERATION_BUSY');
 const existing=(await db.query('SELECT request_hash,result FROM market_operations WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND operation_id=$4',[db.workspaceId,environment,actorId,operationId])).rows[0];
 const requestHash=hash(stableJson(request));
 if(existing){need(existing.request_hash===requestHash,'MARKET_OPERATION_CONFLICT');return existing.result as T;}
 const result=await work();
 await db.query('INSERT INTO market_operations(workspace_id,environment,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',[db.workspaceId,environment,actorId,operationId,requestHash,result]);
 return result;
}
export async function readMarketOperation(db:ProfileExecutor,environment:MarketEnvironment,actorId:string,operationId:string){
 scope(db,environment);operationId=uuid.parse(operationId);
 const row=(await db.query('SELECT result FROM market_operations WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND operation_id=$4',[db.workspaceId,environment,actorId,operationId])).rows[0];
 need(row,'MARKET_NOT_FOUND',404);return row.result;
}
export function marketDraftHash(value:unknown){return hash(stableJson(marketDraftFieldsSchema.parse(value)));}
export function marketRecordVersionHash(row:{record_id:string;workspace_id:string;environment:string;kind:string;version:number;body:unknown}){
 return hash(stableJson({id:row.record_id,workspace_id:row.workspace_id,environment:row.environment,kind:row.kind,revision:row.version,body:row.body}));
}
interface VariantRow{id:string;family_id:string;version:number;draft:unknown;current_release_id:string|null;source_release_id:string|null;release_revision:number}
function view(row:VariantRow){return{id:row.id,family_id:row.family_id,version:row.version,
 draft:marketDraftFieldsSchema.parse(row.draft),draft_sha256:marketDraftHash(row.draft),
 current_release_id:row.current_release_id,source_release_id:row.source_release_id,release_revision:row.release_revision};}
async function variant(db:ProfileExecutor,environment:MarketEnvironment,id:string,lock=false){
 scope(db,environment);id=uuid.parse(id);
 const row=(await db.query<VariantRow>(`SELECT id,family_id,version,draft,current_release_id,source_release_id,release_revision
 FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND id=$3`+(lock?' FOR UPDATE':''),[db.workspaceId,environment,id])).rows[0];
 need(row,'MARKET_NOT_FOUND',404);return row;
}
async function event(db:ProfileExecutor,environment:MarketEnvironment,row:VariantRow,actorId:string,kind:string,releaseId:string|null=null){
 need(typeof actorId==='string'&&actorId.length>0,'MARKET_ACTOR_REQUIRED',400);
 await db.query(`INSERT INTO market_variant_events(workspace_id,environment,variant_id,version,event,actor_id,release_id)
 VALUES($1,$2,$3,$4,$5,$6,$7)`,[db.workspaceId,environment,row.id,row.version,kind,actorId,releaseId]);
}

/** Family identity is the real product ID; no automatic product/Mexico migration. */
export async function adoptMarketFamily(db:ProfileExecutor,environment:MarketEnvironment,input:unknown){
 scope(db,environment);const q=marketFamilyCreateSchema.parse(input);
 const product=(await db.query(`SELECT id,version FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='product' AND id=$3 FOR SHARE`,[db.workspaceId,environment,q.product_id])).rows[0];
 need(product,'MARKET_NOT_FOUND',404);need(product.version===q.expected_product_version,'MARKET_PRODUCT_CHANGED');
 await db.query(`INSERT INTO market_families(workspace_id,environment,id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[db.workspaceId,environment,q.product_id]);
 return{id:product.id};
}
export async function createMarketDraft(db:ProfileExecutor,environment:MarketEnvironment,input:unknown,actorId:string,sourceReleaseId:string|null=null){
 scope(db,environment);const q=marketDraftCreateSchema.parse(input),id=randomUUID();
 need((await db.query('SELECT id FROM market_families WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,environment,q.family_id])).rows.length===1,'MARKET_NOT_FOUND',404);
 const row=(await db.query<VariantRow>(`INSERT INTO market_variants(workspace_id,environment,id,family_id,draft,source_release_id)
 VALUES($1,$2,$3,$4,$5,$6) RETURNING id,family_id,version,draft,current_release_id,source_release_id,release_revision`,[db.workspaceId,environment,id,q.family_id,q.fields,sourceReleaseId])).rows[0]!;
 await event(db,environment,row,actorId,'DRAFT_CREATED');return view(row);
}
export async function readMarketVariant(db:ProfileExecutor,environment:MarketEnvironment,id:string){return view(await variant(db,environment,id));}
export async function listMarketVariants(db:ProfileExecutor,input:unknown){
 const q=marketVariantListSchema.parse(input);scope(db,q.environment);
 need((await db.query('SELECT id FROM market_families WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,q.environment,q.family_id])).rows.length===1,'MARKET_NOT_FOUND',404);
 const rows=(await db.query<VariantRow>(`SELECT id,family_id,version,draft,current_release_id,source_release_id,release_revision
 FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND family_id=$3 AND ($4::uuid IS NULL OR id>$4)
 ORDER BY id LIMIT $5`,[db.workspaceId,q.environment,q.family_id,q.after??null,q.limit+1])).rows;
 const data=rows.slice(0,q.limit).map(view);return{data,meta:{has_more:rows.length>q.limit,next:rows.length>q.limit?data.at(-1)!.id:null}};
}
export async function replaceMarketDraft(db:ProfileExecutor,environment:MarketEnvironment,id:string,input:unknown,actorId:string){
 id=uuid.parse(id);const q=marketDraftReplaceSchema.parse(input),old=await variant(db,environment,id,true);
 need(old.version===q.expected_version,'MARKET_VERSION_CONFLICT');
 const row=(await db.query<VariantRow>(`UPDATE market_variants SET draft=$4,version=version+1,updated_at=clock_timestamp()
 WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$5 RETURNING id,family_id,version,draft,current_release_id,source_release_id,release_revision`,
 [db.workspaceId,environment,id,q.fields,q.expected_version])).rows[0];
 need(row,'MARKET_VERSION_CONFLICT');await event(db,environment,row,actorId,'DRAFT_REPLACED');return view(row);
}
export async function readMarketRelease(db:ProfileExecutor,environment:MarketEnvironment,id:string):Promise<MarketRelease>{
 const expected=scope(db,environment);id=uuid.parse(id);
 const row=(await db.query(`SELECT body,sha256 FROM market_releases WHERE workspace_id=$1 AND environment=$2 AND id=$3`,[db.workspaceId,environment,id])).rows[0];
 need(row,'MARKET_NOT_FOUND',404);const result=marketReleaseSchema.parse(row.body);
 need(result.id===id&&result.scope.workspace_id===expected.workspace_id&&result.scope.environment===expected.environment&&marketReleaseHash(result)===row.sha256,'MARKET_RELEASE_CORRUPT');return result;
}
async function configurationRecord(db:ProfileExecutor,environment:MarketEnvironment,kind:string,raw:unknown){
 const ref=marketVersionRefSchema.parse(raw);
 const row=(await db.query(`SELECT v.record_id,v.workspace_id,v.environment,v.kind,v.version,v.body
 FROM record_versions v JOIN records r ON r.id=v.record_id AND r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.kind=v.kind
 WHERE v.workspace_id=$1 AND v.environment=$2 AND v.kind=$3 AND v.record_id=$4 AND v.version=$5 FOR SHARE OF r`,[db.workspaceId,environment,kind,ref.id,ref.revision])).rows[0];
 need(row&&marketRecordVersionHash(row)===ref.sha256,'MARKET_CONFIGURATION_CHANGED');return row.body;
}
async function validateConfiguration(db:ProfileExecutor,environment:MarketEnvironment,familyId:string,fields:ReturnType<typeof marketDraftFieldsSchema.parse>){
 const c=fields.configuration;
 const offer=await configurationRecord(db,environment,'offer',c.offer);
 const flow=await configurationRecord(db,environment,'workflow',c.flow);
 const seller=await configurationRecord(db,environment,'agent',c.seller);
 const bank=await configurationRecord(db,environment,'bank_profile',c.collection);
 need(stableJson(c.remarketing)===stableJson(c.offer),'MARKET_REMARKETING_VERSION_CHANGED');
 need(offer.status==='PUBLISHED'&&flow.status==='PUBLISHED','MARKET_CONFIGURATION_UNPUBLISHED');
 need(offer.product_id===familyId&&(!flow.product_id||flow.product_id===familyId)&&(!seller.product_id||seller.product_id===familyId),'MARKET_CONFIGURATION_FAMILY_CHANGED');
 need(offer.currency===fields.locale.currency&&bank.currency===fields.locale.currency&&offer.base_amount_minor===fields.amount_minor,'MARKET_PRICE_CHANGED');
 need(offer.workflow_version_id===c.flow.id&&offer.agent_version_id===c.seller.id&&offer.payment_profile_version_id===c.collection.id,'MARKET_CONFIGURATION_LINK_CHANGED');
 need(Array.isArray(offer.fulfillment)&&offer.fulfillment.every((item:{asset_id?:string})=>c.materials.some(ref=>ref.id===item.asset_id)),'MARKET_FULFILLMENT_CHANGED');
 for(const ref of c.materials)await configurationRecord(db,environment,'asset',ref);
}

/** Catalog publication only. No binding, campaign, authorization or effect is created. */
export async function publishMarketRelease(db:ProfileExecutor,environment:MarketEnvironment,id:string,input:unknown,actorId:string){
 id=uuid.parse(id);const q=marketPublishSchema.parse(input),old=await variant(db,environment,id,true);
 need(old.version===q.expected_version&&marketDraftHash(old.draft)===q.draft_sha256,'MARKET_VERSION_CONFLICT');
 const fields=marketDraftFieldsSchema.parse(old.draft);await validateConfiguration(db,environment,old.family_id,fields);
 const release=marketReleaseSchema.parse({id:randomUUID(),scope:scope(db,environment),family_id:old.family_id,variant_id:id,revision:old.release_revision+1,...fields});
 const digest=marketReleaseHash(release);
 await db.query(`INSERT INTO market_releases(workspace_id,environment,id,variant_id,revision,body,sha256) VALUES($1,$2,$3,$4,$5,$6,$7)`,[db.workspaceId,environment,release.id,id,release.revision,release,digest]);
 const current=(await db.query<VariantRow>(`UPDATE market_variants SET current_release_id=$4,release_revision=$5,version=version+1,updated_at=clock_timestamp()
 WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$6 RETURNING id,family_id,version,draft,current_release_id,source_release_id,release_revision`,[db.workspaceId,environment,id,release.id,release.revision,old.version])).rows[0];
 need(current,'MARKET_VERSION_CONFLICT');await event(db,environment,current,actorId,'RELEASE_PUBLISHED',release.id);
 return{variant:view(current),release,sha256:digest,effects_authorized:false as const};
}
export async function copyMarketDraft(db:ProfileExecutor,environment:MarketEnvironment,input:unknown,actorId:string){
 const q=marketCopySchema.parse(input),source=await readMarketRelease(db,environment,q.source_release_id);
 const copy=duplicateMarketDraft({scope:scope(db,environment),source,new_variant_id:randomUUID(),locale:q.locale});
 const draft=await createMarketDraft(db,environment,{family_id:source.family_id,fields:{locale:copy.locale,amount_minor:copy.suggested_amount_minor,configuration:copy.configuration}},actorId,source.id);
 return{...draft,source_release:copy.source_release,pending_review:copy.pending_review,publication_authorized:false as const};
}

/** Internal F3 seam: the caller must have created/authorized the real journey.
 * References are loaded from SQL, never accepted as verified request data.
 */
export async function captureMarketJourney(db:ProfileExecutor,environment:MarketEnvironment,journeyId:string,releaseId:string):Promise<MarketJourneySnapshot>{
 scope(db,environment);journeyId=uuid.parse(journeyId);
 const journey=(await db.query(`SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND id=$3 FOR SHARE`,[db.workspaceId,environment,journeyId])).rows[0];
 need(journey,'MARKET_NOT_FOUND',404);const j=journey.body,release=await readMarketRelease(db,environment,releaseId),c=release.configuration;
 need(j.product_id===release.family_id&&j.offer_version_id===c.offer.id&&j.workflow_version_id===c.flow.id&&j.agent_version_id===c.seller.id,'MARKET_JOURNEY_CONFIGURATION_CHANGED');
 for(const[kind,id]of [['channel_account',j.account_id],['contact',j.contact_id]] as const){uuid.parse(id);need((await db.query('SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND id=$4',[db.workspaceId,environment,kind,id])).rows.length===1,'MARKET_JOURNEY_SCOPE_CHANGED');}
 uuid.parse(j.binding_id);
 const binding=(await db.query(`SELECT id AS record_id,workspace_id,environment,kind,version,body FROM records
 WHERE workspace_id=$1 AND environment=$2 AND kind='binding' AND id=$3 FOR SHARE`,[db.workspaceId,environment,j.binding_id])).rows[0];
 need(binding&&binding.body.account_id===j.account_id&&binding.body.offer_version_id===c.offer.id&&binding.body.workflow_version_id===c.flow.id&&binding.body.agent_version_id===c.seller.id,'MARKET_JOURNEY_BINDING_CHANGED');
 const snapshot=snapshotMarketJourney({journey_id:journeyId,chat:{...scope(db,environment),account_id:j.account_id,contact_id:j.contact_id},release,
 binding:{id:binding.record_id,revision:binding.version,sha256:marketRecordVersionHash(binding)}});
 await db.query(`INSERT INTO market_journey_snapshots(workspace_id,environment,journey_id,release_id,body)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[db.workspaceId,environment,journeyId,release.id,snapshot]);
 const existing=await readMarketJourney(db,environment,journeyId);
 need(stableJson(existing)===stableJson(snapshot),'MARKET_JOURNEY_SNAPSHOT_CONFLICT');return existing;
}
export async function readMarketJourney(db:ProfileExecutor,environment:MarketEnvironment,journeyId:string){
 scope(db,environment);journeyId=uuid.parse(journeyId);
 const row=(await db.query('SELECT body FROM market_journey_snapshots WHERE workspace_id=$1 AND environment=$2 AND journey_id=$3',[db.workspaceId,environment,journeyId])).rows[0];
 need(row,'MARKET_NOT_FOUND',404);const value=marketJourneySnapshotSchema.parse(row.body);
 need(value.journey_id===journeyId&&value.chat.workspace_id===db.workspaceId&&value.chat.environment===environment,'MARKET_SNAPSHOT_CORRUPT');
 need(stableJson(value.release)===stableJson(await readMarketRelease(db,environment,value.release.id)),'MARKET_SNAPSHOT_CORRUPT');
 return value;
}
