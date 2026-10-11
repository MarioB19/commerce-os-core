/** Read-only wall-clock observer, independent of the load driver and its virtual clock. */
import {readFile,writeFile,statfs} from 'node:fs/promises';
import pg from 'pg';
import {applyLocalEnv} from './local-env.mjs';
import {databaseBackingStorage} from './numbers-soak-storage.mjs';
applyLocalEnv();
const input=process.argv[2];if(!input?.startsWith('docs/evidence/numbers-soak-'))throw Error('SOAK_REPORT_REQUIRED');
const source=JSON.parse(await readFile(input,'utf8')),root=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1});
const names=(await root.query("SELECT datname FROM pg_database WHERE datname LIKE 'commerce_numbers_soak_%' ORDER BY datname DESC")).rows;
let db;for(const {datname}of names){const url=new URL(process.env.DATABASE_URL);url.pathname='/'+datname;const candidate=new pg.Pool({connectionString:url.href,max:1,options:'-c default_transaction_read_only=on -c statement_timeout=3000'});try{if((await candidate.query('SELECT 1 FROM warmup_simulation_runs WHERE execution_workspace=$1',[source.workspace])).rowCount){db=candidate;break;}}catch{/* This retained database may belong to an older failed run. */}await candidate.end();}await root.end();if(!db)throw Error('SOAK_DATABASE_NOT_FOUND');
const output=input.replace('.json','-observer.json'),started=Date.now(),first=new Map(),health=new Map();
const report={source:input,workspace:source.workspace,started_at:new Date().toISOString(),status:'RUNNING',method:'read-only 1-second sampling; first observed due effect with confirmed causal receipt, open window, active pool, fresh member observations and no explicit rate/manual block. Subsecond effects may not be sampled. Wait ends at first observed attempt; includes poll-resolution overestimate. Health age uses wall time since a changed provider observation, not accelerated calendar age.',samples:[],infrastructure:[],eligible_wait_ms:[],excluded_disappeared:0,poll_errors:0};
while(true){const tick=Date.now();try{
 if(report.samples.length%30===0){
  const filesystem=await statfs(process.cwd()),postgres_backing_storage=await databaseBackingStorage();
  const database=(await db.query("SELECT pg_database_size(current_database())::float8 bytes,current_setting('max_connections')::int max_connections,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database()) connections,(SELECT count(*)::int FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') lock_waiters,to_regclass('pgboss.job') IS NOT NULL pgboss_table_present")).rows[0];
  const jobs=(await db.query('SELECT state,count(*)::int count FROM number_operations WHERE workspace_id=$1 GROUP BY state',[source.workspace])).rows;
  const ownership=(await db.query("SELECT count(*)::int accounts,count(*) FILTER(WHERE owner.frozen)::int frozen,count(*) FILTER(WHERE owner.lease_expires_at<now())::int expired_leases FROM session_ownership owner JOIN records a ON a.id::text=owner.account_id WHERE owner.workspace_id=$1 AND a.environment='SIMULATION'",[source.workspace])).rows[0];
  report.infrastructure.push({elapsed_seconds:(Date.now()-started)/1000,volume_total_bytes:filesystem.blocks*filesystem.bsize,volume_available_bytes:filesystem.bavail*filesystem.bsize,postgres_backing_storage,database,number_jobs:jobs,ownership,pgboss_execution:'Not exercised by this harness; worker entrypoints invoked directly. No pg-boss throughput claim.'});
 }
 const rows=(await db.query(`SELECT o.id,o.attempts,o.status,p.enabled,p.paused,p.breaker_open,
 o.status IN('READY','BLOCKED') AND p.enabled AND NOT p.paused AND NOT p.breaker_open AND g.expires_at>r.virtual_now
 AND o.not_before<=r.virtual_now AND o.expires_at>r.virtual_now
 AND EXTRACT(hour FROM r.virtual_now AT TIME ZONE (f.config->>'timezone'))>=(f.config->>'start_hour')::int
 AND EXTRACT(hour FROM r.virtual_now AT TIME ZONE (f.config->>'timezone'))<(f.config->>'end_hour')::int
 AND (o.predecessor_id IS NULL OR EXISTS(SELECT 1 FROM warmup_group_receipts receipt JOIN outbox predecessor ON predecessor.id=receipt.effect_id WHERE receipt.effect_id=o.predecessor_id AND receipt.receiver_id=t.sender_id AND receipt.delivery_source='authenticated_receive' AND predecessor.status IN('DELIVERED','READ')))
 AND NOT EXISTS(SELECT 1 FROM warmup_states s JOIN records a ON a.id=s.account_id LEFT JOIN session_ownership owner ON owner.account_id=s.account_id::text WHERE s.pool_id=p.id AND (s.paused OR owner.frozen OR owner.lease_expires_at<now() OR (a.body->>'health_checked_at')::timestamptz<r.virtual_now-interval '60 seconds'))
 AND COALESCE(o.result->>'reason','') NOT IN('WARMUP_QUIET_HOURS','WARMUP_RATE_LIMIT','CONTACT_FREQUENCY_LIMIT','WARMUP_MANUAL_CONTROL','WARMUP_HEALTH_NOT_READY','GROUP_MEMBERSHIP_STALE','WARMUP_MEMBER_NOT_READY','WARMUP_POOL_PAUSED') eligible
 FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id JOIN warmup_conversations v ON v.id=t.conversation_id JOIN warmup_pools p ON p.id=v.pool_id JOIN warmup_profiles f ON f.id=p.profile_id JOIN warmup_groups g ON g.id=v.group_id JOIN warmup_simulation_runs r ON r.id=v.simulation_run_id WHERE o.workspace_id=$1`,[source.workspace])).rows;
 for(const row of rows){if(row.attempts>0&&first.has(row.id)){report.eligible_wait_ms.push(Date.now()-first.get(row.id));first.delete(row.id);}else if(row.eligible&&!first.has(row.id))first.set(row.id,Date.now());else if(!row.eligible&&first.has(row.id)){first.delete(row.id);report.excluded_disappeared++;}}
 const accounts=(await db.query("SELECT id,body->>'health_checked_at' observed FROM records WHERE workspace_id=$1 AND kind='channel_account' AND body->>'number_policy_version'='standard-15d/v1'",[source.workspace])).rows;
 for(const a of accounts){if(health.get(a.id)?.observed!==a.observed)health.set(a.id,{observed:a.observed,changed:Date.now()});}
 const backlog=(await db.query("SELECT kind,status,count(*)::int count,min(created_at) oldest FROM outbox WHERE workspace_id=$1 AND status IN('READY','BLOCKED','SENDING','UNKNOWN') GROUP BY kind,status",[source.workspace])).rows;
 const invariant=(await db.query("SELECT count(*) FILTER(WHERE attempts>1)::int duplicate_attempts,count(*) FILTER(WHERE environment<>'SIMULATION')::int cross_environment FROM outbox WHERE workspace_id=$1",[source.workspace])).rows[0];
 report.samples.push({eligible_queue:first.size,elapsed_seconds:(Date.now()-started)/1000,query_ms:Date.now()-tick,healthy_observation_wall_age_ms:Math.max(0,...[...health.values()].map(h=>Date.now()-h.changed)),backlog,...invariant});
}catch(error){report.poll_errors++;report.last_error_code=error.code??'QUERY_FAILED';}
 if(report.samples.length%10===0)await writeFile(output,JSON.stringify(report,null,2));
 let current;try{current=JSON.parse(await readFile(input,'utf8'));}catch{await new Promise(resolve=>setTimeout(resolve,100));continue;}if(current.status!=='RUNNING'){report.status='COMPLETED';report.finished_at=new Date().toISOString();report.source_status=current.status;await writeFile(output,JSON.stringify(report,null,2));break;}
 await new Promise(resolve=>setTimeout(resolve,Math.max(100,1000-(Date.now()-tick))));
}
await db.end();console.log(JSON.stringify({status:report.status,output,samples:report.samples.length,eligible_samples:report.eligible_wait_ms.length,poll_errors:report.poll_errors}));
