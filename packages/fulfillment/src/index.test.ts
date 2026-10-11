import {describe,it,expect} from 'vitest';
import {SimulatedFulfillmentProvider,WebhookFulfillmentProvider,type GrantRequest} from './index.js';
const request:GrantRequest={grantId:'durable-grant',subjectId:'opaque-subject',assetReference:'portal-course',environment:'REAL',offerVersionId:'immutable-offer'};
const token='synthetic-token-only-for-fixtures';
const make=(fetcher:typeof fetch)=>new WebhookFulfillmentProvider({endpoint:'https://portal.example.com/grants',allowedOrigin:'https://portal.example.com',token,fetcher});
describe('Private fulfillment grant contract (HTTP fixtures, no remote integration)',()=>{
 it('separates simulation from real access',async()=>{
  const sim=new SimulatedFulfillmentProvider();expect((await sim.grant(request)).status).toBe('REJECTED');
  const a=await sim.grant({...request,environment:'SIMULATION'}),b=await sim.grant({...request,environment:'SIMULATION'});expect(a).toEqual(b);expect(a.status).toBe('GRANTED');
  let calls=0;const real=make(async()=>{calls++;return new Response('{}')});expect((await real.grant({...request,environment:'SIMULATION'})).status).toBe('REJECTED');expect(calls).toBe(0);
 });
 it('uses a stable grant ID and returns private access without assuming notification',async()=>{
  let received:any;const provider=make(async(_url,init)=>{received=init;return Response.json({status:'GRANTED',grant_id:'provider-1',access:{url:'https://portal.example.com/access',code:'synthetic-private-code'}})});
  const result=await provider.grant(request);expect(result.status).toBe('GRANTED');expect(result.access?.code).toBe('synthetic-private-code');expect(received.headers['Idempotency-Key']).toBe(request.grantId);expect(JSON.parse(received.body).subject_id).toBe('opaque-subject');
 });
 it('returns UNKNOWN for ambiguous network/5xx/invalid acceptance, without retry',async()=>{
  for(const fetcher of [async()=>{throw new Error('timeout after provider grant')},async()=>new Response('{}',{status:503}),async()=>Response.json({status:'GRANTED'})]){
   let calls=0;const provider=make(async()=>{calls++;return fetcher()});expect((await provider.grant(request)).status).toBe('UNKNOWN');expect(calls).toBe(1);
  }
 });
 it('rejects definite refusal and untrusted endpoint configuration',async()=>{
  expect((await make(async()=>new Response('{}',{status:403})).grant(request)).status).toBe('REJECTED');
  expect(()=>new WebhookFulfillmentProvider({endpoint:'https://attacker.example/grants',allowedOrigin:'https://portal.example.com',token})).toThrow('ENDPOINT_NOT_ALLOWED');
  expect(()=>new WebhookFulfillmentProvider({endpoint:'http://portal.example.com/grants',allowedOrigin:'http://portal.example.com',token})).toThrow('ENDPOINT_NOT_ALLOWED');
 });
});

import {parseStaticAccessReference,StaticAccessFulfillmentProvider} from './index.js';
describe('Approved static portal access is a local durable grant',()=>{
 const privateReference=JSON.stringify({url:'https://portal.example/access',code:'synthetic-shared-code',instructions:'Use the approved shared code.'});
 it('produces a stable private grant without HTTP and never reveals it in simulation',async()=>{
  const provider=new StaticAccessFulfillmentProvider();const input={...request,assetReference:privateReference};const a=await provider.grant(input),b=await provider.grant(input);expect(a).toEqual(b);expect(a).toMatchObject({status:'GRANTED',providerGrantId:'static:durable-grant',access:{code:'synthetic-shared-code'}});expect((await provider.grant({...input,environment:'SIMULATION'})).access).toBeUndefined();
 });
 it('rejects malformed access without reflecting private input',async()=>{
  for(const reference of ['not-json',JSON.stringify({url:'https://portal.example',code:'',instructions:''}),JSON.stringify({url:'javascript:alert(1)',code:'synthetic',instructions:''}),JSON.stringify({url:'https://user:private@portal.example',code:'synthetic',instructions:''}),JSON.stringify({url:'https://portal.example',code:'synthetic',instructions:'',unexpected:'private'})]){expect(()=>parseStaticAccessReference(reference)).toThrow('STATIC_ACCESS_REFERENCE_INVALID');const result=await new StaticAccessFulfillmentProvider().grant({...request,assetReference:reference});expect(result).toEqual({status:'REJECTED',reason:'STATIC_ACCESS_REFERENCE_INVALID'});}
 });
});
