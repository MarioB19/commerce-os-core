// V7 F1 durable ingress relay (ADR-V7-08). Cloud Run, min 0 / max 2.
// WAHA posts here in addition to the host ingress. The relay keeps the exact
// bytes and the provider HMAC and acknowledges only after Pub/Sub accepted the
// message; the VM consumer replays it into the host ingress, which verifies the
// HMAC against the account secret and inserts with the same dedupe key. The
// relay never sees account secrets, the database or decoded payload content.
import {createServer} from 'node:http';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';

export const MAX_BODY=1_048_576;
const TOKEN_URL='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
// 1-256 characters, no slash and no control character.
const ID={test:value=>typeof value==='string'&&value.length>=1&&value.length<=256&&![...value].some(c=>c==='/'||c.charCodeAt(0)<32||c.charCodeAt(0)===127)};

export function relayConfig(env){
 const token=env.RELAY_TOKEN??'',topic=env.PUBSUB_TOPIC??'',endpoint=env.PUBSUB_ENDPOINT??'https://us-east1-pubsub.googleapis.com';
 if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw new Error('RELAY_TOKEN_REQUIRED');
 if(!/^projects\/[a-z][a-z0-9-]{4,61}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/.test(topic))throw new Error('RELAY_TOPIC_REQUIRED');
 if(!/^https:\/\/[a-z0-9.-]+$/.test(endpoint))throw new Error('RELAY_ENDPOINT_INVALID');
 return Object.freeze({tokenDigest:createHash('sha256').update(token).digest(),topic,endpoint});
}

/** /relay/<token>/waha/<workspace>/<account> -> parts, or null. */
export function parseRelayPath(rawUrl){
 let url;try{url=new URL(rawUrl,'http://relay.invalid');}catch{return null;}
 if(url.search)return null;
 const parts=url.pathname.split('/');
 if(parts.length!==6||parts[0]!==''||parts[1]!=='relay'||parts[3]!=='waha')return null;
 let workspace,account;
 try{workspace=decodeURIComponent(parts[4]);account=decodeURIComponent(parts[5]);}catch{return null;}
 if(!ID.test(workspace)||!ID.test(account))return null;
 return{token:parts[2],provider:'waha',workspace,account};
}

export function tokenMatches(config,token){
 const digest=createHash('sha256').update(String(token)).digest();
 return timingSafeEqual(digest,config.tokenDigest);
}

/** Cached metadata-server access token for the service identity. */
export function metadataTokens(fetchImpl=fetch,now=Date.now){
 let cached=null;
 return async()=>{
  if(cached&&cached.expires>now()+60_000)return cached.value;
  const response=await fetchImpl(TOKEN_URL,{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('RELAY_IDENTITY_UNAVAILABLE');
  const body=await response.json();
  if(typeof body.access_token!=='string'||!Number.isFinite(body.expires_in))throw new Error('RELAY_IDENTITY_UNAVAILABLE');
  cached={value:body.access_token,expires:now()+body.expires_in*1000};
  return cached.value;
 };
}

export async function publish(config,message,{fetchImpl=fetch,token}){
 const response=await fetchImpl(`${config.endpoint}/v1/${config.topic}:publish`,{method:'POST',
  headers:{authorization:`Bearer ${await token()}`,'content-type':'application/json'},
  body:JSON.stringify({messages:[message]}),signal:AbortSignal.timeout(10_000)});
 if(!response.ok)throw new Error('RELAY_PUBLISH_REJECTED');
 const body=await response.json();
 if(!Array.isArray(body.messageIds)||body.messageIds.length!==1||typeof body.messageIds[0]!=='string')throw new Error('RELAY_PUBLISH_UNCONFIRMED');
 return body.messageIds[0];
}

function readBody(req){
 return new Promise((resolve,reject)=>{
  const chunks=[];let size=0;
  // Oversized bodies are drained and discarded, then refused with 413.
  req.on('data',chunk=>{size+=chunk.length;if(size<=MAX_BODY)chunks.push(chunk);});
  req.on('end',()=>size>MAX_BODY?reject(Object.assign(new Error('PAYLOAD_TOO_LARGE'),{status:413})):resolve(Buffer.concat(chunks)));
  req.on('error',reject);
 });
}

export function createRelay(config,{fetchImpl=fetch,token=metadataTokens(fetchImpl),now=()=>new Date()}={}){
 const send=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
 return createServer(async(req,res)=>{
  try{
   if(req.method==='GET'&&req.url==='/livez')return send(res,200,{ok:true,service:'ingress-relay'});
   const route=req.method==='POST'?parseRelayPath(req.url??''):null;
   if(!route||!tokenMatches(config,route.token))return send(res,404,{error:{code:'NOT_FOUND'}});
   if(!String(req.headers['content-type']??'').toLowerCase().startsWith('application/json'))return send(res,415,{error:{code:'JSON_BODY_REQUIRED'}});
   const hmac=req.headers['x-webhook-hmac'],algorithm=req.headers['x-webhook-hmac-algorithm'];
   if(algorithm!=='sha512'||typeof hmac!=='string'||!/^[a-f0-9]{128}$/.test(hmac))return send(res,401,{error:{code:'WEBHOOK_AUTHENTICATION_REQUIRED'}});
   if(Number(req.headers['content-length']??0)>MAX_BODY){res.setHeader('connection','close');return send(res,413,{error:{code:'PAYLOAD_TOO_LARGE'}});}
   const body=await readBody(req);
   if(!body.length)return send(res,400,{error:{code:'JSON_BODY_REQUIRED'}});
   const id=await publish(config,{data:body.toString('base64'),orderingKey:`${route.workspace}/${route.account}`,attributes:{
    provider:route.provider,workspace:route.workspace,account:route.account,hmac,hmac_algorithm:algorithm,
    received_at:now().toISOString(),request_id:randomUUID()}},{fetchImpl,token});
   return send(res,200,{ok:true,relayed:id.length>0});
  }catch(error){
   const status=error?.status===413?413:503;
   if(!res.headersSent)send(res,status,{error:{code:status===413?'PAYLOAD_TOO_LARGE':'RELAY_UNAVAILABLE'}});
  }
 });
}

if(import.meta.url===`file://${process.argv[1]}`){
 const server=createRelay(relayConfig(process.env));
 server.requestTimeout=30_000;server.headersTimeout=10_000;
 server.listen(Number(process.env.PORT??8080),'0.0.0.0');
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
