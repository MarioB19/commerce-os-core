import {createHash} from 'node:crypto';
import {numberLabSnapshotSchema,numberLabActionSchema,labScenarios,type NumberLabSnapshot,type NumberLabAction} from '../../../contracts/src/number-laboratory.js';
import {resolveMarketRoute} from '../catalog/market-variants.js';
import {resolveModel,quote} from '../../../ai-providers/src/catalog.js';
import type {Model,ProfileConfiguration,Quote} from '../../../ai-providers/src/contracts.js';
import type {MarketRouteInput} from '../../../contracts/src/market-variants.js';
function need(value:unknown,code:string):asserts value{if(!value)throw new Error(code);}
export function labCanonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(labCanonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+labCanonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export const labHash=(value:unknown)=>createHash('sha256').update(labCanonical(value)).digest('hex');
const equal=(a:unknown,b:unknown)=>labCanonical(a)===labCanonical(b);
export function validateLabSnapshot(raw:unknown):NumberLabSnapshot{
 const value=numberLabSnapshotSchema.parse(raw),variants=value.candidates.map(c=>c.release.variant_id);
 need(new Set(variants).size===variants.length&&new Set(value.candidates.map(c=>c.binding.id)).size===variants.length&&new Set(value.candidates.map(c=>c.release.id)).size===variants.length,'LAB_CATALOG_AMBIGUOUS');
 need(value.candidates.every(c=>c.state==='ACTIVE'&&c.account_id===value.account.id&&c.release.scope.workspace_id===value.workspace_id&&c.release.scope.environment==='REAL'),'LAB_SNAPSHOT_SCOPE');
 need(new Set(value.sources.map(s=>s.kind+':'+s.ref.id+':'+s.ref.revision)).size===value.sources.length,'LAB_DUPLICATE_SOURCE');
 for(const candidate of value.candidates){const c=candidate.release.configuration;
  for(const [kind,ref]of [['offer',c.offer],['workflow',c.flow],['agent',c.seller],['bank_profile',c.collection],['offer',c.remarketing],...c.materials.map(r=>['asset',r])]as const)
   need(value.sources.some(s=>s.kind===kind&&equal(s.ref,ref)),'LAB_CONFIGURATION_INCOMPLETE');
 }
 need(value.tiers.length===variants.length&&new Set(value.tiers.map(t=>t.variant_id)).size===variants.length&&value.tiers.every(t=>variants.includes(t.variant_id)&&new Set(t.tier_ids).size===t.tier_ids.length),'LAB_TIERS_INCOMPLETE');
 return value;
}
export type LabScenario=typeof labScenarios[number];
export interface LabCase {key:string;variant_id:string;release_id:string;tier_id:string;scenario:LabScenario;maximum_ai_calls:number;quote:Quote}
export interface LabEstimate {schema_version:1;snapshot_sha256:string;mode:'CHAT'|'AUTOMATIC';currency:'USD';maximum_microusd:number;maximum_ai_calls:number;cases:LabCase[];valid_until:string;sha256:string}
/** Trusted catalogue/profile configuration only. Callers cannot submit a price or model. */
/** scenarios (RF-19.p): the automatic buyer runs one journey per run. */
export function estimateNumberLab(raw:unknown,mode:'CHAT'|'AUTOMATIC',profile:ProfileConfiguration,catalog:readonly Model[],now:number,scenarios?:readonly LabScenario[]):LabEstimate{
 const snapshot=validateLabSnapshot(raw);need(['CHAT','AUTOMATIC'].includes(mode)&&Number.isFinite(now)&&profile.profileId===snapshot.workspace_id&&profile.version===snapshot.ai_configuration_version,'LAB_AI_SCOPE');
 need(Date.parse(snapshot.captured_at)<=now&&now-Date.parse(snapshot.captured_at)<=120000,'LAB_SNAPSHOT_STALE');
 need(scenarios===undefined||(scenarios.length>0&&scenarios.every(s=>(labScenarios as readonly string[]).includes(s))&&new Set(scenarios).size===scenarios.length),'LAB_SCENARIOS');
 const cases:LabCase[]=[];let total=0n,calls=0,expiry=now+120000;
 for(const c of [...snapshot.candidates].sort((a,b)=>a.release.variant_id.localeCompare(b.release.variant_id))){
  const selected=resolveModel(profile,c.release.variant_id,'chat',catalog,now);need(selected.state==='MODEL','LAB_AI_DEPENDENCY_REQUIRED');
  const q=quote(snapshot.workspace_id,selected.model,Number.MAX_SAFE_INTEGER,now);expiry=Math.min(expiry,Date.parse(selected.model.price.validUntil));
  for(const tier of [...snapshot.tiers.find(t=>t.variant_id===c.release.variant_id)!.tier_ids].sort())for(const scenario of mode==='AUTOMATIC'?(scenarios??labScenarios):['happy']as const){
   // This is an enforced upper bound, not a promised amount spent. Partial runs
   // retain the original limit and report any unexecuted cases explicitly.
   const maximum=mode==='AUTOMATIC'?8:32,key=labHash({variant:c.release.variant_id,release:c.release.id,tier,scenario});
   cases.push({key,variant_id:c.release.variant_id,release_id:c.release.id,tier_id:tier,scenario,maximum_ai_calls:maximum,quote:q});calls+=maximum;total+=BigInt(maximum)*BigInt(q.maximumMicrousd);
  }
 }
 need(total<=BigInt(Number.MAX_SAFE_INTEGER)&&calls<=19200&&expiry>now,'LAB_ESTIMATE_LIMIT');
 const estimate={schema_version:1 as const,snapshot_sha256:labHash(snapshot),mode,currency:'USD' as const,maximum_microusd:Number(total),maximum_ai_calls:calls,cases,valid_until:new Date(expiry).toISOString()};return{...estimate,sha256:labHash(estimate)};
}
/** Same F4 resolver, using the original captured commercial scope. No write or
 * external permission is created by selecting a release for a synthetic journey. */
export function resolveNumberLab(raw:unknown,syntheticContactId:string,input:{variant_id?:string;origin?:'EXPLICIT'|'ADVERTISEMENT'}={}){
 const s=validateLabSnapshot(raw),c=input.variant_id?s.candidates.find(c=>c.release.variant_id===input.variant_id):undefined;
 need(input.variant_id===undefined||c,'LAB_VARIANT_NOT_IN_SNAPSHOT');need(input.origin===undefined||input.variant_id,'LAB_ORIGIN_REQUIRES_VARIANT');
 const evidence=c?{id:c.binding.id,sha256:labHash({snapshot:labHash(s),variant:c.release.variant_id,origin:input.origin??'EXPLICIT'})}:undefined;
 const route:MarketRouteInput={chat:{workspace_id:s.workspace_id,environment:'REAL',account_id:s.account.id,contact_id:syntheticContactId},protections:[],candidates:s.candidates,open_journeys:[],origins:c&&input.origin==='ADVERTISEMENT'?[{binding:c.binding,variant_id:c.release.variant_id,evidence:evidence!}]:[],selections:c&&input.origin!=='ADVERTISEMENT'?[{variant_id:c.release.variant_id,release_id:c.release.id,evidence:evidence!}]:[]};
 return resolveMarketRoute(route);
}
export function advanceLabClock(current:string,action:unknown):string{
 const a=numberLabActionSchema.parse(action);need(a.type==='advance','LAB_CLOCK_ACTION_REQUIRED');const instant=Date.parse(current);need(Number.isFinite(instant),'LAB_CLOCK_INVALID');return new Date(instant+a.hours*3600000).toISOString();
}
export interface LabCaseResult {key:string;state:'PENDING'|'RUNNING'|'PASSED'|'FAILED'|'UNKNOWN';checks:readonly {name:string;passed:boolean}[]}
export function summarizeNumberLab(estimate:LabEstimate,results:readonly LabCaseResult[]){
 need(results.length<=estimate.cases.length&&new Set(results.map(r=>r.key)).size===results.length&&results.every(r=>estimate.cases.some(c=>c.key===r.key)),'LAB_REPORT_SCOPE');
 const required=['route','offer','collection','receipt','delivery','followup'];
 const variants=[...new Set(estimate.cases.map(c=>c.variant_id))].map(variant_id=>{const cases=estimate.cases.filter(c=>c.variant_id===variant_id).map(c=>({planned:c,result:results.find(r=>r.key===c.key)}));
  const complete=cases.every(c=>c.result?.state==='PASSED'&&c.result.checks.length===required.length&&new Set(c.result.checks.map(x=>x.name)).size===required.length&&required.every(name=>c.result!.checks.some(x=>x.name===name&&x.passed)));
  return{variant_id,state:complete?'PASSED' as const:cases.some(c=>c.result?.state==='FAILED')?'FAILED' as const:'PARTIAL' as const,planned:cases.length,completed:cases.filter(c=>c.result?.state==='PASSED').length};});
 return{state:variants.every(v=>v.state==='PASSED')?'PASSED' as const:'PARTIAL' as const,variants};
}
export type {NumberLabAction};
