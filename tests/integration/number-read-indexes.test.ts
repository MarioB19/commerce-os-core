import {afterAll,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {capacityReserve,readCapacitySnapshot} from '../../apps/api/src/number-capacity.js';
import {channelReception} from '../../apps/api/src/channel-reception.js';

// Fixtures use normal triggers and roll back: these global physical allocations
// must not change later tests' available capacity.
afterAll(async()=>{await pool.end();});
it('keeps cross-workspace physical reservations global while excluding SIM, deleted and other providers',async()=>{
 const c=await pool.connect();await c.query('BEGIN');
 try {
  const workspace='number-index-'+randomUUID(),other=workspace+'-other';
  const free=(await c.query(`SELECT n FROM generate_series(1,20) n WHERE
   NOT EXISTS(SELECT 1 FROM channel_sessions WHERE environment='REAL' AND archived_at IS NULL AND gateway_id='http://waha-'||lpad(n::text,2,'0')||':3000')
   AND NOT EXISTS(SELECT 1 FROM number_capacity_slots WHERE environment='REAL' AND slot=n)
   AND NOT EXISTS(SELECT 1 FROM records WHERE environment='REAL' AND kind='channel_account' AND NOT body?'deleted_at' AND body->>'gateway_ref'='waha-'||lpad(n::text,2,'0'))
   ORDER BY n LIMIT 1`)).rows[0].n;
  const occupied=await putRecord(c,{workspaceId:other,environment:'REAL',kind:'channel_account',body:{name:'Global physical fixture',provider:'waha',gateway_ref:'waha-'+String(free).padStart(2,'0'),status:'DISCONNECTED',sending_enabled:false}});
  const sim=await putRecord(c,{workspaceId:other,environment:'SIMULATION',kind:'channel_account',body:{name:'SIM fixture',provider:'simulator'}});
  const cloud=await putRecord(c,{workspaceId:other,environment:'REAL',kind:'channel_account',body:{name:'Cloud fixture',provider:'cloud'}});
  const deleted=await putRecord(c,{workspaceId:other,environment:'REAL',kind:'channel_account',body:{name:'Deleted fixture',provider:'waha',deleted_at:new Date().toISOString()}});
  const snapshot=await readCapacitySnapshot(c,workspace,'REAL');
  expect(snapshot.hostMappings.find(row=>row.account_id===occupied.id)).toMatchObject({workspace_id:other,physical_slot:free});
  expect(snapshot.hostMappings.filter(row=>[sim.id,cloud.id,deleted.id].includes(row.account_id))).toEqual([]);
  expect(snapshot.sessions).toEqual([]);expect(snapshot.metrics.reserved).toBe(0);
  const slot=await capacityReserve(c,workspace,'REAL');expect(slot.slot).not.toBe(free);
  expect((await c.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=ANY($1::text[])',[[workspace,other]])).rows[0].n).toBe(0);
 } finally {await c.query('ROLLBACK');c.release();}
});
it('selects only the last webhook for the exact account and preserves expired or absent UNKNOWN',async()=>{
 const c=await pool.connect();await c.query('BEGIN');
 try {
  const workspace='webhook-index-'+randomUUID();
  const account=await putRecord(c,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Webhook fixture',provider:'waha'}});
  const other=await putRecord(c,{workspaceId:workspace+'-other',environment:'REAL',kind:'channel_account',body:{name:'Other workspace webhook fixture',provider:'waha'}});
  expect((await channelReception(c,account)).webhook.state).toBe('UNKNOWN');
  const observed=new Date().toISOString(),future=new Date(Date.now()+60000).toISOString();
  const first=await putRecord(c,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension:'infrastructure',status:'OK',value:{kind:'webhook',matches:true},observed_at:observed,expires_at:future}});
  await c.query("UPDATE records SET version=version+1,created_at=now()-interval '1 hour' WHERE id=$1",[first.id]);
  await putRecord(c,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension:'infrastructure',status:'BLOCKED',value:{kind:'provider',matches:false},observed_at:observed,expires_at:future}});
  await putRecord(c,{workspaceId:other.workspace_id,environment:'REAL',kind:'health_signal',body:{account_id:other.id,dimension:'infrastructure',status:'BLOCKED',value:{kind:'webhook',matches:false},observed_at:observed,expires_at:future}});
  expect((await channelReception(c,account)).webhook.state).toBe('CONFIGURED');
  const last=await putRecord(c,{workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{account_id:account.id,dimension:'infrastructure',status:'BLOCKED',value:{kind:'webhook',matches:false},observed_at:observed,expires_at:future}});
  expect((await channelReception(c,account)).webhook.state).toBe('MISMATCH');
  await putRecord(c,{id:last.id,version:last.version,workspaceId:workspace,environment:'REAL',kind:'health_signal',body:{...last.body,expires_at:new Date(Date.now()-1000).toISOString()}});
  expect((await channelReception(c,account)).webhook.state).toBe('UNKNOWN');
 } finally {await c.query('ROLLBACK');c.release();}
});
