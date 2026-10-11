import pg from 'pg';
import {readFile,writeFile} from 'node:fs/promises';
import {applyLocalEnv} from './local-env.mjs';
applyLocalEnv();const database=process.argv[2];if(!/^commerce_load_[0-9]+$/.test(database??''))throw new Error('Only retained synthetic load databases are allowed');const uri=new URL(process.env.DATABASE_URL);uri.pathname='/'+database;const client=new pg.Client({connectionString:uri.toString()});await client.connect();await client.query("SET statement_timeout='30s'");
const examples=(await client.query("SELECT workspace_id,id::text,body FROM records WHERE kind='contact' AND body->>'identity' IS NOT NULL LIMIT 1")).rows[0];
const queries={effectProjection:{sql:`SELECT o.* FROM outbox o WHERE o.payload->>'kind' IS DISTINCT FROM 'grant' AND o.status IN('SENT','DELIVERED','READ','FAILED','UNKNOWN') AND (NOT EXISTS(SELECT 1 FROM records m WHERE m.workspace_id=o.workspace_id AND m.kind='message' AND m.body->>'effect_id'=o.id::text) OR EXISTS(SELECT 1 FROM records f WHERE f.workspace_id=o.workspace_id AND f.id::text=o.payload->>'fulfillment_id' AND f.body->>'status' IS DISTINCT FROM o.status)) ORDER BY o.updated_at LIMIT 100`,params:[]},identity:{sql:`SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='contact' AND (body->>'identity'=$2 OR body->'identity_aliases' ? $2) LIMIT 1`,params:[examples.workspace_id,examples.body.identity]},idLookup:{sql:`SELECT * FROM records WHERE workspace_id=$1 AND kind='contact' AND id::text=$2`,params:[examples.workspace_id,examples.id]},eventConsumer:{sql:`SELECT e.* FROM domain_events e WHERE e.event_type IN('provider.ack.observed','provider.session.observed','provider.restriction.observed') AND NOT EXISTS(SELECT 1 FROM consumer_receipts r WHERE r.consumer='channel-v1' AND r.event_id=e.id) ORDER BY e.recorded_at LIMIT 100`,params:[]}};
function nodes(plan,result=[]){result.push({type:plan['Node Type'],index:plan['Index Name']??null,actual_rows:plan['Actual Rows'],loops:plan['Actual Loops'],rows_removed:plan['Rows Removed by Filter']??0,shared_hit_blocks:plan['Shared Hit Blocks']});for(const p of plan.Plans??[])nodes(p,result);return result;}
async function explain(){const result={};for(const[key,q]of Object.entries(queries)){const data=(await client.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+q.sql,q.params)).rows[0]['QUERY PLAN'][0];result[key]={planning_ms:data['Planning Time'],execution_ms:data['Execution Time'],nodes:nodes(data.Plan)};}return result;}
try {
 const counts=(await client.query('SELECT (SELECT count(*) FROM records)::int records,(SELECT count(*) FROM outbox)::int effects,(SELECT count(*) FROM domain_events)::int events')).rows[0];
 const before=await explain();
 await client.query(await readFile('packages/db/migrations/0010_operational_query_indexes.sql','utf8'));
 await client.query('ANALYZE records');await client.query('ANALYZE outbox');await client.query('ANALYZE domain_events');
 const after=await explain();
 const report={database,observed_at:new Date().toISOString(),method:'EXPLAIN ANALYZE BUFFERS on same synthetic retained dataset; warm caches and concurrent local activity, not production throughput guarantee',counts,before,after};
 await writeFile('docs/query-performance.json',JSON.stringify(report,null,2));
 const timings=(data)=>Object.fromEntries(Object.entries(data).map(([k,v])=>[k,v.execution_ms]));
 console.log(JSON.stringify({counts,before:timings(before),after:timings(after)}));
}finally{await client.end();}
