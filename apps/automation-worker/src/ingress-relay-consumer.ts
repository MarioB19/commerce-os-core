/** V7 F1 durable ingress (ADR-V7-08): drain the Pub/Sub subscription fed by
 * the Cloud Run relay and replay each message into the host ingress, which
 * verifies the provider HMAC against the account secret and inserts with the
 * same dedupe key as the direct callback. Ack only after the ingress committed
 * (200, including duplicates) or refused for good (400/401/404/413/415); any
 * other outcome is a nack, so Pub/Sub redelivers and, after its maximum
 * attempts, dead-letters. Within one ordering key nothing after a retry is
 * acknowledged. Runs only with INGRESS_PUBSUB_SUBSCRIPTION configured. */
export type RelayMessage={ackId:string;message:{data?:string;attributes?:Record<string,string>;orderingKey?:string;messageId?:string}};
export type RelayPorts={
 pull():Promise<RelayMessage[]>;
 ack(ids:string[]):Promise<void>;
 nack(ids:string[]):Promise<void>;
 deliver(input:{workspace:string;account:string;headers:Record<string,string>;body:Buffer}):Promise<number>;
};
const FINAL=new Set([400,401,404,413,415]);
const TOKEN_URL='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SUBSCRIPTION=/^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/;

function metadataTokens(){
 let cached:{value:string;expires:number}|null=null;
 return async()=>{
  if(cached&&cached.expires>Date.now()+60_000)return cached.value;
  const response=await fetch(TOKEN_URL,{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('INGRESS_RELAY_IDENTITY_UNAVAILABLE');
  const body=await response.json() as {access_token?:unknown;expires_in?:unknown};
  if(typeof body.access_token!=='string'||typeof body.expires_in!=='number')throw new Error('INGRESS_RELAY_IDENTITY_UNAVAILABLE');
  cached={value:body.access_token,expires:Date.now()+body.expires_in*1000};return cached.value;
 };
}

export function pubsubPorts(subscription:string,ingress=process.env.INTERNAL_INGRESS_URL??'http://ingress:3002',endpoint='https://pubsub.googleapis.com'):RelayPorts{
 if(!SUBSCRIPTION.test(subscription))throw new Error('INGRESS_RELAY_SUBSCRIPTION_INVALID');
 const token=metadataTokens();
 const call=async(method:string,body:unknown,timeout=10_000)=>{
  const response=await fetch(`${endpoint}/v1/${subscription}:${method}`,{method:'POST',headers:{authorization:`Bearer ${await token()}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  if(!response.ok)throw new Error('INGRESS_RELAY_PUBSUB_'+method.toUpperCase()+'_FAILED');
  return response.json() as Promise<Record<string,unknown>>;
 };
 return{
  pull:async()=>((await call('pull',{maxMessages:20},30_000)).receivedMessages??[]) as RelayMessage[],
  ack:async ids=>{if(ids.length)await call('acknowledge',{ackIds:ids});},
  nack:async ids=>{if(ids.length)await call('modifyAckDeadline',{ackIds:ids,ackDeadlineSeconds:0});},
  deliver:async({workspace,account,headers,body})=>{
   const response=await fetch(`${ingress}/webhooks/waha/${encodeURIComponent(workspace)}/${encodeURIComponent(account)}`,{method:'POST',headers,body:new Uint8Array(body),signal:AbortSignal.timeout(15_000)});
   await response.arrayBuffer();return response.status;
  },
 };
}

let configured:RelayPorts|undefined;
export async function consumeIngressRelay(ports?:RelayPorts){
 if(!ports){
  const subscription=process.env.INGRESS_PUBSUB_SUBSCRIPTION;
  if(!subscription)return{skipped:'NOT_CONFIGURED' as const};
  configured??=pubsubPorts(subscription);ports=configured;
 }
 const received=await ports.pull();
 const result={skipped:null,pulled:received.length,delivered:0,rejected:0,retried:0};
 const keys=new Map<string,RelayMessage[]>();
 for(const item of received){const key=item.message.orderingKey??item.ackId;keys.set(key,[...(keys.get(key)??[]),item]);}
 const ack:string[]=[],nack:string[]=[];
 for(const group of keys.values()){
  let blocked=false;
  for(const item of group){
   if(blocked){nack.push(item.ackId);result.retried++;continue;}
   const a=item.message.attributes??{};
   const valid=a.provider==='waha'&&typeof a.workspace==='string'&&typeof a.account==='string'&&a.hmac_algorithm==='sha512'&&/^[a-f0-9]{128}$/.test(a.hmac??'')&&typeof item.message.data==='string';
   if(!valid){ack.push(item.ackId);result.rejected++;continue;}
   const status=await ports.deliver({workspace:a.workspace!,account:a.account!,headers:{'content-type':'application/json','x-webhook-hmac':a.hmac!,'x-webhook-hmac-algorithm':'sha512'},body:Buffer.from(item.message.data!,'base64')}).catch(()=>0);
   if(status===200){ack.push(item.ackId);result.delivered++;}
   else if(FINAL.has(status)){ack.push(item.ackId);result.rejected++;}
   else{nack.push(item.ackId);result.retried++;blocked=true;}
  }
 }
 await ports.ack(ack);await ports.nack(nack);
 return result;
}
