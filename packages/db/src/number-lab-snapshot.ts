import {z} from 'zod';
import {schemas,type Body} from '../../contracts/src/index.js';
import {marketReleaseSchema,type MarketRelease,type MarketRouteCandidate} from '../../contracts/src/market-variants.js';
import type {NumberLabSnapshot} from '../../contracts/src/number-laboratory.js';
import {marketReleaseHash} from '../../domain/src/catalog/market-variants.js';
import {labConfigurationReferences} from '../../domain/src/laboratory/configuration-references.js';
import {labHash,validateLabSnapshot} from '../../domain/src/laboratory/number-lab.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {marketRecordVersionHash} from './market-variants.js';
import type {ProfileExecutor} from './profile-context.js';
function need(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
const uuid=z.string().uuid().transform(v=>v.toLowerCase());
interface Version {record_id:string;workspace_id:string;environment:string;kind:string;version:number;body:Body}
export interface LabConfigurationRecord {kind:string;ref:{id:string;revision:number;sha256:string};body:Body}
export interface LabCapturedConfiguration {snapshot:NumberLabSnapshot;records:LabConfigurationRecord[]}
/** Closed schema-owned configuration only. Secret/storage/access references stay
 * in the REAL asset/credential broker, never become simulator configuration. */
function projection(row:Version):Body{
 const schema=schemas[row.kind] as z.ZodObject<any>|undefined;need(schema&&schema.shape,'LAB_SOURCE_KIND');
 const values=Object.fromEntries(Object.keys(schema.shape).filter(k=>Object.hasOwn(row.body,k)).map(k=>[k,structuredClone(row.body[k])]));
 const scrub=(v:any):any=>Array.isArray(v)?v.map(scrub):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!/(ciphertext|storage_key|delivery_reference|gateway|authorization|access_code|password|token|api_key)/i.test(k)).map(([k,x])=>[k,scrub(x)])):v;
 const clean=scrub(values);if(row.kind==='offer')clean.product_id=row.body.product_id;
 if(['workflow','offer'].includes(row.kind))clean.status=row.body.status;
 if(row.kind==='asset'){clean.status=row.body.status;if(row.body.kind!=='file')delete clean.url;}
 if(row.kind==='bank_profile'){delete clean.account_number;delete clean.holder;}
 return clean;
}
/** Read only, inside withProfileRequest(tests:run) and its live executor. No
 * phone, QR status, channel credential or outbound permission is needed. */
/** config.variantId (RF-19.p): the automatic buyer captures one variant of the
 * number per journey; its other assignments stay out of that run. */
