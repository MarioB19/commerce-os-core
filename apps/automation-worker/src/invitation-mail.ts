import pg from 'pg';
import {dispatchProfileInvitationMail,type InvitationMailResult} from '../../../packages/db/src/profile-invitation-mail.js';
import type {InvitationMailTransport} from '../../../packages/contracts/src/profile-invitation-mail.js';
import type {ProfilePool} from '../../../packages/db/src/profile-context.js';
import {dispatchOwnerAlertMail} from '../../../packages/db/src/owner-alert-mail.js';
import {pool as automationPool} from '@commerce/db';

/** V7 F1 (ADR-V7-13): send queued profile invitations through the App Engine
 * mail service. The dedicated commerce_mail_dispatch login only discovers job
 * identifiers and runs the closed reserve/claim/finish functions; every send is
 * fenced by its 120 s lease and a lost answer is recorded UNCERTAIN, never
 * resent. Inactive without MAIL_DISPATCH_DATABASE_URL, MAIL_SERVICE_ORIGIN and
 * MAIL_ENVELOPE_KEY. */
const IDENTITY='http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

export function appEngineTransport(origin:string,fetchImpl:typeof fetch=fetch):InvitationMailTransport{
 const url=new URL(origin);
 if(url.protocol!=='https:'||url.pathname!=='/'||url.search||url.hash||!url.hostname.endsWith('.appspot.com'))throw new Error('MAIL_SERVICE_ORIGIN_INVALID');
 return{async send(body,beforeSend){
  const identity=await fetchImpl(`${IDENTITY}?audience=${encodeURIComponent(url.origin)}&format=full`,{headers:{'Metadata-Flavor':'Google'},signal:AbortSignal.timeout(5000)});
  if(!identity.ok)throw new Error('MAIL_DISPATCHER_IDENTITY_UNAVAILABLE');
  const token=(await identity.text()).trim();
  if(!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw new Error('MAIL_DISPATCHER_IDENTITY_UNAVAILABLE');
  beforeSend();
  const response=await fetchImpl(`${url.origin}/v1/dispatch`,{method:'POST',redirect:'error',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:new Uint8Array(body),signal:AbortSignal.timeout(30_000)});
  if(!response.ok)throw new Error('MAIL_SERVICE_REJECTED');
  return response.json();
 }};
}

export type InvitationMailPorts={pool:ProfilePool&{query:pg.Pool['query']};key:Uint8Array;transport:InvitationMailTransport;now?:()=>Date;
 /** RF-07.e: the automation pool that queues owner alert mail (default: this worker's pool). */
 queue?:{query:pg.Pool['query']}};
let configured:InvitationMailPorts|undefined;
function fromEnvironment():InvitationMailPorts|undefined{
 const database=process.env.MAIL_DISPATCH_DATABASE_URL,origin=process.env.MAIL_SERVICE_ORIGIN,key=process.env.MAIL_ENVELOPE_KEY;
 if(!database||!origin||!key)return undefined;
 const bytes=Buffer.from(key,'base64');if(bytes.byteLength!==32||bytes.toString('base64')!==key)throw new Error('MAIL_ENVELOPE_KEY_INVALID');
 configured??={pool:new pg.Pool({connectionString:database,max:2,connectionTimeoutMillis:5000}) as InvitationMailPorts['pool'],key:bytes,transport:appEngineTransport(origin)};
 return configured;
}

export async function processInvitationMail(ports?:InvitationMailPorts){
 const active=ports??fromEnvironment();
 if(!active)return{skipped:'NOT_CONFIGURED' as const};
 const jobs=(await active.pool.query('SELECT workspace_id,job_id FROM public.queued_profile_invitation_mail($1)',[5])).rows as {workspace_id:string;job_id:string}[];
 const results:{state:InvitationMailResult['state']|'DEFERRED';code?:string}[]=[];
 for(const job of jobs){
  try{results.push({state:(await dispatchProfileInvitationMail(active.pool,{workspaceId:job.workspace_id,jobId:job.job_id},{key:active.key,transport:active.transport,...(active.now?{now:active.now}:{})})).state});}
  catch(error){
   // Reservation refused (quota, budget, changed invitation): nothing was sent; retried later.
   const code=(error as {message?:string}).message??'';results.push({state:'DEFERRED',code:/^[A-Z0-9_]+$/.test(code)?code:'MAIL_RESERVATION_REFUSED'});
  }
 }
 // RF-07.e: incidents and recoveries for the owners, then their mail.
 let queued=0;try{queued=Number((await (active.queue??automationPool).query('SELECT public.queue_owner_alert_mail($1) AS n',[50])).rows[0]?.n??0);}catch{/* queued on a later pass */}
 const alerts=(await active.pool.query('SELECT workspace_id,job_id FROM public.queued_owner_alert_mail($1)',[5])).rows as {workspace_id:string;job_id:string}[];
 const alertResults:{state:string;code?:string}[]=[];
 for(const job of alerts){
  try{alertResults.push({state:(await dispatchOwnerAlertMail(active.pool,{workspaceId:job.workspace_id,jobId:job.job_id},{key:active.key,transport:active.transport,...(active.now?{now:active.now}:{})})).state});}
  catch(error){const code=(error as {message?:string}).message??'';alertResults.push({state:'DEFERRED',code:/^[A-Z0-9_]+$/.test(code)?code:'MAIL_RESERVATION_REFUSED'});}
 }
 return{skipped:null,jobs:jobs.length,results,alerts:{queued,jobs:alerts.length,results:alertResults}};
}
