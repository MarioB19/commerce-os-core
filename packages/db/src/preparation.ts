import {preparationProgress,localDate,calendarDistance,manualPreparation,STANDARD_V1_POLICY,STANDARD_V2_POLICY,type Declaration} from '../../domain/src/warmup/preparation.js';
import {numberNow} from './number-clock.js';
import type {QueryExecutor} from './index.js';
export async function readPreparation(c:QueryExecutor,workspace:string,environment:string,accountId:string,at?:Date){
 const now=at??await numberNow(c,workspace,environment);
 const episode=(await c.query('SELECT * FROM warmup_episodes WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND closed_at IS NULL',[workspace,environment,accountId])).rows[0];
 const state=(await c.query('SELECT s.*,p.config FROM warmup_states s JOIN warmup_profiles p ON p.id=s.profile_id WHERE s.account_id=$1 AND s.workspace_id=$2 AND s.environment=$3',[accountId,workspace,environment])).rows[0];
 if(!episode)return{episode:null,progress:null,state:state??null,policy_version:state?.config?.policy_version??(state?'legacy-30d/v1':null)};
 const declarations=(await c.query('SELECT *,local_date::text FROM warmup_manual_declarations WHERE episode_id=$1 ORDER BY recorded_at,id',[episode.id])).rows.map(d=>({...d,recorded_at:new Date(d.recorded_at).toISOString()}))as Declaration[];
 const stats=episode.policy_version===STANDARD_V2_POLICY?(await c.query("SELECT count(*)::int samples,count(*) FILTER(WHERE o.status IN('DELIVERED','READ'))::int delivered FROM outbox o JOIN warmup_conversations v ON v.id::text=o.conversation_id JOIN warmup_pools p ON p.id=v.pool_id WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND o.account_id=$3 AND o.attempts>0 AND o.claimed_at >=$4 AND o.claimed_at<$5 AND v.pool_id=$6 AND p.purpose='preparation'",[workspace,environment,accountId,episode.started_at,new Date(now.getTime()-(state?.config?.ack_maturity_minutes??30)*60000),state?.pool_id])).rows[0]:(await c.query("SELECT count(*)::int samples,count(*) FILTER(WHERE status IN('DELIVERED','READ'))::int delivered FROM outbox WHERE workspace_id=$1 AND environment=$2 AND kind='warmup' AND account_id=$3 AND attempts>0 AND claimed_at >=$4 AND claimed_at<$5",[workspace,environment,accountId,episode.started_at,new Date(now.getTime()-(state?.config?.ack_maturity_minutes??30)*60000)])).rows[0];
 const credits=episode.policy_version===STANDARD_V2_POLICY?(await c.query('SELECT count(*)::int days FROM warmup_day_credits WHERE episode_id=$1 AND account_id=$2',[episode.id,accountId])).rows[0].days:Number(state?.effective_days??0);
 const nextExecution=state?(await c.query("SELECT min(o.not_before) next_execution_at FROM outbox o JOIN warmup_conversations v ON v.id::text=o.conversation_id WHERE v.pool_id=$1 AND o.account_id=$2 AND o.status IN('READY','BLOCKED') AND o.not_before>=$3",[state.pool_id,accountId,now])).rows[0]?.next_execution_at:null;
 const progress=preparationProgress({policy_version:episode.policy_version,started_at:new Date(episode.started_at).toISOString(),timezone:episode.timezone,declarations,automatic_days:Number(credits),stable_since:state?.stable_since?new Date(state.stable_since).toISOString():null,last_observed_at:state?.last_observed_at?new Date(state.last_observed_at).toISOString():null,mature_samples:stats.samples,delivered:stats.delivered,confirmed_block:state?.confirmed_block===true,now});
 return {episode,progress:{...progress,next_execution_at:nextExecution?new Date(nextExecution).toISOString():null,completed:!!episode.completed_at||progress.completed,environment,temporal_source:environment==='REAL'?'observed':'simulation'},declarations:episode.policy_version===STANDARD_V1_POLICY?declarations:[],credits:Number(credits),state:state??null,policy_version:episode.policy_version};
}
export async function manualReady(c:QueryExecutor,accountId:string,now:Date){
 const episode=(await c.query('SELECT * FROM warmup_episodes WHERE account_id=$1 AND closed_at IS NULL',[accountId])).rows[0];if(!episode)return{ready:false,reason:'OPEN_EPISODE_REQUIRED',nominal_day:0};
 const declarations=(await c.query('SELECT *,local_date::text FROM warmup_manual_declarations WHERE episode_id=$1 ORDER BY recorded_at,id',[episode.id])).rows.map(d=>({...d,recorded_at:new Date(d.recorded_at).toISOString()}));
 return{...manualPreparation({started_at:new Date(episode.started_at).toISOString(),timezone:episode.timezone,declarations,now}),nominal_day:1+calendarDistance(localDate(new Date(episode.started_at),episode.timezone),localDate(now,episode.timezone))};
}
/** Historical v1 retains declarations; v2 and legacy policies never fabricate them. */
export async function preparationGate(c:QueryExecutor,accountId:string,now:Date){
 const episode=(await c.query('SELECT * FROM warmup_episodes WHERE account_id=$1 AND closed_at IS NULL',[accountId])).rows[0];
 if(!episode)return{ready:false,reason:'OPEN_EPISODE_REQUIRED',policy_version:null,nominal_day:0};
 const nominal_day=1+calendarDistance(localDate(new Date(episode.started_at),episode.timezone),localDate(now,episode.timezone));
 if(episode.policy_version!==STANDARD_V1_POLICY)return{ready:true,reason:null,policy_version:episode.policy_version,nominal_day};
 const manual=await manualReady(c,accountId,now);return{...manual,reason:manual.reason,policy_version:episode.policy_version,nominal_day};
}
