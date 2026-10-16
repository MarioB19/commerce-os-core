import {createHash} from 'node:crypto';
import {z} from 'zod';
import {marketScopeSchema,marketLocaleSchema,marketReleaseSchema,marketDraftCopySchema,
 marketJourneySnapshotSchema,marketRouteInputSchema,marketCopyReviewFields,
 type MarketScope,type MarketRelease,type MarketJourneySnapshot,type MarketRouteInput,
 type MarketRouteCandidate,type MarketDraftCopy} from '../../../contracts/src/market-variants.js';

function need(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}
function sameScope(a:MarketScope,b:MarketScope){return a.workspace_id===b.workspace_id&&a.environment===b.environment;}
function sameRef(a:MarketRouteCandidate['binding'],b:MarketRouteCandidate['binding']){
 return a.id===b.id&&a.revision===b.revision&&a.sha256===b.sha256;
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)
  .map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
 return JSON.stringify(value);
}
export function marketReleaseHash(release:unknown):string{
 return createHash('sha256').update(canonical(marketReleaseSchema.parse(release))).digest('hex');
}

/** Draft only. The old price is a suggestion, never converted or published. */
export function duplicateMarketDraft(input:unknown):MarketDraftCopy{
 const request=z.object({scope:marketScopeSchema,source:marketReleaseSchema,
  new_variant_id:z.string().uuid(),locale:marketLocaleSchema}).strict().parse(input);
 need(sameScope(request.scope,request.source.scope),'MARKET_SCOPE_MISMATCH');
 need(request.new_variant_id!==request.source.variant_id,'MARKET_COPY_ID_REUSED');
 const value={id:request.new_variant_id,scope:request.scope,family_id:request.source.family_id,
  revision:1 as const,status:'DRAFT' as const,locale:request.locale,
  source_release:{id:request.source.id,revision:request.source.revision,sha256:marketReleaseHash(request.source)},
  suggested_amount_minor:request.source.amount_minor,configuration:request.source.configuration,
  pending_review:[...marketCopyReviewFields],number_assignments:[],campaign_bindings:[],publication_authorized:false};
 // Zod returns a deep copy: callers cannot mutate the source release via a draft.
 return marketDraftCopySchema.parse(value);
}

/** Called only after the caller reserves a new journey in its scoped transaction. */
export function snapshotMarketJourney(input:unknown):MarketJourneySnapshot{
 const value=marketJourneySnapshotSchema.parse(input);
 need(sameScope(value.chat,value.release.scope),'MARKET_SCOPE_MISMATCH');
 return value;
}

type EvidenceRef=MarketRouteInput['selections'][number]['evidence'];
type Option={variant_id:string;family_id:string;release_id:string;market:string;currency:string;language:string};
export type MarketRouteResult=
 |{state:'BLOCKED';reason:'CURRENT_PROTECTION'|'SCOPE_MISMATCH'|'INCONSISTENT_CATALOG';protections:MarketRouteInput['protections']}
 |{state:'SELECTION_REQUIRED';reason:'MULTIPLE_OPEN_JOURNEYS'|'STALE_ORIGIN'|'CONFLICTING_ORIGINS'|'STALE_SELECTION'|'CONFLICTING_SELECTIONS'|'NO_ELIGIBLE_VARIANT'|'MULTIPLE_ELIGIBLE_VARIANTS';options:Option[]}
 |{state:'RESOLVED';reason:'OPEN_JOURNEY';snapshot:MarketJourneySnapshot;evidence:[];effects_authorized:false}
 |{state:'RESOLVED';reason:'CURRENT_ORIGIN'|'EXPLICIT_SELECTION'|'ONLY_ELIGIBLE_VARIANT';
   release:MarketRelease;binding:MarketRouteCandidate['binding'];evidence:EvidenceRef[];effects_authorized:false};

