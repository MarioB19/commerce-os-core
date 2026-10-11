#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const ROUTES=['/home','/intelligence','/catalog','/campaigns','/sales','/results','/settings'];
// The strictest shared pagination contract currently caps reads at 100.
// Keeping one bounded limit avoids turning a read-only baseline into a 400 on
// older releases while still reporting incomplete coverage explicitly.
const LIST_LIMIT=100;
const safeCode=value=>/^[A-Z0-9_]{1,80}$/.test(String(value??''))?String(value):'READBACK_UNAVAILABLE';
const countBy=(rows,key='status')=>Object.fromEntries([...rows.reduce((counts,row)=>{
 const raw=String(row?.[key]??'UNSPECIFIED').toUpperCase();
 const value=/^[A-Z0-9_:-]{1,64}$/.test(raw)?raw:'OTHER';
 counts.set(value,(counts.get(value)??0)+1);return counts;
},new Map()).entries()].sort(([a],[b])=>a.localeCompare(b)));
const list=value=>Array.isArray(value?.data)?value.data:[];
const complete=value=>list(value).length<LIST_LIMIT;
const sum=(rows,key)=>rows.reduce((total,row)=>total+(Number.isSafeInteger(Number(row?.[key]))?Number(row[key]):0),0);
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const collectionFingerprint=rows=>{
 const rowDigests=rows.map(row=>createHash('sha256').update(JSON.stringify(canonical(row))).digest('hex')).sort();
 return createHash('sha256').update(rowDigests.join('\n')).digest('hex');
};
// A denied dispatch can be observed more than once. `updated_at` is diagnostic,
// not a transport, status, payload, result or attempt fact. Keep the full hash
// visible while using a second hash to prove that material outbox state did not
// change across a release.
const outboxMaterial=rows=>rows.map(row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='updated_at')));

function baseUrl(value){
 const parsed=new URL(value);
 if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)))throw new Error('HTTPS_REQUIRED');
 if(parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('SAFE_BASE_URL_REQUIRED');
 return parsed;
}

async function boundedJson(response,maxBytes=2*1024*1024){
 const reader=response.body?.getReader(),chunks=[];let bytes=0;
 if(reader)while(true){const item=await reader.read();if(item.done)break;bytes+=item.value.byteLength;if(bytes>maxBytes){await reader.cancel();throw new Error('RESPONSE_TOO_LARGE');}chunks.push(item.value);}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function get(origin,path,{token,fetcher}){
 const url=new URL(path,origin);
 if(url.origin!==origin.origin)throw new Error('ORIGIN_MISMATCH');
 const authenticated=url.pathname.startsWith('/v1/');
 if(authenticated){if(!token)throw new Error('SERVICE_TOKEN_REQUIRED');url.searchParams.set('environment','REAL');}
 const response=await fetcher(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Accept:'application/json',...(authenticated?{Authorization:'Bearer '+token}:{})}});
 if(!response.ok){let code='HTTP_'+response.status;try{code=safeCode((await boundedJson(response,64*1024))?.error?.code??code);}catch{/* never expose response bodies */}throw Object.assign(new Error(code),{code,status:response.status});}
 return boundedJson(response);
}

async function section(task,summarize){
 try{return{status:'CURRENT',...summarize(await task())};}
 catch(error){return{status:'UNAVAILABLE',error_code:safeCode(error?.code??error?.message),http_status:Number.isInteger(error?.status)?error.status:null};}
}

