import {describe,it,expect} from 'vitest';
import {marketReleaseSchema,productFamilySchema,type MarketRelease,type MarketRouteInput} from '../../../contracts/src/market-variants.js';
import {duplicateMarketDraft,marketReleaseHash,resolveMarketRoute,snapshotMarketJourney} from './market-variants.js';

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const evidence=(n:number)=>({id:id(n),sha256:'a'.repeat(64)});
const ref=(n:number)=>({id:id(n),revision:1,sha256:'a'.repeat(64)});
function release(n=1):MarketRelease{return {id:id(n),scope:{workspace_id:'perfil-α',environment:'REAL'},
 family_id:id(10),variant_id:id(100+n),revision:1,locale:{market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'},
 amount_minor:9700,configuration:{offer:ref(201),flow:ref(202),seller:ref(203),collection:ref(204),remarketing:ref(205),materials:[ref(206)]}};}
function input(count=1):MarketRouteInput{return {chat:{workspace_id:'perfil-α',environment:'REAL',account_id:id(300),contact_id:id(301)},
 protections:[],candidates:Array.from({length:count},(_,n)=>({binding:ref(400+n),account_id:id(300),release:release(n+1),state:'ACTIVE'})),
 open_journeys:[],origins:[],selections:[]};}
function journey(value=input()){
 return snapshotMarketJourney({journey_id:id(500),chat:value.chat,release:value.candidates[0]!.release,binding:value.candidates[0]!.binding});
}
function origin(value:MarketRouteInput,n=0){return {binding:value.candidates[n]!.binding,variant_id:value.candidates[n]!.release.variant_id,evidence:evidence(600+n)};}
function selection(value:MarketRouteInput,n=0){return {variant_id:value.candidates[n]!.release.variant_id,release_id:value.candidates[n]!.release.id,evidence:evidence(700+n)};}

describe('market version contract',()=>{
 it('accepts a family and closed commercial version with explicit locale and minor units',()=>{
  expect(productFamilySchema.parse({id:id(10),scope:release().scope,name:'Curso',revision:1}).id).toBe(id(10));
  expect(marketReleaseSchema.parse(release())).toEqual(release());
 });
 it.each(['ZZZ','mxn','MXN ',''])('rejects invalid currency %s',currency=>{
  const r=release();r.locale.currency=currency;expect(()=>marketReleaseSchema.parse(r)).toThrow();
 });
 it.each(['es_MX','not a language','ES-mx',''])('rejects noncanonical language %s',language=>{
  const r=release();r.locale.language=language;expect(()=>marketReleaseSchema.parse(r)).toThrow();
 });
 it.each(['+06:00','America/Unknown',''])('rejects unknown or offset-only zone %s',timezone=>{
  const r=release();r.locale.timezone=timezone;expect(()=>marketReleaseSchema.parse(r)).toThrow();
 });
 it.each([-1,1.1,Number.MAX_SAFE_INTEGER+1,Infinity,NaN])('rejects nonexact amount %s',amount_minor=>{
  expect(()=>marketReleaseSchema.parse({...release(),amount_minor})).toThrow();
 });
 it('rejects duplicate materials, unknown properties, zero revisions and key fields',()=>{
  const r=release();r.configuration.materials.push(ref(206));expect(()=>marketReleaseSchema.parse(r)).toThrow();
  for(const r of [{...release(),revision:0},{...release(),api_key:'synthetic'},{...release(),configuration:{...release().configuration,credentials:[]}}])
   expect(()=>marketReleaseSchema.parse(r)).toThrow();
 });
 it('uses F2 textual profile IDs without trimming or allowing NUL',()=>{
  const r=release();r.scope.workspace_id=' perfil exacto ';expect(marketReleaseSchema.parse(r).scope.workspace_id).toBe(' perfil exacto ');
  for(const value of ['','a'.repeat(257),'profile\0other'])expect(()=>marketReleaseSchema.parse({...r,scope:{...r.scope,workspace_id:value}})).toThrow();
 });
 it('canonical hash ignores key insertion order but distinguishes price, currency and references',()=>{
  const r=release();expect(marketReleaseHash({...r,locale:{timezone:r.locale.timezone,language:r.locale.language,currency:r.locale.currency,market:r.locale.market}})).toBe(marketReleaseHash(r));
  for(const next of [{...r,amount_minor:9701},{...r,locale:{...r.locale,currency:'COP'}},{...r,configuration:{...r.configuration,offer:ref(999)}}])
   expect(marketReleaseHash(next)).not.toBe(marketReleaseHash(r));
 });
});

describe('duplicate draft, not permissions or FX',()=>{
 const request=()=>({scope:release().scope,source:release(),new_variant_id:id(900),locale:{market:'Brasil',currency:'BRL',language:'pt-BR',timezone:'America/Sao_Paulo'}});
 it('copies independently and retains all six review gates with no number/campaign binding',()=>{
  const value=request(),before=structuredClone(value),copy=duplicateMarketDraft(value);
  expect(copy.status).toBe('DRAFT');expect(copy.publication_authorized).toBe(false);
  expect(copy.number_assignments).toEqual([]);expect(copy.campaign_bindings).toEqual([]);
  expect(copy.pending_review).toEqual(['language','price_currency','collection','flow_seller','remarketing','materials']);
  expect(copy.suggested_amount_minor).toBe(9700);expect(copy.locale.currency).toBe('BRL');
  expect(copy.source_release.sha256).toBe(marketReleaseHash(value.source));
  copy.configuration.materials[0]!.revision=2;copy.locale.market='Alterado';expect(value).toEqual(before);
 });
 it('cannot present a draft copy as a published release or a routable candidate',()=>{
  const draft=duplicateMarketDraft(request());expect(()=>marketReleaseSchema.parse(draft)).toThrow();
  const value=input();expect(()=>resolveMarketRoute({...value,candidates:[{...value.candidates[0],release:draft}]})).toThrow();
 });
 it('rejects crossing profile/environment, ID reuse and any credentials or assignments',()=>{
  const value=request();
  for(const scope of [{...value.scope,workspace_id:'otro'},{...value.scope,environment:'SIMULATION'}])
   expect(()=>duplicateMarketDraft({...value,scope})).toThrow('MARKET_SCOPE_MISMATCH');
  expect(()=>duplicateMarketDraft({...value,new_variant_id:value.source.variant_id})).toThrow('MARKET_COPY_ID_REUSED');
  for(const extra of [{credentials:[]},{number_assignments:[id(1)]},{campaign_bindings:[]}])expect(()=>duplicateMarketDraft({...value,...extra})).toThrow();
 });
});

describe('shared deterministic resolver',()=>{
 it('returns the only eligible variant without inventing attribution or enabling effects',()=>{
  const value=input(),result=resolveMarketRoute(value);expect(result).toMatchObject({state:'RESOLVED',reason:'ONLY_ELIGIBLE_VARIANT',release:value.candidates[0]!.release,evidence:[],effects_authorized:false});
 });
 it('returns stable variant choices independent of input order',()=>{
  const value=input(3);expect(resolveMarketRoute({...value,candidates:[...value.candidates].reverse()})).toEqual(resolveMarketRoute(value));
  expect(resolveMarketRoute(value)).toMatchObject({state:'SELECTION_REQUIRED',reason:'MULTIPLE_ELIGIBLE_VARIANTS',options:expect.arrayContaining([{variant_id:id(101),family_id:id(10),release_id:id(1),market:'México',currency:'MXN',language:'es-MX'}])});
 });
 it('does not fall back to draft or retired bindings',()=>{
  const value=input(2);value.candidates[0]!.state='DRAFT';value.candidates[1]!.state='RETIRED';
  expect(resolveMarketRoute(value)).toEqual({state:'SELECTION_REQUIRED',reason:'NO_ELIGIBLE_VARIANT',options:[]});
 });
 it('pins a journey even after new releases change every commercial field',()=>{
  const value=input();const snapshot=journey(value);value.open_journeys=[snapshot];
  value.candidates[0]!.release={...release(),id:id(99),revision:2,locale:{market:'Colombia',currency:'COP',language:'es-CO',timezone:'America/Bogota'},amount_minor:120000,
   configuration:{offer:ref(800),flow:ref(801),seller:ref(802),collection:ref(803),remarketing:ref(804),materials:[]}};
  expect(resolveMarketRoute(value)).toEqual({state:'RESOLVED',reason:'OPEN_JOURNEY',snapshot,evidence:[],effects_authorized:false});
  expect(snapshot.release.amount_minor).toBe(9700);expect(snapshot.release.locale.currency).toBe('MXN');
 });
 it('keeps historical snapshot identity with no current assignment, never grants sending',()=>{
  const value=input();value.open_journeys=[journey(value)];value.candidates=[];
  expect(resolveMarketRoute(value)).toMatchObject({state:'RESOLVED',reason:'OPEN_JOURNEY',effects_authorized:false});
 });
 it('does not select newest among two open journeys',()=>{
  const value=input();value.open_journeys=[journey(value),{...journey(value),journey_id:id(501)}];
  expect(resolveMarketRoute(value)).toMatchObject({reason:'MULTIPLE_OPEN_JOURNEYS'});
 });
 it.each(['PROFILE_SUSPENDED','HUMAN_PAUSED','OPTED_OUT','CHANNEL_UNAVAILABLE','BUDGET_BLOCKED'] as const)('preserves protection %s above all evidence',protection=>{
  const value=input();value.open_journeys=[journey(value)];value.origins=[origin(value)];value.selections=[selection(value)];value.protections=[protection];
  expect(resolveMarketRoute(value)).toEqual({state:'BLOCKED',reason:'CURRENT_PROTECTION',protections:[protection]});
 });
 it('routes observed campaign before explicit selection but keeps an open journey above both',()=>{
  const value=input(2);value.origins=[origin(value,1)];value.selections=[selection(value,0)];
  expect(resolveMarketRoute(value)).toMatchObject({reason:'CURRENT_ORIGIN',release:value.candidates[1]!.release,evidence:[evidence(601)]});
  value.open_journeys=[journey(value)];expect(resolveMarketRoute(value)).toMatchObject({reason:'OPEN_JOURNEY',snapshot:value.open_journeys[0]});
 });
 it('stale campaign cannot silently fall back to a single variant or explicit stale-event selection',()=>{
  const value=input();value.origins=[{...origin(value),binding:{...value.candidates[0]!.binding,revision:2}}];value.selections=[selection(value)];
  expect(resolveMarketRoute(value)).toMatchObject({state:'SELECTION_REQUIRED',reason:'STALE_ORIGIN'});
  value.origins=[];expect(resolveMarketRoute(value)).toMatchObject({reason:'EXPLICIT_SELECTION'});
 });
 it('rejects changed binding hash or identity even with same variant',()=>{
  for(const field of ['id','sha256'] as const){const value=input();value.origins=[origin(value)];value.origins[0]!.binding={...value.origins[0]!.binding,[field]:field==='id'?id(999):'b'.repeat(64)};
   expect(resolveMarketRoute(value)).toMatchObject({reason:'STALE_ORIGIN'});}
 });
 it('conflicting campaign bindings require disambiguation',()=>{
  const value=input(2);value.origins=[origin(value,0),origin(value,1)];expect(resolveMarketRoute(value)).toMatchObject({reason:'CONFLICTING_ORIGINS'});
 });
 it('explicit selection names an exact current release, not a raw variant UUID alone',()=>{
  const value=input(2);value.selections=[selection(value,1)];expect(resolveMarketRoute(value)).toMatchObject({reason:'EXPLICIT_SELECTION',release:value.candidates[1]!.release});
  value.selections[0]!.release_id=id(999);expect(resolveMarketRoute(value)).toMatchObject({reason:'STALE_SELECTION'});
 });
 it('conflicting explicit selections are not ordered by input position',()=>{
  const value=input(2);value.selections=[selection(value,1),selection(value,0)];expect(resolveMarketRoute(value)).toMatchObject({reason:'CONFLICTING_SELECTIONS'});
 });
 it.each(['workspace_id','environment','account_id','contact_id'] as const)('rejects a journey crossing %s',field=>{
  const value=input();const snap=journey(value);snap.chat={...snap.chat,[field]:field==='workspace_id'?'otro':field==='environment'?'SIMULATION':id(999)};value.open_journeys=[snap];
  expect(resolveMarketRoute(value)).toEqual({state:'BLOCKED',reason:'SCOPE_MISMATCH',protections:[]});
 });
 it('rejects polluted candidates rather than returning foreign labels',()=>{
  const value=input(2);value.candidates[1]!.release.scope.workspace_id='otro';
  expect(resolveMarketRoute(value)).toEqual({state:'BLOCKED',reason:'SCOPE_MISMATCH',protections:[]});
  const other=input();other.candidates[0]!.account_id=id(999);expect(resolveMarketRoute(other)).toMatchObject({reason:'SCOPE_MISMATCH'});
 });
 it('rejects ambiguous catalog identities',()=>{
  const value=input(2);value.candidates[1]!.release.variant_id=value.candidates[0]!.release.variant_id;
  expect(resolveMarketRoute(value)).toMatchObject({reason:'INCONSISTENT_CATALOG'});
  const duplicate=input();duplicate.candidates.push(structuredClone(duplicate.candidates[0]!));expect(resolveMarketRoute(duplicate)).toMatchObject({reason:'INCONSISTENT_CATALOG'});
 });
 it('rejects two different variants claiming the same immutable release identity',()=>{
  const value=input(2);value.candidates[1]!.release.id=value.candidates[0]!.release.id;
  expect(resolveMarketRoute(value)).toEqual({state:'BLOCKED',reason:'INCONSISTENT_CATALOG',protections:[]});
 });
 it('creates independent snapshots, rejects foreign scope and cannot be influenced by an AI choice field',()=>{
  const value=input();const snap=journey(value);snap.release.configuration.offer.revision=7;expect(value.candidates[0]!.release.configuration.offer.revision).toBe(1);
  expect(()=>snapshotMarketJourney({...snap,chat:{...snap.chat,workspace_id:'otro'}})).toThrow('MARKET_SCOPE_MISMATCH');
  expect(()=>resolveMarketRoute({...value,ai_selected_variant:id(1)})).toThrow();
 });
 it('does not mutate caller data or alias output to caller state',()=>{
  const value=input();const before=structuredClone(value),result=resolveMarketRoute(value);expect(value).toEqual(before);
  if(result.state==='RESOLVED'&&result.reason!=='OPEN_JOURNEY')result.release.amount_minor=1;
  expect(value).toEqual(before);
 });
 it('same resolver gives equivalent REAL/lab decisions for three variants/two markets',()=>{
  const real=input(3);real.candidates[1]!.release.locale={market:'Brasil',currency:'BRL',language:'pt-BR',timezone:'America/Sao_Paulo'};
  real.selections=[selection(real,1)];const lab=structuredClone(real);lab.chat.environment='SIMULATION';for(const c of lab.candidates)c.release.scope.environment='SIMULATION';
  const result=resolveMarketRoute(real),simulated=resolveMarketRoute(lab);expect(simulated.state).toBe('RESOLVED');
  expect(JSON.stringify(simulated).replaceAll('SIMULATION','REAL')).toBe(JSON.stringify(result));
 });
});
