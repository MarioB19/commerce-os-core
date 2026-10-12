import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import Fastify,{type FastifyInstance} from 'fastify';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {requireMigratedProfileSchema,selectFixtureSession} from '../support/migrated-database.js';
import {profileInvitationRoutes} from '../../apps/api/src/profile-invitations.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
const suffix=randomBytes(8).toString('hex'),login='f2_invites_'+suffix,one='invites_one_'+suffix,two='invites_two_'+suffix,actor='owner_'+suffix,foreign='foreign_'+suffix;
const session={id:'session_'+actor,userId:actor};let selection=0,admin:pg.Pool|undefined,runtime:pg.Pool|undefined,app:FastifyInstance|undefined;
const headers=()=>({origin:'https://fixture.test','x-commerce-profile-id':one,'x-commerce-profile-version':String(selection)});
const create=(input:Record<string,unknown>)=>app!.inject({method:'POST',url:'/v2/invitations',headers:headers(),payload:input});
const counts=async()=>{const rows=(await admin!.query("SELECT (SELECT count(*) FROM profile_invitations WHERE workspace_id=$1)::int invitations,(SELECT count(*) FROM profile_invitation_mail_jobs WHERE workspace_id=$1)::int jobs,(SELECT count(*) FROM domain_events WHERE workspace_id=$1 AND event_type LIKE 'profile.invitation.%')::int events",[one])).rows;return rows[0];};
const input=()=>({operationId:randomUUID(),email:randomUUID()+'@example.test',role:'operator'});
describe('isolated invitation queue under native profile authority',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-invitation-'+randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});await requireMigratedProfileSchema(admin);
  const password=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);await admin.query(`GRANT commerce_api TO "${login}"`);
  for(const id of [actor,foreign])await admin.query('INSERT INTO "user"(id,name,email) VALUES($1,$1,$1||\'@example.test\')',[id]);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','UTC',1,10,10),($2,'Synthetic Two','UTC',1,10,10)",[one,two]);
  await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner'),($3,$4,'owner')",[actor,one,foreign,two]);
  await admin.query('INSERT INTO session(id,"userId",token,"expiresAt") VALUES($1,$2,$1,now()+interval \'1 hour\')',[session.id,actor]);
  url.username=login;url.password=password;runtime=new pg.Pool({connectionString:url.toString(),max:5,connectionTimeoutMillis:5000});selection=(await selectFixtureSession(runtime,session,one,0)).version;
  app=Fastify();await profileInvitationRoutes(app,{origins:['https://fixture.test'],nativeSession:async()=>session,session:(native,fence,environment,action,work)=>withProfileSessionTransaction(runtime!,native,fence,action,(db,profile)=>work({db,profile,environment})),personal:async()=>{throw new Error('NO_PAT_IN_THIS_FIXTURE');}});
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('creates one encrypted invitation, queued mail reference and non-PII audit atomically',async()=>{
  const value=input(),before=await counts();const response=await create(value);expect(response.statusCode).toBe(201);expect(response.json().data).toMatchObject({role:'operator',status:'PENDING',delivery:'QUEUED',version:1,expiresAt:null,created:true});
  expect(await counts()).toEqual({invitations:before.invitations+1,jobs:before.jobs+1,events:before.events+1});
  const row=(await admin!.query('SELECT * FROM profile_invitations WHERE workspace_id=$1 AND operation_id=$2',[one,value.operationId])).rows[0];expect(JSON.stringify(row)).not.toContain(value.email);const audit=(await admin!.query('SELECT actor,payload FROM domain_events WHERE aggregate_id=$1',[row.id])).rows[0];expect(audit).toEqual({actor:{id:actor,type:'human'},payload:{role:'operator',version:1}});
  const found=await app!.inject({url:'/v2/invitations/operations/'+value.operationId,headers:headers()});expect(found.statusCode).toBe(200);expect(found.json().data.email).toBe(value.email);expect(found.headers['cache-control']).toBe('no-store');
 });
 it('reconciles the same operation, rejects changed payload and another pending request',async()=>{
  const value=input();const first=await create(value),before=await counts();const again=await create(value);expect(again.statusCode).toBe(200);expect(again.json().data).toEqual({...first.json().data,created:false});expect((await create({...value,role:'viewer'})).statusCode).toBe(409);expect((await create({...value,operationId:randomUUID()})).statusCode).toBe(409);expect(await counts()).toEqual(before);
 });
 it('serializes concurrent same-operation creation without duplicate effects',async()=>{
  const value=input(),before=await counts(),responses=await Promise.all([create(value),create(value)]);expect(responses.filter(r=>r.statusCode===201)).toHaveLength(1);expect(responses.every(r=>[200,201,409].includes(r.statusCode))).toBe(true);expect(await counts()).toEqual({invitations:before.invitations+1,jobs:before.jobs+1,events:before.events+1});expect((await create(value)).statusCode).toBe(200);
 });
 it('enforces SQL context, composite recipient-owner/job FK and closed runtime grants',async()=>{
  expect((await runtime!.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  const value=input();await create(value);const row=(await admin!.query('SELECT * FROM profile_invitations WHERE operation_id=$1',[value.operationId])).rows[0];
  for(const sql of ["UPDATE profile_invitations SET role='owner' WHERE id=$1",'DELETE FROM profile_invitations WHERE id=$1',"UPDATE profile_invitation_mail_jobs SET status='QUEUED' WHERE invitation_id=$1"]){await expect(runtime!.query(sql,[row.id])).rejects.toMatchObject({code:'42501'});}
  // V7 F2: commerce_api runs under FORCE RLS; a row outside the transaction's
  // profile context is invisible, so the write matches no row (ADR v7 isolation).
  expect((await runtime!.query("UPDATE profile_invitations SET status='CANCELLED',version=version+1 WHERE id=$1",[row.id])).rowCount).toBe(0);
  expect((await withProfileTransaction(runtime!,two,db=>db.query("UPDATE profile_invitations SET status='CANCELLED',version=version+1 WHERE id=$1",[row.id]))).rowCount).toBe(0);
  await expect(withProfileTransaction(runtime!,one,db=>db.query("INSERT INTO profile_invitations(id,workspace_id,operation_id,requested_by,role,recipient_digest,recipient_ciphertext,request_digest,created_at) VALUES($1,$2,$3,$4,'viewer',$5,'cipher',$6,clock_timestamp())",[randomUUID(),one,randomUUID(),foreign,'a'.repeat(64),'b'.repeat(64)]))).rejects.toMatchObject({code:'23503'});
  await expect(withProfileTransaction(runtime!,two,db=>db.query("INSERT INTO profile_invitation_mail_jobs(id,workspace_id,invitation_id,invitation_version,template,created_at) VALUES($1,$2,$3,1,'profile-invitation-v1',$4)",[randomUUID(),two,row.id,row.created_at]))).rejects.toThrow('PROFILE_INVITATION_MAIL_BINDING_REQUIRED');
 });
 it('cancels by CAS, retains queue for reconciliation and allows explicit replacement request',async()=>{
  const value=input();const response=await create(value),id=response.json().data.id,before=await counts();const cancel=()=>app!.inject({method:'POST',url:'/v2/invitations/'+id+'/cancel',headers:headers(),payload:{expectedVersion:1}});
  expect((await cancel()).json().data).toMatchObject({status:'CANCELLED',version:2});expect((await cancel()).statusCode).toBe(409);expect(await counts()).toEqual({...before,events:before.events+1});expect((await create({...value,operationId:randomUUID()})).statusCode).toBe(201);
 });
 it('rolls back invitation and mail queue when auditing fails',async()=>{
  const before=await counts();await admin!.query("CREATE FUNCTION fixture_fail_invite_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='profile.invitation.queued' THEN RAISE EXCEPTION 'FIXTURE_AUDIT_FAILURE'; END IF; RETURN NEW; END $$; CREATE TRIGGER fixture_fail_invite_audit BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION fixture_fail_invite_audit()");
  try{expect((await create(input())).statusCode).toBe(500);expect(await counts()).toEqual(before);}finally{await admin!.query('DROP TRIGGER fixture_fail_invite_audit ON domain_events; DROP FUNCTION fixture_fail_invite_audit()');}
 });
 it('rolls back all local effects if session expires waiting for the queue lock',async()=>{
  const before=await counts(),blocker=await admin!.connect();let pending:ReturnType<typeof create>|undefined;
  try{await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'2 seconds\' WHERE id=$1',[session.id]);await blocker.query('BEGIN');await blocker.query('LOCK TABLE profile_invitation_mail_jobs IN ACCESS EXCLUSIVE MODE');pending=create(input());
   let blocked=false;for(let i=0;i<100&&!blocked;i++){blocked=Boolean((await admin!.query("SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND query LIKE 'INSERT INTO profile_invitation_mail_jobs%'",[login])).rowCount);if(!blocked)await new Promise(r=>setTimeout(r,10));}expect(blocked).toBe(true);
   await admin!.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM "expiresAt"-clock_timestamp()))+0.02) FROM session WHERE id=$1',[session.id]);await blocker.query('COMMIT');expect((await pending).statusCode).toBe(401);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;await admin!.query('UPDATE session SET "expiresAt"=clock_timestamp()+interval \'1 hour\' WHERE id=$1',[session.id]);}
  expect(await counts()).toEqual(before);
 });
 it('denies unknown operation and explicit foreign profile, recipient or environment overrides',async()=>{
  const before=await counts();expect((await app!.inject({url:'/v2/invitations/operations/'+randomUUID(),headers:headers()})).statusCode).toBe(404);
  expect((await create({...input(),workspaceId:two})).statusCode).toBe(400);expect((await create({...input(),html:'forged'})).statusCode).toBe(400);expect((await app!.inject({url:'/v2/invitations?environment=SIMULATION',headers:headers()})).statusCode).toBe(400);expect(await counts()).toEqual(before);
 });
});