/** Routing only. The effect gate still revalidates current permissions/pauses. */
export function resolveMarketRoute(raw:unknown):MarketRouteResult{
 const input=marketRouteInputSchema.parse(raw);
 const blocked=(reason:'SCOPE_MISMATCH'|'INCONSISTENT_CATALOG'):MarketRouteResult=>({state:'BLOCKED',reason,protections:[]});
 if(input.protections.length)return {state:'BLOCKED',reason:'CURRENT_PROTECTION',protections:[...new Set(input.protections)]};
 // A polluted repository projection is rejected, not filtered to leak another profile.
 if(input.candidates.some(c=>!sameScope(c.release.scope,input.chat)||c.account_id!==input.chat.account_id)||
  input.open_journeys.some(j=>!sameScope(j.chat,input.chat)||!sameScope(j.release.scope,input.chat)||
   j.chat.account_id!==input.chat.account_id||j.chat.contact_id!==input.chat.contact_id))return blocked('SCOPE_MISMATCH');
 if(new Set(input.candidates.map(c=>c.binding.id)).size!==input.candidates.length||
  new Set(input.candidates.map(c=>c.release.id)).size!==input.candidates.length||
  new Set(input.open_journeys.map(j=>j.journey_id)).size!==input.open_journeys.length)return blocked('INCONSISTENT_CATALOG');
 const eligible=input.candidates.filter(c=>c.state==='ACTIVE');
 // A variant must have one current binding/release, never choose newest by position.
 if(new Set(eligible.map(c=>c.release.variant_id)).size!==eligible.length)return blocked('INCONSISTENT_CATALOG');
 const options=eligible.map(({release:r})=>({variant_id:r.variant_id,family_id:r.family_id,release_id:r.id,
  market:r.locale.market,currency:r.locale.currency,language:r.locale.language}))
  .sort((a,b)=>a.variant_id<b.variant_id?-1:a.variant_id>b.variant_id?1:0);
 const choose=(reason:Extract<MarketRouteResult,{state:'SELECTION_REQUIRED'}>['reason']):MarketRouteResult=>({state:'SELECTION_REQUIRED',reason,options});
 if(input.open_journeys.length>1)return choose('MULTIPLE_OPEN_JOURNEYS');
 if(input.open_journeys.length===1)return {state:'RESOLVED',reason:'OPEN_JOURNEY',snapshot:input.open_journeys[0]!,evidence:[],effects_authorized:false};
 const resolved=(candidate:MarketRouteCandidate,reason:'CURRENT_ORIGIN'|'EXPLICIT_SELECTION'|'ONLY_ELIGIBLE_VARIANT',evidence:EvidenceRef[]):MarketRouteResult=>
  ({state:'RESOLVED',reason,release:candidate.release,binding:candidate.binding,evidence,effects_authorized:false});
 if(input.origins.length){
  const matches=input.origins.map(origin=>eligible.find(c=>c.release.variant_id===origin.variant_id&&sameRef(c.binding,origin.binding)));
  if(matches.some(c=>!c))return choose('STALE_ORIGIN');
  if(new Set(matches.map(c=>c!.release.variant_id)).size!==1)return choose('CONFLICTING_ORIGINS');
  return resolved(matches[0]!, 'CURRENT_ORIGIN',input.origins.map(o=>o.evidence));
 }
 if(input.selections.length){
  const matches=input.selections.map(selection=>eligible.find(c=>c.release.variant_id===selection.variant_id&&c.release.id===selection.release_id));
  if(matches.some(c=>!c))return choose('STALE_SELECTION');
  if(new Set(matches.map(c=>c!.release.variant_id)).size!==1)return choose('CONFLICTING_SELECTIONS');
  return resolved(matches[0]!,'EXPLICIT_SELECTION',input.selections.map(s=>s.evidence));
 }
 if(eligible.length===1)return resolved(eligible[0]!,'ONLY_ELIGIBLE_VARIANT',[]);
 return choose(eligible.length?'MULTIPLE_ELIGIBLE_VARIANTS':'NO_ELIGIBLE_VARIANT');
}
