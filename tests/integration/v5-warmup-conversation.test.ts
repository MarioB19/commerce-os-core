import {afterAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,withTransaction} from '../../packages/db/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {disposeAllFixtureProfiles} from '../support/migrated-database.js';
import {createWarmupSimulation,readWarmupSimulation,type WarmupSimulationInput} from '../../packages/db/src/warmup-simulation.js';
import {processWarmupSimulations} from '../../apps/automation-worker/src/warmup-simulation.js';
import {processInbound} from '../../apps/automation-worker/src/inbound.js';
import {channelTick} from '../../apps/channel-worker/src/runtime.js';
import {providerFor} from '../../apps/channel-worker/src/providers.js';
const owner='v5-warmup-conversation-worker';
afterAll(()=>pool.end());
// V7 F2: a laboratory run executes inside its requesting profile; every case
// starts from fresh synthetic profiles (an installation admits three).
beforeEach(()=>disposeAllFixtureProfiles(pool));
async function labRun<T>(workspace:string,work:(c:Parameters<Parameters<typeof withTransaction>[0]>[0])=>Promise<T>){await fixtureProfiles(workspace);return withTransaction(work);}
it.each(['none','duplicate','out_of_order','delay'] as const)('completes six real pipeline turns under local %s transport events without sales projections',async fault=>{
 const workspace='v5-warm-'+randomUUID(),run=await labRun(workspace,c=>createWarmupSimulation(c,workspace,{seed:7,at:'2026-09-14T12:00:00Z',participants:2,fault}));
 // Advance until the durable terminal state within the documented four-hour virtual window.
 // A delayed ACK is scheduled four minutes after acceptance; global queue contention is not a failed delivery.
 for(let i=0;i<=240;i++){await processWarmupSimulations();await channelTick(providerFor,owner);await processInbound(200);const current=await readWarmupSimulation(pool,run.id,workspace);if(current?.status!=='RUNNING')break;}
 const result=await readWarmupSimulation(pool,run.id,workspace);expect(result?.status,JSON.stringify(result)).toBe('COMPLETED');expect(result?.turns).toHaveLength(6);expect(result?.turns.every(t=>t.received_envelope_id&&t.provider_message_id&&t.attempts===1&&['DELIVERED','READ'].includes(t.status))).toBe(true);
 const execution=(await pool.query('SELECT execution_workspace FROM warmup_simulation_runs WHERE id=$1',[run.id])).rows[0].execution_workspace;
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind IN('contact','conversation','order','receipt','fulfillment')",[execution])).rows[0].n).toBe(0);expect((await pool.query('SELECT max(effective_days) days FROM warmup_states WHERE workspace_id=$1',[execution])).rows[0].days).toBe(0);expect(result).toMatchObject({external_effects:0,real_observation:false,internal_criteria_met:false});
});
it.each(['accepted_timeout','rejected','peer_disconnected'] as const)('preserves %s without fake completion or blind retry',async(fault:WarmupSimulationInput['fault'])=>{const workspace='v5-fault-'+randomUUID(),run=await labRun(workspace,c=>createWarmupSimulation(c,workspace,{seed:11,at:'2026-09-14T12:00:00Z',participants:2,fault}));for(let i=0;i<=240;i++){await processWarmupSimulations();await channelTick(providerFor,owner);await processInbound(200);if((await readWarmupSimulation(pool,run.id,workspace))?.status!=='RUNNING')break;}const result=await readWarmupSimulation(pool,run.id,workspace);expect(result?.status,JSON.stringify(result)).toBe('ATTENTION');expect(result?.turns.reduce((n,t)=>n+t.attempts,0)).toBeLessThanOrEqual(1);expect(result?.internal_criteria_met).toBe(false);});
it('creates isolated runs under the API database role, resumes persisted turns after worker restart and includes three peers',async()=>{
 const workspace='v5-three-'+randomUUID(),run=await labRun(workspace,async c=>{await c.query('SET LOCAL ROLE commerce_api');await c.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment','SIMULATION',true)",[workspace]);return createWarmupSimulation(c,workspace,{seed:42,at:'2026-09-14T12:00:00Z',participants:3,fault:'none'});});
 for(let i=0;i<=240;i++){await processWarmupSimulations();await channelTick(providerFor,i>3?owner+'-restarted':owner);await processInbound(200);if(i===3)await pool.query("UPDATE session_ownership SET lease_expires_at=now()-interval '1 second' WHERE workspace_id=(SELECT execution_workspace FROM warmup_simulation_runs WHERE id=$1)",[run.id]);if((await readWarmupSimulation(pool,run.id,workspace))?.status!=='RUNNING')break;}
 const result=await readWarmupSimulation(pool,run.id,workspace);expect(result?.status,JSON.stringify(result)).toBe('COMPLETED');expect(new Set(result?.turns.flatMap(t=>[t.sender_id,t.recipient_id])).size).toBe(3);expect(result?.turns.every(t=>t.attempts===1)).toBe(true);
});

it('stops at quiet hours or a bounded virtual deadline without producing successful effects',async()=>{
 for(const deadline of [false,true]){const workspace='v5-window-'+randomUUID(),run=await labRun(workspace,c=>createWarmupSimulation(c,workspace,{seed:3,at:deadline?'2026-09-14T12:00:00Z':'2026-09-14T23:30:00Z',participants:2,fault:'none'}));if(deadline)await pool.query("UPDATE warmup_simulation_runs SET result=jsonb_build_object('virtual_steps',240) WHERE id=$1",[run.id]);await processWarmupSimulations();const result=await readWarmupSimulation(pool,run.id,workspace);expect(result?.status).toBe('ATTENTION');expect(result?.result.reason).toBe(deadline?'SIMULATION_WINDOW_EXHAUSTED':'QUIET_HOURS');expect(result?.turns).toHaveLength(0);expect(result?.version).toBeGreaterThan(1);}
});
it('replays a seed and clock with the same logical turns while isolating run and account identifiers',async()=>{
 const runs=[];for(let i=0;i<2;i++){const workspace='v5-seed-'+randomUUID();runs.push(await labRun(workspace,c=>createWarmupSimulation(c,workspace,{seed:73,at:'2026-09-14T12:00:00Z',participants:2,fault:'none'})));}await processWarmupSimulations();const normalized=[];for(const run of runs){const rows=(await pool.query("SELECT t.position,s.body->>'name' sender,r.body->>'name' recipient,o.payload->>'text' text FROM warmup_turns t JOIN records s ON s.id=t.sender_id JOIN records r ON r.id=t.recipient_id JOIN outbox o ON o.id=t.effect_id WHERE t.workspace_id=(SELECT execution_workspace FROM warmup_simulation_runs WHERE id=$1) ORDER BY t.position",[run.id])).rows;normalized.push(rows);}expect(normalized[0]).toHaveLength(6);expect(normalized[0]).toEqual(normalized[1]);expect(runs[0]!.id).not.toBe(runs[1]!.id);expect(runs[0]!.account_ids).not.toEqual(runs[1]!.account_ids);
});
