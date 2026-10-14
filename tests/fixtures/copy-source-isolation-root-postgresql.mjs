// All evidence/data below is synthetic; no production Root CLI or Cloud call.
import fs from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
const wt=process.env.COMMERCE_SOURCE_WT??fileURLToPath(new URL('../../',import.meta.url));
const req=createRequire(wt+'/package.json'),pg=req('pg'),execute=promisify(execFile);
const bridge=fileURLToPath(new URL('./copy-source-isolation-root-sql.py',import.meta.url));
const original=process.env.DATABASE_URL;if(!original)throw new Error('SYNTHETIC_DATABASE_URL_REQUIRED');
const controlPool=new pg.Pool({connectionString:original}),database='isolation_issuer_'+randomUUID().replaceAll('-','');
const migrationUrl=new URL(original);migrationUrl.pathname='/'+database;
const ownerUrl=new URL(migrationUrl);ownerUrl.searchParams.set('options','-c role=commerce_owner');
const apiUrl=new URL(migrationUrl);apiUrl.searchParams.set('options','-c role=commerce_api');
const hash=raw=>createHash('sha256').update(raw).digest('hex');
const raw=value=>Buffer.from(JSON.stringify(value));
const ref=(path,bytes)=>({path,bytes:bytes.length,sha256:hash(bytes)});
const iso=milliseconds=>new Date(milliseconds).toISOString();
const results=[];let admin,data,app,pool,putRecord,insertPersonalToken,newPersonalToken,ensureProfile,created=false,createdOwnerRole=false;
const billing=raw({schema_version:1,recorded_at_utc:iso(Date.now()-60000),status:'ACTUAL_READONLY_SOURCE_BILLING_OBSERVED',source_project:'vibe-conversa-prod',credential_account:'synthetic-billing@example.invalid',native_method:'gcloud billing projects describe vibe-conversa-prod --format=json(projectId,billingEnabled)',native_response:{projectId:'vibe-conversa-prod',billingEnabled:false},identity_verified_by:'gcloud auth list ACTIVE actual output in the same Cloud Shell terminal',cloud_mutations:0,primary_devices_revoked:false,primary_revocation_evidence:'PENDING_HUMAN_USER_DEFERRED',live_compute_state_observed:false,docker_container_stop_attested:false,screenshot:'synthetic.jpg',authorizes_session_or_sending:false});
async function guardsBypassed(sql,values){const c=await data.connect();try{await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");await c.query(sql,values);await c.query('COMMIT');}catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}}
// V7: every workspace is an adopted profile and an installation admits three.
// Each case starts from one fresh profile in this throwaway database.
async function freshProfile(workspace){
 const c=await data.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  const tables=(await c.query("SELECT DISTINCT c.relname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attname='workspace_id' AND NOT a.attisdropped ORDER BY 1")).rows;
  for(const {id} of (await c.query('SELECT id FROM profiles')).rows){for(const {relname} of tables)await c.query(`DELETE FROM public."${relname}" WHERE workspace_id::text=$1`,[id]);await c.query('DELETE FROM profiles WHERE id=$1',[id]);}
  await c.query("SET LOCAL session_replication_role='origin'");await ensureProfile(c,workspace);await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
}
async function fixture(ttl=3600){
 const workspace='synthetic-issuer-'+randomUUID(),user=randomUUID();
 await freshProfile(workspace);
 await data.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[user,'Synthetic issuer owner',user+'@example.invalid']);
 await data.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[user,workspace]);
 // V7: a profile always keeps a Dueño; a synthetic co-owner lets a case deactivate the responsible one.
 const coOwner=randomUUID();await data.query('INSERT INTO "user"(id,name,email) VALUES($1,$2,$3)',[coOwner,'Synthetic co-owner',coOwner+'@example.invalid']);await data.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[coOwner,workspace]);
 await data.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'workspace',$1,true,'Synthetic frozen copy',$2)",[workspace,user]);
 await data.query("INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by) VALUES($1,'REAL',1,$2,$3)",[workspace,{dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false,allow_channel_onboarding:false,contact_messages_per_minute:1,channel_account_concurrency:1},user]);
 const a=await putRecord(data,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic Root issuer line',provider:'waha',gateway_ref:'synthetic-'+randomUUID(),sending_enabled:false}});
 const s=(await data.query("UPDATE channel_sessions SET primary_device_id='synthetic-primary',responsible_user_id=$2 WHERE account_id=$1 RETURNING *",[a.id,user])).rows[0];
 await data.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'synthetic-old-owner',3,true,clock_timestamp()-interval '1 hour')",[a.id,workspace]);
 const token=newPersonalToken(),credential=randomUUID();await insertPersonalToken(data,{workspace_id:workspace,user_id:user,name:'Synthetic Root issuer report',allowed_environments:['REAL','SIMULATION'],expires_at:iso(Date.now()+3600000)},token,credential);
 const adoption=Buffer.from('synthetic-adoption-only'),c={schema_version:1,action:'prepare',candidate_sha:'a'.repeat(40),migration67_sha256:hash(fs.readFileSync(wt+'/packages/db/migrations/0067_copy_source_isolation.sql')),adoption_ref:ref('/opt/commerce-os/private/api-web-adoption.json',adoption),billing_ref:ref('/opt/commerce-os/private/source-isolation/evidence/synthetic-billing.json',billing),challenge_id:randomUUID(),ttl_seconds:ttl,binding:{account_id:a.id,workspace_id:workspace,account_version:a.version,session_id:s.id,session_revision:s.revision,previous_owner_id:'synthetic-old-owner',generation:3,credential_generation:s.credential_generation,primary_device_id:s.primary_device_id,responsible_user_id:user,gateway_id:s.gateway_id,remote_session_name:s.remote_session_name,expected_identity_fingerprint:s.expected_identity_fingerprint}};
 return{a,s,workspace,user,token,credential,c};
}
// execFile has no input option. Use the existing closed child-process protocol.
async function generated(f,c=f.c,human,message,billingBytes=billing){
 const input=raw({control:c,billing_hex:billingBytes.toString('hex'),...(human?{human_hex:human.toString('hex'),message_hex:message.toString('hex')}: {})});
 const {spawn}=await import('node:child_process');
 return await new Promise((resolve,reject)=>{
  const p=spawn('python3',[bridge],{stdio:['pipe','pipe','pipe']});let out='',err='';
  const timeout=setTimeout(()=>{p.kill('SIGKILL');reject(new Error('SYNTHETIC_SQL_GENERATOR_TIMEOUT'));},10000);
  p.stdout.on('data',v=>{out+=v;if(out.length>256*1024){p.kill('SIGKILL');reject(new Error('SYNTHETIC_SQL_GENERATOR_BOUND'));}});
  p.stderr.on('data',v=>{err+=v;});p.once('error',reject);
  p.once('close',code=>{clearTimeout(timeout);if(code===0)resolve(out);else reject(new Error('SYNTHETIC_CORE_REJECTED:'+err.match(/ISOLATION_[A-Z_]+/g)?.at(-1)));});
  p.stdin.end(input);
 });
}
async function run(sql){const c=await admin.connect();try{const list=await c.query(sql);return JSON.parse(list.find(v=>v.rows?.length)?.rows[0].current_setting);}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
const prepare=async f=>run(await generated(f));
async function confirmation(f){
 await data.query('SELECT pg_sleep(0.003)');const performed=iso(Date.now());await data.query('SELECT pg_sleep(0.003)');const key=randomUUID();
 const payload={challenge_id:f.c.challenge_id,expected_account_version:f.a.version,expected_session_version:f.s.revision,previous_commerce_devices_revoked:true,confirmation:'REVOKED_PREVIOUS_COMMERCE_DEVICES_AFTER_CHALLENGE',reason:'Synthetic explicit primary-device confirmation'};
 const response=await app.inject({method:'POST',url:'/v1/channel-accounts/'+f.a.id+'/source-isolation/confirm?environment=REAL',payload,headers:{authorization:'Bearer '+f.token,'idempotency-key':key}});
 assert.equal(response.statusCode,200,response.body);await data.query('SELECT pg_sleep(0.003)');
 const e=(await data.query("SELECT * FROM domain_events WHERE aggregate_id=$1 AND event_type='channel.source_isolation.primary_reported' ORDER BY recorded_at DESC LIMIT 1",[f.a.id])).rows[0];
 const source={schema_version:1,kind:'DIRECT_HUMAN_PRIMARY_DEVICE_CONFIRMATION',challenge_id:f.c.challenge_id,account_id:f.a.id,workspace_id:f.workspace,actor_user_id:f.user,responsible_user_id:f.user,primary_device_id:f.s.primary_device_id,performed_at:performed,received_at:iso(Date.now()),confirmation:'REVOKED_PREVIOUS_COMMERCE_DEVICES_AFTER_CHALLENGE',source_message_id:'synthetic-human-message-'+randomUUID(),statement:'Synthetic human fixture explicitly reports primary-device revocation after this challenge; this is not a real message.'};
 const message=raw(source),doc={schema_version:1,status:'HUMAN_PRIMARY_DEVICE_REVOCATION_ATTESTED',challenge_id:f.c.challenge_id,account_id:f.a.id,workspace_id:f.workspace,actor_user_id:f.user,responsible_user_id:f.user,primary_device_id:f.s.primary_device_id,performed_at:performed,recorded_at:iso(Date.now()),confirmation:'REVOKED_PREVIOUS_COMMERCE_DEVICES_AFTER_CHALLENGE',canonical_event_id:e.id,idempotency_key:key,authentication_method:'personal_access_token',credential_id:f.credential,source_message_ref:ref('/opt/commerce-os/private/source-isolation/evidence/synthetic-human-message.json',message)};
 const human=raw(doc),c={...f.c,action:'finalize',human_ref:ref('/opt/commerce-os/private/source-isolation/evidence/synthetic-human-attestation.json',human)};
 return{c,human,message,doc,source};
}
const finalize=async(f,h)=>run(await generated(f,h.c,h.human,h.message));
async function snapshot(f){
 const value=(await data.query(`SELECT json_build_object('record',(SELECT to_jsonb(r) FROM records r WHERE id=$1),'session',(SELECT to_jsonb(s) FROM channel_sessions s WHERE account_id=$1),'ownership',(SELECT to_jsonb(o) FROM session_ownership o WHERE account_id=$1::text),'policy',(SELECT to_jsonb(p) FROM operational_settings p WHERE workspace_id=$2 AND environment='REAL'),'control',(SELECT to_jsonb(m) FROM manual_controls m WHERE workspace_id=$2 AND scope_type='workspace'),'commands',(SELECT coalesce(jsonb_agg(c ORDER BY id),'[]') FROM commands c WHERE resource_id=$1::text),'outbox',(SELECT coalesce(jsonb_agg(x ORDER BY id),'[]') FROM outbox x WHERE account_id=$1::text),'events',(SELECT coalesce(jsonb_agg(e ORDER BY id),'[]') FROM domain_events e WHERE aggregate_id=$1::text),'idempotency',(SELECT coalesce(jsonb_agg(i ORDER BY key),'[]') FROM idempotency i WHERE workspace_id=$2),'attempts',(SELECT coalesce(jsonb_agg(t ORDER BY t.id),'[]') FROM effect_attempts t JOIN outbox x ON x.id=t.effect_id WHERE x.account_id=$1::text)) v`,[f.a.id,f.workspace])).rows[0].v;
 return JSON.stringify(value);
}
async function counts(f){return(await data.query('SELECT (SELECT count(*)::int FROM copy_source_isolation_challenges WHERE account_id=$1) challenges,(SELECT count(*)::int FROM ownership_isolation_receipts WHERE account_id=$1) receipts',[f.a.id])).rows[0];}
async function check(name,fn){const start=performance.now();await fn();results.push({name,status:'PASS',milliseconds:Math.round(performance.now()-start)});}
try{
 // CI local setup logs in as commerce, while the closed issuer requires commerce_owner.
 // Create only a missing NOLOGIN role; preserve every pre-existing role unchanged.
 if(!(await controlPool.query("SELECT 1 FROM pg_roles WHERE rolname='commerce_owner'")).rowCount){
  await controlPool.query('CREATE ROLE commerce_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');createdOwnerRole=true;
 }
 await controlPool.query(`CREATE DATABASE "${database}" OWNER commerce_owner TEMPLATE template0`);created=true;
 await execute(process.execPath,['--import',req.resolve('tsx'),'packages/db/src/migrate.ts'],{cwd:wt,env:{...process.env,DATABASE_URL:migrationUrl.toString()},timeout:30000});
 const setup=new pg.Pool({connectionString:migrationUrl.toString()});
 try{
  // All grants are restricted to this freshly created synthetic database.
  await setup.query('GRANT USAGE ON SCHEMA public TO commerce_owner; GRANT ALL ON ALL TABLES IN SCHEMA public TO commerce_owner; GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO commerce_owner; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO commerce_owner');
  // V7: production's commerce_owner is the image bootstrap superuser and so is
  // not subject to RLS. This synthetic NOLOGIN stand-in gets the equivalent
  // owner visibility only inside this throwaway database.
  await setup.query(`DO $$DECLARE t record; BEGIN FOR t IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity LOOP EXECUTE format('CREATE POLICY issuer_fixture_owner ON public.%I TO commerce_owner USING(true) WITH CHECK(true)',t.relname); END LOOP; END$$`);
 }finally{await setup.end();}
 admin=new pg.Pool({connectionString:ownerUrl.toString()});
 // V7: synthetic setup/readback run as the cluster superuser (as production's
 // bootstrap owner does); the closed issuer below still runs as commerce_owner.
 data=new pg.Pool({connectionString:migrationUrl.toString()});
 const identity=(await admin.query("SELECT current_user role,pg_get_userbyid(datdba) database_owner FROM pg_database WHERE datname=current_database()")).rows[0];
 assert.equal(identity.role,'commerce_owner');assert.equal(identity.database_owner,'commerce_owner');process.env.DATABASE_URL=apiUrl.toString();process.env.BETTER_AUTH_SECRET='synthetic-issuer-auth-secret-000000000000';process.env.PRIVATE_DATA_KEY='ab'.repeat(32);
 ({pool,putRecord}=await import(pathToFileURL(wt+'/packages/db/src/index.ts')));
 ({insertPersonalToken,newPersonalToken}=await import(pathToFileURL(wt+'/packages/db/src/personal-access-tokens.ts')));
 ({ensureProfile}=await import(pathToFileURL(wt+'/packages/db/src/profile-provisioning.ts')));
 app=await(await import(pathToFileURL(wt+'/apps/api/src/app.ts'))).createApp();
 assert.equal((await pool.query('SELECT current_user role')).rows[0].role,'commerce_api');
 await check('prepare exact replay changes only one challenge and no business table',async()=>{const f=await fixture(),before=await snapshot(f);const one=await prepare(f),two=await prepare(f);assert.deepEqual(two,one);assert.equal(one.root_receipt_issued,false);assert.equal(await snapshot(f),before);assert.deepEqual(await counts(f),{challenges:1,receipts:0});});
 await check('canonical PAT report alone never supplies Root human proof',async()=>{const f=await fixture();await prepare(f);const h=await confirmation(f),before=await snapshot(f);await assert.rejects(generated(f,h.c),/ISOLATION/);assert.equal(await snapshot(f),before);assert.deepEqual(await counts(f),{challenges:1,receipts:0});});
 await check('separate bound human fixture plus canonical API report finalizes once without business effects',async()=>{const f=await fixture();await prepare(f);const h=await confirmation(f),before=await snapshot(f);const a=await finalize(f,h),b=await finalize(f,h);assert.deepEqual(a,b);assert.equal(a.root_receipt_issued,true);assert.equal(a.authorizes_operations,false);assert.equal(await snapshot(f),before);assert.deepEqual(await counts(f),{challenges:1,receipts:1});const completed=(await data.query('SELECT completed_receipt_id FROM copy_source_isolation_challenges WHERE id=$1',[f.c.challenge_id])).rows[0];assert.equal(completed.completed_receipt_id,a.receipt_id);});
 await check('replay rejects a changed technical payload',async()=>{const f=await fixture();await prepare(f);const modified=Buffer.from(billing.toString().replace('synthetic.jpg','synthetic-new.jpg')),c={...f.c,billing_ref:ref(f.c.billing_ref.path,modified)};await assert.rejects(run(await generated(f,c,undefined,undefined,modified)),/ISOLATION_CHALLENGE_TUPLE_CHANGED/);assert.deepEqual(await counts(f),{challenges:1,receipts:0});});
 await check('completed exact UUID rejects a changed human source and evidence digest',async()=>{const f=await fixture();await prepare(f);const h=await confirmation(f);await finalize(f,h);const message=raw({...h.source,source_message_id:'synthetic-changed-source'}),human=raw({...h.doc,source_message_ref:ref(h.doc.source_message_ref.path,message)}),c={...h.c,human_ref:ref(h.c.human_ref.path,human)};await assert.rejects(finalize(f,{c,human,message}),/ISOLATION_COMPLETED_RECEIPT_CHANGED/);assert.deepEqual(await counts(f),{challenges:1,receipts:1});});
 await check('identity/credential/session/version/owner drift fail closed with no receipt',async()=>{for(const update of["UPDATE channel_sessions SET credential_generation=2 WHERE account_id=$1","UPDATE channel_sessions SET primary_device_id='synthetic-changed' WHERE account_id=$1","UPDATE channel_sessions SET revision=2 WHERE account_id=$1","UPDATE session_ownership SET generation=4 WHERE account_id=$1","UPDATE channel_sessions SET gateway_id='synthetic-other' WHERE account_id=$1"]){const f=await fixture();await prepare(f);const h=await confirmation(f);await data.query(update,[f.a.id]);const before=await snapshot(f);await assert.rejects(finalize(f,h),/ISOLATION_(SESSION|OWNERSHIP)_CHANGED/);assert.equal(await snapshot(f),before);assert.deepEqual(await counts(f),{challenges:1,receipts:0});}});
 await check('inactive responsible membership and changed installed migration rejected',async()=>{const f=await fixture();await data.query('UPDATE memberships SET active=false WHERE user_id=$1',[f.user]);await assert.rejects(prepare(f),/ISOLATION_RESPONSIBLE_INACTIVE/);await data.query('UPDATE memberships SET active=true WHERE user_id=$1',[f.user]);await assert.rejects(run(await generated(f,{...f.c,migration67_sha256:'c'.repeat(64)})),/ISOLATION_INSTALLED_MIGRATION_CHANGED/);assert.deepEqual(await counts(f),{challenges:0,receipts:0});});
 await check('pending/uncertain commands and queued effects block prepare without cancelling them',async()=>{for(const status of ['PENDING','FAILED']){const f=await fixture();await data.query('INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,idempotency_key) VALUES($1,\'REAL\',\'channel_command\',$2,$3,\'{"type":"logout"}\',$4,$5)',[f.workspace,f.a.id,f.user,status,randomUUID()]);const before=await snapshot(f);await assert.rejects(prepare(f),/ISOLATION_RECONCILIATION_REQUIRED/);assert.equal(await snapshot(f),before);assert.deepEqual(await counts(f),{challenges:0,receipts:0});}const f=await fixture();await data.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,config_hash) VALUES($1,'REAL',$2,'synthetic-conversation','synthetic-contact',$3,'{}','synthetic-hash')",[f.workspace,f.a.id,randomUUID()]);const before=await snapshot(f);await assert.rejects(prepare(f),/ISOLATION_RECONCILIATION_REQUIRED/);assert.equal(await snapshot(f),before);});
 await check('live old lease is rejected and never interpreted as isolation',async()=>{const f=await fixture();await data.query("UPDATE session_ownership SET lease_expires_at=clock_timestamp()+interval '1 hour' WHERE account_id=$1",[f.a.id]);const before=await snapshot(f);await assert.rejects(prepare(f),/ISOLATION_OWNERSHIP_CHANGED/);assert.equal(await snapshot(f),before);});
 await check('prepare is bounded to 12h and to technical 24h freshness',async()=>{const f=await fixture(43200);const result=await prepare(f);const c=(await data.query('SELECT expires_at-issued_at ttl,expires_at<=technical_observed_at+interval \'24 hours\' within_technical FROM copy_source_isolation_challenges WHERE id=$1',[f.c.challenge_id])).rows[0];assert.equal(c.within_technical,true);assert.equal(c.ttl.hours,12);assert.equal(result.status,'CHALLENGE_PREPARED');});
 await check('actual challenge row-lock wait crosses expiry and rolls back finalize',async()=>{/* V7: profile setup and Root bridges take seconds on a 2-vCPU runner under load; 20s keeps the challenge alive until the lock wait, which then crosses it */const f=await fixture(20);await prepare(f);const h=await confirmation(f),sql=await generated(f,h.c,h.human,h.message),locker=await admin.connect(),issuer=await admin.connect();let pending;try{await locker.query('BEGIN');await locker.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment','REAL',true)",[f.workspace]);await locker.query('SELECT id FROM copy_source_isolation_challenges WHERE id=$1 FOR UPDATE',[f.c.challenge_id]);const lockPid=(await locker.query('SELECT pg_backend_pid() pid')).rows[0].pid,issuerPid=(await issuer.query('SELECT pg_backend_pid() pid')).rows[0].pid;pending=issuer.query(sql);const observed=performance.now()+5000;let blocked=false;while(performance.now()<observed){if((await data.query('SELECT pg_blocking_pids($1) ids',[issuerPid])).rows[0].ids.includes(lockPid)){blocked=true;break;}await data.query('SELECT pg_sleep(0.01)');}assert.equal(blocked,true);await data.query('SELECT pg_sleep(20.1)');await locker.query('COMMIT');await assert.rejects(pending,/ISOLATION_CHALLENGE_EXPIRED/);pending=undefined;await issuer.query('ROLLBACK');assert.deepEqual(await counts(f),{challenges:1,receipts:0});}finally{await locker.query('ROLLBACK').catch(()=>{});await pending?.catch(()=>{});await issuer.query('ROLLBACK').catch(()=>{});locker.release();issuer.release();}});
 await check('two finalizers wait on the canonical channel advisory lock then reuse one exact receipt',async()=>{
  const f=await fixture();await prepare(f);const h=await confirmation(f),sql=await generated(f,h.c,h.human,h.message),before=await snapshot(f);
  const holder=await admin.connect(),one=await admin.connect(),two=await admin.connect();let pending=[];
  try{await holder.query('BEGIN');await holder.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment','REAL',true)",[f.workspace]);await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+f.a.id]);
   const pids=[(await one.query('SELECT pg_backend_pid() pid')).rows[0].pid,(await two.query('SELECT pg_backend_pid() pid')).rows[0].pid];
   pending=[one.query(sql),two.query(sql)];const deadline=performance.now()+5000;let observed=false;
   while(performance.now()<deadline){const rows=(await data.query("SELECT count(*)::int n FROM pg_locks WHERE pid=ANY($1::int[]) AND locktype='advisory' AND NOT granted",[pids])).rows;if(rows[0].n===2){observed=true;break;}await data.query('SELECT pg_sleep(0.01)');}
   assert.equal(observed,true);await holder.query('COMMIT');const values=await Promise.all(pending);pending=[];
   const receipts=values.map(list=>JSON.parse(list.find(v=>v.rows?.length)?.rows[0].current_setting));assert.deepEqual(receipts[0],receipts[1]);
   assert.deepEqual(await counts(f),{challenges:1,receipts:1});assert.equal(await snapshot(f),before);
  }finally{await holder.query('ROLLBACK').catch(()=>{});await Promise.allSettled(pending);await one.query('ROLLBACK').catch(()=>{});await two.query('ROLLBACK').catch(()=>{});holder.release();one.release();two.release();}
 });
 await check('forged event reference and revoked declaring credential cannot finalize',async()=>{
  for(const mode of['event','credential']){const f=await fixture();await prepare(f);const h=await confirmation(f);
   if(mode==='event'){const human=raw({...h.doc,canonical_event_id:randomUUID()});h.human=human;h.c={...h.c,human_ref:ref(h.c.human_ref.path,human)};}
   else await data.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp(),version=version+1 WHERE id=$1',[f.credential]);
   const before=await snapshot(f);await assert.rejects(finalize(f,h),/ISOLATION_(CANONICAL_REPORT_REQUIRED|REPORT_CREDENTIAL_INACTIVE)/);
   assert.equal(await snapshot(f),before);assert.deepEqual(await counts(f),{challenges:1,receipts:0});
  }
 });
 await check('a consumed receipt is never revived by exact Root replay',async()=>{const f=await fixture();await prepare(f);const h=await confirmation(f),done=await finalize(f,h);await data.query('UPDATE ownership_isolation_receipts SET consumed_at=clock_timestamp() WHERE id=$1',[done.receipt_id]);await assert.rejects(finalize(f,h),/ISOLATION_COMPLETED_RECEIPT_CHANGED/);assert.deepEqual(await counts(f),{challenges:1,receipts:1});});
 await check('issuer waits for the API operations lock before taking channel and avoids the inverted-order deadlock',async()=>{
  const f=await fixture(),sql=await generated(f),before=await snapshot(f),holder=await pool.connect(),issuer=await admin.connect();let pending;
  try{await holder.query('BEGIN');await holder.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment','REAL',true)",[f.workspace]);await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['operations:'+f.workspace+':REAL']);
   await holder.query("SELECT 1 FROM operational_settings WHERE workspace_id=$1 AND environment='REAL' FOR UPDATE",[f.workspace]);
   const lockPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,issuerPid=(await issuer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=issuer.query(sql);const deadline=performance.now()+5000;let observed=false;
   while(performance.now()<deadline){if((await data.query('SELECT pg_blocking_pids($1) ids',[issuerPid])).rows[0].ids.includes(lockPid)){observed=true;break;}await data.query('SELECT pg_sleep(0.01)');}
   assert.equal(observed,true);assert.equal((await data.query("SELECT count(*)::int n FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND granted",[issuerPid])).rows[0].n,0);
   assert.equal((await holder.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) ok',['channel-command:'+f.a.id])).rows[0].ok,true);
   await holder.query('COMMIT');const values=await pending;pending=undefined;assert.equal(JSON.parse(values.find(v=>v.rows?.length)?.rows[0].current_setting).status,'CHALLENGE_PREPARED');
   assert.equal(await snapshot(f),before);assert.deepEqual(await counts(f),{challenges:1,receipts:0});
  }finally{await holder.query('ROLLBACK').catch(()=>{});await pending?.catch(()=>{});await issuer.query('ROLLBACK').catch(()=>{});holder.release();issuer.release();}
 });
 await check('completed replay waits on canonical idempotency then rejects expiry without reviving a receipt',async()=>{
  /* 20s: setup, finalize and Root bridges must finish before the lock wait crosses expiry (2-vCPU runner under load) */const f=await fixture(20);await prepare(f);const h=await confirmation(f);await finalize(f,h);const sql=await generated(f,h.c,h.human,h.message);
  const holder=await admin.connect(),issuer=await admin.connect();let pending;
  try{await holder.query('BEGIN');await holder.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment','REAL',true)",[f.workspace]);await holder.query('SELECT key FROM idempotency WHERE workspace_id=$1 AND key=$2 FOR UPDATE',[f.workspace,h.doc.idempotency_key]);
   const lockPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,issuerPid=(await issuer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=issuer.query(sql);const deadline=performance.now()+5000;let observed=false;
   while(performance.now()<deadline){if((await data.query('SELECT pg_blocking_pids($1) ids',[issuerPid])).rows[0].ids.includes(lockPid)){observed=true;break;}await data.query('SELECT pg_sleep(0.01)');}
   assert.equal(observed,true);await data.query('SELECT pg_sleep(20.1)');await holder.query('COMMIT');await assert.rejects(pending,/ISOLATION_CHALLENGE_EXPIRED/);pending=undefined;
   await issuer.query('ROLLBACK');assert.deepEqual(await counts(f),{challenges:1,receipts:1});
  }finally{await holder.query('ROLLBACK').catch(()=>{});await pending?.catch(()=>{});await issuer.query('ROLLBACK').catch(()=>{});holder.release();issuer.release();}
 });
 await check('completed replay rechecks PAT expiry after its actual row-lock wait',async()=>{
  const f=await fixture();await prepare(f);/* V7: token identity (expiry) is immutable; the fixture shortens it with guards bypassed */await guardsBypassed("UPDATE personal_access_tokens SET expires_at=clock_timestamp()+interval '2 seconds',version=version+1 WHERE id=$1",[f.credential]);
  const h=await confirmation(f);await finalize(f,h);const sql=await generated(f,h.c,h.human,h.message),holder=await admin.connect(),issuer=await admin.connect();let pending;
  try{await holder.query('BEGIN');await holder.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment','REAL',true)",[f.workspace]);await holder.query('SELECT id FROM personal_access_tokens WHERE id=$1 FOR UPDATE',[f.credential]);
   const lockPid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid,issuerPid=(await issuer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
   pending=issuer.query(sql);const deadline=performance.now()+5000;let observed=false;
   while(performance.now()<deadline){if((await data.query('SELECT pg_blocking_pids($1) ids',[issuerPid])).rows[0].ids.includes(lockPid)){observed=true;break;}await data.query('SELECT pg_sleep(0.01)');}
   assert.equal(observed,true);await data.query('SELECT pg_sleep(2.1)');await holder.query('COMMIT');await assert.rejects(pending,/ISOLATION_REPORT_CREDENTIAL_INACTIVE/);pending=undefined;
   await issuer.query('ROLLBACK');assert.deepEqual(await counts(f),{challenges:1,receipts:1});
  }finally{await holder.query('ROLLBACK').catch(()=>{});await pending?.catch(()=>{});await issuer.query('ROLLBACK').catch(()=>{});holder.release();issuer.release();}
 });
 await check('runtime API role cannot invoke owner issuer or manufacture completion',async()=>{const f=await fixture();const sql=await generated(f),client=await pool.connect();try{await assert.rejects(client.query(sql),/ISOLATION_ROOT_DATABASE_OWNER_REQUIRED/);await client.query('ROLLBACK');}finally{client.release();}assert.deepEqual(await counts(f),{challenges:0,receipts:0});});
 console.log(JSON.stringify({status:'PASS',all_evidence_synthetic:true,root_cli_executed:false,node:process.version,owner_role:identity.role,database_owner:identity.database_owner,postgres:(await data.query('SHOW server_version')).rows[0].server_version,migration67_sha256:hash(fs.readFileSync(wt+'/packages/db/migrations/0067_copy_source_isolation.sql')),tests:results},null,2));
}finally{
 try{await app?.close();await pool?.end();await admin?.end();await data?.end();}finally{
  process.env.DATABASE_URL=original;
  try{if(created)await controlPool.query(`DROP DATABASE "${database}"`);if(createdOwnerRole)await controlPool.query('DROP ROLE commerce_owner');}finally{await controlPool.end();}
 }
}