export function summarizeAuthenticated(values){
 const system=values.system?.data??{},settings=values.settings?.data??{},settingBody=settings.body??settings;
 const capacity=values.capacity?.data??{},assignments=list(values.assignments),commands=list(values.commands),outbox=list(values.outbox),authorizations=list(values.authorizations);
 const messageCampaigns=list(values.messageCampaigns),acquisitionCampaigns=list(values.acquisitionCampaigns),orders=list(values.orders),receipts=list(values.receipts),conversions=list(values.conversions);
 const now=Date.now(),activeAuthorizations=authorizations.filter(row=>!row.revoked_at&&Date.parse(row.expires_at)>now).length;
 const services=Array.isArray(system.services)?system.services:[];
 const knownServices=['api','automation-worker','channel-worker','ingress','web','postgres'];
 return{
  system:{database:system.database==='READY'?'READY':'NOT_READY',configuration_version:Number.isSafeInteger(system.configuration_version)?system.configuration_version:null,dispatch_frozen:system.dispatch_frozen===true,pending_commands:Number(system.pending_commands??0),pending_ingress:Number(system.pending_ingress??0),unknown_effects:Number(system.unknown_effects??0),services:Object.fromEntries(knownServices.map(name=>{const rows=services.filter(row=>(row.name??row.service)===name).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at)),row=rows[0];return[name,{present:!!row,status:/^[A-Z_]{2,32}$/.test(String(row?.status??''))?row.status:'UNAVAILABLE',stale:row?.stale===true}];}))},
  operational_policy:{version:Number.isSafeInteger(settings.version)?settings.version:null,dispatch_frozen:settingBody.dispatch_frozen===true,real_sends_enabled:settingBody.real_sends_enabled===true,allow_real_operations:settingBody.allow_real_operations===true,allow_channel_onboarding:settingBody.allow_channel_onboarding===true},
  capacity:{
   logical:[capacity.configured_limit,capacity.metrics?.logical_limit,capacity.logical_limit].find(Number.isSafeInteger)??null,
   installed:Number.isSafeInteger(capacity.installed)?capacity.installed:Number.isSafeInteger(capacity.metrics?.provisioned_verified)?capacity.metrics.provisioned_verified:null,
   reserved:Number.isSafeInteger(capacity.reserved)?capacity.reserved:Number.isSafeInteger(capacity.metrics?.reserved)?capacity.metrics.reserved:null,
   legacy_reservations:Array.isArray(capacity.legacy_reservations)?capacity.legacy_reservations.length:0,
   in_use:Number.isSafeInteger(capacity.in_use)?capacity.in_use:Number.isSafeInteger(capacity.metrics?.connected_sessions)?capacity.metrics.connected_sessions:null,
   physical_measured:Number.isSafeInteger(capacity.physical_capacity_verified??capacity.metrics?.physical_capacity_measured??capacity.physical_limit)&&capacity.measurement_stale!==true,
   physical:[capacity.physical_capacity_verified,capacity.metrics?.physical_capacity_measured,capacity.physical_limit].find(Number.isSafeInteger)??null,
   measurement_stale:capacity.measurement_stale!==false,
   topology_states:countBy(Array.isArray(capacity.topology)?capacity.topology:[],capacity.topology?.some?.(row=>row?.status!==undefined)?'status':'state'),
  },
  assignments:{total:assignments.length,by_state:countBy(assignments,'state'),fingerprint:collectionFingerprint(assignments),complete:complete(values.assignments)},
  commands:{total:commands.length,by_status:countBy(commands),fingerprint:collectionFingerprint(commands),complete:complete(values.commands)},
  outbox:{total:outbox.length,by_status:countBy(outbox),by_kind:countBy(outbox,'kind'),attempts:sum(outbox,'attempts'),fingerprint:collectionFingerprint(outbox),material_fingerprint:collectionFingerprint(outboxMaterial(outbox)),complete:complete(values.outbox)},
  authorizations:{total:authorizations.length,active:activeAuthorizations,fingerprint:collectionFingerprint(authorizations),complete:complete(values.authorizations)},
  campaigns:{message_total:messageCampaigns.length,message_by_status:countBy(messageCampaigns),message_fingerprint:collectionFingerprint(messageCampaigns),acquisition_total:acquisitionCampaigns.length,acquisition_by_status:countBy(acquisitionCampaigns),acquisition_fingerprint:collectionFingerprint(acquisitionCampaigns),complete:complete(values.messageCampaigns)&&complete(values.acquisitionCampaigns)},
  commercial_records:{orders:orders.length,orders_by_status:countBy(orders),orders_fingerprint:collectionFingerprint(orders),receipts:receipts.length,receipts_by_status:countBy(receipts),receipts_fingerprint:collectionFingerprint(receipts),conversions:conversions.length,conversions_fingerprint:collectionFingerprint(conversions),complete:complete(values.orders)&&complete(values.receipts)&&complete(values.conversions)},
 };
}

