import nodemailer from 'nodemailer';
import {isIP} from 'node:net';
import {z} from 'zod';
import {pool,uuid,encrypt,decrypt,withTransaction,type QueryExecutor} from '../../../packages/db/src/index.js';
import {activeMember,identityLock,identityAudit,identityDigest,resetTTLSeconds} from '../../../packages/db/src/identity.js';

const line=z.string().min(1).max(160).regex(/^[^\r\n<>]*$/);
export const mailConfigSchema=z.object({mode:z.enum(['local','remote']),host:z.string().min(1).max(253).regex(/^[a-zA-Z0-9.-]+$/),port:z.number().int().min(1).max(65535),tls:z.enum(['none','starttls','implicit']),from:z.email().max(254),name:line}).strict();
export const mailPatchSchema=z.object({expected_version:z.number().int().min(0),enabled:z.boolean(),config:mailConfigSchema,username:z.string().max(254).regex(/^[^\r\n]*$/).optional(),password:z.string().min(1).max(1024).optional(),clear_credentials:z.boolean().optional()}).strict();
type MailConfig=z.infer<typeof mailConfigSchema>;
type MailSetting={version:number;enabled:boolean;config:MailConfig;secret_ciphertext:string|null;diagnostic_code:string|null;diagnosed_at:Date|null};
function allowedTarget(config:MailConfig){
 const targets=z.array(z.object({host:z.string(),port:z.number(),addresses:z.array(z.string().refine(x=>Boolean(isIP(x)))).min(1),mode:z.enum(['local','remote'])}).strict()).parse(JSON.parse(process.env.SMTP_ALLOWED_TARGETS??'[]'));
 const target=targets.find(t=>t.host===config.host&&t.port===config.port&&t.mode===config.mode);
 if(!target)throw new Error('SMTP_TARGET_DENIED');
 if(config.mode==='remote'&&!(config.port===587&&config.tls==='starttls'||config.port===465&&config.tls==='implicit'))throw new Error('SMTP_TLS_REQUIRED');
 if(config.mode==='local'&&target.addresses.some(ip=>! /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)&&ip!=='::1'))throw new Error('SMTP_LOCAL_TARGET_DENIED');
 return target;
}
export function publicWebOrigin(){
 const value=process.env.PUBLIC_WEB_ORIGIN??process.env.CLIENT_ORIGIN?.split(',')[0]??process.env.BETTER_AUTH_URL??'http://localhost:5173';
 const url=new URL(value);
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['http:','https:'].includes(url.protocol)||
  (url.protocol!=='https:'&&(process.env.NODE_ENV==='production'||!['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('PUBLIC_WEB_ORIGIN_INVALID');
 return url.origin;
}
export async function readMailSetting(c:QueryExecutor=pool){return (await c.query('SELECT * FROM identity_mail_settings WHERE singleton=true')).rows[0] as MailSetting|undefined;}
function credentials(setting:MailSetting){
 if(!setting.secret_ciphertext)return {} as {username?:string;password?:string};
 const clear=JSON.parse(decrypt(setting.secret_ciphertext));
 if(clear.scope!=='identity.smtp'||clear.version!==setting.version)throw new Error('SMTP_SECRET_UNAVAILABLE');
 return {username:clear.username as string,password:clear.password as string};
}
export function mailMetadata(setting:MailSetting|undefined){return {version:setting?.version??0,enabled:setting?.enabled??false,config:setting?.config??null,credentials_configured:Boolean(setting?.secret_ciphertext),diagnostic:setting?.diagnostic_code??'NOT_CONFIGURED',diagnosed_at:setting?.diagnosed_at??null};}
export async function saveMailSetting(c:QueryExecutor,input:z.infer<typeof mailPatchSchema>,actor:string,correlation:string){
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('identity:mail-settings',0))");
 const previous=await readMailSetting(c);
 if((previous?.version??0)!==input.expected_version)throw Object.assign(new Error('VERSION_CONFLICT'),{statusCode:409});
 allowedTarget(input.config);publicWebOrigin();
 if(input.clear_credentials&&(input.username!==undefined||input.password!==undefined))throw Object.assign(new Error('INVALID_CREDENTIAL_PATCH'),{statusCode:400});
 const changedServer=previous&&(previous.config.host.toLowerCase()!==input.config.host.toLowerCase()||previous.config.mode!==input.config.mode);
 if(changedServer&&previous.secret_ciphertext&&!input.clear_credentials&&input.password===undefined)throw Object.assign(new Error('SMTP_CREDENTIAL_REPLACEMENT_REQUIRED'),{statusCode:400,code:'SMTP_CREDENTIAL_REPLACEMENT_REQUIRED',publicMessage:'Al cambiar de servidor, introduce una credencial nueva o elimina la anterior.'});
 const old=previous?credentials(previous):{};
 const secret=input.clear_credentials?{}:{...old,...(input.username!==undefined?{username:input.username}:{}),...(input.password!==undefined?{password:input.password}:{})};
 if(input.config.mode==='local'&&(secret.username||secret.password))throw Object.assign(new Error('LOCAL_SMTP_NO_CREDENTIALS'),{statusCode:400});
 if(input.config.mode==='remote'&&input.enabled&&(!secret.username||!secret.password))throw Object.assign(new Error('SMTP_CREDENTIALS_REQUIRED'),{statusCode:400});
 if(secret.password&&JSON.stringify(input.config).includes(secret.password))throw Object.assign(new Error('SECRET_IN_PUBLIC_FIELDS'),{statusCode:400});
 const version=(previous?.version??0)+1;
 const ciphertext=secret.username||secret.password?encrypt({scope:'identity.smtp',version,...secret}):null;
 await c.query(`INSERT INTO identity_mail_settings(singleton,version,enabled,config,secret_ciphertext,updated_by) VALUES(true,$1,$2,$3,$4,$5)
 ON CONFLICT(singleton) DO UPDATE SET version=$1,enabled=$2,config=$3,secret_ciphertext=$4,updated_by=$5,updated_at=now(),diagnostic_code=NULL,diagnosed_at=NULL`,[version,input.enabled,input.config,ciphertext,actor]);
 await identityAudit(c,'smtp.settings','UPDATED',correlation,undefined,actor);
 return mailMetadata(await readMailSetting(c));
}
export async function mailReady(c:QueryExecutor=pool){
 try{const s=await readMailSetting(c);if(!s?.enabled)return false;allowedTarget(mailConfigSchema.parse(s.config));publicWebOrigin();const cred=credentials(s);return s.config.mode==='local'||Boolean(cred.username&&cred.password);}catch{return false;}
}
function transport(setting:MailSetting){
 const config=mailConfigSchema.parse(setting.config),target=allowedTarget(config),cred=credentials(setting);
 return nodemailer.createTransport({host:target.addresses[0],port:config.port,secure:config.tls==='implicit',requireTLS:config.tls==='starttls',ignoreTLS:config.tls==='none',
  tls:{rejectUnauthorized:true,servername:config.host,minVersion:'TLSv1.2'},
  ...(config.mode==='remote'?{auth:{user:cred.username,pass:cred.password}}:{}),
  connectionTimeout:5000,greetingTimeout:5000,socketTimeout:10000,logger:false,debug:false,disableFileAccess:true,disableUrlAccess:true});
}
export function smtpFailure(error:unknown):{code:string;retry:boolean;uncertain:boolean}{
 const e=error as {code?:string;responseCode?:number;command?:string;syscall?:string};
 // Permanent AUTH failures need an actionable diagnostic; temporary 4xx AUTH failures remain retryable.
 if(e.code==='EAUTH'&&(!e.responseCode||e.responseCode>=500))return {code:'SMTP_AUTH_FAILED',retry:false,uncertain:false};
 if(e.responseCode&&e.responseCode>=400)return {code:e.responseCode>=500?'SMTP_REJECTED':'SMTP_TEMPORARY_REJECTION',retry:e.responseCode<500,uncertain:false};
 if(e.code?.includes('CERT')||e.code==='ETLS')return {code:'SMTP_TLS_FAILED',retry:false,uncertain:false};
 // Nodemailer may label a socket timeout CONN even after DATA: never infer a safe retry from that label.
 if(e.code!=='ETIMEDOUT'&&(['EHLO','HELO','STARTTLS','AUTH'].includes(e.command??'')||e.syscall==='connect'||e.code==='ECONNECTION'||e.code==='EDNS'))return {code:'SMTP_UNREACHABLE',retry:true,uncertain:false};
 return {code:'SMTP_OUTCOME_UNKNOWN',retry:false,uncertain:true};
}
export async function diagnoseMail(){
 const s=await readMailSetting();if(!s)return {code:'NOT_CONFIGURED',accepted_is_not_received:true};
 let code='SMTP_CONNECTION_OK';
 try{const tx=transport(s);try{await tx.verify();}finally{tx.close();}}catch(error){code=smtpFailure(error).code;}
 await pool.query('UPDATE identity_mail_settings SET diagnostic_code=$1,diagnosed_at=now() WHERE singleton=true AND version=$2',[code,s.version]);
 return {code,accepted_is_not_received:true};
}
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function resetMailTemplate(url:string){
 const text=`Restablece tu contraseña de Commerce OS\n\nRecibimos una solicitud para recuperar tu acceso. Este enlace es de un solo uso y vence en 30 minutos:\n\n${url}\n\nSi no lo solicitaste, ignora este correo. Tu contraseña no ha cambiado.\n\nCommerce OS`;
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Recupera tu acceso</title></head><body style="margin:0;background:#f4f6f8;color:#172332;font:16px/1.6 Arial,sans-serif"><main style="max-width:560px;margin:32px auto;padding:32px;background:#fff;border-radius:12px"><p style="font-weight:bold;color:#1a5948">Commerce OS</p><h1 style="font-size:26px">Restablece tu contraseña</h1><p>Recibimos una solicitud para recuperar tu acceso.</p><p>El enlace es de un solo uso y vence en <strong>30 minutos</strong>.</p><p style="margin:28px 0"><a href="${escape(url)}" style="display:inline-block;background:#155c49;color:#fff;text-decoration:none;padding:14px 22px;border-radius:8px;font-weight:bold">Restablecer contraseña</a></p><p>Si el botón no funciona, copia este enlace:</p><p style="overflow-wrap:anywhere;word-break:break-all"><a style="color:#155c49" href="${escape(url)}">${escape(url)}</a></p><hr style="border:0;border-top:1px solid #dce4e0"><p>Si no lo solicitaste, ignora este correo. Tu contraseña no ha cambiado.</p></main></body></html>`;
 return {subject:'Restablece tu contraseña · Commerce OS',text,html};
}
export async function enqueueResetMail(c:QueryExecutor,user:{id:string;email:string},token:string){
 const digest=identityDigest('reset','reset-password:'+token),id=uuid(),expires=new Date(Date.now()+resetTTLSeconds*1000);
 // Fragment never reaches HTTP access logs; a GET cannot consume Better Auth's verifier.
 const url=publicWebOrigin()+'/reset-password#token='+encodeURIComponent(token);
 const setting=await readMailSetting(c);
 const message_id=`<${id}@${setting?.config.from.split('@')[1]??new URL(publicWebOrigin()).hostname}>`;
 await c.query('INSERT INTO identity_reset_links(digest,user_id,expires_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[digest,user.id,expires]);
 await c.query('INSERT INTO identity_mail_jobs(id,link_digest,user_id,payload_ciphertext,expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(link_digest) DO NOTHING',[id,digest,user.id,encrypt({scope:'identity.reset-mail',id,user_id:user.id,to:user.email,url,message_id}),expires]);
}
async function finish(c:QueryExecutor,job:any,status:string,code:string){
 await c.query('UPDATE identity_mail_jobs SET status=$2,diagnostic_code=$3,payload_ciphertext=NULL,finished_at=now() WHERE id=$1',[job.id,status,code]);
 await identityAudit(c,'smtp.dispatch',status,job.id,job.user_id,undefined,job.id);
}
/** Every promise is awaited; abandoned claims are uncertain, never blindly replayed. */
export async function processIdentityMail(){
 await withTransaction(async c=>{
  const stale=(await c.query("SELECT * FROM identity_mail_jobs WHERE status='SENDING' AND claimed_at<now()-interval '60 seconds' FOR UPDATE SKIP LOCKED")).rows;
  for(const job of stale)await finish(c,job,'UNCERTAIN','WORKER_INTERRUPTED');
  const expired=(await c.query("SELECT * FROM identity_mail_jobs WHERE status='PENDING' AND expires_at<=now() FOR UPDATE SKIP LOCKED")).rows;
  for(const job of expired)await finish(c,job,'EXPIRED','LINK_EXPIRED');
 });
 // Release job locks before touching verifiers: reset locks verifiers before cancelling jobs.
 await withTransaction(async c=>{
  await c.query('DELETE FROM verification WHERE identifier IN (SELECT digest FROM identity_reset_links WHERE expires_at<=now())');
  await c.query('DELETE FROM identity_reset_links WHERE expires_at<=now()');
  await c.query('DELETE FROM identity_rate_limits WHERE expires_at<now()');
 });
 const job=await withTransaction(async c=>{
  const row=(await c.query("SELECT * FROM identity_mail_jobs WHERE status='PENDING' AND available_at<=now() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
  if(!row)return;
  await c.query("UPDATE identity_mail_jobs SET status='SENDING',claimed_at=now(),attempts=attempts+1 WHERE id=$1",[row.id]);return {...row,attempts:row.attempts+1};
 });
 if(!job)return false;
 await withTransaction(async c=>{
  await identityLock(c,job.user_id);
  const current=(await c.query('SELECT * FROM identity_mail_jobs WHERE id=$1 FOR UPDATE',[job.id])).rows[0];
  if(current.status!=='SENDING')return;
  if(new Date(current.expires_at).getTime()<=Date.now()+10000){await finish(c,job,'EXPIRED','LINK_EXPIRED');return;}
  if(!await activeMember(c,job.user_id)||!(await c.query('SELECT 1 FROM identity_reset_links l JOIN verification v ON v.identifier=l.digest WHERE l.digest=$1 AND v."expiresAt">now()+interval \'10 seconds\'',[job.link_digest])).rowCount){await finish(c,job,'CANCELLED','LINK_INVALIDATED');return;}
  if(!await mailReady(c)){await finish(c,job,'FAILED','SMTP_NOT_CONFIGURED');return;}
  const setting=(await readMailSetting(c))!;
  let status='ACCEPTED',code='SMTP_ACCEPTED';
  try{
   const payload=JSON.parse(decrypt(current.payload_ciphertext));
   if(payload.scope!=='identity.reset-mail'||payload.id!==job.id||payload.user_id!==job.user_id||typeof payload.message_id!=='string'||/[\r\n]/.test(payload.message_id))throw new Error('PAYLOAD_SCOPE_MISMATCH');
   const tx=transport(setting);
   try{const result=await tx.sendMail({from:{name:setting.config.name,address:setting.config.from},to:payload.to,messageId:payload.message_id,...resetMailTemplate(payload.url)});
    if(result.accepted.length!==1){status='FAILED';code='SMTP_REJECTED';}
   }finally{tx.close();}
  }catch(error){const failure=smtpFailure(error);code=failure.code;
   if(failure.retry&&job.attempts<3){await c.query("UPDATE identity_mail_jobs SET status='PENDING',available_at=now()+interval '30 seconds',diagnostic_code=$2 WHERE id=$1",[job.id,code]);await identityAudit(c,'smtp.dispatch','RETRY_PENDING',job.id,job.user_id,undefined,job.id);return;}
   status=failure.uncertain?'UNCERTAIN':'FAILED';
  }
  await finish(c,job,status,code);
 });return true;
}
export function startIdentityMailWorker(){
 let running:Promise<unknown>|undefined,stopped=false;
 const run=()=>{if(running||stopped)return;running=processIdentityMail().catch(()=>{process.stderr.write('identity_mail_worker_failed; durable state retained\n');}).finally(()=>{running=undefined;});};
 const timer=setInterval(run,1000);timer.unref();run();
 return async()=>{stopped=true;clearInterval(timer);await running;};
}
