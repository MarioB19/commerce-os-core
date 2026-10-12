import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {hashPassword,verifyPassword} from 'better-auth/crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {encrypt} from '../../packages/db/src/index.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {acceptExistingProfileInvitation,readExistingProfileInvitation,registerInvitedProfileIdentity,generateInvitationLink} from '../../packages/db/src/profile-invitation-acceptance.js';
import {invitationRecipientDigest} from '../../packages/db/src/profile-invitation.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
const suffix=randomBytes(8).toString('hex'),login='f2_accept_'+suffix,workspace='accept_'+suffix,owner='owner_'+suffix;
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined;
async function invitation(role:'owner'|'operator'|'viewer'='operator',target=workspace){
 const id=randomUUID(),userId='recipient_'+randomUUID(),sessionId='session_'+randomUUID(),email=userId+'@example.invalid',link=generateInvitationLink();
 await admin!.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true)',[userId,email]);
 await admin!.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,clock_timestamp()+interval \'1 hour\')',[sessionId,userId]);
 await withProfileTransaction(admin!,target,async db=>{
  await db.query("INSERT INTO profile_invitations(id,workspace_id,operation_id,requested_by,role,recipient_digest,recipient_ciphertext,request_digest,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())",[id,target,randomUUID(),owner,role,invitationRecipientDigest(target,email),encrypt({scope:'profile.invitation.recipient.v1',workspaceId:target,invitationId:id,email}),'a'.repeat(64)]);
  // Synthetic delivery preparation by the fixture owner only. This does not
  // simulate a Mail API acceptance or claim that the dispatcher is installed.
  await db.query("UPDATE profile_invitations SET delivery='UNCERTAIN',attempt_id=$2,link_digest=$3,dispatched_at=statement_timestamp(),expires_at=statement_timestamp()+interval '24 hours' WHERE id=$1",[id,randomUUID(),link.digest]);
 });
 return{id,userId,email,token:link.token,digest:link.digest,session:{id:sessionId,userId}};
}
async function accept(row:Awaited<ReturnType<typeof invitation>>){return acceptExistingProfileInvitation(runtime!,row.session,row.token,'synthetic-correlation');}
async function membership(user:string){return(await admin!.query('SELECT role,active FROM memberships WHERE user_id=$1 AND workspace_id=$2',[user,workspace])).rows;}
describe('isolated recipient acceptance and transactional expiry',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-acceptance-'+randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:5000});if((await admin.query("SELECT to_regclass('public.profiles') AS existing")).rows[0].existing)throw Error('TRANSITION_SCHEMA_ALREADY_PRESENT');
  const setup=await admin.connect();try{await setup.query('BEGIN');for(const file of ['001_profile_identity.sql','004_profile_employees.sql','005_profile_invitations.sql','006_profile_invitation_acceptance.sql','007_profile_invitation_registration.sql'])await setup.query(await readFile(new URL('../../packages/db/profile-transition/'+file,import.meta.url),'utf8'));await setup.query('COMMIT');}catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);await admin.query(`GRANT commerce_api TO "${login}"`);
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[owner]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic','UTC',1,10,10)",[workspace]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[owner,workspace]);
  url.username=login;url.password=password;runtime=new pg.Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:5000});
 });
 afterAll(async()=>{await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('creates exactly the invited membership and non-PII audit after confirmed transaction',async()=>{
  const row=await invitation('viewer'),before=(await admin!.query("SELECT count(*)::int AS n FROM domain_events WHERE event_type='profile.invitation.accepted'")).rows[0].n;
  expect(await accept(row)).toEqual({workspaceId:workspace,invitationId:row.id,accepted:true,created:true});expect(await membership(row.userId)).toEqual([{role:'viewer',active:true}]);
  const saved=(await admin!.query('SELECT status,version,accepted_user_id FROM profile_invitations WHERE id=$1',[row.id])).rows[0];expect(saved).toEqual({status:'ACCEPTED',version:2,accepted_user_id:row.userId});
  const events=(await admin!.query("SELECT payload FROM domain_events WHERE event_type='profile.invitation.accepted'")).rows;expect(events).toHaveLength(before+1);expect(JSON.stringify(events)).not.toContain(row.email);expect(JSON.stringify(events)).not.toContain(row.token);
 });
 it('fixed locator exposes only IDs and excludes cancelled or expired links',async()=>{
  const row=await invitation(),found=(await runtime!.query('SELECT * FROM locate_profile_invitation($1)',[row.digest])).rows;expect(found).toEqual([{invitation_id:row.id,workspace_id:workspace}]);
  await withProfileTransaction(admin!,workspace,db=>db.query("UPDATE profile_invitations SET status='CANCELLED',version=version+1 WHERE id=$1",[row.id]));expect((await runtime!.query('SELECT * FROM locate_profile_invitation($1)',[row.digest])).rows).toEqual([]);await expect(accept(row)).rejects.toThrow('INVALID_OR_EXPIRED');
 });
 it('rejects mismatched or unverified native identity with no membership',async()=>{
  const row=await invitation(),other=await invitation();await expect(acceptExistingProfileInvitation(runtime!,other.session,row.token,'c')).rejects.toThrow('RECIPIENT_MISMATCH');expect(await membership(other.userId)).toEqual([]);
  await admin!.query('UPDATE "user" SET "emailVerified"=false WHERE id=$1',[row.userId]);await expect(accept(row)).rejects.toThrow('VERIFIED_IDENTITY_REQUIRED');expect(await membership(row.userId)).toEqual([]);
 });
 it('does not reactivate existing or historically revoked memberships',async()=>{
  const row=await invitation();await accept(row);await withProfileTransaction(admin!,workspace,db=>db.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[row.userId,workspace]));expect(await accept(row)).toMatchObject({created:false});expect(await membership(row.userId)).toEqual([{role:'operator',active:false}]);
  const existing=await invitation();await admin!.query("INSERT INTO memberships(user_id,workspace_id,role,active) VALUES($1,$2,'viewer',false)",[existing.userId,workspace]);await expect(accept(existing)).rejects.toThrow('MEMBERSHIP_ALREADY_EXISTS');expect(await membership(existing.userId)).toEqual([{role:'viewer',active:false}]);
 });
 it('serializes two acceptances and preserves one membership/event',async()=>{
  const row=await invitation(),out=await Promise.allSettled([accept(row),accept(row)]);expect(out.filter(r=>r.status==='fulfilled'&&r.value.created)).toHaveLength(1);expect(await membership(row.userId)).toHaveLength(1);expect(await accept(row)).toMatchObject({created:false});expect((await admin!.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='profile.invitation.accepted'",[row.id])).rows[0].n).toBe(1);
 });
 it('runtime cannot change token/role or accept without native session and link context',async()=>{
  const row=await invitation();for(const statement of ["UPDATE profile_invitations SET role='owner' WHERE id=$1",'UPDATE profile_invitations SET link_digest=repeat(\'b\',64) WHERE id=$1',"UPDATE profile_invitations SET delivery='ACCEPTED' WHERE id=$1"]){await expect(runtime!.query(statement,[row.id])).rejects.toMatchObject({code:'42501'});}
  await expect(withProfileTransaction(runtime!,workspace,db=>db.query("UPDATE profile_invitations SET status='ACCEPTED',version=version+1,accepted_user_id=$2 WHERE id=$1",[row.id,row.userId]))).rejects.toThrow('ACCEPTANCE_REQUIRED');expect(await membership(row.userId)).toEqual([]);
 });
 it('revalidates session time after waiting for issuer lock',async()=>{
  const row=await invitation(),blocker=await admin!.connect();let pending:Promise<unknown>|undefined;
  try{await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[row.session.id]);await blocker.query('BEGIN');await blocker.query('SELECT * FROM memberships WHERE user_id=$1 AND workspace_id=$2 FOR UPDATE',[owner,workspace]);pending=accept(row).then(value=>({value}),error=>({error}));
   let blocked=false;for(let i=0;i<150&&!blocked;i++){blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT role,active FROM memberships%'",[login])).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);
   await admin!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM "expiresAt"-clock_timestamp()))+0.02) FROM session WHERE id=$1',[row.session.id]);await blocker.query('COMMIT');expect(await pending).toMatchObject({error:{message:'INVITATION_SESSION_EXPIRED'}});
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}expect(await membership(row.userId)).toEqual([]);
 });
 it('auditing failure rolls back membership and acceptance together',async()=>{
  const row=await invitation();await admin!.query("CREATE FUNCTION fixture_fail_accept_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='profile.invitation.accepted' THEN RAISE EXCEPTION 'FIXTURE_AUDIT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_fail_accept_audit BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION fixture_fail_accept_audit()");
  try{await expect(accept(row)).rejects.toThrow('FIXTURE_AUDIT_FAILURE');expect(await membership(row.userId)).toEqual([]);expect((await admin!.query('SELECT status,version FROM profile_invitations WHERE id=$1',[row.id])).rows[0]).toEqual({status:'PENDING',version:1});}finally{await admin!.query('DROP TRIGGER fixture_fail_accept_audit ON domain_events; DROP FUNCTION fixture_fail_accept_audit()');}
 });
 it('status queries reconcile pending and accepted states without membership or audit writes',async()=>{
  const row=await invitation(),read=()=>readExistingProfileInvitation(runtime!,row.session,row.token),count=async()=>(await admin!.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='profile.invitation.accepted'",[row.id])).rows[0].n;
  expect(await read()).toEqual({workspaceId:workspace,invitationId:row.id,state:'PENDING'});expect(await membership(row.userId)).toEqual([]);expect(await count()).toBe(0);
  await accept(row);await withProfileTransaction(admin!,workspace,db=>db.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[row.userId,workspace]));
  expect(await read()).toEqual({workspaceId:workspace,invitationId:row.id,state:'ACCEPTED'});expect(await membership(row.userId)).toEqual([{role:'operator',active:false}]);expect(await count()).toBe(1);
 });
 async function newRecipient(target=workspace){const row=await invitation('viewer',target);await admin!.query('DELETE FROM session WHERE id=$1',[row.session.id]);await admin!.query('DELETE FROM "user" WHERE id=$1',[row.userId]);return row;}
 const rawPassword='synthetic-native-registration123';
 async function register(row:Awaited<ReturnType<typeof invitation>>,passwordHash?:string){return registerInvitedProfileIdentity(runtime!,{token:row.token,email:row.email,name:'Synthetic Recipient',passwordHash:passwordHash??await hashPassword(rawPassword)},'registration-fixture');}
 it('invitation registration uses native hash and creates all rows with no session',async()=>{
  const row=await newRecipient();expect(await register(row)).toEqual({registered:true,loginRequired:true});
  const users=(await admin!.query('SELECT id,"emailVerified" FROM "user" WHERE email=$1',[row.email])).rows;expect(users).toHaveLength(1);expect(users[0].emailVerified).toBe(true);
  const account=(await admin!.query('SELECT "accountId","providerId",issuer,password FROM account WHERE "userId"=$1',[users[0].id])).rows;expect(account).toHaveLength(1);expect(account[0]).toMatchObject({accountId:users[0].id,providerId:'credential',issuer:'local:credential'});expect(await verifyPassword({password:rawPassword,hash:account[0].password})).toBe(true);
  expect((await admin!.query('SELECT id FROM session WHERE "userId"=$1',[users[0].id])).rows).toHaveLength(0);expect(await membership(users[0].id)).toEqual([{role:'viewer',active:true}]);
 });
 it('existing identity and repeated registration never replace credentials or add sessions',async()=>{
  const existing=await invitation();await expect(register(existing)).rejects.toThrow('EXISTING_IDENTITY_LOGIN_REQUIRED');expect(await membership(existing.userId)).toEqual([]);
  const row=await newRecipient();await register(row);const before=(await admin!.query('SELECT a.password FROM account a JOIN "user" u ON u.id=a."userId" WHERE u.email=$1',[row.email])).rows;
  await expect(register(row)).rejects.toThrow('EXISTING_IDENTITY_LOGIN_REQUIRED');expect((await admin!.query('SELECT a.password FROM account a JOIN "user" u ON u.id=a."userId" WHERE u.email=$1',[row.email])).rows).toEqual(before);
 });
 it('SQL rejects forging new-user context around identity created in a prior transaction',async()=>{
  const row=await invitation(),hash=await hashPassword(rawPassword);await admin!.query(`INSERT INTO account(id,"accountId","providerId","userId",password,issuer) VALUES($1,$2,'credential',$2,$3,'local:credential')`,[randomUUID(),row.userId,hash]);
  await expect(withProfileTransaction(runtime!,workspace,async db=>{await db.query("SELECT set_config('app.invitation_new_user_id',$1,true),set_config('app.invitation_link_digest',$2,true)",[row.userId,row.digest]);await db.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'operator')",[row.userId,workspace]);await db.query("UPDATE profile_invitations SET status='ACCEPTED',version=version+1,accepted_user_id=$2 WHERE id=$1",[row.id,row.userId]);})).rejects.toThrow('NEW_IDENTITY_TRANSACTION_REQUIRED');expect(await membership(row.userId)).toEqual([]);
 });
 it('registration audit failure rolls back user, credential, membership and acceptance',async()=>{
  const row=await newRecipient();await admin!.query("CREATE FUNCTION fixture_fail_registration_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='profile.invitation.accepted' THEN RAISE EXCEPTION 'FIXTURE_REGISTRATION_AUDIT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_fail_registration_audit BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION fixture_fail_registration_audit()");
  try{await expect(register(row)).rejects.toThrow('FIXTURE_REGISTRATION_AUDIT_FAILURE');expect((await admin!.query('SELECT id FROM "user" WHERE email=$1',[row.email])).rows).toHaveLength(0);expect((await admin!.query('SELECT status FROM profile_invitations WHERE id=$1',[row.id])).rows[0].status).toBe('PENDING');}finally{await admin!.query('DROP TRIGGER fixture_fail_registration_audit ON domain_events;DROP FUNCTION fixture_fail_registration_audit()');}
 });
 it('registration rejects profile suspension and a mismatched recipient before creating identity',async()=>{
  const row=await newRecipient(),hash=await hashPassword(rawPassword);await expect(registerInvitedProfileIdentity(runtime!,{token:row.token,email:'foreign@example.invalid',name:'Synthetic',passwordHash:hash},'c')).rejects.toThrow('RECIPIENT_MISMATCH');
  await admin!.query("UPDATE profiles SET state='SUSPENDED' WHERE id=$1",[workspace]);try{await expect(register(row,hash)).rejects.toThrow('INVALID_OR_EXPIRED');}finally{await admin!.query("UPDATE profiles SET state='ACTIVE' WHERE id=$1",[workspace]);}expect((await admin!.query('SELECT id FROM "user" WHERE email=$1',[row.email])).rows).toHaveLength(0);
 });
 it('two profile invitations racing the same email create only one native identity',async()=>{
  const other=workspace+'_other';await admin!.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic','UTC',1,10,10)",[other]);await admin!.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[owner,other]);
  const one=await newRecipient(),two=await newRecipient(other);two.email=one.email;await withProfileTransaction(admin!,other,db=>db.query('UPDATE profile_invitations SET recipient_digest=$2,recipient_ciphertext=$3 WHERE id=$1',[two.id,invitationRecipientDigest(other,one.email),encrypt({scope:'profile.invitation.recipient.v1',workspaceId:other,invitationId:two.id,email:one.email})]));
  const hash=await hashPassword(rawPassword),out=await Promise.allSettled([register(one,hash),register(two,hash)]);expect(out.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect((await admin!.query('SELECT id FROM "user" WHERE email=$1',[one.email])).rows).toHaveLength(1);
  expect((await admin!.query("SELECT count(*)::int n FROM profile_invitations WHERE id=ANY($1) AND status='ACCEPTED'",[[one.id,two.id]])).rows[0].n).toBe(1);
 });
 it('registration link expiry after issuer lock wait leaves no identity',async()=>{
  const row=await newRecipient(),hash=await hashPassword(rawPassword),blocker=await admin!.connect();let pending:Promise<unknown>|undefined;
  await withProfileTransaction(admin!,workspace,db=>db.query("UPDATE profile_invitations SET created_at=statement_timestamp()-interval '24 hours',dispatched_at=statement_timestamp()-interval '24 hours'+interval '2 seconds',expires_at=statement_timestamp()+interval '2 seconds' WHERE id=$1",[row.id]));
  try{await blocker.query('BEGIN');await blocker.query('SELECT * FROM memberships WHERE user_id=$1 AND workspace_id=$2 FOR UPDATE',[owner,workspace]);pending=register(row,hash).then(value=>({value}),error=>({error}));let blocked=false;for(let i=0;i<150&&!blocked;i++){blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT role,active FROM memberships%'",[login])).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);
   await admin!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.02) FROM profile_invitations WHERE id=$1',[row.id]);await blocker.query('COMMIT');expect(await pending).toMatchObject({error:{message:'INVITATION_LINK_INVALID_OR_EXPIRED'}});
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}expect((await admin!.query('SELECT id FROM "user" WHERE email=$1',[row.email])).rows).toHaveLength(0);
 });

});
