import {randomBytes,randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {profileReadRoutes} from '../../apps/api/src/profile-reads.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {bindProfileEnvironment} from '../../packages/db/src/profile-environment.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {fixtureProfileRow,requireMigratedProfileSchema} from '../support/migrated-database.js';

// V7 F2 reads (Inicio, uso, auditoría, operaciones) over HTTP with the restricted API role.
const suffix=randomBytes(8).toString('hex'),apiLogin='reads_api_'+suffix,origin='https://commerce.example.test',created:string[]=[];
const one='reads-one-'+suffix,two='reads-two-'+suffix,users={owner:'owner-'+suffix,viewer:'viewer-'+suffix,other:'other-'+suffix};
let admin:pg.Pool,api:pg.Pool,app:FastifyInstance;const operationId=randomUUID();
async function authority(db:{query:(s:string,v?:unknown[])=>Promise<{rows:any[]}>},workspace:string,user:string):Promise<ProfileAuthority>{
 const m=(await db.query('SELECT role,active,version FROM memberships WHERE workspace_id=$1 AND user_id=$2',[workspace,user])).rows[0];
 if(!m)throw Object.assign(Error('PROFILE_MEMBERSHIP_REQUIRED'),{code:'PROFILE_MEMBERSHIP_REQUIRED',statusCode:403});
 return{profile:{id:workspace,state:'ACTIVE'},membership:{userId:user,workspaceId:workspace,role:m.role,active:m.active,version:m.version},credential:{kind:'session',userId:user,workspaceId:workspace,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[],membershipVersion:m.version}};
}
const get=(url:string,user:string,workspace:string)=>app.inject({method:'GET',url,headers:{origin,'x-user':user,'x-commerce-profile-id':workspace,'x-commerce-profile-version':'1'}});
async function seed(workspace:string){
 const c=await admin.connect();
 try{
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  const working=randomUUID(),down=randomUUID();
  await c.query(`INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($2,$1,'REAL','channel_account','{"status":"WORKING","sending_enabled":true}'),($3,$1,'REAL','channel_account','{"status":"DISCONNECTED"}'),
   (gen_random_uuid(),$1,'REAL','conversation','{"status":"OPEN","text":"PRIVATE_SENTINEL"}'),(gen_random_uuid(),$1,'REAL','order','{}'),
   (gen_random_uuid(),$1,'REAL','receipt','{"status":"APPROVED"}'),(gen_random_uuid(),$1,'REAL','receipt','{"status":"PENDING"}'),(gen_random_uuid(),$1,'REAL','product','{"name":"P"}')`,[workspace,working,down]);
  await c.query(`INSERT INTO channel_sessions(account_id,workspace_id,environment,provider,gateway_id,remote_session_name,operational_pause) VALUES($2,$1,'REAL','waha','gw-'||$1,'s-'||$1,false)`,[workspace,working]);
  await c.query(`INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code) VALUES($1,'REAL','k1','NUMBER_DOWN','CRITICAL','NUMBER_DOWN')`,[workspace]);
  await c.query(`INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id,actor,payload) VALUES($1,'REAL','profile.employee.access.changed','u1','c1','{"type":"human","id":"owner"}','{"before":{"role":"viewer","email":"leak@example.test"},"after":{"role":"operator"},"message":"PRIVATE_SENTINEL"}'),
   ($1,'REAL','conversation.closed','c2','c2','{"type":"automation"}','{"text":"PRIVATE_SENTINEL"}')`,[workspace]);
  await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
describe('V7 profile reads: home, usage, audit and operations',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
  admin=new pg.Pool({connectionString:url.toString(),max:4});await requireMigratedProfileSchema(admin);
  const password=randomBytes(24).toString('hex');await admin.query(`CREATE ROLE "${apiLogin}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT commerce_api TO "${apiLogin}"`);
  const u=new URL(url);u.username=apiLogin;u.password=password;api=new pg.Pool({connectionString:u.toString(),max:4});
  for(const id of [one,two])await fixtureProfileRow(admin,created,id,{numbers:2,timezone:'America/Mexico_City'});
  for(const [user,role,workspace] of [[users.owner,'owner',one],[users.viewer,'viewer',one],[users.other,'owner',two]] as const){
   await admin.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$1,$2,true) ON CONFLICT DO NOTHING',[user,user+'@example.test']);
   await admin.query('INSERT INTO memberships(user_id,workspace_id,role) VALUES($1,$2,$3)',[user,workspace,role]);
  }
  await seed(one);
  await admin.query("INSERT INTO result_goal_operations(workspace_id,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,repeat('a',64),'{\"status\":\"CREATED\"}')",[one,users.owner,operationId]);
  app=Fastify({logger:false});app.setErrorHandler((e:any,_r,reply)=>reply.code(e.statusCode??500).send({error:{code:e.code??e.message}}));
  await app.register(async scoped=>{await profileReadRoutes(scoped,{origins:[origin],nativeSession:async(req:any)=>({id:'s',userId:String(req.headers['x-user'])}),
   session:(s:any,f:any,e:any,action:any,work:any)=>withProfileTransaction(api,f.workspaceId,async db=>{const auth=await authority(db,f.workspaceId,s.userId);
    try{authorizeProfileAction(auth,{...action,workspaceId:f.workspaceId},new Date());}catch(error){throw Object.assign(error as Error,{statusCode:403});}
    await bindProfileEnvironment(db,e);return work({db,profile:{authority:auth},environment:e});}),
   personal:async()=>{throw Error('unused');}});});
  await app.ready();
 });
 afterAll(async()=>{await app?.close();await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${apiLogin}"`);}finally{await admin.end();}}});
 it('summarizes Inicio with connection, aptitude to attend and sales kept apart',async()=>{
  const r=await get('/v2/home',users.viewer,one);expect(r.statusCode).toBe(200);const data=r.json().data;
  expect(data.numbers).toEqual({registered:2,connected:1,attending:1,causes:{DISCONNECTED:1,PAUSED:0,NOT_AUTHORIZED:0}});
  expect(data.today).toEqual({conversations:1,orders:1,approvedReceipts:1});expect(data.pending).toEqual({receiptsToReview:1,alerts:1,criticalAlerts:1});
  expect(data.next).toEqual({kind:'ONBOARDING',step:'ai'});expect(r.body).not.toContain('PRIVATE_SENTINEL');
  const empty=(await get('/v2/home',users.other,two)).json().data;expect(empty.numbers.registered).toBe(0);expect(empty.today.conversations).toBe(0);
 });
 it('reports configured limits next to observed use',async()=>{
  const data=(await get('/v2/usage',users.owner,one)).json().data;
  expect(data).toMatchObject({numbers:{used:2,limit:2},products:{used:1,limit:100},conversationsToday:{used:1,limit:100},aiCost:null});
 });
 it('lists sensitive actions with a reviewed payload subset and exports CSV only for owners',async()=>{
  const r=await get('/v2/audit',users.viewer,one);expect(r.statusCode).toBe(200);const entries=r.json().data.entries;
  expect(entries).toHaveLength(1);expect(entries[0]).toMatchObject({action:'profile.employee.access.changed',details:{before:{role:'viewer'},after:{role:'operator'}}});
  expect(r.body).not.toContain('leak@example.test');expect(r.body).not.toContain('PRIVATE_SENTINEL');
  expect((await get('/v2/audit/export',users.viewer,one)).statusCode).toBe(403);
  const csv=await get('/v2/audit/export',users.owner,one);expect(csv.statusCode).toBe(200);expect(csv.headers['content-type']).toContain('text/csv');expect(csv.body).toContain('profile.employee.access.changed');
  expect((await get('/v2/audit?limit=999',users.owner,one)).statusCode).toBe(400);
  expect((await get('/v2/audit',users.other,two)).json().data.entries).toHaveLength(0);
 });
 it('returns only the caller\'s own operation results inside the profile',async()=>{
  expect((await get('/v2/operations/'+operationId,users.owner,one)).json().data).toMatchObject({family:'goals',state:'RECORDED',result:{status:'CREATED'}});
  expect((await get('/v2/operations/'+operationId,users.viewer,one)).json().data.state).toBe('NOT_FOUND');
  expect((await get('/v2/operations/'+operationId,users.other,two)).json().data.state).toBe('NOT_FOUND');
  expect((await get('/v2/operations/not-a-uuid',users.owner,one)).statusCode).toBe(400);
 });
});
