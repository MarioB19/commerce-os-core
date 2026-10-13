import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {fixtureProfiles,fixtureCoOwner} from '../support/profile-fixture.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,hash,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {readPersonalToken,insertPersonalToken} from '../../packages/db/src/personal-access-tokens.js';
import {issueOwnerToken} from '../../scripts/owner-api-token.js';

const workspace='personal-api-'+randomUUID(),email='personal-'+randomUUID()+'@example.invalid',origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,userId:string;
const expires=()=>new Date(Date.now()+86400000).toISOString();
function call(method:any,path:string,body?:any,token?:string,key=randomUUID()) {return app.inject({method,url:path,headers:{...(token?{authorization:'Bearer '+token}:{cookie,origin}),'idempotency-key':key},...(body===undefined?{}:{payload:body})});}
async function issue(allowed_environments=['REAL','SIMULATION']){return withTransaction(c=>insertPersonalToken(c,{workspace_id:workspace,user_id:userId,name:'Synthetic personal API',allowed_environments,expires_at:expires()}));}
beforeAll(async()=>{app=await createApp();const password=randomBytes(24).toString('base64url');userId=(await provisionUser({name:'Synthetic owner',email,password,workspace_id:workspace,role:'owner'})).id;/* V7 F2: a second owner lets cases downgrade this one (last-owner rule) */await fixtureCoOwner(pool,workspace);const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');});
afterAll(async()=>{await app.close();await pool.end();});

// V7 F8-D: personal tokens are issued from /v2/tokens (profile-tokens-http);
// here the same token authenticates the /v1 routes V7 kept, with the token's
// environments, the current membership and the profile boundary.
describe('Personal owner API access',()=>{
 it('authenticates the actual owner on the kept /v1 routes and locates the token only through the definer port',async()=>{
  const t=await issue(),me=await call('GET','/v1/me?environment=REAL',undefined,t.token);expect(me.statusCode).toBe(200);expect(me.json().data).toMatchObject({authentication_method:'personal_access_token',role:'owner',service:false,user:{id:userId},product_version:'V7'});
  for(const path of ['/v1/service-tokens','/v1/settings/operations','/v1/system/status','/v1/numbers/overview','/v1/conversations','/v1/orders'])expect((await call('GET',path+'?environment=REAL',undefined,t.token)).statusCode,path).toBe(200);
  for(const path of ['/v1/personal-access-tokens','/v1/users','/v1/products','/v1/channel-accounts','/v1/workflows'])expect((await call('GET',path+'?environment=REAL',undefined,t.token)).statusCode,path).toBe(404);
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET LOCAL ROLE commerce_api');expect((await client.query('SELECT token_id,workspace_id FROM public.locate_personal_profile_token($1)',[hash(t.token)])).rows).toEqual([{token_id:t.id,workspace_id:workspace}]);expect(await readPersonalToken(client,t.token)).toBeUndefined();}finally{await client.query('ROLLBACK');client.release();}
 });
 it('does not let a historical service token reach the retired token administration',async()=>{
  const secret=randomBytes(24).toString('hex');
  await pool.query(`INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,allowed_environments,expires_at) VALUES($1,$2,'Scoped fixture',$3,'["channels:read"]','["REAL"]',$4)`,[workspace,userId,hash(secret),expires()]);
  expect((await call('GET','/v1/me?environment=REAL',undefined,secret)).json().data).toMatchObject({service:true,authentication_method:'service_token'});
  expect((await call('POST','/v1/service-tokens',{environment:'REAL',name:'Retired grant',scopes:['channels:read'],expires_at:expires()})).statusCode).toBe(404);
  expect((await call('POST','/v1/personal-access-tokens',{environment:'REAL'},secret)).statusCode).toBe(404);
 });
 it('protects environments, expiry, membership changes and workspace boundaries',async()=>{
  const t=await issue(['REAL']);expect((await call('GET','/v1/me?environment=SIMULATION',undefined,t.token)).statusCode).toBe(403);
  const foreignWorkspace='foreign-'+randomUUID();await fixtureProfiles(foreignWorkspace);// V7 F2: an adopted profile
  const foreign=await putRecord(pool,{workspaceId:foreignWorkspace,environment:'REAL',kind:'order',body:{status:'OPEN'}});expect((await call('GET','/v1/orders/'+foreign.id+'?environment=REAL',undefined,t.token)).statusCode).toBe(404);
  // V7 F2: effective permission = token scopes ∩ current role; a demoted owner keeps
  // only Solo lectura through the same token, effective immediately.
  await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",[userId,workspace]);try{expect((await call('GET','/v1/me?environment=REAL',undefined,t.token)).statusCode).toBe(200);expect((await call('POST','/v1/system/controls',{environment:'REAL',paused:true,reason:'Demoted write attempt'},t.token)).statusCode).toBe(403);}finally{await pool.query("UPDATE memberships SET role='owner' WHERE user_id=$1 AND workspace_id=$2",[userId,workspace]);}
  await pool.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[userId,workspace]);try{expect((await call('GET','/v1/me?environment=REAL',undefined,t.token)).statusCode).toBe(401);}finally{await pool.query('UPDATE memberships SET active=true WHERE user_id=$1 AND workspace_id=$2',[userId,workspace]);}
  /* simulated clock: V7 token identity is immutable, so the fixture ages it with guards bypassed */await withTransaction(async c=>{await c.query('SET LOCAL session_replication_role=replica');await c.query("UPDATE personal_access_tokens SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[t.id]);});expect((await call('GET','/v1/me?environment=REAL',undefined,t.token)).statusCode).toBe(401);
 });
 it('bootstraps only an exact active owner and proves one durable token with a private ledger',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'owner-pat-test-'));const input={operation_id:randomUUID(),workspace_id:workspace,owner_email_sha256:hash(email.toLowerCase()),authorization_sha256:hash('Synthetic explicit administrative authorization'),confirmation:'CREATE_OWNER_API_TOKEN',name:'Bootstrap fixture',reason:'Explicit bootstrap integration fixture',allowed_environments:['REAL'],expires_at:expires()};
  try{
   await expect(issueOwnerToken('inspect',{...input,owner_email_sha256:hash('absent@example.invalid')},directory)).rejects.toThrow('EXACT_ACTIVE_OWNER_REQUIRED');
   expect((await issueOwnerToken('inspect',input,directory)).status).toBe('OWNER_MATCHED');expect((await issueOwnerToken('issue',input,directory)).status).toBe('CREATED');expect((await issueOwnerToken('readback',input,directory)).status).toBe('ACTIVE_READBACK_VERIFIED');expect((await issueOwnerToken('issue',input,directory)).status).toBe('ACTIVE_READBACK_VERIFIED');
   const token=(await readFile(join(directory,'personal-token'),'utf8')).trim();expect((await stat(join(directory,'personal-token'))).mode&0o777).toBe(0o600);expect((await call('GET','/v1/me?environment=REAL',undefined,token)).json().data.authentication_method).toBe('personal_access_token');
   await expect(issueOwnerToken('issue',{...input,name:'Changed request'},directory)).rejects.toThrow('BOOTSTRAP_INPUT_CONFLICT');
   const rows=(await pool.query("SELECT count(*) FROM domain_events WHERE workspace_id=$1 AND event_type='personal_access_token.bootstrap' AND payload->>'operation_id'=$2",[workspace,input.operation_id])).rows[0];expect(Number(rows.count)).toBe(1);
  }finally{await rm(directory,{recursive:true,force:true});}
 });
});
