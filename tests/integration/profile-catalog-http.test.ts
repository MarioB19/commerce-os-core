import {randomBytes,randomUUID,createHash} from 'node:crypto';
import Fastify,{type FastifyInstance,type FastifyRequest} from 'fastify';
import {fromNodeHeaders} from 'better-auth/node';
import {hashPassword} from 'better-auth/crypto';
import {ZodError} from 'zod';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {listProfileChoicesFromSession,selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import {requireMigratedProfileSchema,sealFixtureProfiles} from '../support/migrated-database.js';
import {createAuth} from '../../apps/api/src/auth.js';
import {profileCatalogRoutes} from '../../apps/api/src/profile-catalog.js';
import {profileIdentityRoutes} from '../../apps/api/src/profile-identity.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {withProfileSessionTransaction} from '../../packages/db/src/profile-session-transaction.js';
import {withPersonalProfileTransaction} from '../../packages/db/src/profile-personal-token.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {sessionProfileCatalog} from '../../packages/commerce-client/src/profile-catalog.js';
import {createProfileMcp} from '../../apps/commerce-mcp/src/profile-server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';

const suffix=randomBytes(8).toString('hex'),login='f2_catalog_'+suffix;
const one='catalog_one_'+suffix,two='catalog_two_'+suffix,origin='http://localhost:5173';
const productOne=randomUUID(),productTwo=randomUUID(),simulation=randomUUID(),archived=randomUUID();
const password='synthetic-catalog-password123';
let admin:pg.Pool|undefined,runtime:pg.Pool|undefined,app:FastifyInstance|undefined,address:string,passwordHash:string;
async function transaction<T>(work:(client:pg.PoolClient)=>Promise<T>){const c=await runtime!.connect();try{await c.query('BEGIN');const result=await work(c);expect((await c.query('COMMIT')).command).toBe('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
async function nativeSession(req:FastifyRequest){return transaction(async c=>{const native=await createAuth(c).api.getSession({headers:fromNodeHeaders(req.headers),query:{disableRefresh:true}});return native&&native.session.userId===native.user.id?{id:native.session.id,userId:native.user.id}:null;});}
async function request(path:string,headers:Record<string,string>={},body?:object){return fetch(address+path,{method:body?'POST':'GET',redirect:'error',headers:{origin,...headers,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
function fence(cookie:string,profile=one,version=1){return{cookie,'x-commerce-profile-id':profile,'x-commerce-profile-version':String(version)};}
async function account(){
 const user=randomUUID(),email=user+'@example.invalid';
 await admin!.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,\'Synthetic Catalog\',$2,true)',[user,email]);
 await admin!.query('INSERT INTO account(id,"accountId","providerId","userId",password,issuer) VALUES($1,$2,\'credential\',$2,$3,\'local:credential\')',[randomUUID(),user,passwordHash]);
 await admin!.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,'viewer'),($1,$3,'viewer')",[user,one,two]);
 const r=await request('/api/auth/sign-in/email',{}, {email,password});expect(r.status).toBe(200);
 const cookie=r.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');expect(cookie).toContain('better-auth.session_token=');
 return{user,cookie};
}
async function select(cookie:string,workspaceId=one,expectedVersion=0){const r=await request('/v2/me/profile-selection',{cookie},{workspaceId,expectedVersion});expect(r.status).toBe(200);return(await r.json()).data;}
async function token(user:string,scopes=['products:read']){const secret='cos_pat_'+randomBytes(32).toString('base64url'),id=randomUUID();await admin!.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at)
 VALUES($1,$2,$3,'Synthetic catalog',$4,'["REAL"]',$5,clock_timestamp()+interval '1 hour')`,[id,one,user,createHash('sha256').update(secret).digest('hex'),JSON.stringify(scopes)]);return{id,secret};}

describe('commercial catalog HTTP on actual records with profile RLS and native identity',()=>{
 beforeAll(async()=>{
  vi.stubEnv('BETTER_AUTH_SECRET','synthetic-catalog-'+randomBytes(32).toString('hex'));passwordHash=await hashPassword(password);
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:3,connectionTimeoutMillis:5000});
  await requireMigratedProfileSchema(admin);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT;GRANT commerce_api TO "${login}"`);
  // V7 F2: the migrations (0096) install forced profile RLS on these tables;
  // the test no longer adds its own fixture policies.
  for(const table of ['records','record_versions','personal_access_tokens'])expect((await admin.query('SELECT relrowsecurity AND relforcerowsecurity forced FROM pg_class WHERE oid=$1::regclass',['public.'+table])).rows[0].forced).toBe(true);
  await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic One','UTC',1,10,10),($2,'Synthetic Two','UTC',1,10,10)",[one,two]);await sealFixtureProfiles(admin,one,two);
  for(const [id,workspace,environment,body]of [
   [productOne,one,'REAL',{name:'Visible One',description:'Catalog',status:'DRAFT',secret_ciphertext:'needle-private'}],
   [productTwo,two,'REAL',{name:'Visible Two',status:'DRAFT'}],
   [simulation,one,'SIMULATION',{name:'Simulated One',status:'DRAFT'}],
   [archived,one,'REAL',{name:'Archived One',status:'ARCHIVED'}],
  ]as const)await admin.query('INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,$3,\'product\',$4)',[id,workspace,environment,body]);
  await admin.query("UPDATE records SET version=2,body=body||'{\"description\":\"Revision Two\"}'::jsonb WHERE id=$1",[productOne]);
  url.username=login;url.password=secret;runtime=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:5000});
  app=Fastify({logger:false,disableRequestLogging:true});app.setErrorHandler((e:any,_r,reply)=>reply.code(e instanceof ZodError?400:e.statusCode??500).send({error:{code:e.code??'INTERNAL_ERROR'}}));
  await profileIdentityRoutes(app,{origins:[origin],session:nativeSession,list:s=>listProfileChoicesFromSession(runtime!,s),select:(s,w,v)=>transaction(c=>selectProfileFromSession(c,s,w,v))});
  await profileCatalogRoutes(app,{origins:[origin],nativeSession,
   session:(s,f,environment,action,work)=>withProfileSessionTransaction(runtime!,s,f,action,(db,profile)=>work({db,profile,environment})),
   personal:(t,environment,action,work)=>withPersonalProfileTransaction(runtime!,t,environment,action,(db,profile)=>work({db,profile,environment})),
  });
  app.post('/api/auth/*',{bodyLimit:4096},async(req,reply)=>{if(req.headers.origin!==origin)return reply.code(403).send({error:'ORIGIN'});const result=await transaction(c=>createAuth(c).handler(new Request('http://localhost:3001'+req.url,{method:'POST',headers:fromNodeHeaders(req.headers),body:JSON.stringify(req.body)})));reply.code(result.status);if(result.ok)reply.header('set-cookie',result.headers.getSetCookie());return{signedIn:result.ok};});
  address=await app.listen({host:'127.0.0.1',port:0});
 });
 afterAll(async()=>{await app?.close();await runtime?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}vi.unstubAllEnvs();});
 it('enforces native RLS without impersonating a superuser, and leaves pooled SQL context empty',async()=>{
  expect((await runtime!.query('SELECT current_user,session_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]).toEqual({current_user:login,session_user:login,rolsuper:false,rolbypassrls:false});
  for(const table of ['records','record_versions']){expect((await runtime!.query('SELECT * FROM '+table)).rows).toEqual([]);const row=(await admin!.query('SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner) owner FROM pg_class WHERE oid=$1::regclass',[table])).rows[0];expect(row).toMatchObject({relrowsecurity:true,relforcerowsecurity:true});expect(row.owner).not.toBe(login);}
  // V7 F2: the record privacy guard (0094) refuses the foreign profile before RLS.
  await expect(withProfileTransaction(runtime!,one,db=>db.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','product','{}')",[two]))).rejects.toThrow(/PRIVACY_ASSET_CONTEXT_REQUIRED|row-level security/);
 });
 it('uses the explicit native selection, then rejects the stale profile fence after switching',async()=>{
  const {cookie}=await account();expect((await request('/v2/catalog/products',fence(cookie))).status).toBe(409);await select(cookie);
  const first=await request('/v2/catalog/products',fence(cookie));expect(first.status).toBe(200);expect((await first.json()).data.map((x:any)=>x.id)).toEqual([productOne]);
  await select(cookie,two,1);expect((await request('/v2/catalog/products',fence(cookie))).status).toBe(409);
  expect((await(await request('/v2/catalog/products',fence(cookie,two,2))).json()).data.map((x:any)=>x.id)).toEqual([productTwo]);
 });
 it('keeps foreign profiles and environments indistinguishable from absent details and history',async()=>{
  const {cookie}=await account();await select(cookie);
  for(const id of [productTwo,simulation,randomUUID()])for(const suffix of ['','/versions'])expect((await request('/v2/catalog/products/'+id+suffix,fence(cookie))).status).toBe(404);
  const r=await request('/v2/catalog/products?environment=SIMULATION',fence(cookie));expect((await r.json()).data.map((x:any)=>x.id)).toEqual([simulation]);
 });
 it('reads only the current profile history and applies bounded version pages',async()=>{
  const {cookie}=await account();await select(cookie);const path='/v2/catalog/products/'+productOne+'/versions';
  const first=await(await request(path+'?limit=1',fence(cookie))).json();expect(first.data.map((x:any)=>x.version)).toEqual([2]);expect(first.meta.hasMore).toBe(true);
  const second=await(await request(path+'?before=2&limit=1',fence(cookie))).json();expect(second.data.map((x:any)=>x.version)).toEqual([1]);expect(second.meta.hasMore).toBe(false);expect(JSON.stringify(second)).not.toContain('needle-private');
 });
 it('filters archived rows and never searches encrypted/private fields',async()=>{
  const {cookie}=await account();await select(cookie);
  expect((await(await request('/v2/catalog/products?q=needle-private',fence(cookie))).json()).data).toEqual([]);
  const rows=await(await request('/v2/catalog/products?include_archived=true&limit=1',fence(cookie))).json();expect(rows.data).toHaveLength(1);expect(rows.meta.hasMore).toBe(true);
  const visible=await request('/v2/catalog/products?q=Visible',fence(cookie));expect(visible.status).toBe(200);const raw=await visible.text();expect(raw).toContain('Visible One');expect(raw).not.toContain('needle-private');expect(raw).not.toContain('secret_ciphertext');
 });
 it('rejects revoked membership before exposing catalog data and never falls back to another profile',async()=>{
  const {cookie,user}=await account();await select(cookie);await admin!.query('UPDATE memberships SET active=false WHERE workspace_id=$1 AND user_id=$2',[one,user]);
  expect((await request('/v2/catalog/products',fence(cookie))).status).toBe(403);expect((await request('/v2/catalog/products',fence(cookie,two))).status).toBe(409);
 });
 it('keeps PAT profile, scope and environment fixed across cookie selections and revocation',async()=>{
  const {cookie,user}=await account();await select(cookie,two);const t=await token(user),headers={cookie,authorization:'Bearer '+t.secret};
  expect((await(await request('/v2/catalog/products',headers)).json()).data.map((x:any)=>x.id)).toEqual([productOne]);
  expect((await request('/v2/catalog/offers',headers)).status).toBe(403);expect((await request('/v2/catalog/products?environment=SIMULATION',headers)).status).toBe(401);
  expect((await request('/v2/catalog/products',{...headers,...fence(cookie,two)})).status).toBe(403);
  await admin!.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[t.id]);expect((await request('/v2/catalog/products',headers)).status).toBe(401);
 });
 it('preserves isolation across concurrent requests and subsequent bare pooled reads',async()=>{
  const a=await account(),b=await account();await select(a.cookie);await select(b.cookie,two);
  const requests=await Promise.all(Array.from({length:10},(_,i)=>request('/v2/catalog/products',i%2?fence(b.cookie,two):fence(a.cookie))));
  for(const[i,r]of requests.entries()){expect(r.status).toBe(200);expect((await r.json()).data.map((x:any)=>x.id)).toEqual([i%2?productTwo:productOne]);}
  expect((await runtime!.query('SELECT * FROM records')).rows).toEqual([]);expect((await runtime!.query('SELECT * FROM record_versions')).rows).toEqual([]);
 });
 it('runs the shared cookie client against native HTTP, rejects stale selection and keeps versions scoped',async()=>{
  const {cookie}=await account();await select(cookie);
  const browserFetch:typeof fetch=(url,init)=>fetch(address+url,{...init,headers:{...init!.headers,cookie}});
  const read=sessionProfileCatalog({workspaceId:one,version:1},browserFetch);
  expect((await read({operation:'list',resource:'products'})).data.map(x=>x.id)).toEqual([productOne]);
  expect((await read({operation:'versions',resource:'products',id:productOne})).data.map(x=>x.version)).toEqual([2,1]);
  await expect(read({operation:'get',resource:'products',id:productTwo})).rejects.toMatchObject({status:404});
  await select(cookie,two,1);await expect(read({operation:'list',resource:'products'})).rejects.toMatchObject({status:409});
  expect((await sessionProfileCatalog({workspaceId:two,version:2},browserFetch)({operation:'list',resource:'products'})).data.map(x=>x.id)).toEqual([productTwo]);
 });
 it('runs MCP SDK through real HTTP and restricted PostgreSQL with one fixed PAT, including revocation',async()=>{
  const {user,cookie}=await account();await select(cookie,two);const t=await token(user);
  const server=createProfileMcp(address,t.secret),list=(args:Record<string,unknown>)=>client.callTool({name:'products_manage',arguments:{action:'listar',...args}});
  const client=new Client({name:'native-profile-catalog',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
  try{
   const result=await list({resource:'products'});
   expect(result.isError).not.toBe(true);expect((result.structuredContent as any).data.map((x:any)=>x.id)).toEqual([productOne]);
   for(const args of [{resource:'products',environment:'SIMULATION'},{resource:'offers'},{resource:'products',profile_id:two}])expect((await list(args)).isError).toBe(true);
   expect((await client.callTool({name:'products_manage',arguments:{action:'leer',resource:'products',id:productTwo}})).isError).toBe(true);
   await admin!.query('UPDATE personal_access_tokens SET revoked_at=clock_timestamp() WHERE id=$1',[t.id]);
   const rejected=await list({resource:'products'});expect(rejected.isError).toBe(true);expect(JSON.stringify(rejected)).not.toContain(t.secret);
  }finally{await client.close();await server.close();}
 });
});
