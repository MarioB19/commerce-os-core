import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,hash,putRecord} from '../../packages/db/src/index.js';
import {readPersonalToken} from '../../packages/db/src/personal-access-tokens.js';
import {issueOwnerToken} from '../../scripts/owner-api-token.js';

const workspace='personal-api-'+randomUUID(),email='personal-'+randomUUID()+'@example.invalid',origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,userId:string;
const expires=()=>new Date(Date.now()+86400000).toISOString();
function call(method:any,path:string,body?:any,token?:string,key=randomUUID()) {return app.inject({method,url:path,headers:{...(token?{authorization:'Bearer '+token}:{cookie,origin}),'idempotency-key':key},...(body===undefined?{}:{payload:body})});}
async function issue(allowed_environments=['REAL','SIMULATION']) {const r=await call('POST','/v1/personal-access-tokens',{environment:allowed_environments[0],name:'Synthetic personal API',allowed_environments,expires_at:expires(),reason:'Explicit synthetic owner delegation',confirmation:'CREATE_OWNER_API_TOKEN'});expect(r.statusCode).toBe(201);return r.json().data;}
beforeAll(async()=>{app=await createApp();const password=randomBytes(24).toString('base64url');userId=(await provisionUser({name:'Synthetic owner',email,password,workspace_id:workspace,role:'owner'})).id;const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');});
afterAll(async()=>{await app.close();await pool.end();});

describe('Personal owner API access',()=>{
 it('delegates the actual owner, distinguishes audit identity and manages an inert channel over HTTP',async()=>{
  const t=await issue(),me=await call('GET','/v1/me?environment=REAL',undefined,t.token);expect(me.statusCode).toBe(200);expect(me.json().data).toMatchObject({authentication_method:'personal_access_token',role:'owner',service:false,user:{id:userId}});
  for(const path of ['/v1/service-tokens','/v1/settings/operations','/v1/system/status','/v1/users'])expect((await call('GET',path+'?environment=REAL',undefined,t.token)).statusCode).toBe(200);
  const created=await call('POST','/v1/channel-accounts',{environment:'SIMULATION',name:'Synthetic inert account',provider:'simulator',purpose:'',sending_enabled:false},t.token);expect(created.statusCode).toBe(201);const a=created.json().data;expect(a.sending_enabled).toBe(false);
  const session=await call('GET',`/v1/channel-accounts/${a.id}/session?environment=SIMULATION`,undefined,t.token);expect(session.json().data).toMatchObject({desired_state:'STOPPED',operational_pause:true,recovery_enabled:false});
  const deleted=await call('DELETE','/v1/channel-accounts/'+a.id,{environment:'SIMULATION',expected_version:a.version,confirmation:'DELETE_CHANNEL_ACCOUNT',reason:'Remove inert synthetic account'},t.token);expect(deleted.statusCode).toBe(200);expect(deleted.json().data.history_preserved).toBe(true);
  expect((await call('GET','/v1/channel-accounts/'+a.id+'?environment=SIMULATION',undefined,t.token)).json().data.deleted_at).toBeTruthy();
  const event=(await pool.query("SELECT actor FROM domain_events WHERE workspace_id=$1 AND event_type='channel.deleted' AND aggregate_id=$2",[workspace,a.id])).rows[0];expect(event.actor).toMatchObject({type:'personal_api',id:userId,credential_id:t.id});
  for(const table of ['commands','outbox'])expect(Number((await pool.query(`SELECT count(*) FROM ${table} WHERE workspace_id=$1`,[workspace])).rows[0].count)).toBe(0);
  // V7 F2: commerce_api locates a PAT only through the closed DEFINER port (002);
  // the historical direct lookup sees no row without a profile context.
  const client=await pool.connect();try{await client.query('BEGIN');await client.query('SET LOCAL ROLE commerce_api');expect((await client.query('SELECT token_id,workspace_id FROM public.locate_personal_profile_token($1)',[hash(t.token)])).rows).toEqual([{token_id:t.id,workspace_id:workspace}]);expect(await readPersonalToken(client,t.token)).toBeUndefined();}finally{await client.query('ROLLBACK');client.release();}
 });
 it('does not upgrade service tokens, accept wildcard scopes, or mint from a viewer',async()=>{
  const r=await call('POST','/v1/service-tokens',{environment:'REAL',name:'Scoped fixture',allowed_environments:['REAL'],scopes:['channels:read','products:read'],expires_at:expires()});expect(r.statusCode).toBe(201);const token=r.json().data.token;
  expect((await call('GET','/v1/personal-access-tokens?environment=REAL',undefined,token)).statusCode).toBe(403);
  expect((await call('POST','/v1/personal-access-tokens',{environment:'REAL'},token)).statusCode).toBe(403);
  expect((await call('POST','/v1/channel-accounts',{environment:'REAL',name:'Forbidden'},token)).statusCode).toBe(403);
  const p=(await call('GET','/v1/me?environment=REAL',undefined,token)).json().data;expect(p).toMatchObject({service:true,role:'viewer',authentication_method:'service_token'});
  expect((await call('POST','/v1/service-tokens',{environment:'REAL',name:'Forbidden grant',scopes:['channels:*'],expires_at:expires()})).statusCode).toBe(400);
 });
 it('protects environments, expiry, membership changes and workspace boundaries',async()=>{
  const t=await issue(['REAL']);expect((await call('GET','/v1/me?environment=SIMULATION',undefined,t.token)).statusCode).toBe(403);
  const foreignWorkspace='foreign-'+randomUUID();await fixtureProfiles(foreignWorkspace);// V7 F2: an adopted profile
  const foreign=await putRecord(pool,{workspaceId:foreignWorkspace,environment:'REAL',kind:'product',body:{name:'Foreign'}});expect((await call('GET','/v1/products/'+foreign.id+'?environment=REAL',undefined,t.token)).statusCode).toBe(404);
  await pool.query("UPDATE memberships SET role='viewer' WHERE user_id=$1 AND workspace_id=$2",[userId,workspace]);try{expect((await call('GET','/v1/me?environment=REAL',undefined,t.token)).statusCode).toBe(401);}finally{await pool.query("UPDATE memberships SET role='owner' WHERE user_id=$1 AND workspace_id=$2",[userId,workspace]);}
  await pool.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[userId,workspace]);try{expect((await call('GET','/v1/me?environment=REAL',undefined,t.token)).statusCode).toBe(401);}finally{await pool.query('UPDATE memberships SET active=true WHERE user_id=$1 AND workspace_id=$2',[userId,workspace]);}
  await pool.query("UPDATE personal_access_tokens SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[t.id]);expect((await call('GET','/v1/me?environment=REAL',undefined,t.token)).statusCode).toBe(401);
 });
 it('requires explicit confirmation and gives isolated encrypted replay without exposing stored secrets',async()=>{
  const body={environment:'REAL',name:'Replay test',allowed_environments:['REAL'],expires_at:expires(),reason:'Explicit test request',confirmation:'CREATE_OWNER_API_TOKEN'},key=randomUUID();
  expect((await call('POST','/v1/personal-access-tokens',{...body,confirmation:'wrong'})).statusCode).toBe(400);
  const first=await call('POST','/v1/personal-access-tokens',body,undefined,key),second=await call('POST','/v1/personal-access-tokens',body,undefined,key);expect(first.statusCode).toBe(201);expect(second.json().data.token).toBe(first.json().data.token);expect(first.headers['cache-control']).toBe('no-store');
  expect((await call('POST','/v1/personal-access-tokens',{...body,name:'conflict'},undefined,key)).statusCode).toBe(409);
  const list=await call('GET','/v1/personal-access-tokens?environment=REAL');expect(list.body).not.toContain(first.json().data.token);expect(list.body).not.toContain('token_hash');
  const row=(await pool.query("SELECT response FROM idempotency WHERE workspace_id=$1 AND operation='personal-token.create' AND key=$2",[workspace,key])).rows[0];expect(row.response._encrypted_response).toBeTruthy();expect(JSON.stringify(row)).not.toContain(first.json().data.token);
 });
 it('revokes immediately, rotates atomically, and cannot extend the issuer grant',async()=>{
  const t=await issue(['REAL']);const grant={environment:'REAL',name:'Rotated test',allowed_environments:['REAL'],expires_at:new Date(Date.parse(t.expires_at)+86400000).toISOString(),reason:'Explicit rotation test',confirmation:'ROTATE_OWNER_API_TOKEN',expected_version:t.version};
  expect((await call('POST','/v1/personal-access-tokens',{...grant,confirmation:'CREATE_OWNER_API_TOKEN',expected_version:undefined,expires_at:new Date(Date.now()+2*86400000).toISOString()},t.token)).statusCode).toBe(403);
  expect((await call('POST','/v1/personal-access-tokens',{environment:'REAL',name:'Broader environment',allowed_environments:['REAL','SIMULATION'],expires_at:grant.expires_at,reason:grant.reason,confirmation:'CREATE_OWNER_API_TOKEN'},t.token)).statusCode).toBe(403);
  const rotated=await call('POST','/v1/personal-access-tokens/'+t.id+'/rotate',grant,t.token);expect(rotated.statusCode).toBe(201);const next=rotated.json().data;expect((await call('GET','/v1/me?environment=REAL',undefined,t.token)).statusCode).toBe(401);expect((await call('GET','/v1/me?environment=REAL',undefined,next.token)).statusCode).toBe(200);
  const revoked=await call('DELETE','/v1/personal-access-tokens/'+next.id,{environment:'REAL',confirmation:'REVOKE_OWNER_API_TOKEN',reason:'End synthetic delegation',expected_version:next.version});expect(revoked.statusCode).toBe(200);expect((await call('GET','/v1/me?environment=REAL',undefined,next.token)).statusCode).toBe(401);
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
 it('publishes explicit PAT security, body and idempotency contracts',async()=>{
  const r=await call('GET','/v1/openapi.json');expect(r.statusCode).toBe(200);const spec=r.json();expect(spec.components.securitySchemes.ownerPersonalToken.scheme).toBe('bearer');expect(spec.paths['/v1/channel-accounts'].post.security).toContainEqual({ownerPersonalToken:[]});expect(spec.paths['/v1/personal-access-tokens'].post.requestBody.content['application/json'].schema.required).toContain('confirmation');
 });
 it('revokes personal tokens when the real user changes their password',async()=>{
  const password=randomBytes(24).toString('base64url'),nextPassword=randomBytes(24).toString('base64url'),address='password-'+randomUUID()+'@example.invalid';
  await provisionUser({name:'Password revocation fixture',email:address,password,workspace_id:'password-'+randomUUID(),role:'owner'});
  const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email:address,password}});expect(login.statusCode).toBe(200);
  const privateCookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');
  const created=await app.inject({method:'POST',url:'/v1/personal-access-tokens',headers:{origin,cookie:privateCookie,'idempotency-key':randomUUID()},payload:{environment:'REAL',name:'Password test PAT',allowed_environments:['REAL'],expires_at:expires(),confirmation:'CREATE_OWNER_API_TOKEN',reason:'Synthetic password revocation test'}});expect(created.statusCode).toBe(201);
  const changed=await app.inject({method:'POST',url:'/api/auth/change-password',headers:{origin,cookie:privateCookie},payload:{currentPassword:password,newPassword:nextPassword,confirmPassword:nextPassword}});expect(changed.statusCode).toBe(200);
  expect((await call('GET','/v1/me?environment=REAL',undefined,created.json().data.token)).statusCode).toBe(401);
 });
});
