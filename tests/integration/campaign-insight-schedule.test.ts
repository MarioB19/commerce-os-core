import {beforeAll,beforeEach,afterEach,afterAll,describe,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {scheduleRecentInsights} from '../../apps/automation-worker/src/meta-insights.js';
import type {Body} from '../../packages/contracts/src/index.js';

let app:FastifyInstance,w:string,cookie:string,ip=100;
const origin=(process.env.TRUSTED_ORIGINS??'http://127.0.0.1:5173').split(',')[0]!,from='2026-08-10',to='2026-09-08';
beforeAll(async()=>{app=await createApp();});
afterAll(async()=>{await app.close();await pool.end();});
afterEach(async()=>{await pool.query('DELETE FROM meta_insight_jobs WHERE workspace_id=$1',[w]);});
beforeEach(async()=>{
 w='campaign-schedule-'+randomUUID();ip++;const email=randomUUID()+'@commerce.test',password=randomBytes(24).toString('base64url');
 await provisionUser({email,password,name:'Synthetic schedule owner',workspace_id:w,role:'owner'});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'198.51.100.'+ip,headers:{origin},payload:{email,password}});
 expect(r.statusCode,r.body).toBe(200);cookie=(Array.isArray(r.headers['set-cookie'])?r.headers['set-cookie']:[r.headers['set-cookie']]).map(x=>String(x).split(';')[0]).join('; ');
});
const sync=(body:Body)=>app.inject({method:'POST',url:'/v1/meta/insights/sync',remoteAddress:'198.51.100.'+ip,headers:{cookie,origin,'idempotency-key':randomUUID()},payload:{environment:'REAL',from,to,...body}});
async function oldSchedule(){
 return(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status,created_at) VALUES($1,'REAL','synthetic-human',$2,'SYNCED',now()-interval '3 hours') RETURNING *",[w,{from:'2026-09-01',to:'2026-09-04',recurring:true,meta_ad_account_id:'act_123',interval_minutes:120,lookback_days:3}])).rows[0];
}
const jobs=async()=>(await pool.query('SELECT * FROM meta_insight_jobs WHERE workspace_id=$1 ORDER BY created_at',[w])).rows;

describe('One-off Insights preserve explicit recurring configuration',()=>{
 it('keeps the previous account and cadence, waits for active work and enqueues only one subsequent scheduled job',async()=>{
  const original=await oldSchedule(),request={recurring:false,preserve_schedule:true,meta_ad_account_id:'act_456'};
  const response=await sync(request);expect(response.statusCode,response.body).toBe(202);const id=response.json().data.id;
  const replay=await sync(request);expect(replay.statusCode,replay.body).toBe(202);expect(replay.json().data).toMatchObject({id,reused:true});
  await scheduleRecentInsights();expect(await jobs()).toHaveLength(2);
  await pool.query("UPDATE meta_insight_jobs SET status='RUNNING',lease_until=now()+interval '5 minutes' WHERE id=$1",[id]);await scheduleRecentInsights();expect(await jobs()).toHaveLength(2);
  await pool.query("UPDATE meta_insight_jobs SET status='SYNCED',lease_until=NULL WHERE id=$1",[id]);
  await Promise.all([scheduleRecentInsights(),scheduleRecentInsights()]);await scheduleRecentInsights();
  const result=await jobs();expect(result).toHaveLength(3);const scheduled=result.find(j=>j.actor_id==='insights-scheduler');
  expect(scheduled).toMatchObject({environment:'REAL',status:'PENDING',request:{recurring:true,scheduled:true,meta_ad_account_id:'act_123',interval_minutes:120,lookback_days:3}});expect(scheduled.request.preserve_schedule??false).toBe(false);
  expect(Date.parse(scheduled.request.to)-Date.parse(scheduled.request.from)).toBe(3*86400000);
  expect(result.find(j=>j.id===original.id).request).toEqual(original.request);
  expect(result.find(j=>j.id===id).request).toMatchObject({from,to,recurring:false,preserve_schedule:true,meta_ad_account_id:'act_456'});
 });
 it('retains the legacy explicit recurring:false cancellation when preserve_schedule is omitted',async()=>{
  await oldSchedule();const response=await sync({recurring:false});expect(response.statusCode,response.body).toBe(202);
  await pool.query("UPDATE meta_insight_jobs SET status='SYNCED' WHERE id=$1",[response.json().data.id]);await scheduleRecentInsights();
  const result=await jobs();expect(result).toHaveLength(2);expect(result[1].request).toMatchObject({recurring:false,preserve_schedule:false});expect(result.some(j=>j.actor_id==='insights-scheduler')).toBe(false);
 });
 it('does not create a schedule where no recurring configuration exists',async()=>{
  const response=await sync({recurring:false,preserve_schedule:true});expect(response.statusCode,response.body).toBe(202);
  await pool.query("UPDATE meta_insight_jobs SET status='SYNCED' WHERE id=$1",[response.json().data.id]);await scheduleRecentInsights();expect(await jobs()).toHaveLength(1);
 });
 it('rejects preserve_schedule with recurring:true including the default and documents the constraint',async()=>{
  for(const body of [{preserve_schedule:true,recurring:true},{preserve_schedule:true}]){const r=await sync(body);expect(r.statusCode,r.body).toBe(400);}expect(await jobs()).toHaveLength(0);
  const spec=(await app.inject({method:'GET',url:'/v1/openapi.json'})).json();expect(spec.paths['/v1/meta/insights/sync'].post.description).toContain('preserve_schedule:true exige recurring:false');
 });
 it('coalesces a legacy active request without the new flag but rejects a different schedule intent',async()=>{
  const id=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status) VALUES($1,'REAL','synthetic-human',$2,'PENDING') RETURNING id",[w,{from,to,recurring:false,interval_minutes:60,lookback_days:7}])).rows[0].id;
  const same=await sync({recurring:false});expect(same.statusCode,same.body).toBe(202);expect(same.json().data).toMatchObject({id,reused:true});
  const different=await sync({recurring:false,preserve_schedule:true});expect(different.statusCode,different.body).toBe(409);expect(await jobs()).toHaveLength(1);
 });
});
