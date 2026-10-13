import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {SMTPServer} from 'smtp-server';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser,createAuth} from '../../apps/api/src/auth.js';
import {pool,withTransaction,decrypt} from '../../packages/db/src/index.js';
import {processIdentityMail,saveMailSetting,enqueueResetMail} from '../../apps/api/src/identity-mail.js';
import {recoveryMessage} from '../../apps/api/src/account-security.js';
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const workspace='identity-'+randomUUID();
let app:FastifyInstance,smtp:SMTPServer;let smtpPort:number;const received:string[]=[];let smtpMode:'accept'|'reject'|'temporary'|'timeout'='accept';
const secret=()=>randomBytes(24).toString('base64url');
type Person={id:string;email:string;password:string;cookie:string};
let owner:Person;
function cookie(r:any){return (Array.isArray(r.headers['set-cookie'])?r.headers['set-cookie']:[r.headers['set-cookie']]).filter(Boolean).map((x:any)=>String(x).split(';')[0]).join('; ');}
async function call(path:string,body?:any,person?:Person,extras:Record<string,string>={}){return app.inject(explicitFixtureEnvironment({method:body===undefined?'GET':'POST',url:'/api/auth'+path,payload:body,headers:{origin,...(person?{cookie:person.cookie}:{}),...extras},remoteAddress:'127.0.0.'+ (++ip%220+1)}));}
let ip=0;
async function login(p:Person,password=p.password){return call('/sign-in/email',{email:p.email,password});}
async function person(role:any='owner'){const email=randomUUID()+'@example.invalid',password=secret();const user=await provisionUser({email,password,name:'Synthetic identity',workspace_id:workspace,role});const p={...user,email,password,cookie:''};p.cookie=cookie(await login(p));return p;}
async function requestLink(p:Person){const r=await call('/request-password-reset',{email:p.email});expect(r.statusCode).toBe(200);const job=(await pool.query('SELECT * FROM identity_mail_jobs WHERE user_id=$1 ORDER BY created_at DESC',[p.id])).rows[0];const payload=JSON.parse(decrypt(job.payload_ciphertext));return {job,token:new URLSearchParams(new URL(payload.url).hash.slice(1)).get('token')!};}
async function reset(token:string,newPassword=secret()){return call('/reset-password',{token,newPassword,confirmPassword:newPassword});}
beforeAll(async()=>{
 process.env.PUBLIC_WEB_ORIGIN=origin;
 smtp=new SMTPServer({authOptional:true,disabledCommands:['STARTTLS','AUTH'],logger:false,onData(stream,_session,done){let data='';stream.on('data',chunk=>{data+=chunk.toString();});stream.on('end',()=>{received.push(data);if(smtpMode==='timeout')return;if(smtpMode==='reject'||smtpMode==='temporary')done(Object.assign(new Error('synthetic SMTP failure'),{responseCode:smtpMode==='reject'?550:451}));else done();});}});
 await new Promise<void>(resolve=>smtp.listen(0,'127.0.0.1',resolve));smtpPort=(smtp as any).server.address().port;
 process.env.SMTP_ALLOWED_TARGETS=JSON.stringify([{host:'localhost',port:smtpPort,mode:'local',addresses:['127.0.0.1']}]);
 app=await createApp();owner=await person();
 await withTransaction(c=>saveMailSetting(c,{expected_version:0,enabled:true,config:{mode:'local',host:'localhost',port:smtpPort,tls:'none',from:'security@example.invalid',name:'Commerce OS'}},owner.id,randomUUID()));
});
afterAll(async()=>{await app.close();await new Promise<void>(resolve=>smtp.close(()=>resolve()));await pool.end();});
describe('Account security through native HTTP endpoints',()=>{
 it('rotates one of three sessions, removes tokens from JSON and leaves other accounts intact',async()=>{
  const p=await person(),other=await person(),old=[p.cookie,cookie(await login(p)),cookie(await login(p))];const next=secret();
  const r=await call('/change-password',{currentPassword:p.password,newPassword:next,confirmPassword:next,revokeOtherSessions:false},p);
  expect(r.statusCode,r.body).toBe(200);expect(r.json().token).toBeUndefined();const fresh=cookie(r);expect(fresh).not.toBe(p.cookie);
  for(const previous of old)expect((await call('/get-session',undefined,{...p,cookie:previous})).statusCode).toBe(401);
  expect((await call('/get-session',undefined,{...p,cookie:fresh})).statusCode).toBe(200);
  expect((await login(p)).statusCode).toBe(401);expect((await login(p,next)).statusCode).toBe(200);expect((await call('/get-session',undefined,other)).statusCode).toBe(200);
 });
 it('rejects bad current, equal, short, long and mismatched passwords without writes',async()=>{
  const p=await person();
  for(const [currentPassword,newPassword,confirmPassword] of [[secret(),secret(),'ignored'],[p.password,p.password,p.password],[p.password,'short','short'],[p.password,'x'.repeat(129),'x'.repeat(129)],[p.password,secret(),secret()]]){
   const body={currentPassword,newPassword,confirmPassword:confirmPassword==='ignored'?newPassword:confirmPassword};const r=await call('/change-password',body,p);expect(r.statusCode).toBe(400);
  }expect((await login(p)).statusCode).toBe(200);
 });
 it('returns the refreshed cookie only from the committed native session response',async()=>{
  const p=await person();
  await pool.query('UPDATE session SET "updatedAt"=now()-interval \'2 hours\',"expiresAt"=now()+interval \'10 hours\' WHERE "userId"=$1',[p.id]);
  const response=await call('/get-session',undefined,p);
  expect(response.statusCode).toBe(200);expect(cookie(response)).toContain('session_token=');expect(response.json().session.token).toBeUndefined();
  const current=(await pool.query('SELECT "expiresAt" FROM session WHERE "userId"=$1',[p.id])).rows[0];expect(new Date(current.expiresAt).getTime()).toBeGreaterThan(Date.now()+11*60*60*1000);
 });
 it('supports every active human role, preserves spaces, and enforces mandatory revocation when omitted',async()=>{
  // V7 F2 (D-23): the active human roles are owner, operator and viewer.
  for(const role of ['owner','operator','viewer']){const p=await person(role);const next='  '+secret()+'  ';const r=await call('/change-password',{currentPassword:p.password,newPassword:next,confirmPassword:next},p);expect(r.statusCode,r.body).toBe(200);expect((await login(p,next)).statusCode).toBe(200);expect((await call('/get-session',undefined,p)).statusCode).toBe(401);}
 });
 it('rejects anonymous, expired, inactive, service, hostile origin, target manipulation and alternate routes',async()=>{
  const p=await person(),next=secret(),body={currentPassword:p.password,newPassword:next,confirmPassword:next};
  expect((await call('/change-password',body)).statusCode).toBe(401);
  expect((await call('/change-password',body,p,{origin:'https://foreign.invalid'})).statusCode).toBe(403);
  expect((await call('/change-password',body,p,{authorization:'Bearer synthetic-service'})).statusCode).toBe(403);
  expect((await call('/change-password',{...body,userId:owner.id},p)).statusCode).toBe(400);
  expect((await call('/set-password',{newPassword:next},p)).statusCode).toBe(404);
  expect((await call('/update-user',{name:'Forbidden'},p)).statusCode).toBe(404);
  await pool.query('UPDATE memberships SET active=false WHERE user_id=$1',[p.id]);expect((await call('/change-password',body,p)).statusCode).toBe(403);expect((await login(p)).statusCode).toBe(401);
  await pool.query('UPDATE memberships SET active=true WHERE user_id=$1',[p.id]);await pool.query('UPDATE session SET "expiresAt"=now()-interval \'1 second\' WHERE "userId"=$1',[p.id]);expect((await call('/change-password',body,p)).statusCode).toBe(401);
 });
 it('hides existing/inactive/unknown accounts, suppresses repeated recipients and never sends to inactive members',async()=>{
  const p=await person(),inactive=await person();await pool.query('UPDATE memberships SET active=false WHERE user_id=$1',[inactive.id]);
  const outputs=[];for(const email of [p.email,inactive.email,randomUUID()+'@example.invalid']){const r=await call('/request-password-reset',{email});outputs.push([r.statusCode,r.json()]);}expect(outputs[1]).toEqual(outputs[0]);expect(outputs[2]).toEqual(outputs[0]);expect(outputs[0]).toEqual([200,{status:true,message:recoveryMessage}]);
  for(let i=0;i<5;i++)expect((await call('/request-password-reset',{email:p.email.toUpperCase()})).statusCode).toBe(200);
  expect((await pool.query('SELECT count(*)::int count FROM identity_mail_jobs WHERE user_id=$1',[p.id])).rows[0].count).toBe(3);
  expect((await pool.query('SELECT 1 FROM identity_mail_jobs WHERE user_id=$1',[inactive.id])).rowCount).toBe(0);expect((await login(p)).statusCode).toBe(200);
 });
 it('sends a Spanish multipart SMTP message with one stable link while dispatch is frozen',async()=>{
  // Clear unrelated pending fixtures; this does not touch any commercial table.
  await pool.query("UPDATE identity_mail_jobs SET status='CANCELLED',payload_ciphertext=NULL WHERE status='PENDING'");
  const p=await person(),{job,token}=await requestLink(p);
  const plain=(await pool.query('SELECT identifier FROM verification WHERE value=$1',[p.id])).rows;
  expect(JSON.stringify(plain)).not.toContain(token);
  expect((await pool.query('SELECT payload_ciphertext FROM identity_mail_jobs WHERE id=$1',[job.id])).rows[0].payload_ciphertext).not.toContain(token);
  await processIdentityMail();expect(received.length).toBe(1);expect(received[0]).toContain('multipart/alternative');expect(received[0]).toContain(job.id);
  const r=(await pool.query('SELECT status,payload_ciphertext FROM identity_mail_jobs WHERE id=$1',[job.id])).rows[0];expect(r).toEqual({status:'ACCEPTED',payload_ciphertext:null});
  expect((await reset(token)).statusCode).toBe(200);
 });
 it('GET does not consume, reset invalidates every session/link and requires fresh login',async()=>{
  const p=await person(),first=await requestLink(p),second=await requestLink(p),next=secret();
  const visit=await call('/reset-password/'+first.token+'?callbackURL='+encodeURIComponent(origin+'/reset-password'));expect(visit.statusCode).toBe(302);expect(visit.headers['referrer-policy']).toBe('no-referrer');
  const r=await reset(first.token,next);expect(r.statusCode,r.body).toBe(200);expect(r.headers['set-cookie']).toBeUndefined();
  expect((await call('/get-session',undefined,p)).statusCode).toBe(401);expect((await login(p)).statusCode).toBe(401);expect((await login(p,next)).statusCode).toBe(200);
  expect((await reset(first.token)).statusCode).toBe(400);expect((await reset(second.token)).statusCode).toBe(400);
 });
 it('rejects invalid, expired and deactivated links and leaves malformed submissions reusable',async()=>{
  const p=await person(),{token}=await requestLink(p);expect((await reset('invalid')).statusCode).toBe(400);
  expect((await call('/reset-password',{token,newPassword:'short',confirmPassword:'short'})).statusCode).toBe(400);
  await pool.query('UPDATE memberships SET active=false WHERE user_id=$1',[p.id]);expect((await reset(token)).statusCode).toBe(400);
  await pool.query('UPDATE memberships SET active=true WHERE user_id=$1',[p.id]);await pool.query('UPDATE verification SET "expiresAt"=now()-interval \'1 second\' WHERE value=$1',[p.id]);expect((await reset(token)).statusCode).toBe(400);expect((await login(p)).statusCode).toBe(200);
 });
 it('serializes simultaneous consumption of same and different links and authenticated double submissions',async()=>{
  for(const same of [true,false]){const p=await person(),one=await requestLink(p),two=same?one:await requestLink(p);const results=await Promise.all([reset(one.token),reset(two.token)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,400]);}
  const p=await person(),next=secret(),body={currentPassword:p.password,newPassword:next,confirmPassword:next};const results=await Promise.all([call('/change-password',body,p),call('/change-password',body,p)]);expect(results.map(r=>r.statusCode).sort()).toEqual([200,401]);
 });
 it('rolls back password, token and sessions if audit or revocation fails',async()=>{
  const p=await person(),{token}=await requestLink(p),next=secret();
  await pool.query(`CREATE FUNCTION identity_test_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic fault'; END $$`);
  try{
   for(const table of ['identity_audit','session']){
    await pool.query(`CREATE TRIGGER identity_test_fail BEFORE ${table==='session'?'DELETE':'INSERT'} ON ${table} FOR EACH ROW EXECUTE FUNCTION identity_test_fault()`);
    try{const r=await reset(token,next);expect(r.statusCode).toBe(500);}finally{await pool.query(`DROP TRIGGER identity_test_fail ON ${table}`);}
    expect((await call('/get-session',undefined,p)).statusCode).toBe(200);expect((await login(p)).statusCode).toBe(200);
   }
  }finally{await pool.query('DROP FUNCTION identity_test_fault()');}
  expect((await reset(token,next)).statusCode).toBe(200);
 });
 it('enforces persistent IP limit and trusted callbacks on native routes',async()=>{
  for(let i=0;i<11;i++){const r=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/request-password-reset',headers:{origin},payload:{email:randomUUID()+'@example.invalid'},remoteAddress:'192.0.2.10'}));expect(r.statusCode).toBe(i===10?429:200);}
  expect((await call('/request-password-reset',{email:owner.email,redirectTo:'https://evil.invalid/reset-password'})).statusCode).toBe(400);
 });
 it('keeps transactional mail platform-admin only, protected, versioned and without commercial revisions',async()=>{
  // V7 F8: one installation-wide setting, so a profile owner is not enough.
  const viewer=await person('viewer');const read=async(p:Person)=>app.inject({method:'GET',url:'/v2/platform/mail',headers:{cookie:p.cookie,origin}});
  expect((await read(viewer)).statusCode).toBe(403);expect((await read(owner)).statusCode).toBe(403);
  expect((await app.inject(explicitFixtureEnvironment({method:'GET',url:'/v1/identity/mail',headers:{cookie:owner.cookie,origin}}))).statusCode).toBe(404);
  await pool.query("INSERT INTO platform_admins(user_id,source) VALUES($1,'INSTALLER') ON CONFLICT DO NOTHING",[owner.id]);
  try{
   const metadata=(await read(owner)).json().data;expect(metadata.credentials_configured).toBe(false);
   const bad=await app.inject({method:'PUT',url:'/v2/platform/mail',headers:{cookie:owner.cookie,origin},payload:{expected_version:metadata.version,enabled:true,config:{...metadata.config,host:'169.254.169.254'}}});expect(bad.statusCode).toBe(400);
   expect((await app.inject({method:'PUT',url:'/v2/platform/mail',headers:{cookie:owner.cookie,origin:'https://foreign.invalid'},payload:{}})).statusCode).toBe(403);
  }finally{await pool.query('DELETE FROM platform_admins WHERE user_id=$1',[owner.id]);}
 });
 it('reports unavailable uniformly and persists SMTP retry/abandoned-claim outcomes without secret audit',async()=>{
  await pool.query('UPDATE identity_mail_settings SET enabled=false');const a=await call('/request-password-reset',{email:owner.email}),b=await call('/request-password-reset',{email:'missing@example.invalid'});expect(a.statusCode).toBe(503);expect(a.body).toBe(b.body);await pool.query('UPDATE identity_mail_settings SET enabled=true');
  const p=await person(),{job,token}=await requestLink(p);
  await withTransaction(c=>enqueueResetMail(c,{id:p.id,email:p.email},token));expect((await pool.query('SELECT count(*)::int count FROM identity_mail_jobs WHERE link_digest=$1',[job.link_digest])).rows[0].count).toBe(1);
  await pool.query("UPDATE identity_mail_jobs SET status='SENDING',claimed_at=now()-interval '2 minutes' WHERE id=$1",[job.id]);await processIdentityMail();
  expect((await pool.query('SELECT status,payload_ciphertext FROM identity_mail_jobs WHERE id=$1',[job.id])).rows[0]).toEqual({status:'UNCERTAIN',payload_ciphertext:null});
  const audit=JSON.stringify((await pool.query('SELECT * FROM identity_audit')).rows);for(const forbidden of [p.email,p.password,token,'reset-password#',owner.cookie])expect(audit).not.toContain(forbidden);
 });
 it('retries known temporary SMTP rejection, stops on rejection, expires queues and never replays DATA timeout',async()=>{
  await pool.query("UPDATE identity_mail_jobs SET status='CANCELLED',payload_ciphertext=NULL WHERE status='PENDING'");
  for(const mode of ['temporary','reject','timeout'] as const){
   smtpMode=mode;const p=await person(),{job}=await requestLink(p);await processIdentityMail();
   const result=(await pool.query('SELECT * FROM identity_mail_jobs WHERE id=$1',[job.id])).rows[0];
   expect(result.status).toBe(mode==='temporary'?'PENDING':mode==='reject'?'FAILED':'UNCERTAIN');
   if(mode==='temporary'){
    const previous=(await pool.query('SELECT config FROM identity_mail_settings')).rows[0].config;
    await pool.query('UPDATE identity_mail_settings SET config=$1',[{...previous,from:'security@changed.example.invalid'}]);
    smtpMode='accept';await pool.query("UPDATE identity_mail_jobs SET available_at=now() WHERE id=$1",[job.id]);await processIdentityMail();
    const after=(await pool.query('SELECT status,attempts,payload_ciphertext FROM identity_mail_jobs WHERE id=$1',[job.id])).rows[0];expect(after).toEqual({status:'ACCEPTED',attempts:2,payload_ciphertext:null});
    const messages=received.filter(r=>r.includes(job.id));expect(messages.length).toBe(2);expect(messages[0]?.match(/Message-ID: ([^\r]+)/)?.[1]).toBe(messages[1]?.match(/Message-ID: ([^\r]+)/)?.[1]);
    await pool.query('UPDATE identity_mail_settings SET config=$1',[previous]);
   }else expect(result.payload_ciphertext).toBeNull();
  }
  smtpMode='accept';const p=await person(),{job}=await requestLink(p);await pool.query("UPDATE identity_mail_jobs SET expires_at=now()-interval '1 second' WHERE id=$1",[job.id]);const before=received.length;await processIdentityMail();expect(received.length).toBe(before);expect((await pool.query('SELECT status,payload_ciphertext FROM identity_mail_jobs WHERE id=$1',[job.id])).rows[0]).toEqual({status:'EXPIRED',payload_ciphertext:null});
 });
 it('serializes password reset with simultaneous login and persists a changed credential across bootstrap',async()=>{
  const p=await person(),{token}=await requestLink(p),next=secret();
  const [changed,signedIn]=await Promise.all([reset(token,next),login(p)]);expect(changed.statusCode).toBe(200);
  if(signedIn.statusCode===200)expect((await call('/get-session',undefined,{...p,cookie:cookie(signedIn)})).statusCode).toBe(401);
  else expect(signedIn.statusCode).toBe(401);
  expect((await login(p,next)).statusCode).toBe(200);
  const {spawn}=await import('node:child_process');
  const code=await new Promise<number|null>(resolve=>{const child=spawn(process.execPath,['--import','tsx','scripts/bootstrap.ts'],{env:{...process.env,BOOTSTRAP_EMAIL:p.email,BOOTSTRAP_PASSWORD:p.password,WORKSPACE_ID:workspace},stdio:'ignore'});child.on('exit',resolve);});expect(code).toBe(0);expect((await login(p)).statusCode).toBe(401);expect((await login(p,next)).statusCode).toBe(200);
 });
 it('expires queue payloads without inverting reset verifier and job lock order',async()=>{
  await pool.query("UPDATE identity_mail_jobs SET status='CANCELLED',payload_ciphertext=NULL WHERE status='PENDING'");
  const p=await person(),{job}=await requestLink(p);
  await pool.query("UPDATE identity_mail_jobs SET expires_at=now()-interval '1 second' WHERE id=$1",[job.id]);
  await pool.query("UPDATE identity_reset_links SET expires_at=now()-interval '1 second' WHERE digest=$1",[job.link_digest]);
  const c=await pool.connect();let worker:Promise<unknown>|undefined;
  try{
   await c.query('BEGIN');await c.query('SELECT identifier FROM verification WHERE identifier=$1 FOR UPDATE',[job.link_digest]);
   worker=processIdentityMail();
   let waiting=false;
   for(let i=0;i<100&&!waiting;i++){
    waiting=Boolean((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'DELETE FROM verification WHERE identifier IN (%'")).rowCount);
    if(!waiting)await new Promise(resolve=>setTimeout(resolve,10));
   }
   expect(waiting).toBe(true);
   const {invalidateResetLinks}=await import('../../packages/db/src/identity.js');await invalidateResetLinks(c,p.id);await c.query('COMMIT');await worker;
   expect((await pool.query('SELECT payload_ciphertext FROM identity_mail_jobs WHERE id=$1',[job.id])).rows[0].payload_ciphertext).toBeNull();
  }finally{await c.query('ROLLBACK');c.release();await worker;}
 });

 it('encrypts SMTP credentials, rejects stale revisions and insecure remote modes, and validates TLS certificates',async()=>{
  const previous=(await pool.query('SELECT * FROM identity_mail_settings')).rows[0];const oldTargets=process.env.SMTP_ALLOWED_TARGETS;
  const smtpPassword=secret(),smtpUsername='synthetic@example.invalid';
  process.env.SMTP_ALLOWED_TARGETS=JSON.stringify([...JSON.parse(oldTargets!),{host:'smtp.example.invalid',port:587,mode:'remote',addresses:['127.0.0.1']}]);
  const input={expected_version:previous.version,enabled:true,config:{mode:'remote' as const,host:'smtp.example.invalid',port:587,tls:'starttls' as const,from:'security@example.invalid',name:'Commerce OS'},username:smtpUsername,password:smtpPassword};
  try{
   const saved=await withTransaction(c=>saveMailSetting(c,input,owner.id,randomUUID()));expect(saved.credentials_configured).toBe(true);expect(JSON.stringify(saved)).not.toContain(smtpPassword);expect(JSON.stringify(saved)).not.toContain(smtpUsername);
   const encrypted=(await pool.query('SELECT secret_ciphertext FROM identity_mail_settings')).rows[0].secret_ciphertext;expect(encrypted).not.toContain(smtpPassword);expect(JSON.parse(decrypt(encrypted)).password).toBe(smtpPassword);
   await expect(withTransaction(c=>saveMailSetting(c,input,owner.id,randomUUID()))).rejects.toThrow('VERSION_CONFLICT');
   await expect(withTransaction(c=>saveMailSetting(c,{...input,expected_version:saved.version,config:{...input.config,tls:'none'}},owner.id,randomUUID()))).rejects.toThrow('SMTP_TLS_REQUIRED');
   process.env.SMTP_ALLOWED_TARGETS=JSON.stringify([...JSON.parse(process.env.SMTP_ALLOWED_TARGETS!),{host:'smtp.resend.com',port:465,mode:'remote',addresses:['127.0.0.1']}]);
   const changed={expected_version:saved.version,enabled:false,config:{...input.config,host:'smtp.resend.com',port:465,tls:'implicit' as const},username:'resend'};
   await expect(withTransaction(c=>saveMailSetting(c,changed,owner.id,randomUUID()))).rejects.toThrow('SMTP_CREDENTIAL_REPLACEMENT_REQUIRED');
   await pool.query("INSERT INTO platform_admins(user_id,source) VALUES($1,'INSTALLER') ON CONFLICT DO NOTHING",[owner.id]);
   try{const denied=await app.inject({method:'PUT',url:'/v2/platform/mail',headers:{origin,cookie:owner.cookie},payload:changed});expect(denied.statusCode).toBe(400);expect(denied.json().error.code).toBe('SMTP_CREDENTIAL_REPLACEMENT_REQUIRED');}
   finally{await pool.query('DELETE FROM platform_admins WHERE user_id=$1',[owner.id]);}
   const updated=await withTransaction(c=>saveMailSetting(c,{...changed,password:secret()},owner.id,randomUUID()));expect(updated.credentials_configured).toBe(true);expect(updated.enabled).toBe(false);

  }finally{process.env.SMTP_ALLOWED_TARGETS=oldTargets;await pool.query('UPDATE identity_mail_settings SET version=$1,enabled=$2,config=$3,secret_ciphertext=$4',[previous.version,previous.enabled,previous.config,previous.secret_ciphertext]);}
  const tlsServer=new SMTPServer({authOptional:true,logger:false});tlsServer.on('error',()=>{});
  await new Promise<void>(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));const port=(tlsServer as any).server.address().port;
  try{
   process.env.SMTP_ALLOWED_TARGETS=JSON.stringify([{host:'localhost',port,mode:'local',addresses:['127.0.0.1']}]);
   await pool.query('UPDATE identity_mail_settings SET config=$1',[{...previous.config,port,tls:'starttls'}]);
   const {diagnoseMail}=await import('../../apps/api/src/identity-mail.js');const result=await diagnoseMail();expect(result.code).not.toBe('SMTP_CONNECTION_OK');
  }finally{await new Promise<void>(resolve=>tlsServer.close(()=>resolve()));process.env.SMTP_ALLOWED_TARGETS=oldTargets;await pool.query('UPDATE identity_mail_settings SET config=$1',[previous.config]);}
 });

 it('operates with the production API database profile and isolates identity from commercial workers',async()=>{
  const p=await person();
  await withTransaction(async c=>{
   await c.query('SET LOCAL ROLE commerce_api');
   const scoped=createAuth(c);
   const result=await scoped.api.requestPasswordReset({body:{email:p.email}});expect(result.status).toBe(true);
   const {identityAudit}=await import('../../packages/db/src/identity.js');await identityAudit(c,'test.profile','SUCCEEDED',randomUUID(),p.id);
   await c.query("UPDATE identity_mail_jobs SET diagnostic_code='PROFILE_VERIFIED' WHERE user_id=$1",[p.id]);
  });
  for(const role of ['commerce_ingress','commerce_automation','commerce_channel'])for(const table of ['identity_mail_jobs','identity_mail_settings','identity_audit']){
   await expect(withTransaction(async c=>{await c.query('SET LOCAL ROLE '+role);await c.query('SELECT * FROM '+table+' LIMIT 1');})).rejects.toMatchObject({code:'42501'});
  }
 });
 it('handles more simultaneous changes than pool connections without nested-connection starvation',async()=>{
  const people=[];for(let i=0;i<7;i++)people.push(await person());
  const results=await Promise.all(people.map(p=>{const next=secret();return call('/change-password',{currentPassword:p.password,newPassword:next,confirmPassword:next},p);}));
  expect(results.map(r=>r.statusCode)).toEqual(Array(7).fill(200));
 });

});
