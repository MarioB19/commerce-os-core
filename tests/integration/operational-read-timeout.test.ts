import {afterAll,beforeAll,expect,it} from 'vitest';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {hash,pool,putRecord} from '../../packages/db/src/index.js';
import {withOperationalReadBudget} from '../../apps/api/src/operational-read-budget.js';
import {roleExecutor} from '../support/database-role.js';

const workspace='operational-read-'+randomUUID(),withRole=roleExecutor(pool);
// V7 F2: fixture workspaces are adopted profiles (max three per installation).
beforeAll(()=>fixtureProfiles(workspace));
let app:Awaited<ReturnType<typeof createApp>>,token:string,accountId:string;
async function credential(scopes:string[],resources?:string[]){
 const value=randomBytes(32).toString('hex');
 await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,resource_ids,expires_at,allowed_environments) VALUES($1,'bounded-read','Synthetic bounded reader',$2,$3,$4,now()+interval '1 hour',$5)",[workspace,hash(value),JSON.stringify(scopes),resources?JSON.stringify(resources):null,JSON.stringify(['SIMULATION'])]);
 return value;
}
beforeAll(async()=>{
 app=await createApp();token=await credential(['channels:read']);
 accountId=(await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Bounded read fixture',provider:'simulator',sending_enabled:false}})).id;
});
afterAll(async()=>{await app.close();await pool.end();});
const cases=[
 {method:'GET' as const,path:'/v1/number-capacity',table:'number_operations'},
 {method:'GET' as const,path:'/v1/number-capacity/reconciliation',table:'number_capacity_slots'},
 {method:'GET' as const,path:'/v1/number-capacity/discrepancies',table:'number_capacity_slots'},
 {method:'POST' as const,path:'/v1/number-capacity',table:'number_capacity_slots',payload:{action:'preview',reason:'Synthetic read only preview'}},
];
const request=(input:typeof cases[number],bearer=token)=>withRole('commerce_api',()=>app.inject({method:input.method,url:input.path+'?environment=SIMULATION',payload:input.payload,headers:{authorization:'Bearer '+bearer}}));

it.each(cases)('returns an explicit unavailable error and recovers after a blocked $method $path read',async input=>{
 const blocker=await pool.connect();
 try{
  await blocker.query('BEGIN');
  // Fixed fixture table names only. The capacity GET blocks at its last query,
  // proving that the response budget includes more than the initial snapshot.
  await blocker.query(`LOCK TABLE ${input.table} IN ACCESS EXCLUSIVE MODE`);
  const response=await request(input);
  expect(response.statusCode,response.body).toBe(503);
  expect(response.json()).toEqual({error:{code:'OPERATIONAL_READ_TIMEOUT',message:'No se pudo completar la operación.'}});
  expect(response.json()).not.toHaveProperty('data');
  expect(response.body).not.toContain(token);
  expect(response.body).not.toMatch(/SELECT|statement timeout|lock timeout/);
 }finally{await blocker.query('ROLLBACK');blocker.release();}
 const recovered=await request(input);expect(recovered.statusCode,recovered.body).toBe(200);
 expect(recovered.json()).toHaveProperty('data');
 expect(pool.waitingCount).toBe(0);
});

it('preserves permission, environment and resource isolation without creating commands or capacity work',async()=>{
 const denied=await credential([]),restricted=await credential(['channels:read'],[accountId]);
 for(const input of cases){expect((await request(input,denied)).statusCode).toBe(403);}
 expect((await request(cases[0]!,restricted)).statusCode).toBe(403);
 const foreign=await putRecord(pool,{workspaceId:'other-'+randomUUID(),environment:'SIMULATION',kind:'channel_account',body:{name:'Other fixture',provider:'simulator'}});
 // V7 F8-D: the per-number health read left with the V5 screens; the kept
 // session read keeps the same resource and environment boundaries.
 expect((await app.inject({method:'GET',url:`/v1/channel-accounts/${accountId}/session?environment=SIMULATION`,headers:{authorization:'Bearer '+restricted}})).statusCode).not.toBe(403);
 expect((await app.inject({method:'GET',url:`/v1/channel-accounts/${foreign.id}/session?environment=SIMULATION`,headers:{authorization:'Bearer '+token}})).statusCode).toBe(404);
 expect((await app.inject({method:'GET',url:`/v1/channel-accounts/${accountId}/session?environment=REAL`,headers:{authorization:'Bearer '+token}})).statusCode).toBe(403);
 for(const table of ['commands','outbox','number_operations'])expect((await pool.query(`SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,[workspace])).rows[0].n).toBe(0);
});

it('maps a cancelled server read to unavailable while preserving read-only enforcement and pool recovery',async()=>{
 await expect(withOperationalReadBudget(c=>c.query('SELECT pg_sleep(2)'),150)).rejects.toMatchObject({statusCode:503,code:'OPERATIONAL_READ_TIMEOUT'});
 expect(await withOperationalReadBudget(async c=>(await c.query('SELECT 1 ok')).rows[0].ok)).toBe(1);
 await expect(withOperationalReadBudget(c=>c.query("INSERT INTO operational_settings(workspace_id,environment,body) VALUES($1,'SIMULATION','{}')",[workspace]))).rejects.toMatchObject({code:'25006'});
 expect((await pool.query('SELECT 1 ok')).rows[0].ok).toBe(1);
});
