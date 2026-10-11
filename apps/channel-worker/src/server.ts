import Fastify from 'fastify';
import {getRecord,pool,withTransaction,readOperationalSettings} from '@commerce/db';
import {providerFor,assertGatewayIsolation,type ProviderFactory} from './providers.js';
import {onboardingEnabled,onboardingCode,onboardingFailure,type OnboardingCode} from '../../../packages/messaging/src/onboarding.js';
import {ProviderError} from '../../../packages/messaging/src/types.js';
import {ChannelLoopMonitor,channelLoopMetrics} from './loop-monitor.js';
import {withReadBudget} from '../../../packages/db/src/read-budget.js';
export async function buildChannelServer(factory:ProviderFactory=providerFor,monitor=new ChannelLoopMonitor()){const app=Fastify({logger:false});
 app.addHook('onRequest',async(req,reply)=>{if(req.url==='/livez'||req.url==='/readyz')return;const expected=process.env.INTERNAL_SERVICE_TOKEN??process.env.CHANNEL_INTERNAL_TOKEN;if(!expected||req.headers.authorization!==`Bearer ${expected}`)return reply.code(401).send({error:{code:'INTERNAL_AUTH_REQUIRED'}});});
 app.get('/livez',async()=>({ok:true,service:'channel-worker'}));app.get('/readyz',async(_req,reply)=>{try{await withReadBudget(pool,2000,c=>c.query('SELECT 1'));const progress=monitor.snapshot();return reply.code(progress.ready?200:503).send({ok:progress.ready,...progress});}catch{return reply.code(503).send({ok:false,code:'DB_UNAVAILABLE',loops:monitor.snapshot().loops});}});
 app.get('/metrics',async(_req,reply)=>reply.type('text/plain').send(channelLoopMetrics(monitor.snapshot())));
 app.get<{Params:{id:string}}>('/accounts/:id/qr',async(req,reply)=>{
  reply.header('Cache-Control','no-store,private,max-age=0').header('Pragma','no-cache');
  const workspace=String(req.headers['x-workspace-id']??'');
  const account=await getRecord(pool,workspace,'channel_account',req.params.id);
  const supplied=String(req.headers['x-diagnostic-id']??'');
  const diagnosticId=/^[a-zA-Z0-9_-]{1,100}$/.test(supplied)?supplied:req.id;
  const failed=(code:OnboardingCode,error?:unknown)=>{const result=onboardingFailure(code,'get_qr',account?.body.status,diagnosticId);return reply.code(result.statusCode).send({error:{...result.error,...(error instanceof ProviderError&&error.httpStatus?{technical:{provider_http_status:error.httpStatus}}:{})}});};
  if(!account)return failed('ACCOUNT_NOT_FOUND');
  if(account.body.deleted_at)return failed('CHANNEL_ACCOUNT_DELETED');
  if(account.environment==='SIMULATION')return failed('SIMULATION_HAS_NO_REAL_QR');
  if(account.body.provider==='cloud')return failed('QR_NOT_SUPPORTED');
  try{return await withTransaction(async c=>{const policy=await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'});if(policy.release_hold)return reply.code(409).send({error:{code:'RELEASE_HOLD_ACTIVE'}});if(!onboardingEnabled(policy.body))return failed('QR_OPERATION_NOT_AUTHORIZED');await assertGatewayIsolation(account);return{data:await (await factory(account)).qr()};});}catch(error){return failed(onboardingCode(error,'get_qr'),error);}
 });
 return app;
}
