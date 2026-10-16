import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {pool} from '../../packages/db/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {roleExecutor} from '../support/database-role.js';

// V7 LIFE (Fases F3, «Suites transversales»): 50 synthetic lifecycle events in
// two profiles, concurrently, while the same channel-worker loop keeps running.
// Measured: no physical slot shared by two profiles, quota retired once per
// removal and reused by the same profile, the other profile's numbers
// untouched, the worker loop never restarted or failed, zero external effects.
const A='life-a-'+randomUUID(),B='life-b-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const withRole=roleExecutor(pool);
let app:Awaited<ReturnType<typeof createApp>>;const cookies:Record<string,string>={};
const call=(profile:string,method:string,path:string,body?:unknown)=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie:cookies[profile]!,'idempotency-key':randomUUID()}});
async function login(profile:string){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Dueño '+profile.slice(0,6),email,password,workspace_id:profile,role:'owner'});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookies[profile]=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
}
beforeAll(async()=>{await fixtureProfiles({id:A,numbers:10},{id:B,numbers:10});app=await createApp();await login(A);await login(B);});
afterAll(async()=>{await app.close();await pool.end();});
async function inProfile<T>(scope:string,work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[scope]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
const create=async(profile:string,n:number)=>{const r=await call(profile,'POST','/v1/numbers/quick',{alias:`Número ${n}`,country:'MX',phone:`55 ${String(1000+n).padStart(4,'0')} ${String(2000+n).padStart(4,'0')}`});expect(r.statusCode,r.body).toBe(202);return r.json().data.id as string;};
const remove=async(profile:string,id:string)=>{const version=(await inProfile(profile,c=>c.query('SELECT version FROM records WHERE id=$1',[id]))).rows[0].version;const r=await call(profile,'POST',`/v1/numbers/${id}/removal`,{expected_version:version,confirmation:'REMOVE_NUMBER'});expect(r.statusCode,r.body).toBe(202);expect(r.json().data.state).toBe('REMOVED');};
const pause=async(profile:string,id:string)=>{const r=await call(profile,'POST',`/v1/numbers/${id}/pause`,{paused:true});expect(r.statusCode,r.body).toBe(200);};

it('runs 50 concurrent lifecycle events in two profiles without cross effects or worker restart',async()=>{
 let loopRuns=0,loopFailures=0,running=true;
 const loop=(async()=>{while(running){try{await withRole('commerce_channel',()=>processNumberOperations('life-worker'));loopRuns++;}catch{loopFailures++;}await new Promise(r=>setTimeout(r,20));}})();
 const events:string[]=[];
 // 1. 20 registrations (10 per profile), all at once.
 const [a,b]=await Promise.all([A,B].map(p=>Promise.all(Array.from({length:10},(_,i)=>create(p,i)))));events.push(...a!.map(()=>'create'),...b!.map(()=>'create'));
 const bUntouched=b!.slice(5);
 const before=(await inProfile(B,c=>c.query('SELECT id,version,body FROM records WHERE id=ANY($1::uuid[]) ORDER BY id',[bUntouched]))).rows;
 // 2. 10 removals (5 per profile), concurrently.
 await Promise.all([...a!.slice(0,5).map(id=>remove(A,id)),...b!.slice(0,5).map(id=>remove(B,id))]);events.push(...Array(10).fill('remove'));
 // 3. 10 new registrations reuse each profile's own released slots and quota.
 const [a2,b2]=await Promise.all([A,B].map(p=>Promise.all(Array.from({length:5},(_,i)=>create(p,20+i)))));events.push(...Array(10).fill('create'));
 // 4. 10 explicit pauses (5 per profile).
 await Promise.all([...a2!.map(id=>pause(A,id)),...b2!.map(id=>pause(B,id))]);events.push(...Array(10).fill('pause'));
 running=false;await loop;
 expect(events).toHaveLength(50);
 // No physical slot number is held by two profiles; each profile stays within its own peak.
 const shared=(await pool.query("SELECT slot FROM number_capacity_slots WHERE environment='REAL' AND workspace_id=ANY($1::text[]) GROUP BY slot HAVING count(DISTINCT workspace_id)>1",[[A,B]])).rows;
 expect(shared).toEqual([]);
 for(const p of [A,B]){
  const slots=(await inProfile(p,c=>c.query("SELECT count(*)::int n,count(*) FILTER(WHERE account_id IS NOT NULL)::int bound FROM number_capacity_slots WHERE workspace_id=$1 AND environment='REAL'",[p]))).rows[0];
  expect(slots.n,p).toBe(10);expect(slots.bound,p).toBe(10);
  const quota=(await inProfile(p,c=>c.query("SELECT count(*) FILTER(WHERE retired_at IS NULL)::int live,count(*) FILTER(WHERE retired_at IS NOT NULL)::int retired,count(*)::int total,count(DISTINCT record_id)::int distinct_ids FROM profile_quota_entries WHERE workspace_id=$1 AND kind='channel_account'",[p]))).rows[0];
  expect(quota,p).toEqual({live:10,retired:5,total:15,distinct_ids:15});
  const removed=(await inProfile(p,c=>c.query("SELECT count(*)::int n FROM domain_events WHERE workspace_id=$1 AND event_type='channel.deleted'",[p]))).rows[0].n;
  expect(removed,p).toBe(5);
 }
 // The other profile's numbers were not modified by any of these events.
 const after=(await inProfile(B,c=>c.query('SELECT id,version,body FROM records WHERE id=ANY($1::uuid[]) ORDER BY id',[bUntouched]))).rows;
 expect(after).toEqual(before);
 // The same worker loop kept running across every event; nothing external happened.
 expect(loopRuns).toBeGreaterThan(0);expect(loopFailures).toBe(0);
 for(const p of [A,B]){
  expect((await inProfile(p,c=>c.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[p]))).rows[0].n).toBe(0);
  expect((await inProfile(p,c=>c.query("SELECT count(*)::int n FROM commands WHERE workspace_id=$1 AND kind='channel_command'",[p]))).rows[0].n).toBe(0);
 }
},120000);
