import test from 'node:test';
import assert from 'node:assert/strict';
import {captureReadback,compareReadbacks,summarizeAuthenticated} from '../commerce-resilience-readback.mjs';

const list=data=>({data,meta:{total:data.length}});
const values={
 system:{data:{database:'READY',configuration_version:7,dispatch_frozen:true,pending_commands:0,pending_ingress:0,unknown_effects:0,services:[{service:'channel-worker',status:'OK',observed_at:'2026-09-21T12:00:00Z'}]}},
 settings:{data:{version:7,body:{dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false,allow_channel_onboarding:false}}},
 capacity:{data:{configured_limit:20,metrics:{logical_limit:20,physical_capacity_measured:null},installed:0,reserved:3,in_use:0,physical_capacity_verified:null,measurement_stale:true,legacy_reservations:[{slot:1,account_id:'private-a'},{slot:2,account_id:'private-b'},{slot:3,account_id:'private-c'}],topology:[{status:'STOPPED',private_phone:'+1 202 555 0162'}]}},
 assignments:list([{state:'ACTIVE',id:'private-assignment'}]),commands:list([]),outbox:list([{status:'BLOCKED',kind:'text',attempts:0,updated_at:'2026-09-21T12:00:00Z',payload:{text:'private message'},result:{reason:'REAL_OPERATION_NOT_ENABLED'}}]),
 authorizations:list([{revoked_at:null,expires_at:'2999-01-01T00:00:00Z',scope:{contact_ids:['private-contact']}}]),
 messageCampaigns:list([{status:'PAUSED',name:'private campaign'}]),acquisitionCampaigns:list([{status:'PAUSED'}]),orders:list([]),receipts:list([]),conversions:list([]),
};

test('summarizes only allowlisted aggregate fields',()=>{
 const summary=summarizeAuthenticated(values),serialized=JSON.stringify(summary);
 assert.equal(summary.outbox.total,1);assert.equal(summary.outbox.attempts,0);assert.equal(summary.capacity.physical_measured,false);assert.equal(summary.capacity.logical,20);assert.equal(summary.capacity.reserved,3);assert.equal(summary.capacity.legacy_reservations,3);
 assert.match(summary.authorizations.fingerprint,/^[a-f0-9]{64}$/);
 for(const privateValue of ['+1 202 555 0162','private-assignment','private message','private-contact','private campaign'])assert.equal(serialized.includes(privateValue),false);
});

test('capture is GET-only, sanitized, and performs no provider request',async()=>{
 const calls=[];
 const payloads=new Map([
  ['/readyz',{status:'ready',service:'api'}],['/api/version',{service:'commerce-api',release:'ci-123-aaaaaaaaaa',sha:'a'.repeat(40),configured:true}],
  ['/v1/system/status',values.system],['/v1/settings/operations',values.settings],['/v1/number-capacity',values.capacity],['/v1/assignments',values.assignments],['/v1/commands',values.commands],['/v1/outbox',values.outbox],['/v1/operation-authorizations',values.authorizations],['/v1/message-campaigns',values.messageCampaigns],['/v1/acquisition-campaigns',values.acquisitionCampaigns],['/v1/orders',values.orders],['/v1/receipts',values.receipts],['/v1/conversions',values.conversions],
 ]);
 const fetcher=async(input,init)=>{const url=new URL(String(input));calls.push({url,init});if(['/home','/intelligence','/catalog','/campaigns','/sales','/results','/settings'].includes(url.pathname))return new Response('<!doctype html>',{status:200,headers:{'content-type':'text/html'}});const body=payloads.get(url.pathname);return new Response(JSON.stringify(body),{status:body?200:404,headers:{'content-type':'application/json'}});};
 const snapshot=await captureReadback({apiUrl:'https://commerce.example.invalid',token:'private-token-never-print',fetcher});
 assert.equal(snapshot.public.status,'CURRENT');assert.equal(snapshot.authenticated.status,'CURRENT');assert.equal(snapshot.request_policy.provider_calls,'NOT_PERFORMED_BY_SCRIPT');
 assert.equal(snapshot.claim_limits.operation_authorizations,'FULL_ROW_FINGERPRINT_WITHOUT_ROW_CONTENT');
 assert.ok(calls.every(call=>call.init.method==='GET'));assert.equal(calls.some(call=>/provider|waha|meta/.test(call.url.hostname+call.url.pathname)),false);
 assert.equal(JSON.stringify(snapshot).includes('private-token-never-print'),false);
});

test('keeps readiness and route evidence when a legacy release lacks /api/version',async()=>{
 const payloads=new Map([
  ['/readyz',{status:'ready',service:'api'}],
  ['/v1/system/status',values.system],['/v1/settings/operations',values.settings],['/v1/number-capacity',values.capacity],['/v1/assignments',values.assignments],['/v1/commands',values.commands],['/v1/outbox',values.outbox],['/v1/operation-authorizations',values.authorizations],['/v1/message-campaigns',values.messageCampaigns],['/v1/acquisition-campaigns',values.acquisitionCampaigns],['/v1/orders',values.orders],['/v1/receipts',values.receipts],['/v1/conversions',values.conversions],
 ]);
 const fetcher=async input=>{const url=new URL(String(input));if(['/home','/intelligence','/catalog','/campaigns','/sales','/results','/settings'].includes(url.pathname))return new Response('<!doctype html>',{status:200,headers:{'content-type':'text/html'}});if(url.pathname==='/api/version')return new Response('<!doctype html>',{status:200,headers:{'content-type':'text/html'}});const body=payloads.get(url.pathname);return new Response(JSON.stringify(body),{status:body?200:404,headers:{'content-type':'application/json'}});};
 const snapshot=await captureReadback({apiUrl:'https://commerce.example.invalid',token:'private-token-never-print',fetcher});
 assert.equal(snapshot.public.status,'PARTIAL');assert.equal(snapshot.public.ready,true);assert.equal(snapshot.public.routes.length,7);assert.equal(snapshot.public.version.configured,false);assert.equal(snapshot.authenticated.status,'CURRENT');
});

