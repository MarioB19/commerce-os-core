import {randomBytes,randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {requireMigratedProfileSchema} from '../support/migrated-database.js';
import {createAuth} from '../../apps/api/src/auth.js';
import {invitationRegistrationRoutes} from '../../apps/api/src/profile-invitation-registration.js';
import {invitationAcceptanceRoutes} from '../../apps/api/src/profile-invitation-acceptance.js';
import {profileIdentityRoutes} from '../../apps/api/src/profile-identity.js';
import {encrypt} from '../../packages/db/src/index.js';
import {identityAudit,identityLimit} from '../../packages/db/src/identity.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {acceptExistingProfileInvitation,readExistingProfileInvitation,registerInvitedProfileIdentity,generateInvitationLink} from '../../packages/db/src/profile-invitation-acceptance.js';
import {invitationRecipientDigest} from '../../packages/db/src/profile-invitation.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
const suffix=randomBytes(8).toString('hex'),login='f2_http_'+suffix,workspace='http_'+suffix,owner='owner_'+suffix;
const origin='http://localhost:5173',password='synthetic-http-registration123';
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,app:FastifyInstance|undefined,address:string;
async function transaction<T>(work:(client:pg.PoolClient)=>Promise<T>){const client=await runtime!.connect();try{await client.query('BEGIN');const value=await work(client);expect((await client.query('COMMIT')).command).toBe('COMMIT');return value;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
async function session(req:FastifyRequest){return transaction(async client=>{const value=await createAuth(client).api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});return value&&value.user.id===value.session.userId?{id:value.session.id,userId:value.user.id}:null;});}
async function request(path:string,body?:object,cookie?:string,selectedOrigin=origin){return fetch(address+path,{method:body?'POST':'GET',redirect:'error',headers:{origin:selectedOrigin,...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});}
async function invitation(){const id=randomUUID(),email=randomUUID()+'@example.invalid',link=generateInvitationLink();await withProfileTransaction(admin!,workspace,async db=>{await db.query("INSERT INTO profile_invitations(id,workspace_id,operation_id,requested_by,role,recipient_digest,recipient_ciphertext,request_digest,created_at) VALUES($1,$2,$3,$4,'viewer',$5,$6,$7,clock_timestamp())",[id,workspace,randomUUID(),owner,invitationRecipientDigest(workspace,email),encrypt({scope:'profile.invitation.recipient.v1',workspaceId:workspace,invitationId:id,email}),'a'.repeat(64)]);await db.query("UPDATE profile_invitations SET delivery='UNCERTAIN',attempt_id=$2,link_digest=$3,dispatched_at=statement_timestamp(),expires_at=statement_timestamp()+interval '24 hours' WHERE id=$1",[id,randomUUID(),link.digest]);});return{id,email,token:link.token};}
async function registration(row:Awaited<ReturnType<typeof invitation>>){return request('/v2/invitation-registration',{token:row.token,email:row.email,name:'Synthetic HTTP Recipient',password});}
async function signIn(email:string,secret=password){const response=await request('/api/auth/sign-in/email',{email,password:secret});const cookie=response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');return{response,cookie};}
async function account(){const row=await invitation();expect((await registration(row)).status).toBe(201);const result=await signIn(row.email);expect(result.response.status).toBe(200);expect(result.cookie).toMatch(/^better-auth\.session_token=/);return{...row,cookie:result.cookie};}

describe('loopback HTTP invitation registration with real native auth and restricted PostgreSQL',()=>{
 beforeAll(async()=>{
  vi.stubEnv('PRIVATE_DATA_KEY',randomBytes(32).toString('hex'));vi.stubEnv('BETTER_AUTH_SECRET','synthetic-http-'+randomBytes(32).toString('hex'));
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:5000});await requireMigratedProfileSchema(admin);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`);await admin.query(`GRANT commerce_api TO "${login}"`);
  await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$1||\'@example.invalid\',true)',[owner]);await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic HTTP','UTC',1,10,10)",[workspace]);await admin.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'owner')",[owner,workspace]);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:6,connectionTimeoutMillis:5000});expect((await runtime.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({rolsuper:false,rolbypassrls:false});
  app=Fastify({logger:false,disableRequestLogging:true});
  app.setErrorHandler((error:any,_req,reply)=>reply.code(error.statusCode??500).send({error:{code:error.code??'INTERNAL_ERROR',message:(error.statusCode??500)<500?error.message:'No se pudo completar la operación.'}}));
  await invitationRegistrationRoutes(app,{origins:[origin],hasSession:async req=>Boolean(await session(req)),limit:(kind,value,max)=>identityLimit(kind,value,max,900,runtime!),hash:hashPassword,register:(input,correlation)=>registerInvitedProfileIdentity(runtime!,input,correlation)});
  await invitationAcceptanceRoutes(app,{origins:[origin],nativeSession:session,accept:(identity,token,correlation)=>acceptExistingProfileInvitation(runtime!,identity,token,correlation),read:(identity,token)=>readExistingProfileInvitation(runtime!,identity,token)});
  await profileIdentityRoutes(app,{origins:[origin],session,list:identity=>listProfileChoicesFromSession(runtime!,identity),select:(identity,target,version,correlation)=>transaction(async client=>{const result=await selectProfileFromSession(client,identity,target,version);await identityAudit(client,'profile.selection','SUCCEEDED',correlation,identity.userId,identity.userId);return result;})});
  // Test-only loopback adapter around the installed native Better Auth handler.
  // No mock session, account or response; COMMIT precedes disclosure of cookies.
  app.post('/api/auth/*',{bodyLimit:4096},async(req,reply)=>{if(req.headers.origin!==origin)return reply.code(403).send({error:{code:'ORIGIN_REJECTED',message:'ORIGIN_REJECTED'}});const response=await transaction(async client=>createAuth(client).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));reply.code(response.status);if(response.ok)reply.header('set-cookie',response.headers.getSetCookie());return{signedIn:response.ok};});
  address=await app.listen({host:'127.0.0.1',port:0});
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('creates identity over HTTP without a cookie, then logs in, selects profile and observes accepted invitation',async()=>{
  const row=await invitation(),created=await registration(row);expect(created.status).toBe(201);expect(await created.json()).toEqual({data:{registered:true,loginRequired:true}});expect(created.headers.get('set-cookie')).toBeNull();
  expect((await admin!.query('SELECT count(*)::int n FROM identity_rate_limits WHERE hits=1')).rows[0].n).toBe(2);
  expect((await admin!.query('SELECT s.id FROM session s JOIN "user" u ON u.id=s."userId" WHERE u.email=$1',[row.email])).rowCount).toBe(0);
  const {response,cookie}=await signIn(row.email);expect(response.status).toBe(200);expect(cookie).toContain('better-auth.session_token=');
  const profiles=await request('/v2/me/profiles',undefined,cookie);expect(profiles.status).toBe(200);expect((await profiles.json()).data).toMatchObject({profiles:[{id:workspace,role:'viewer',selected:false}],selection:{workspaceId:null,version:0}});
  const selected=await request('/v2/me/profile-selection',{workspaceId:workspace,expectedVersion:0},cookie);expect(selected.status).toBe(200);expect(await selected.json()).toEqual({data:{workspaceId:workspace,version:1}});
  const status=await request('/v2/invitation-acceptance/status',{token:row.token},cookie);expect(status.status).toBe(200);expect(await status.json()).toEqual({data:{workspaceId:workspace,invitationId:row.id,state:'ACCEPTED'}});
  const replay=await request('/v2/invitation-acceptance',{token:row.token},cookie);expect(replay.status).toBe(200);expect((await replay.json()).data.created).toBe(false);
  expect((await admin!.query("SELECT count(*)::int n FROM domain_events WHERE aggregate_id=$1 AND event_type='profile.invitation.accepted'",[row.id])).rows[0].n).toBe(1);
 });
 it('native public sign-up remains disabled with no new identity or cookie',async()=>{const email=randomUUID()+'@example.invalid',r=await request('/api/auth/sign-up/email',{email,name:'Synthetic',password});expect(r.status).toBe(400);expect(r.headers.get('set-cookie')).toBeNull();expect((await admin!.query('SELECT id FROM "user" WHERE email=$1',[email])).rowCount).toBe(0);});
 it('wrong native password produces no signed cookie',async()=>{const row=await account(),r=await signIn(row.email,'wrong-password-123');expect(r.response.status).toBe(401);expect(r.cookie).toBe('');});
 it('anonymous or forged-cookie profile access cannot choose a profile',async()=>{for(const cookie of [undefined,'better-auth.session_token=forged']){expect((await request('/v2/me/profiles',undefined,cookie)).status).toBe(401);expect((await request('/v2/me/profile-selection',{workspaceId:workspace,expectedVersion:0},cookie)).status).toBe(401);}});
 it('another profile and stale CAS selection remain denied after valid login',async()=>{const row=await account();expect((await request('/v2/me/profile-selection',{workspaceId:'other-profile',expectedVersion:0},row.cookie)).status).toBe(403);expect((await request('/v2/me/profile-selection',{workspaceId:workspace,expectedVersion:0},row.cookie)).status).toBe(200);expect((await request('/v2/me/profile-selection',{workspaceId:workspace,expectedVersion:0},row.cookie)).status).toBe(409);});
 it('foreign Origin blocks registration and selection before effects',async()=>{const row=await account(),pending=await invitation();expect((await request('/v2/invitation-registration',{token:pending.token,email:pending.email,name:'Synthetic',password},undefined,'https://foreign.example.invalid')).status).toBe(403);expect((await request('/v2/me/profile-selection',{workspaceId:workspace,expectedVersion:0},row.cookie,'https://foreign.example.invalid')).status).toBe(403);expect((await admin!.query('SELECT id FROM "user" WHERE email=$1',[pending.email])).rowCount).toBe(0);});
 it('membership revocation after native login removes the profile and cannot reactivate it by replay',async()=>{const row=await account(),user=(await admin!.query('SELECT id FROM "user" WHERE email=$1',[row.email])).rows[0].id;await withProfileTransaction(admin!,workspace,db=>db.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[user,workspace]));const result=await request('/v2/me/profiles',undefined,row.cookie);expect(result.status).toBe(200);expect((await result.json()).data.profiles).toEqual([]);expect((await request('/v2/me/profile-selection',{workspaceId:workspace,expectedVersion:0},row.cookie)).status).toBe(403);const replay=await request('/v2/invitation-acceptance',{token:row.token},row.cookie);expect(replay.status).toBe(200);expect((await replay.json()).data.created).toBe(false);expect((await admin!.query('SELECT active FROM memberships WHERE user_id=$1 AND workspace_id=$2',[user,workspace])).rows[0].active).toBe(false);});
});
