import {afterAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {numberHealth} from '../../packages/db/src/number-health.js';
import {operationalStatistics} from '../../packages/domain/src/health/operational-statistics.js';
import type {Evidence} from '../../packages/domain/src/health/number-health.js';

const migration=await readFile(new URL('../../packages/db/migrations/0065_health_history_covering.sql',import.meta.url),'utf8');
const original=`WITH previous AS (
 SELECT max(observed_at) at FROM health_observation_index WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND dimension=$4 AND observed_at<$5
) SELECT record_id id,dimension,status,source,observed_at,CASE WHEN isfinite(expires_at) THEN expires_at END expires_at
FROM health_observation_index WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND dimension=$4
AND observed_at>=COALESCE((SELECT at FROM previous),$5) AND observed_at<=$6 AND isfinite(observed_at) ORDER BY observed_at`;
const normalize=(rows:ReturnType<typeof operationalStatistics>[])=>rows.map(r=>({...r,session:{...r.session,sources:r.session.sources.toSorted((a,b)=>String(a).localeCompare(String(b)))}}));
afterAll(async()=>{await pool.end();});

it.each(['simulator','cloud'])('preserves all history, edge ties and arbitrary text before/after migration for %s',async provider=>{
 const c=await pool.connect(),workspaceId='cover-history-'+randomUUID()+'x'.repeat(650),now=new Date('2026-09-28T04:00:00Z'),start=new Date(now.getTime()-7*86400000);
 try{
  await c.query('BEGIN');
  await c.query('DROP INDEX health_observation_history_cover_idx');await c.query('DROP INDEX health_observation_history_wide_idx');
  const account=await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'channel_account',body:{provider,name:'Synthetic arbitrary evidence'}}),dimension=provider==='cloud'?'transport':'session';
  const fixedBytes=Buffer.byteLength(workspaceId+'SIMULATION'+account.id+dimension+'OK');
  const threshold='a'.repeat(1024-fixedBytes),wide=randomBytes(5000).toString('hex');
  const base={account_id:account.id,dimension,scope:'account',status:'OK',source:'fixture',observed_at:new Date(now.getTime()-60000).toISOString(),expires_at:new Date(now.getTime()+120000).toISOString()};
  const bodies=[
   {...base,observed_at:new Date(start.getTime()-120000).toISOString(),status:'BLOCKED'},
   {...base,observed_at:new Date(start.getTime()-60000).toISOString(),status:'BLOCKED',source:wide},
   {...base,observed_at:new Date(start.getTime()-60000).toISOString(),status:'OK'},
   {...base,observed_at:start.toISOString(),source:threshold},
   {...base,observed_at:new Date(start.getTime()+60000).toISOString(),source:threshold+'b'},
   {...base,observed_at:new Date(start.getTime()+120000).toISOString(),source:'漢'.repeat(400)},
   {...base,observed_at:new Date(now.getTime()-3600000).toISOString(),status:wide},
   {...base,observed_at:new Date(now.getTime()-120000).toISOString(),status:null,source:null},
   {...base,expires_at:'malformed'},
   {...base,observed_at:now.toISOString(),source:wide,expires_at:'infinity'},
   {...base,observed_at:new Date(now.getTime()+1).toISOString(),status:'BLOCKED'},
   {...base,observed_at:'-infinity',status:'BLOCKED'},
   {...base,observed_at:'invalid',status:'BLOCKED'},
   {...base,dimension:dimension==='session'?'transport':'session',status:'BLOCKED'},
  ];
  for(const body of bodies)await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'health_signal',body});
  const other=await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'channel_account',body:{provider,name:'Separate fixture'}});
  await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'health_signal',body:{...base,account_id:other.id,source:'must-not-leak'}});
  // Migration must accept existing incompressible text exceeding a B-tree tuple.
  await c.query(migration);
  const counts=(await c.query("SELECT count(*)::int total,count(*) FILTER(WHERE source=$2)::int wide FROM health_observation_index WHERE workspace_id=$1",[workspaceId,wide])).rows[0];
  expect(counts).toEqual({total:15,wide:2});
  await c.query('SET LOCAL ROLE commerce_channel');
  const fresh=await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'health_signal',body:{...base,source:wide,observed_at:new Date(now.getTime()-30000).toISOString()}});
  await putRecord(c,{id:fresh.id,version:fresh.version,workspaceId,environment:'SIMULATION',kind:'health_signal',body:{...fresh.body,status:'BLOCKED'}});
  await c.query('SET LOCAL ROLE commerce_api');
  const rows=(await c.query(original,[workspaceId,'SIMULATION',account.id,dimension,start,now])).rows;
  expect(rows).toHaveLength(10);
  const history=rows.map(r=>({...r,observed_at:new Date(r.observed_at).toISOString(),expires_at:r.expires_at?new Date(r.expires_at).toISOString():''})) as Evidence[];
  const expected=[1,24,168].map(hours=>operationalStatistics({now,hours,signals:history,dimension,envelopes:[],queue:[],simulation:true}));
  const actual=await numberHealth(c,account,now);
  expect(normalize(actual.operational_statistics)).toEqual(normalize(expected));
  expect(actual.operational_statistics[2]?.session.sources).toContain(wide);
  expect(actual.operational_statistics[2]?.session.sources).not.toContain('must-not-leak');
  expect(actual.operational_statistics[2]?.session.observations).toBe(7);
 }finally{await c.query('ROLLBACK');c.release();}
});

it('returns faithful empty and non-finite-only histories',async()=>{
 const c=await pool.connect(),workspaceId='cover-empty-'+randomUUID(),now=new Date('2026-09-28T04:00:00Z');
 try{
  await c.query('BEGIN');
  const account=await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'channel_account',body:{provider:'simulator',name:'Empty fixture'}});
  const empty=(await numberHealth(c,account,now)).operational_statistics;
  for(const observed_at of ['-infinity','infinity','invalid'])await putRecord(c,{workspaceId,environment:'SIMULATION',kind:'health_signal',body:{account_id:account.id,dimension:'session',scope:'account',status:'OK',source:null,observed_at,expires_at:'infinity'}});
  expect((await numberHealth(c,account,now)).operational_statistics).toEqual(empty);
 }finally{await c.query('ROLLBACK');c.release();}
});
