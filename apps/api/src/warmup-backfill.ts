import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {hash,stableJson,type QueryExecutor} from '../../../packages/db/src/index.js';
import {warmupIdentityMatches} from '../../../packages/db/src/warmup.js';
import {STANDARD_V2_POLICY,warmupProfileSchema,localWindow} from '../../../packages/domain/src/warmup/policy.js';
import type {Body,DomainRecord} from '../../../packages/contracts/src/index.js';
import {principal,envOf,scopedRecord,parseBody,mutate,fail,audit} from './context.js';
const day=86400000,hour=3600000;
const at=(value:unknown)=>value instanceof Date?value.getTime():new Date(String(value??'')).getTime();

/** Evidence is bounded at membership creation, so a new curve cannot manufacture its own backfill. */
export async function assessWarmupBackfill(c:QueryExecutor,account:DomainRecord,state:Body,identity:Body|undefined,now:Date){
 const reasons:string[]=[];
 const reject=(code:string)=>{if(!reasons.includes(code))reasons.push(code);};
 if(account.body.provider!==(account.environment==='REAL'?'waha':'simulator'))reject('BACKFILL_PROVIDER_NOT_APPLICABLE');
 if(account.body.deleted_at||account.body.status!=='WORKING'||account.body.identity_verified!==true||account.body.identity_conflict)reject('BACKFILL_CURRENT_IDENTITY_UNVERIFIED');
 if(!identity||!warmupIdentityMatches(account,identity))reject('BACKFILL_REGISTERED_IDENTITY_MISMATCH');
 if(state.enrolled_at||state.warmup_started_at||state.effective_days>0||state.graduated_at)reject('BACKFILL_CURVE_ALREADY_STARTED');
 if(state.paused||state.confirmed_block||['PAUSED','QUARANTINED'].includes(state.status))reject('BACKFILL_ACCOUNT_REVIEW_REQUIRED');
 if((await c.query('SELECT 1 FROM warmup_plans WHERE account_id=$1 LIMIT 1',[account.id])).rowCount)reject('BACKFILL_CURVE_ALREADY_STARTED');
 const profileRow=(await c.query('SELECT config FROM warmup_profiles WHERE id=$1 AND workspace_id=$2 AND environment=$3',[state.profile_id,account.workspace_id,account.environment])).rows[0];
 const profile=warmupProfileSchema.parse(profileRow?.config),requiredDays=profile.mode==='standard'?30:profile.inbound_light_days;
 if(profile.policy_version===STANDARD_V2_POLICY)reject('BACKFILL_POLICY_NOT_APPLICABLE');
 const cutoff=new Date(Math.min(at(state.created_at),now.getTime())),since=new Date(cutoff.getTime()-90*day),matureBefore=new Date(cutoff.getTime()-profile.ack_maturity_minutes*60000);
 const effects=(await c.query(`SELECT o.id,o.status,o.created_at,ack.id ack_id,ack.recorded_at ack_at,ack.envelope_id,
  EXISTS(SELECT 1 FROM effect_attempts t WHERE t.effect_id=o.id AND t.status='SENT' AND t.result->>'provider_message_id'=o.provider_message_id AND t.finished_at<=$7) accepted_attempt
  FROM outbox o LEFT JOIN LATERAL (
   SELECT e.id,e.recorded_at,e.payload->>'envelope_id' envelope_id FROM domain_events e JOIN inbound_envelopes i ON i.id::text=e.payload->>'envelope_id'
   WHERE e.workspace_id=o.workspace_id AND e.environment=o.environment AND e.aggregate_id=o.account_id AND e.event_type='provider.ack.observed'
    AND e.actor->>'type'='provider' AND e.actor->>'id'=$6 AND e.payload->>'provider_message_id'=o.provider_message_id AND e.payload->>'status' IN('DELIVERED','READ','PLAYED')
    AND e.recorded_at>=o.created_at AND e.recorded_at<=$7 AND i.workspace_id=o.workspace_id AND i.environment=o.environment AND i.account_id=o.account_id AND i.provider=$6 AND i.status='PROCESSED' AND i.received_at<=$5 AND i.processed_at<=$5
   ORDER BY e.recorded_at LIMIT 1
  ) ack ON true WHERE o.workspace_id=$1 AND o.environment=$2 AND o.account_id=$3 AND o.kind<>'warmup' AND o.attempts>0 AND o.created_at>=$4 AND EXISTS(SELECT 1 FROM effect_attempts t WHERE t.effect_id=o.id AND t.status<>'NOT_SENT' AND t.started_at<=$7) ORDER BY o.created_at,o.id`,[account.workspace_id,account.environment,account.id,since,cutoff,account.body.provider,matureBefore])).rows;
 const delivered=effects.filter(e=>['DELIVERED','READ'].includes(e.status)&&e.ack_id&&e.accepted_attempt);
 const activityDays=new Set(delivered.map(e=>localWindow(profile,new Date(e.ack_at)).date));
 const first=delivered.length?new Date(Math.min(...delivered.map(e=>at(e.ack_at)))):null;
 if(activityDays.size<requiredDays||effects.length<profile.min_ack_samples||delivered.length/effects.length<0.98)reject('BACKFILL_ACTIVITY_NOT_DEMONSTRATED');
 if(first){
  const history=(await c.query(`SELECT version,body,created_at FROM record_versions WHERE record_id=$1 AND workspace_id=$2 AND environment=$3 AND (created_at>=$4 OR version=(SELECT version FROM record_versions WHERE record_id=$1 AND created_at<=$4 ORDER BY created_at DESC,version DESC LIMIT 1)) ORDER BY created_at,version`,[account.id,account.workspace_id,account.environment,first])).rows;
  const anchor=history.filter(v=>at(v.created_at)<=first.getTime()).at(-1);
  if(!anchor||!identity||history.some(v=>!warmupIdentityMatches({...account,body:v.body},identity)))reject('BACKFILL_IDENTITY_HISTORY_INSUFFICIENT');
 }
 const signals=(await c.query("SELECT id,body,created_at FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='health_signal' AND body->>'account_id'=$3 AND ((created_at>=$4 AND created_at<=$5) OR created_at>=$6) ORDER BY created_at,id",[account.workspace_id,account.environment,account.id,new Date(cutoff.getTime()-7*day-hour),cutoff,new Date(now.getTime()-7*day-hour)])).rows;
 const trusted=(s:Body)=>['provider_read','provider_event'].includes(s.body.source)&&Number.isFinite(at(s.body.observed_at))&&Math.abs(at(s.created_at)-at(s.body.observed_at))<5*60000;
 const matching=(s:Body)=>s.body.dimension!=='transport'||!!identity&&warmupIdentityMatches({...account,body:{...account.body,identity_fingerprint:s.body.value?.identity_fingerprint}},identity);
 const current=signals.filter(s=>trusted(s)&&at(s.body.observed_at)<=now.getTime()+60000&&at(s.body.expires_at)>now.getTime());
 if(!['session','transport'].every(d=>current.some(s=>s.body.dimension===d&&s.body.status==='OK'&&matching(s)))||current.some(s=>s.body.status==='BLOCKED'||['session','transport'].includes(s.body.dimension)&&(s.body.status==='UNKNOWN'||!matching(s))))reject('BACKFILL_CURRENT_HEALTH_UNAVAILABLE');
 const historical=signals.filter(s=>at(s.created_at)<=cutoff.getTime()&&trusted(s));
 const continuous=(observed:Body[],start:number,end:number)=>{
  const window=observed.filter(s=>at(s.body.observed_at)>=start-hour&&at(s.body.observed_at)<=end);
  if(window.some(s=>at(s.body.observed_at)>=start&&(s.body.status==='BLOCKED'||['session','transport'].includes(s.body.dimension)&&(s.body.status!=='OK'||!matching(s)))))return false;
  return ['session','transport'].every(dimension=>{
   const observations=window.filter(s=>s.body.dimension===dimension&&s.body.status==='OK'&&matching(s)).map(s=>at(s.body.observed_at)).sort((a,b)=>a-b);
   const anchor=observations.filter(t=>t<=start).at(-1);
   const times=anchor===undefined?[]:[anchor,...observations.filter(t=>t>start),end];
   return times.length>0&&!times.some((t,i)=>i>0&&t-times[i-1]!>=hour);
  });
 };
 if(!continuous(historical,cutoff.getTime()-7*day,cutoff.getTime())||!continuous(signals.filter(trusted),now.getTime()-7*day,now.getTime()))reject('BACKFILL_STABILITY_NOT_DEMONSTRATED');
 if((await c.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('SENDING','UNKNOWN') LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount)reject('BACKFILL_UNCERTAIN_EFFECTS');
 if((await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='health_signal' AND body->>'account_id'=$3 AND body->>'dimension'='restriction' AND body->>'status'='BLOCKED' AND created_at>=$4 LIMIT 1",[account.workspace_id,account.environment,account.id,first??since])).rowCount)reject('BACKFILL_RESTRICTION_HISTORY');
 const summary={required_activity_days:requiredDays,observed_activity_days:activityDays.size,mature_samples:effects.length,verified_deliveries:delivered.length,delivery_ratio:effects.length?delivered.length/effects.length:null,first_verified_activity_at:first?.toISOString()??null,evidence_cutoff:cutoff.toISOString(),historical_health_samples:historical.length};
 const evidenceHash=hash(stableJson({account_id:account.id,account_version:account.version,state_version:state.version,profile_id:state.profile_id,identity_id:identity?.id,summary,effects:effects.map(e=>({id:e.id,status:e.status,ack_id:e.ack_id,envelope_id:e.envelope_id})),health_ids:historical.map(s=>s.id)}));
 return{eligible:reasons.length===0,reasons,evidence_hash:evidenceHash,summary};
}

export async function warmupBackfillRoutes(app:FastifyInstance){
 app.post('/v1/warmup/accounts/:id/backfill',async(req:FastifyRequest)=>{
  const p=principal(req);if(p.service||p.role!=='owner')throw fail(403,'OWNER_REQUIRED');
  const id=z.string().uuid().parse((req.params as Body).id),input=z.object({dry_run:z.boolean().default(true),expected_version:z.number().int().positive(),expected_account_version:z.number().int().positive(),evidence_hash:z.string().regex(/^[a-f0-9]{64}$/).optional(),reason:z.string().trim().min(8).max(500)}).strict().parse(parseBody(req));
  const result=await mutate(req,'warmup.backfill:'+id,async c=>{
   await scopedRecord(req,'channel_account',id,c);
   const ref=(await c.query('SELECT pool_id FROM warmup_states WHERE account_id=$1 AND workspace_id=$2 AND environment=$3',[id,p.workspace_id,envOf(req)])).rows[0];if(!ref)throw fail(404,'NOT_FOUND');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-pool:${ref.pool_id}`]);
   const state=(await c.query('SELECT * FROM warmup_states WHERE account_id=$1 FOR UPDATE',[id])).rows[0];
   await c.query('SELECT id FROM records WHERE id=$1 FOR UPDATE',[id]);const account=await scopedRecord(req,'channel_account',id,c);
   if(state.version!==input.expected_version||account.version!==input.expected_account_version)throw fail(409,'VERSION_CONFLICT');
   const identity=(await c.query('SELECT * FROM warmup_identities WHERE id=$1 AND account_id=$2 FOR SHARE',[state.identity_id,id])).rows[0];
   const assessment=await assessWarmupBackfill(c,account,state,identity,new Date());
   if(input.dry_run)return{data:{account_id:id,dry_run:true,expected_version:state.version,expected_account_version:account.version,...assessment,commercial_permissions_changed:false,external_effects:0}};
   if(!assessment.eligible)throw fail(409,'BACKFILL_EVIDENCE_INSUFFICIENT','No se ha demostrado una historia operativa apta para backfill.',assessment.reasons);
   if(!input.evidence_hash||input.evidence_hash!==assessment.evidence_hash)throw fail(409,'BACKFILL_EVIDENCE_CHANGED');
   const updated=(await c.query("UPDATE warmup_states SET status='GRADUATED',reason='BACKFILL',enrolled_at=$2,warmup_started_at=NULL,graduated_at=now(),version=version+1,updated_at=now() WHERE account_id=$1 RETURNING account_id,status,reason,version,effective_days,enrolled_at,warmup_started_at,graduated_at",[id,assessment.summary.first_verified_activity_at])).rows[0];
   await audit(c,req,'warmup.backfilled',id,{evidence_hash:assessment.evidence_hash,evidence_summary:assessment.summary,reason:input.reason,commercial_permissions_changed:false,external_effects:0});
   return{data:{...updated,evidence_hash:assessment.evidence_hash,commercial_permissions_changed:false,external_effects:0}};
  });return{data:result.data};
 });
}
