import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {AutomationLoopMonitor} from '../../apps/automation-worker/src/loop-monitor.js';
import {persistAutomationHeartbeat} from '../../apps/automation-worker/src/heartbeat.js';
import {AUTOMATION_LOOP_NAMES} from '../../packages/domain/src/operations/automation-progress.js';
import type {Body} from '../../packages/contracts/src/index.js';

const workspace='automation-progress-'+randomUUID(),instance='fixture-automation-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie='';
beforeAll(async()=>{
 app=await createApp();const email=`automation-progress-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic progress owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 expect(login.statusCode).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
 await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic progress account',provider:'simulator',status:'DISCONNECTED',sending_enabled:false}});
});
afterAll(async()=>{await app.close();await pool.end();});
it('persists all twelve loops with history and API rejects forged freshness, incomplete or failed progress',async()=>{
 const read=async()=>{const response=await app.inject({method:'GET',url:'/v1/readiness?environment=SIMULATION',headers:{origin,cookie}});expect(response.statusCode,response.body).toBe(200);return response.json().data.checks.find((check:Body)=>check.key==='automation-worker');};
 expect((await read()).status).toBe('UNAVAILABLE');
 let fail=false;const monitor=new AutomationLoopMonitor(),handles=AUTOMATION_LOOP_NAMES.map(name=>monitor.add(name,async()=>{if(name==='operations_monitor'&&fail)throw Error('private diagnostic');}));
 await persistAutomationHeartbeat(instance,monitor.snapshot());expect((await read()).status).toBe('BLOCKED');
 await Promise.all(handles.map(handle=>handle.run()));await persistAutomationHeartbeat(instance,monitor.snapshot());expect((await read()).status).toBe('VERIFIED');
 fail=true;await expect(handles[8]!.run()).rejects.toThrow('private diagnostic');await persistAutomationHeartbeat(instance,monitor.snapshot());expect((await read()).status).toBe('BLOCKED');
 fail=false;await handles[8]!.run();await persistAutomationHeartbeat(instance,monitor.snapshot());expect((await read()).status).toBe('VERIFIED');
 let beat=(await pool.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND kind='service_heartbeat' AND body->>'instance'=$2",[workspace,instance])).rows[0];const healthy=beat.body;
 expect(healthy.loops).toHaveLength(12);expect(healthy.loops[8]).toMatchObject({attempts:3,successes:2,failures:1,consecutive_failures:0});
 expect((await pool.query('SELECT count(*)::int n FROM record_versions WHERE record_id=$1',[beat.id])).rows[0].n).toBe(4);
 const write=async(body:Body)=>{beat=await putRecord(pool,{id:beat.id,version:beat.version,workspaceId:workspace,environment:'SIMULATION',kind:'service_heartbeat',body});};
 for(const loops of [healthy.loops.slice(1),healthy.loops.map((loop:Body,i:number)=>i===0?{...loop,status:'FAILED'}:loop),healthy.loops.map((loop:Body,i:number)=>i===0?{...loop,last_success_at:new Date(Date.now()-181000).toISOString()}:loop)]){await write({...healthy,status:'OK',loops});expect(await read()).toMatchObject({status:'BLOCKED',message:'AUTOMATION_LOOPS_NOT_READY'});}
 await write({...healthy,source:'local_probe',loops:undefined});expect((await read()).status).toBe('BLOCKED');
 await write({...healthy,expires_at:new Date(Date.now()-1000).toISOString()});expect((await read()).status).toBe('STALE');
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});