test('comparison detects durable effects and does not claim provider zero',()=>{
 const base={schema_version:1,kind:'commerce-resilience-readback',environment:'REAL',authenticated:{status:'CURRENT',...summarizeAuthenticated(values)}};
 const same=structuredClone(base),pass=compareReadbacks(base,same);assert.equal(pass.passed,true);assert.equal(pass.status,'ZERO_MATERIAL_EFFECT_DELTA');assert.equal(pass.provider_calls.zero_claim,false);
 const changed=structuredClone(same);changed.authenticated.outbox.attempts=1;const failure=compareReadbacks(base,changed);assert.equal(failure.passed,false);assert.equal(failure.status,'ATTENTION_REQUIRED');
});

test('comparison rejects updated_at churn because every outbox row must remain literal',()=>{
 const snapshot=current=>({schema_version:1,kind:'commerce-resilience-readback',environment:'REAL',authenticated:{status:'CURRENT',...summarizeAuthenticated(current)}});
 const beforeValues=structuredClone(values),afterValues=structuredClone(values);
 afterValues.outbox.data[0].updated_at='2026-09-21T12:01:00Z';
 const before=snapshot(beforeValues),after=snapshot(afterValues),timestampOnly=compareReadbacks(before,after);
 assert.notEqual(before.authenticated.outbox.fingerprint,after.authenticated.outbox.fingerprint);
 assert.equal(before.authenticated.outbox.material_fingerprint,after.authenticated.outbox.material_fingerprint);
	 assert.equal(timestampOnly.passed,false);
	 assert.equal(timestampOnly.checks.find(item=>item.path==='authenticated.outbox.fingerprint')?.ok,false);
 assert.equal(timestampOnly.observations[0].changed,true);
 afterValues.outbox.data[0].result={reason:'DIFFERENT_BLOCKER'};
 assert.equal(compareReadbacks(before,snapshot(afterValues)).passed,false);
});

test('comparison detects in-place campaign, assignment and commercial mutations',()=>{
 const baseline={schema_version:1,kind:'commerce-resilience-readback',environment:'REAL',authenticated:{status:'CURRENT',...summarizeAuthenticated(values)}};
 for(const [name,mutate] of [
  ['campaign',copy=>{copy.messageCampaigns.data[0].status='SCHEDULED';}],
  ['assignment',copy=>{copy.assignments.data[0].state='RETIRED';}],
  ['order',copy=>{copy.orders=list([{id:'order-1',status:'OFFERED',version:1}]);}],
 ]){
  const beforeValues=structuredClone(values),afterValues=structuredClone(values);mutate(beforeValues);mutate(afterValues);
  if(name==='campaign')beforeValues.messageCampaigns.data[0].status='PAUSED';
  if(name==='assignment')beforeValues.assignments.data[0].state='ACTIVE';
  if(name==='order'){
   beforeValues.orders=list([{id:'order-1',status:'OFFERED',version:1}]);
   afterValues.orders=list([{id:'order-1',status:'OFFERED',version:2}]);
  }
  const before={...baseline,authenticated:{status:'CURRENT',...summarizeAuthenticated(beforeValues)}};
  const after={...baseline,authenticated:{status:'CURRENT',...summarizeAuthenticated(afterValues)}};
  assert.equal(compareReadbacks(before,after).passed,false,name);
 }
});

test('comparison detects authorization deletion revocation and mutation',()=>{
 const snapshot=current=>({schema_version:1,kind:'commerce-resilience-readback',environment:'REAL',authenticated:{status:'CURRENT',...summarizeAuthenticated(current)}});
 const before=snapshot(structuredClone(values));
 for(const [name,change] of [
  ['deletion',copy=>{copy.authorizations=list([]);}],
  ['revocation',copy=>{copy.authorizations.data[0].revoked_at='2026-09-22T12:00:00.000Z';}],
  ['mutation',copy=>{copy.authorizations.data[0].scope={contact_ids:['different-private-contact']};}],
 ]){
  const afterValues=structuredClone(values);change(afterValues);
  const result=compareReadbacks(before,snapshot(afterValues));
  assert.equal(result.passed,false,name);
  assert.equal(result.checks.find(item=>item.path==='authenticated.authorizations.fingerprint')?.ok,false,name);
 }
});

test('comparison refuses a zero-effect claim at the bounded collection limit',()=>{
 const capped=structuredClone(values);capped.authorizations=list(Array.from({length:100},(_,index)=>({id:'authorization-'+index,revoked_at:null,expires_at:'2999-01-01T00:00:00Z'})));
 const snapshot={schema_version:1,kind:'commerce-resilience-readback',environment:'REAL',authenticated:{status:'CURRENT',...summarizeAuthenticated(capped)}};
 const result=compareReadbacks(snapshot,structuredClone(snapshot));
 assert.equal(snapshot.authenticated.authorizations.complete,false);
 assert.equal(result.passed,false);
 assert.equal(result.coverage.find(item=>item.path==='authenticated.authorizations.complete')?.ok,false);
});
