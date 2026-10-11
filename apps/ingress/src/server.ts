import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {readIntegrationSettings} from '../../../packages/db/src/integration-settings.js';
import {getRecord,pool,withTransaction,encrypt,uuid,query} from '@commerce/db';
import {eventDigest,verifyHmac,explicitProviderTimestamp} from '@commerce/messaging';
export async function buildIngress(){
  const app=Fastify({logger:false,bodyLimit:1_048_576,trustProxy:false});
  await app.register(rateLimit,{max:Number(process.env.INGRESS_ACCOUNT_RATE_LIMIT??600),timeWindow:'1 minute',keyGenerator:req=>{const p=req.params as Record<string,string>;return `${req.ip}:${p?.workspace??''}:${p?.account??''}`;}});
  const aggregate=new Map<string,{start:number;count:number}>();app.addHook('onRequest',async(req,reply)=>{const now=Date.now();let bucket=aggregate.get(req.ip);if(!bucket||now-bucket.start>60000){bucket={start:now,count:0};aggregate.set(req.ip,bucket);}if(++bucket.count>Number(process.env.INGRESS_GLOBAL_RATE_LIMIT??6000))return reply.code(429).send({error:{code:'INGRESS_GLOBAL_RATE_LIMIT'}});if(aggregate.size>10000)for(const [key,value] of aggregate)if(now-value.start>60000)aggregate.delete(key);});
  app.removeContentTypeParser('application/json');app.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  app.get('/livez',async()=>({ok:true,service:'ingress'}));
  app.get('/readyz',async(_req,reply)=>{try{await query('SELECT 1');encrypt('readiness');return{ok:true};}catch{return reply.code(503).send({error:{code:'PERSISTENCE_UNAVAILABLE'}});}});
  app.get<{Params:{workspace:string;account:string};Querystring:Record<string,string>}>('/webhooks/cloud/:workspace/:account',async(req,reply)=>{
    const account=await getRecord(pool,req.params.workspace,'channel_account',req.params.account);if(!account||account.body.deleted_at||account.body.provider!=='cloud')return reply.code(404).send();
    const ref=String(account.body.gateway_ref??'CLOUD');const profile=await readIntegrationSettings(pool,account.workspace_id,account.environment,`cloud:${ref}`);const expected=profile?.enabled?profile.secrets.verify_token:undefined;
    if(!expected||req.query['hub.mode']!=='subscribe'||req.query['hub.verify_token']!==expected)return reply.code(403).send({error:{code:'WEBHOOK_VERIFY_FAILED'}});
    return reply.type('text/plain').send(req.query['hub.challenge']??'');
  });
  app.post<{Params:{provider:string;workspace:string;account:string}}>('/webhooks/:provider/:workspace/:account',async(req,reply)=>{
    const {provider,workspace,account:accountId}=req.params;const account=await getRecord(pool,workspace,'channel_account',accountId);if(!account||account.body.deleted_at||account.body.provider!==provider)return reply.code(404).send({error:{code:'ACCOUNT_NOT_FOUND'}});
    const body=req.body as Buffer;if(!Buffer.isBuffer(body))return reply.code(400).send({error:{code:'JSON_BODY_REQUIRED'}});
    const ref=String(account.body.gateway_ref??provider.toUpperCase());const profile=['waha','cloud'].includes(provider)?await readIntegrationSettings(pool,workspace,account.environment,`${provider}:${ref}`):undefined;const protectedSecret=(field:string)=>profile?.enabled?profile.secrets[field]??'':'';
    const header=(name:string)=>typeof req.headers[name]==='string'?req.headers[name]as string:undefined;
    const valid=provider==='waha'?header('x-webhook-hmac-algorithm')==='sha512'&&verifyHmac(body,protectedSecret('webhook_secret'),header('x-webhook-hmac'),'sha512'):
      provider==='cloud'?verifyHmac(body,protectedSecret('app_secret'),header('x-hub-signature-256'),'sha256'):
      provider==='simulator'&&account.environment==='SIMULATION'&&!!process.env.SIMULATOR_INGRESS_TOKEN&&header('authorization')===`Bearer ${process.env.SIMULATOR_INGRESS_TOKEN}`;
    if(!valid)return reply.code(401).send({error:{code:'WEBHOOK_AUTHENTICATION_FAILED'}});
    let payload:any;try{payload=JSON.parse(body.toString('utf8'));}catch{return reply.code(400).send({error:{code:'INVALID_JSON'}});}
    if(provider==='waha'&&payload.session!==String(account.body.session??'default'))return reply.code(400).send({error:{code:'SESSION_MISMATCH'}});
    if(provider==='cloud'&&payload.object!=='whatsapp_business_account')return reply.code(400).send({error:{code:'OBJECT_MISMATCH'}});
    // Entire raw envelope remains encrypted, byte-preserved; provider retries share a durable dedupe key.
    const providerEventId=provider==='waha'&&payload.id?String(payload.id):eventDigest(body);const envelopeId=uuid();
    try{const inserted=await withTransaction(async client=>client.query('INSERT INTO inbound_envelopes(id,workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext,metadata,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) ON CONFLICT(workspace_id,account_id,provider,provider_event_id) DO NOTHING RETURNING id',[envelopeId,workspace,account.environment,accountId,provider,providerEventId,encrypt(body.toString('utf8')),{content_type:'application/json',byte_length:body.length,request_id:eventDigest(String(req.id)),...explicitProviderTimestamp(provider,payload,profile?.config.phone_number_id as string|undefined)}]));return reply.code(200).send({ok:true,duplicate:inserted.rowCount===0});}
    catch{return reply.code(503).send({error:{code:'DURABLE_COMMIT_FAILED'}});}
  });
  app.setErrorHandler((error,_req,reply)=>{const status=typeof (error as {statusCode?:number}).statusCode==='number'?(error as {statusCode:number}).statusCode:500;reply.code(status).send({error:{code:status===413?'PAYLOAD_TOO_LARGE':'INGRESS_REQUEST_FAILED'}});});
  return app;
}