export async function captureReadback({apiUrl=process.env.COMMERCE_API_URL,token=process.env.COMMERCE_SERVICE_TOKEN,fetcher=fetch}={}){
 const origin=baseUrl(apiUrl??'');
 const [readinessReadback,versionReadback,routesReadback]=await Promise.all([
  section(()=>get(origin,'/readyz',{fetcher}),value=>({ready:value?.status==='ready'})),
  section(()=>get(origin,'/api/version',{fetcher}),value=>({version:{service:value?.service==='commerce-api'?'commerce-api':'UNKNOWN',release:/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value?.release??'')?value.release:'UNAVAILABLE',sha:/^[a-f0-9]{40}$/.test(value?.sha??'')?value.sha:null,configured:value?.configured===true}})),
  section(async()=>{
  const routes=[];for(const path of ROUTES){const response=await fetcher(new URL(path,origin),{method:'GET',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Accept:'text/html'}});routes.push({path,http_status:response.status,html:(response.headers.get('content-type')??'').toLowerCase().includes('text/html')});await response.body?.cancel();}
  return routes;
  },routes=>({routes})),
 ]);
 const publicParts={readiness:readinessReadback,version:versionReadback,routes:routesReadback};
 const publicReadback={
  status:Object.values(publicParts).every(item=>item.status==='CURRENT')?'CURRENT':'PARTIAL',
  ready:readinessReadback.ready??false,
  version:versionReadback.version??{service:'UNKNOWN',release:'UNAVAILABLE',sha:null,configured:false},
  routes:routesReadback.routes??[],
  sources:publicParts,
 };
 const limit=`limit=${LIST_LIMIT}`;
 const endpoints={system:'/v1/system/status',settings:'/v1/settings/operations',capacity:`/v1/number-capacity?${limit}`,assignments:`/v1/assignments?${limit}`,commands:`/v1/commands?${limit}`,outbox:`/v1/outbox?${limit}`,authorizations:`/v1/operation-authorizations?${limit}`,messageCampaigns:`/v1/message-campaigns?${limit}`,acquisitionCampaigns:`/v1/acquisition-campaigns?${limit}`,orders:`/v1/orders?${limit}`,receipts:`/v1/receipts?${limit}`,conversions:`/v1/conversions?${limit}`};
 const authenticated=await section(async()=>Object.fromEntries(await Promise.all(Object.entries(endpoints).map(async([key,path])=>[key,await get(origin,path,{token,fetcher})]))),summarizeAuthenticated);
 return{schema_version:1,kind:'commerce-resilience-readback',captured_at:new Date().toISOString(),environment:'REAL',read_only:true,request_policy:{methods:['GET'],list_limit:LIST_LIMIT,provider_calls:'NOT_PERFORMED_BY_SCRIPT'},public:publicReadback,authenticated,claim_limits:{provider_calls:'NOT_OBSERVABLE_FROM_CORE_API',physical_capacity:'ONLY_MEASURED_WHEN_EXPLICITLY_REPORTED',ui_functionality:'ROUTE_HTTP_STATUS_IS_NOT_A_FUNCTIONAL_TEST',durable_effects:'ONLY_COMPLETE_AUTHENTICATED_COLLECTIONS_BELOW_LIST_LIMIT',operation_authorizations:'FULL_ROW_FINGERPRINT_WITHOUT_ROW_CONTENT'}};
}