export async function captureNumberLab(db:ProfileExecutor,authority:ProfileAuthority,accountId:string,config:{engineSha256:string;aiConfigurationVersion:number;variantId?:string}):Promise<LabCapturedConfiguration>{
 accountId=uuid.parse(accountId);need(/^[a-f0-9]{64}$/.test(config.engineSha256)&&Number.isSafeInteger(config.aiConfigurationVersion)&&config.aiConfigurationVersion>0,'LAB_RUNTIME_CONFIG');
 const now=async()=>new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);
 const started=await now();authorizeProfileAction(authority,{scope:'tests:run',workspaceId:db.workspaceId,mutation:true},started);
 const account=(await db.query<Version>(`SELECT id AS record_id,workspace_id,environment,kind,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='channel_account' AND id=$2 FOR SHARE`,[db.workspaceId,accountId])).rows[0];need(account,'LAB_ACCOUNT_NOT_FOUND');
 // Do not silently fall back to an old binding when a canonical row exists but
 // is paused/retired. Publication/adoption of a variant remains a separate action.
 const assignments=(await db.query(`SELECT a.*,b.version AS binding_version,b.body AS binding_body FROM commercial_assignments a JOIN records b ON b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.id=a.binding_id AND b.kind='binding' WHERE a.workspace_id=$1 AND a.environment='REAL' AND a.account_id=$2 ORDER BY a.id LIMIT 21 FOR SHARE OF a,b`,[db.workspaceId,accountId])).rows;
 need(assignments.length>0&&assignments.length<=20,'LAB_ASSIGNMENT_COVERAGE');
 const active=assignments.filter(a=>a.state==='ACTIVE'&&Date.parse(a.binding_body.valid_from)<=started.getTime()&&(!a.binding_body.valid_to||Date.parse(a.binding_body.valid_to)>started.getTime())&&(config.variantId===undefined||a.variant_id===config.variantId));need(active.length>0,'LAB_ASSIGNMENT_NOT_CURRENT');
 const sources=new Map<string,LabConfigurationRecord>(),candidates:MarketRouteCandidate[]=[],tiers:NumberLabSnapshot['tiers']=[];
 const load=async(kind:string,ref:{id:string;revision:number;sha256:string})=>{
  const k=kind+':'+ref.id+':'+ref.revision,old=sources.get(k);if(old){need(old.ref.sha256===ref.sha256,'LAB_SOURCE_CONFLICT');return old;}
  need(sources.size<300,'LAB_SOURCE_LIMIT');const row=(await db.query<Version>(`SELECT v.record_id,v.workspace_id,v.environment,v.kind,v.version,v.body FROM record_versions v JOIN records r ON r.id=v.record_id AND r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.kind=v.kind WHERE v.workspace_id=$1 AND v.environment='REAL' AND v.kind=$2 AND v.record_id=$3 AND v.version=$4 FOR SHARE OF r`,[db.workspaceId,kind,ref.id,ref.revision])).rows[0];need(row&&marketRecordVersionHash(row)===ref.sha256,'LAB_SOURCE_CHANGED');
  need(row.kind!=='asset'||row.body.status==='READY','LAB_ASSET_NOT_READY');
  need(!['workflow','offer'].includes(row.kind)||row.body.status==='PUBLISHED','LAB_SOURCE_NOT_PUBLISHED');
  const source={kind,ref:structuredClone(ref),body:projection(row)};sources.set(k,source);return source;
 };
 for(const assignment of active){const b=assignment.binding_body;
  const bindingRef={id:assignment.binding_id,revision:assignment.binding_version,sha256:marketRecordVersionHash({record_id:assignment.binding_id,workspace_id:db.workspaceId,environment:'REAL',kind:'binding',version:assignment.binding_version,body:b})};
  await load('binding',bindingRef);
  // V7 F4: an assignment that follows a variant is tested with that variant's
  // current release (what a new conversation would use); otherwise the release
  // pinned by the binding, exactly as before.
  const matches=assignment.variant_id
   ?(await db.query(`SELECT r.body,r.sha256 FROM market_variants v JOIN market_releases r ON r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.id=v.current_release_id AND r.variant_id=v.id WHERE v.workspace_id=$1 AND v.environment='REAL' AND v.family_id=$2 AND v.id=$3 AND v.archived_at IS NULL FOR SHARE OF v`,[db.workspaceId,assignment.product_id,assignment.variant_id])).rows
   :(await db.query(`SELECT r.body,r.sha256 FROM market_variants v JOIN market_releases r ON r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.id=v.current_release_id AND r.variant_id=v.id WHERE v.workspace_id=$1 AND v.environment='REAL' AND v.family_id=$2 AND r.body->'configuration'->'offer'->>'id'=$3 AND r.body->'configuration'->'flow'->>'id'=$4 AND r.body->'configuration'->'seller'->>'id'=$5 ORDER BY v.id LIMIT 2 FOR SHARE OF v`,[db.workspaceId,assignment.product_id,b.offer_version_id,b.workflow_version_id,b.agent_version_id])).rows;
  need(matches.length===1,'LAB_VARIANT_BINDING_REQUIRED');const release:MarketRelease=marketReleaseSchema.parse(matches[0].body);need(release.scope.workspace_id===db.workspaceId&&release.scope.environment==='REAL'&&release.family_id===assignment.product_id&&marketReleaseHash(release)===matches[0].sha256,'LAB_RELEASE_CHANGED');
  const c=release.configuration;need(labHash(c.remarketing)===labHash(c.offer),'LAB_REMARKETING_REFERENCE');
  const offer=await load('offer',c.offer);await load('workflow',c.flow);await load('agent',c.seller);await load('bank_profile',c.collection);for(const ref of c.materials){const asset=await load('asset',ref);need(asset.body.status==='READY','LAB_ASSET_NOT_READY');}
  need(offer.body.status==='PUBLISHED'&&offer.body.product_id===release.family_id&&offer.body.currency===release.locale.currency&&offer.body.base_amount_minor===release.amount_minor,'LAB_OFFER_CHANGED');
  const product=(await db.query<Version>(`SELECT id AS record_id,workspace_id,environment,kind,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='product' AND id=$2 FOR SHARE`,[db.workspaceId,release.family_id])).rows[0];need(product,'LAB_PRODUCT_MISSING');await load('product',{id:product.record_id,revision:product.version,sha256:marketRecordVersionHash(product)});
  if(offer.body.receipt_policy_version_id){const policy=(await db.query<Version>(`SELECT id AS record_id,workspace_id,environment,kind,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='receipt_policy' AND id=$2 FOR SHARE`,[db.workspaceId,offer.body.receipt_policy_version_id])).rows[0];need(policy,'LAB_RECEIPT_POLICY_MISSING');await load('receipt_policy',{id:policy.record_id,revision:policy.version,sha256:marketRecordVersionHash(policy)});}
  candidates.push({binding:bindingRef,account_id:accountId,state:'ACTIVE',release});
  tiers.push({variant_id:release.variant_id,tier_ids:offer.body.tiers?.length?offer.body.tiers.map((t:any)=>t.id):['base']});
 }
 // Freeze every explicit release root before resolving an unversioned nested
 // reference. Two pinned revisions must never be selected by iteration order.
 const selected=new Map<string,LabConfigurationRecord>();
 for(const source of sources.values()){
  const key=source.kind+':'+source.ref.id;
  need(!selected.has(key)||selected.get(key)!.ref.revision===source.ref.revision,'LAB_SOURCE_VERSION_AMBIGUOUS');selected.set(key,source);
 }
 const pending=[...sources.values()];
 for(let index=0;index<pending.length;index++){
  const source=pending[index]!;
  if(['binding','acquisition_campaign','ad_set'].includes(source.kind)&&source.body.account_id!==undefined)need(source.body.account_id===accountId,'LAB_CONFIGURATION_ACCOUNT_CHANGED');
  for(const target of labConfigurationReferences(source.body)){
   const key=target.kind+':'+target.id;if(selected.has(key))continue;
   const row=(await db.query<Version>(`SELECT id AS record_id,workspace_id,environment,kind,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind=$2 AND id=$3 FOR SHARE`,[db.workspaceId,target.kind,target.id])).rows[0];
   need(row,'LAB_REFERENCE_MISSING');const loaded=await load(target.kind,{id:row.record_id,revision:row.version,sha256:marketRecordVersionHash(row)});
   selected.set(key,loaded);pending.push(loaded);
  }
 }
 const ended=await now();need(ended.getTime()>=started.getTime()&&ended.getTime()-started.getTime()<=120000&&active.every(a=>!a.binding_body.valid_to||Date.parse(a.binding_body.valid_to)>ended.getTime()),'LAB_CAPTURE_EXPIRED');authorizeProfileAction(authority,{scope:'tests:run',workspaceId:db.workspaceId,mutation:true},ended);
 const records=[...sources.values()].sort((a,b)=>(a.kind+':'+a.ref.id).localeCompare(b.kind+':'+b.ref.id));
 const snapshot=validateLabSnapshot({schema_version:1,workspace_id:db.workspaceId,source_environment:'REAL',account:{id:accountId,revision:account.version,sha256:marketRecordVersionHash(account)},captured_at:started.toISOString(),engine_sha256:config.engineSha256,configuration_sha256:labHash(records),ai_configuration_version:config.aiConfigurationVersion,candidates,sources:records.map(r=>({kind:r.kind,ref:r.ref})),tiers});
 return{snapshot,records};
}
