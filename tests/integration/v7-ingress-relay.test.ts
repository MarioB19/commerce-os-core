import {afterAll,beforeAll,expect,it} from 'vitest';
import {createHmac,randomUUID} from 'node:crypto';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {pool,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import {buildIngress} from '../../apps/ingress/src/server.js';
import {consumeIngressRelay,type RelayMessage,type RelayPorts} from '../../apps/automation-worker/src/ingress-relay-consumer.js';

// V7 F1 (ADR-V7-08): relayed webhooks replay into the host ingress, which
// checks the account HMAC and deduplicates with the direct callback.
const workspace='relay-'+randomUUID(),secret='synthetic-relay-hook';
let ingress:Awaited<ReturnType<typeof buildIngress>>,accountId='';
beforeAll(async()=>{
 await fixtureProfiles(workspace);
 const ref='TEST_'+randomUUID().replaceAll('-','');
 await withTransaction(c=>saveIntegrationSetting(c,workspace,'REAL','waha:'+ref,{expected_version:0,label:'Synthetic relay gateway',enabled:true,config:{base_url:'http://waha-01:3000'},secrets:{api_key:'synthetic-api',webhook_secret:secret},clear_secrets:[],reason:'Synthetic relay regression'},'synthetic-owner'));
 accountId=(await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic relay account',provider:'waha',gateway_ref:ref,session:'default',status:'CONNECTED',sending_enabled:false}})).id;
 ingress=await buildIngress();
});
afterAll(async()=>{await ingress?.close();await pool.end();});

const event=(id:string,key=secret)=>{
 const body=Buffer.from(JSON.stringify({id,session:'default',event:'message',payload:{id:'msg-'+id,from:'5215550000000@c.us',body:'hola',timestamp:1791900000}}));
 return{body,hmac:createHmac('sha512',key).update(body).digest('hex')};
};
function message(id:string,{key=secret,account=accountId,ordering=''}:{key?:string;account?:string;ordering?:string}={}):RelayMessage{
 ordering||=`${workspace}/${account}`;
 const {body,hmac}=event(id,key);
 return{ackId:'ack-'+id,message:{data:body.toString('base64'),orderingKey:ordering,attributes:{provider:'waha',workspace,account,hmac,hmac_algorithm:'sha512'}}};
}
function ports(batch:RelayMessage[],fail:(id:string)=>boolean=()=>false){
 const acked:string[]=[],nacked:string[]=[];
 const value:RelayPorts={
  pull:async()=>batch,ack:async ids=>{acked.push(...ids);},nack:async ids=>{nacked.push(...ids);},
  deliver:async({workspace:w,account:a,headers,body})=>{
   const id=JSON.parse(body.toString()).id as string;if(fail(id))throw new Error('ingress unreachable');
   return (await ingress.inject({method:'POST',url:`/webhooks/waha/${encodeURIComponent(w)}/${encodeURIComponent(a)}`,headers,payload:body})).statusCode;
  }};
 return{value,acked,nacked};
}
const envelopes=async(id:string)=>Number((await pool.query('SELECT count(*) FROM inbound_envelopes WHERE workspace_id=$1 AND account_id=$2 AND provider_event_id=$3',[workspace,accountId,id])).rows[0].count);

it('commits once, acknowledges duplicates and refuses forged or unknown deliveries for good',async()=>{
 const direct=event('evt-direct');
 expect((await ingress.inject({method:'POST',url:`/webhooks/waha/${workspace}/${accountId}`,headers:{'content-type':'application/json','x-webhook-hmac':direct.hmac,'x-webhook-hmac-algorithm':'sha512'},payload:direct.body})).statusCode).toBe(200);
 const p=ports([message('evt-1'),message('evt-1'),message('evt-direct'),message('evt-forged',{key:'wrong'}),message('evt-unknown',{account:randomUUID(),ordering:'other'}),{ackId:'ack-bad',message:{data:'e30=',attributes:{provider:'cloud'}}}]);
 const result=await consumeIngressRelay(p.value);
 expect(result).toMatchObject({pulled:6,delivered:3,rejected:3,retried:0});
 expect(p.acked.sort()).toEqual(['ack-bad','ack-evt-1','ack-evt-1','ack-evt-direct','ack-evt-forged','ack-evt-unknown'].sort());
 expect(p.nacked).toEqual([]);
 expect(await envelopes('evt-1')).toBe(1);expect(await envelopes('evt-direct')).toBe(1);expect(await envelopes('evt-forged')).toBe(0);
});

it('never acknowledges past a retry within one ordering key, other keys continue',async()=>{
 const p=ports([message('evt-a1'),message('evt-a2'),message('evt-b1',{ordering:'another-key'})],id=>id==='evt-a1');
 const result=await consumeIngressRelay(p.value);
 expect(result).toMatchObject({pulled:3,delivered:1,retried:2});
 expect(p.nacked).toEqual(['ack-evt-a1','ack-evt-a2']);expect(p.acked).toEqual(['ack-evt-b1']);
 expect(await envelopes('evt-a2')).toBe(0);
});

it('stays idle without a configured subscription',async()=>{
 delete process.env.INGRESS_PUBSUB_SUBSCRIPTION;
 expect(await consumeIngressRelay()).toEqual({skipped:'NOT_CONFIGURED'});
});
