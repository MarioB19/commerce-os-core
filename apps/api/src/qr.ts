import type {FastifyRequest} from 'fastify';
import {randomUUID} from 'node:crypto';
import type {DomainRecord} from '../../../packages/contracts/src/index.js';
import {onboardingFailure,type OnboardingCode} from '../../../packages/messaging/src/onboarding.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,scopedRecord,fail,audit,envOf} from './context.js';
import {pool,withTransaction,readOperationalSettings} from '../../../packages/db/src/index.js';

/** Keep remote QR material in memory only. Never log a remote body or copy remote error text. */
export async function accountQr(req:FastifyRequest) {
  assertPermission(principal(req),'channels:manage');
  const diagnosticId=randomUUID();
  const attemptedAt=new Date().toISOString();
  let account:DomainRecord;
  try{account=await scopedRecord(req,'channel_account',(req.params as {id:string}).id);}
  catch(error){if((error as {statusCode?:number}).statusCode!==404)throw error;const failure=onboardingFailure('NOT_FOUND','get_qr','UNKNOWN',diagnosticId,attemptedAt);await audit(pool,req,'channel.qr_failed',diagnosticId,{...failure.error.diagnostic,stage:'api_resource_scope'},envOf(req));throw Object.assign(fail(404,'NOT_FOUND',failure.error.message),{diagnostic:failure.error.diagnostic,publicMessage:failure.error.message});}
  const failed=async(code:OnboardingCode,stage:string,httpStatus?:number,providerHttpStatus?:number)=>{
    const failure=onboardingFailure(code,'get_qr',account.body.status,diagnosticId,attemptedAt);
    await audit(pool,req,'channel.qr_failed',account.id,{...failure.error.diagnostic,stage,...(httpStatus?{upstream_http_status:httpStatus}:{}),...(providerHttpStatus?{provider_http_status:providerHttpStatus}:{})},account.environment);
    throw Object.assign(fail(failure.statusCode,failure.error.code,failure.error.message),{diagnostic:failure.error.diagnostic,publicMessage:failure.error.message});
  };
  if(account.body.deleted_at)return failed('CHANNEL_ACCOUNT_DELETED','api');
  if(account.body.provider==='cloud')return failed('QR_NOT_SUPPORTED','api');
  if(account.environment==='SIMULATION')return failed('SIMULATION_HAS_NO_REAL_QR','api');
  // The channel service retains SHARE through the provider call. Holding it
  // across this proxy request would nest two connections behind a queued hold.
  const policy=await readOperationalSettings(pool,account.workspace_id,'REAL');if(policy.release_hold)throw fail(409,'RELEASE_HOLD_ACTIVE');
  if(!process.env.CHANNEL_INTERNAL_URL||!process.env.INTERNAL_SERVICE_TOKEN)return failed('CHANNEL_QR_UNAVAILABLE','api');
  let response:Response;
  try {response=await fetch(`${process.env.CHANNEL_INTERNAL_URL.replace(/\/$/,'')}/accounts/${account.id}/qr`,{headers:{authorization:`Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`,'x-workspace-id':account.workspace_id,'x-diagnostic-id':diagnosticId},redirect:'error',signal:AbortSignal.timeout(20_000)});}
  catch(error){return failed(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name)?'CHANNEL_TIMEOUT':'CHANNEL_OPERATION_FAILED','channel_proxy');}
  const body=await response.json().catch(()=>null);
  if(!response.ok){
    if(response.status===409&&body?.error?.code==='RELEASE_HOLD_ACTIVE')throw fail(409,'RELEASE_HOLD_ACTIVE');
    const known=['CHANNEL_ACCOUNT_DELETED','QR_OPERATION_NOT_AUTHORIZED','SIMULATION_HAS_NO_REAL_QR','QR_NOT_SUPPORTED','PROVIDER_CONFIGURATION_REQUIRED','GATEWAY_AUTH_REJECTED','SESSION_NOT_FOUND','QR_NOT_READY','SESSION_ALREADY_CONNECTED','SESSION_CONFLICT','CHANNEL_GATEWAY_ALREADY_ASSIGNED','CHANNEL_TIMEOUT','QR_RESPONSE_INVALID','CHANNEL_OPERATION_FAILED','ACCOUNT_NOT_FOUND'];
    const code=response.status===401?'CHANNEL_AUTH_REJECTED':known.includes(body?.error?.code)?body.error.code as OnboardingCode:'CHANNEL_OPERATION_FAILED';
    const status=body?.error?.technical?.provider_http_status;
    return failed(code,'channel_worker',response.status,Number.isInteger(status)&&status>=400&&status<=599?status:undefined);
  }
  const qr=body?.data;
  if(qr?.mimeType!=='image/png'||typeof qr.data!=='string'||qr.data.length>2_000_000||!Number.isFinite(Date.parse(qr.expiresAt))||Date.parse(qr.expiresAt)<=Date.now())return failed('QR_RESPONSE_INVALID','channel_response');
  // A hold can commit after the protected SDK call, before this proxy reads it.
  // Recheck locally under SHARE before success audit or returning QR bytes.
  return withTransaction(async c=>{
  const after=await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'});if(after.release_hold)throw fail(409,'RELEASE_HOLD_ACTIVE');
  await audit(c,req,'channel.qr_requested',account.id,{diagnostic_id:diagnosticId,operation:'get_qr',qr_persisted:false},account.environment);
  return {data:{mimeType:qr.mimeType,data:qr.data,expiresAt:qr.expiresAt}};
  });
}
