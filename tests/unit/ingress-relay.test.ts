import {afterEach,describe,expect,it} from 'vitest';
import {createHmac,randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
// @ts-expect-error plain ESM without declarations, deployed as a single file
import {createRelay,relayConfig,parseRelayPath,MAX_BODY} from '../../infra/ingress-relay/relay.mjs';

const token=randomBytes(32).toString('base64url');
const config=relayConfig({RELAY_TOKEN:token,PUBSUB_TOPIC:'projects/project-c6f43813-9ac9-47ab-9fe/topics/commerce-v7-ingress'});
const servers:any[]=[];
afterEach(async()=>{for(const s of servers.splice(0))await new Promise(r=>s.close(r));});
async function start(publishResult:(body:any)=>Response){
 const published:any[]=[];
 const fetchImpl=async(url:string,init:any)=>{expect(url).toBe('https://us-east1-pubsub.googleapis.com/v1/projects/project-c6f43813-9ac9-47ab-9fe/topics/commerce-v7-ingress:publish');expect(init.headers.authorization).toBe('Bearer service-token');const body=JSON.parse(init.body);published.push(body);return publishResult(body);};
 const server=createRelay(config,{fetchImpl,token:async()=>'service-token',now:()=>new Date('2026-10-13T12:00:00Z')});servers.push(server);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()));
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 return{published,base};
}
const body=Buffer.from(JSON.stringify({id:'evt_1',session:'default',event:'message',payload:{body:'hola'}}));
const hmac=createHmac('sha512','account-secret').update(body).digest('hex');
const headers={'content-type':'application/json','x-webhook-hmac':hmac,'x-webhook-hmac-algorithm':'sha512'};

describe('ingress relay (ADR-V7-08)',()=>{
 it('acknowledges only after Pub/Sub accepted the exact bytes, HMAC and routing attributes',async()=>{
  const {published,base}=await start(()=>Response.json({messageIds:['42']}));
  const r=await fetch(`${base}/relay/${token}/waha/perfil%20uno/acc-1`,{method:'POST',headers,body});
  expect(r.status).toBe(200);expect(await r.json()).toEqual({ok:true,relayed:true});
  expect(published).toHaveLength(1);const message=published[0].messages[0];
  expect(Buffer.from(message.data,'base64').equals(body)).toBe(true);
  expect(message.orderingKey).toBe('perfil uno/acc-1');
  expect(message.attributes).toMatchObject({provider:'waha',workspace:'perfil uno',account:'acc-1',hmac,hmac_algorithm:'sha512',received_at:'2026-10-13T12:00:00.000Z'});
 });
 it('refuses wrong tokens, paths, queries and unsigned bodies without publishing',async()=>{
  const {published,base}=await start(()=>Response.json({messageIds:['1']}));
  for(const path of [`/relay/${token}x/waha/p/a`,`/relay/${token}/cloud/p/a`,`/relay/${token}/waha/p`,`/relay/${token}/waha/p/a?x=1`,`/relay/${token}/waha/p%2Fq/a`,`/webhooks/waha/p/a`])
   expect((await fetch(base+path,{method:'POST',headers,body})).status).toBe(404);
  expect((await fetch(`${base}/relay/${token}/waha/p/a`,{method:'POST',headers:{...headers,'x-webhook-hmac-algorithm':'sha256'},body})).status).toBe(401);
  expect((await fetch(`${base}/relay/${token}/waha/p/a`,{method:'POST',headers:{'content-type':'text/plain','x-webhook-hmac':hmac,'x-webhook-hmac-algorithm':'sha512'},body})).status).toBe(415);
  expect((await fetch(`${base}/relay/${token}/waha/p/a`,{method:'POST',headers,body:Buffer.alloc(MAX_BODY+1,32)})).status).toBe(413);
  expect(published).toHaveLength(0);
  expect((await fetch(`${base}/livez`)).status).toBe(200);
 });
 it('answers 503 so WAHA retries when the publish is rejected or unconfirmed',async()=>{
  for(const result of [()=>new Response('no',{status:500}),()=>Response.json({messageIds:[]})]){
   const {base}=await start(result);
   expect((await fetch(`${base}/relay/${token}/waha/p/a`,{method:'POST',headers,body})).status).toBe(503);
  }
 });
 it('validates its configuration and path strictly',()=>{
  expect(()=>relayConfig({RELAY_TOKEN:'short',PUBSUB_TOPIC:'projects/p-12345/topics/t12'})).toThrow('RELAY_TOKEN_REQUIRED');
  expect(()=>relayConfig({RELAY_TOKEN:token,PUBSUB_TOPIC:'topics/x'})).toThrow('RELAY_TOPIC_REQUIRED');
  expect(()=>relayConfig({RELAY_TOKEN:token,PUBSUB_TOPIC:'projects/project-c6f43813-9ac9-47ab-9fe/topics/commerce-v7-ingress',PUBSUB_ENDPOINT:'http://x'})).toThrow('RELAY_ENDPOINT_INVALID');
  expect(parseRelayPath('/relay/t/waha/%E0%A4%A/a')).toBeNull();
  expect(parseRelayPath('/relay/t/waha/w/a')).toEqual({token:'t',provider:'waha',workspace:'w',account:'a'});
 });
});
