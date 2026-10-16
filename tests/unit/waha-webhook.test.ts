import {describe,it,expect} from 'vitest';
import {WahaProvider} from '../../packages/messaging/src/providers.js';
import {reconcileWebhook,webhookConfiguration} from '../../packages/messaging/src/waha-webhook.js';
const target={url:'http://ingress:3002/webhooks/waha/synthetic/new-account',hmacKey:'synthetic-hmac'};
const old={url:'http://ingress:3002/webhooks/waha/synthetic/retired-account',events:['message'],hmac:{key:'synthetic-old'}};
const response=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
function fixture(status='WORKING',config:Record<string,unknown>={webhooks:[old],gows:{store:{messages:true}}}){
 const calls:Array<{method:string;path:string;body?:any}>=[];let state={status,config,me:{id:'synthetic@c.us'}};
 const provider=new WahaProvider({baseUrl:'http://gateway.invalid',apiKey:'synthetic-api',session:'default',engine:'GOWS',webhook:target},async(input,init)=>{
  const method=init?.method??'GET',path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,path,body});
  if(method==='PUT'){state={...state,status:state.status==='STOPPED'?'STOPPED':'STARTING',config:body.config};return response(state);}
  if(method==='POST'){state={...state,status:'STARTING'};return response(state);}
  return response(state);
 });return{provider,calls,get state(){return state;}};
}
describe('WAHA account replacement reception',()=>{
 it('reports connected transport separately from a stale webhook without exposing credentials or URLs',async()=>{
  const f=fixture(),health=await f.provider.health();
  expect(health.find(h=>h.dimension==='session')?.value).toBe('WORKING');
  expect(health.find(h=>h.dimension==='infrastructure')).toMatchObject({status:'BLOCKED',value:{kind:'webhook',matches:false}});
  for(const secret of [target.url,target.hmacKey,'synthetic-api',old.url])expect(JSON.stringify(health)).not.toContain(secret);
  expect(f.calls.every(c=>c.method==='GET')).toBe(true);
 });
 it('repairs a connected reused session with one PUT, preserves settings, verifies readback and never logs out',async()=>{
  const external={url:'https://example.invalid/own-hook',events:['session.status']};const f=fixture('WORKING',{webhooks:[old,external],gows:{store:{messages:true}},metadata:{label:'keep'}});
  expect(await f.provider.lifecycle('restart')).toEqual({status:'STARTING'});
  expect(f.calls.map(c=>c.method)).toEqual(['GET','PUT','GET']);
  expect(f.state.config).toMatchObject({gows:{store:{messages:true}},metadata:{label:'keep'}});
  expect(f.state.config.webhooks).toContainEqual(external);
  expect(JSON.stringify(f.state.config)).not.toContain('retired-account');
  expect(webhookConfiguration(f.state.config,target).matches).toBe(true);
 });
 it('connect on an already correct active session is read-only; stop/logout never rewrite config',async()=>{
  const f=fixture('WORKING',reconcileWebhook({},target));await f.provider.lifecycle('start');expect(f.calls.map(c=>c.method)).toEqual(['GET']);
  for(const action of ['stop','logout']as const){const other=fixture();await other.provider.lifecycle(action);expect(other.calls.map(c=>c.path)).toEqual(['/api/sessions/default/'+action]);}
 });
 it('a stopped reused session is configured before an explicit start',async()=>{
  const f=fixture('STOPPED');await f.provider.lifecycle('start');expect(f.calls.map(c=>c.method)).toEqual(['GET','PUT','GET','POST']);expect(f.calls.at(-1)?.path).toBe('/api/sessions/default/start');
 });
 it('never retries a failed/uncertain remote PUT or follows it with start',async()=>{
  let puts=0,posts=0;const p=new WahaProvider({baseUrl:'http://gateway.invalid',apiKey:'synthetic',session:'default',engine:'GOWS',webhook:target},async(_u,i)=>{if(i?.method==='PUT'){puts++;throw new Error('lost response');}if(i?.method==='POST')posts++;return response({status:'WORKING',config:{webhooks:[old]}});});
  await expect(p.lifecycle('restart')).rejects.toThrow();expect(puts).toBe(1);expect(posts).toBe(0);
 });
 it('detects an obsolete callback even when the correct callback also exists',()=>{
  const correct=reconcileWebhook({},target);expect(webhookConfiguration({...correct,webhooks:[...correct.webhooks,old]},target).matches).toBe(false);
 });
 it('rejects malformed config and another workspace callback without mutating either',()=>{
  expect(()=>reconcileWebhook({webhooks:'invalid'},target)).toThrow('WEBHOOK_CONFIGURATION_INVALID');
  expect(()=>reconcileWebhook({webhooks:[{url:'http://ingress:3002/webhooks/waha/other/account'}]},target)).toThrow('WEBHOOK_SCOPE_CONFLICT');
 });
});

describe('durable relay (ADR-V7-08)',()=>{
 const relayed={...target,relayUrl:'https://relay.example.invalid/relay/synthetic-token/waha/synthetic/new-account'};
 function relayFixture(status:string,config:Record<string,unknown>){
  const calls:Array<{method:string;path:string;body?:any}>=[];let state={status,config,me:{id:'synthetic@c.us'}};
  const provider=new WahaProvider({baseUrl:'http://gateway.invalid',apiKey:'synthetic-api',session:'default',engine:'GOWS',webhook:relayed},async(input,init)=>{
   const method=init?.method??'GET',path=new URL(String(input)).pathname,body=init?.body?JSON.parse(String(init.body)):undefined;calls.push({method,path,body});
   if(method==='PUT'){state={...state,config:body.config};return response(state);}
   if(method==='POST'){state={...state,status:'STARTING'};return response(state);}
   return response(state);
  });return{provider,calls,get state(){return state;}};
 }
 it('adds the relay with the same HMAC next to the host callback and replaces an older relay token',()=>{
  const stale={url:'https://relay.example.invalid/relay/old-token/waha/synthetic/new-account',events:['message'],hmac:{key:'x'}};
  const config=reconcileWebhook({webhooks:[stale]},relayed);
  expect(config.webhooks.map((h:any)=>h.url)).toEqual([target.url,relayed.relayUrl]);
  expect(config.webhooks.every((h:any)=>h.hmac.key===target.hmacKey)).toBe(true);
  expect(webhookConfiguration(config,relayed)).toMatchObject({matches:true,relay_matches:true});
  expect(()=>reconcileWebhook({},{...target,relayUrl:'http://relay.example.invalid/x'})).toThrow('WEBHOOK_RELAY_INVALID');
 });
 it('never restarts a live session to add the relay; a stopped one gets it before start',async()=>{
  const live=relayFixture('WORKING',reconcileWebhook({},target));
  await live.provider.lifecycle('start');expect(live.calls.map(c=>c.method)).toEqual(['GET']);
  const health=await live.provider.health();
  expect(health.find(h=>h.dimension==='infrastructure')).toMatchObject({status:'OK',value:{matches:true,relay_matches:false}});
  expect(JSON.stringify(health)).not.toContain('synthetic-token');
  const stopped=relayFixture('STOPPED',reconcileWebhook({},target));
  await stopped.provider.lifecycle('start');
  expect(stopped.calls.map(c=>c.method)).toEqual(['GET','PUT','GET','POST']);
  expect(webhookConfiguration(stopped.state.config,relayed)).toMatchObject({matches:true,relay_matches:true});
 });
});