const at=(object,path)=>path.split('.').reduce((value,key)=>value?.[key],object);
export function compareReadbacks(before,after){
 if(before?.schema_version!==1||before?.kind!=='commerce-resilience-readback'||before?.environment!=='REAL')throw new Error('INVALID_BASELINE');
 const exact=['authenticated.assignments.total','authenticated.assignments.fingerprint','authenticated.commands.total','authenticated.commands.fingerprint','authenticated.outbox.total','authenticated.outbox.attempts','authenticated.outbox.fingerprint','authenticated.outbox.material_fingerprint','authenticated.authorizations.total','authenticated.authorizations.fingerprint','authenticated.campaigns.message_total','authenticated.campaigns.message_fingerprint','authenticated.campaigns.acquisition_total','authenticated.campaigns.acquisition_fingerprint','authenticated.commercial_records.orders','authenticated.commercial_records.orders_fingerprint','authenticated.commercial_records.receipts','authenticated.commercial_records.receipts_fingerprint','authenticated.commercial_records.conversions','authenticated.commercial_records.conversions_fingerprint'];
 const nonIncreasing=['authenticated.authorizations.active'];
 const checks=[...exact.map(path=>({path,rule:'EXACT',before:at(before,path),after:at(after,path),ok:at(before,path)===at(after,path)})),...nonIncreasing.map(path=>({path,rule:'NON_INCREASING',before:at(before,path),after:at(after,path),ok:Number(at(after,path))<=Number(at(before,path))}))];
 const coverage=['authenticated.assignments.complete','authenticated.commands.complete','authenticated.outbox.complete','authenticated.authorizations.complete','authenticated.campaigns.complete','authenticated.commercial_records.complete'].map(path=>({path,ok:at(before,path)===true&&at(after,path)===true}));
 const guard=after?.authenticated?.operational_policy??{};
 checks.push({path:'authenticated.operational_policy.dispatch_frozen',rule:'TRUE_AFTER',before:at(before,'authenticated.operational_policy.dispatch_frozen'),after:guard.dispatch_frozen,ok:guard.dispatch_frozen===true});
 checks.push({path:'authenticated.operational_policy.real_sends_enabled',rule:'FALSE_AFTER',before:at(before,'authenticated.operational_policy.real_sends_enabled'),after:guard.real_sends_enabled,ok:guard.real_sends_enabled===false});
 checks.push({path:'authenticated.operational_policy.allow_real_operations',rule:'FALSE_AFTER',before:at(before,'authenticated.operational_policy.allow_real_operations'),after:guard.allow_real_operations,ok:guard.allow_real_operations===false});
 const ready=before.authenticated?.status==='CURRENT'&&after.authenticated?.status==='CURRENT'&&coverage.every(item=>item.ok);
 const observations=[{path:'authenticated.outbox.fingerprint',rule:'OBSERVED_FULL_ROW',before:at(before,'authenticated.outbox.fingerprint'),after:at(after,'authenticated.outbox.fingerprint'),changed:at(before,'authenticated.outbox.fingerprint')!==at(after,'authenticated.outbox.fingerprint')}];
 return{status:ready&&checks.every(item=>item.ok)?'ZERO_MATERIAL_EFFECT_DELTA':'ATTENTION_REQUIRED',passed:ready&&checks.every(item=>item.ok),checks,coverage,observations,provider_calls:{status:'NOT_OBSERVABLE',zero_claim:false,required_evidence:'independent provider boundary'},notes:['Collection fingerprints are SHA-256 hashes of canonical response rows and retain no row contents.','The complete outbox fingerprint, including updated_at, must remain exact. The secondary material fingerprint excludes only updated_at and remains available for diagnosis.','Authorization row count and fingerprint must remain exact; active grants may decrease only through wall-clock expiry because revocation, deletion or mutation changes the fingerprint.','A collection at the list limit is incomplete and cannot support a zero-material-effect conclusion.','The dispatcher scan sequence, gate schedule and service heartbeats are operational scheduler state outside this business-state comparison.','No provider call is made by this script. Core counters and a deployment receipt cannot prove that an external provider received zero calls.']};
}

async function main(){
 const [command='snapshot',file]=process.argv.slice(2);
 if(!['snapshot','compare'].includes(command)||command==='compare'&&!file){process.stderr.write('Usage: node scripts/commerce-resilience-readback.mjs snapshot | compare baseline.json\n');process.exitCode=2;return;}
 const current=await captureReadback();
 const output=command==='snapshot'?current:{...current,zero_effects:compareReadbacks(JSON.parse(await readFile(file,'utf8')),current)};
 process.stdout.write(JSON.stringify(output,null,2)+'\n');
 if(output.zero_effects&&!output.zero_effects.passed)process.exitCode=2;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{process.stderr.write(JSON.stringify({error:{code:safeCode(error?.code??error?.message)}})+'\n');process.exitCode=1;});
