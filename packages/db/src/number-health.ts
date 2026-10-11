import type {DomainRecord} from '../../contracts/src/index.js';
import {effectStatistics,purposes,summarizeNumberHealth,type Evidence,type EffectSample} from '../../domain/src/health/number-health.js';
import {deliveryTrend,operationalStatistics} from '../../domain/src/health/operational-statistics.js';
import type {QueryExecutor} from './index.js';
import {readEffectiveHealth} from './effective-health.js';
export async function numberHealth(c:QueryExecutor,account:DomainRecord,now=new Date()){
 const signals=(await readEffectiveHealth(c,{workspaceId:account.workspace_id,environment:account.environment,accountId:account.id,now})).signals as Evidence[];
 const control=(await c.query("SELECT paused,suppressed,takeover FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='channel_account' AND scope_id=$2) OR (scope_type='workspace' AND scope_id=$1))",[account.workspace_id,account.id])).rows;
 const lease=(await c.query('SELECT frozen,lease_expires_at FROM session_ownership WHERE workspace_id=$1 AND account_id=$2',[account.workspace_id,account.id])).rows[0];
 const warmup=(await c.query('SELECT status,enrolled_at FROM warmup_states WHERE workspace_id=$1 AND environment=$2 AND account_id=$3',[account.workspace_id,account.environment,account.id])).rows[0];
 const samples=(await c.query(`SELECT o.id,o.environment,o.kind,o.payload,o.status,o.created_at,o.claimed_at,o.result,o.contact_id,
 (SELECT min(CASE WHEN pg_input_is_valid(e.payload->>'provider_at','timestamp with time zone') THEN (e.payload->>'provider_at')::timestamptz END) FROM domain_events e WHERE e.workspace_id=o.workspace_id AND e.environment=o.environment AND e.event_type='message.acknowledged' AND e.payload->>'effect_id'=o.id::text AND e.payload->>'status' IN('DELIVERED','READ','PLAYED')) delivered_at,
 (SELECT count(*)::int FROM effect_attempts a WHERE a.effect_id=o.id AND a.status<>'NOT_SENT') physical_attempts,
 (SELECT min(a.started_at) FROM effect_attempts a WHERE a.effect_id=o.id AND a.status<>'NOT_SENT') first_attempt_at
 FROM outbox o WHERE o.workspace_id=$1 AND o.environment=$2 AND o.account_id=$3 AND (o.created_at>$4 OR o.claimed_at>$4 OR CASE WHEN pg_input_is_valid(o.result->>'accepted_at','timestamp with time zone') THEN (o.result->>'accepted_at')::timestamptz>$4 ELSE false END) ORDER BY o.created_at`,[account.workspace_id,account.environment,account.id,new Date(now.getTime()-14*86400000)])).rows.map(r=>({id:r.id,purpose:r.environment==='SIMULATION'?'SIMULATION':r.kind==='warmup'?'WARMUP':r.payload?.test_scope_id||r.payload?.purpose==='TEST'?'TEST':'COMMERCIAL',attempted_at:new Date(r.first_attempt_at??r.claimed_at??r.created_at).toISOString(),accepted_at:r.result?.accepted_at,delivered_at:r.delivered_at?new Date(r.delivered_at).toISOString():undefined,status:r.status,physical_attempts:r.physical_attempts,peer_id:r.contact_id})) as EffectSample[];
 const products=(await c.query("SELECT DISTINCT p.id,p.body->>'name' name FROM records p JOIN commercial_assignments b ON b.workspace_id=p.workspace_id AND b.environment=p.environment AND b.product_id=p.id AND b.state='ACTIVE' WHERE p.workspace_id=$1 AND p.environment=$2 AND p.kind='product' AND b.account_id::text=$3",[account.workspace_id,account.environment,account.id])).rows;
 const scope=[account.workspace_id,account.environment,account.id];
 const dimension=account.body.provider==='cloud'?'transport':'session';
 // Operational windows use seven days, one dimension, and the immediately
 // preceding observation (including ties) for coverage/transition at the edge.
 // Delivery trends retain their separate fourteen-day effect baseline.
 // The byte predicates exactly match 0065. They partition all rows, including
 // null text fields, without truncating long historical sources or statuses.
 const history=(await c.query(`WITH previous AS (
  SELECT max(observed_at) at FROM health_observation_index WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND dimension=$4 AND observed_at<$5
 ), history AS (
 SELECT record_id id,dimension,status,source,observed_at,CASE WHEN isfinite(expires_at) THEN expires_at END expires_at
 FROM health_observation_index WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND dimension=$4
 AND observed_at>=COALESCE((SELECT at FROM previous),$5) AND observed_at<=$6 AND isfinite(observed_at)
 AND (octet_length(workspace_id)::bigint+octet_length(environment)+COALESCE(octet_length(account_id),0)+COALESCE(octet_length(dimension),0)+COALESCE(octet_length(status),0)+COALESCE(octet_length(source),0))<=1024
 UNION ALL
 SELECT record_id id,dimension,status,source,observed_at,CASE WHEN isfinite(expires_at) THEN expires_at END expires_at
 FROM health_observation_index WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND dimension=$4
 AND observed_at>=COALESCE((SELECT at FROM previous),$5) AND observed_at<=$6 AND isfinite(observed_at)
 AND (octet_length(workspace_id)::bigint+octet_length(environment)+COALESCE(octet_length(account_id),0)+COALESCE(octet_length(dimension),0)+COALESCE(octet_length(status),0)+COALESCE(octet_length(source),0))>1024
 ) SELECT * FROM history ORDER BY observed_at`,[...scope,dimension,new Date(now.getTime()-7*86400000),now])).rows.map(r=>({...r,observed_at:new Date(r.observed_at).toISOString(),expires_at:r.expires_at?new Date(r.expires_at).toISOString():''})) as Evidence[];
 const envelopes=(await c.query("SELECT id,received_at,processed_at,status,metadata->>'provider_event_at' provider_at FROM inbound_envelopes WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND (received_at>$4 OR status='PENDING')",[...scope,new Date(now.getTime()-7*86400000)])).rows.map(r=>({...r,received_at:new Date(r.received_at).toISOString(),processed_at:r.processed_at?new Date(r.processed_at).toISOString():null}));
 const queue=(await c.query("SELECT id,status,created_at,not_before FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('READY','BLOCKED','SENDING','UNKNOWN')",scope)).rows.map(r=>({...r,created_at:new Date(r.created_at).toISOString(),not_before:new Date(r.not_before).toISOString()}));
 const horizon=account.body.provider==='cloud'?300:1800;
 return{account_id:account.id,alias:account.body.name,products,...summarizeNumberHealth({provider:account.body.provider,signals,now,paused:control.some(r=>r.paused||r.suppressed||r.takeover),identityConflict:account.body.identity_conflict===true,leaseValid:!!lease&&!lease.frozen&&new Date(lease.lease_expires_at)>now,sendingEnabled:account.body.sending_enabled===true,warming:!!warmup?.enrolled_at&&warmup.status!=='GRADUATED',real:account.environment==='REAL'}),statistics:purposes.map(purpose=>({purpose,windows:[1,24,168].map(hours=>({...effectStatistics(samples.filter(s=>s.purpose===purpose),now,hours,horizon),trend:deliveryTrend(samples.filter(s=>s.purpose===purpose),now,hours,horizon)}))})),operational_statistics:[1,24,168].map(hours=>operationalStatistics({now,hours,signals:history,dimension:account.body.provider==='cloud'?'transport':'session',envelopes,queue,simulation:account.environment==='SIMULATION'})),observed_cost_minor:null};
}
