import {channelProgress} from '../../../packages/domain/src/operations/service-progress.js';
import {collectSessionAlerts} from './session-alerts.js';
import {pool,withTransaction,appendEvent,readIntegrationSettings,readOperationalSettings,putRecord,type QueryExecutor} from '@commerce/db';
import {statfs} from 'node:fs/promises';
import {publicEndpointFetch} from '../../../packages/fulfillment/src/public-fetch.js';
import type {Environment} from '@commerce/contracts';
import {warmupProfileSchema,localWindow} from '../../../packages/domain/src/warmup/policy.js';

/** V7.5 §6 (H11): one open episode per profile, environment, cause and
 * resource. A repeated observation updates the open row (last observation and
 * count) without touching its acknowledgement or creating another notice; the
 * cleared condition resolves it; a later recurrence opens a new row. A rise
 * from WARNING to CRITICAL is a new notice for the person (acknowledgement
 * cleared). `resolution` documents why a cleared episode closed. */
export async function episodeAlert(c:QueryExecutor,input:{workspace:string;environment:Environment;kind:string;severity:'WARNING'|'CRITICAL';active:boolean;now:Date;accountId?:string|null;episode?:string;evidence?:Record<string,unknown>;resolution?:string}){
 const {workspace,environment,kind,severity,active,now}=input,account=input.accountId??null;
 if(!active){
  await c.query(`UPDATE operational_alerts SET resolved_at=$5,updated_at=now(),evidence=evidence||jsonb_build_object('resolution',$6::text)
   WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND account_id IS NOT DISTINCT FROM $4::uuid AND resolved_at IS NULL AND superseded_by IS NULL`,[workspace,environment,kind,account,now,input.resolution??'CONDITION_CLEARED']);
  return null;
 }
 const updated=(await c.query(`UPDATE operational_alerts SET last_observed_at=GREATEST(last_observed_at,$5),observations=observations+1,updated_at=now(),
   severity=CASE WHEN $6='CRITICAL' THEN 'CRITICAL' ELSE severity END,
   acknowledged_at=CASE WHEN $6='CRITICAL' AND severity='WARNING' THEN NULL ELSE acknowledged_at END,
   acknowledged_by=CASE WHEN $6='CRITICAL' AND severity='WARNING' THEN NULL ELSE acknowledged_by END
  WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND account_id IS NOT DISTINCT FROM $4::uuid AND resolved_at IS NULL AND superseded_by IS NULL RETURNING id`,[workspace,environment,kind,account,now,severity])).rows[0];
 if(updated)return updated.id as string;
 const inserted=(await c.query(`INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code,account_id,episode,evidence,first_observed_at,last_observed_at)
  VALUES($1,$2,$3,$4,$5,$4,$6,$7,$8,$9,$9) ON CONFLICT DO NOTHING RETURNING id`,[workspace,environment,`${kind}:${account??'profile'}:${now.toISOString()}`,kind,severity,account,input.episode??`observation:${now.toISOString()}`,{...input.evidence,recipient_receipt:'NOT_OBSERVED'},now])).rows[0];
 return inserted?.id as string|undefined??null;
}
async function accountAlert(c:QueryExecutor,workspace:string,environment:Environment,accountId:string,kind:string,active:boolean,now:Date,evidence:Record<string,unknown>={}){
 await episodeAlert(c,{workspace,environment,kind,severity:kind==='EFFECT_UNKNOWN'||kind==='RELEASE_RECOVERY_PENDING'?'CRITICAL':'WARNING',active,now,accountId,evidence});
}
async function workspaceAlert(c:QueryExecutor,workspace:string,kind:string,active:boolean,episode:string,now:Date){
 await episodeAlert(c,{workspace,environment:'REAL',kind,severity:['RELEASE_HOLD_OVERDUE','CHANNEL_WORKER_UNAVAILABLE'].includes(kind)?'CRITICAL':'WARNING',active,now,episode});
}
/** R01: early disk warning with hysteresis, before the critical floor. */
export const diskThresholds=Object.freeze({warnFreeRatio:0.2,warnFreeBytes:25*1024**3,clearFreeRatio:0.22,clearFreeBytes:27*1024**3,criticalFreeRatio:0.05,criticalFreeBytes:1024**3});
export function diskCondition(disk:{available_bytes:number;total_bytes:number}|null,warningOpen:boolean){
 if(!disk||!(disk.total_bytes>0))return{critical:false,warning:warningOpen};
 const ratio=disk.available_bytes/disk.total_bytes;
 const critical=disk.available_bytes<Math.max(diskThresholds.criticalFreeBytes,disk.total_bytes*diskThresholds.criticalFreeRatio);
 const warning=warningOpen?ratio<diskThresholds.clearFreeRatio||disk.available_bytes<diskThresholds.clearFreeBytes:ratio<diskThresholds.warnFreeRatio||disk.available_bytes<diskThresholds.warnFreeBytes;
 return{critical,warning:warning||critical};
}
/** §6: backup currency from the producer the installation runs (PITR runs,
 * same limits as /healthz/platform) or a verified, unexpired external record. */
export function backupCurrent(input:{evidence?:{status:string;expires_at:Date|string}|null;runs?:{last_success_at:string|null;last_full_at:string|null;last_failure_at:string|null}|null;now:Date}){
 const {evidence,runs,now}=input;
 if(evidence&&evidence.status==='VERIFIED'&&new Date(evidence.expires_at)>now)return{current:true,source:'VERIFIED_EXTERNAL_EVIDENCE'};
 if(!runs?.last_success_at)return{current:false,source:'NO_VERIFIED_BACKUP_OBSERVED'};
 const age=(at:string|null)=>at?now.getTime()-Date.parse(at):Infinity;
 if(runs.last_failure_at&&Date.parse(runs.last_failure_at)>Date.parse(runs.last_success_at))return{current:false,source:'LAST_BACKUP_RUN_FAILED'};
 if(age(runs.last_success_at)>36*3600_000)return{current:false,source:'BACKUP_STALE'};
 if(age(runs.last_full_at)>8*86400_000)return{current:false,source:'FULL_BACKUP_STALE'};
 return{current:true,source:'PITR_RUNS'};
}
/** Durable incident dedupe; presence of an incident never claims notification receipt. */
export async function collectOperationalAlerts(){
 await collectSessionAlerts();
 const storage=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;
 const disk=storage?await statfs(storage).then(s=>({available_bytes:Number(s.bavail)*Number(s.bsize),total_bytes:Number(s.blocks)*Number(s.bsize)})).catch(()=>null):null;
 const scopes=(await pool.query("SELECT DISTINCT workspace_id,environment FROM records WHERE kind='channel_account'")).rows;
 // Platform-wide, content-free; an unreadable producer keeps the alert open.
 const backupRuns=await pool.query('SELECT public.platform_backup_currency() AS s').then(r=>r.rows[0]?.s??null).catch(()=>null);
 for(const {workspace_id:workspace,environment}of scopes)await withTransaction(async c=>{
  const now=(await c.query('SELECT now() now')).rows[0].now as Date;
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`operations-monitor:${workspace}:${environment}`]);
  if(environment==='REAL'){
   const policy=await readOperationalSettings(c,workspace,'REAL');
   const heartbeat=(await c.query("SELECT body FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='service_heartbeat' AND body->>'service'='channel-worker' ORDER BY updated_at DESC LIMIT 1",[workspace])).rows[0];
   const active=Boolean((await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='channel_account' AND NOT body?'deleted_at' LIMIT 1",[workspace])).rowCount);
   await workspaceAlert(c,workspace,'CHANNEL_WORKER_UNAVAILABLE',active&&!channelProgress(heartbeat?.body,now).ready,now.toISOString(),now);
   await workspaceAlert(c,workspace,'RELEASE_HOLD_OVERDUE',!!policy.release_hold&&!!policy.release_hold_at&&now.getTime()-new Date(policy.release_hold_at).getTime()>5*60_000,policy.release_hold_at?.toISOString()??'unknown',now);
   await workspaceAlert(c,workspace,'REAL_POLICY_FROZEN',!policy.release_hold&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations),String(policy.version),now);
   // RF-13.d (CHAOS-PROVIDER): the profile's AI is failing (provider error, its
   // balance or the monthly budget). The owner sees it; the next successful answer
   // resolves it with no reauthorization. Chats already with a person stay there.
   const lastAi=(await c.query("SELECT body->>'status' status,body->>'reason' reason,updated_at FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='ai_run' AND body->>'status' IN('COMPLETED','AWAITING_EFFECT','FAILED') ORDER BY updated_at DESC LIMIT 1",[workspace])).rows[0];
   await workspaceAlert(c,workspace,'AI_UNAVAILABLE',lastAi?.status==='FAILED'&&lastAi.reason!=='AI_AUTHORITY',lastAi?new Date(lastAi.updated_at).toISOString():'none',now);
   const rows=(await c.query(`SELECT r.id::text account_id,o.release_frozen,o.updated_at ownership_updated_at,
    (SELECT min(auth.expires_at) FROM commercial_assignments a JOIN operation_authorizations auth ON auth.id=a.authorization_id WHERE a.account_id=r.id AND a.state='ACTIVE' AND auth.revoked_at IS NULL AND auth.configuration_version=$2) authorization_expires_at,
    (SELECT count(*)::int FROM outbox e WHERE e.workspace_id=$1 AND e.environment='REAL' AND e.account_id=r.id::text AND e.status='UNKNOWN') unknown,
    (SELECT count(*)::int FROM outbox e WHERE e.workspace_id=$1 AND e.environment='REAL' AND e.account_id=r.id::text AND e.status='BLOCKED' AND e.created_at<now()-interval '30 minutes') blocked
    FROM records r LEFT JOIN session_ownership o ON o.account_id=r.id::text WHERE r.workspace_id=$1 AND r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at')`,[workspace,policy.version])).rows;
   for(const row of rows){
    const expires=row.authorization_expires_at?new Date(row.authorization_expires_at).getTime():null;
    await accountAlert(c,workspace,'REAL',row.account_id,'RELEASE_RECOVERY_PENDING',!!row.release_frozen&&!policy.release_hold&&!!policy.release_hold_at&&now.getTime()-new Date(policy.release_hold_at).getTime()>5*60_000,now);
    await accountAlert(c,workspace,'REAL',row.account_id,'AUTHORIZATION_EXPIRING',expires!==null&&expires>now.getTime()&&expires-now.getTime()<24*3600_000,now,{expires_at:row.authorization_expires_at});
    await accountAlert(c,workspace,'REAL',row.account_id,'AUTHORIZATION_EXPIRED',expires!==null&&expires<=now.getTime(),now,{expired_at:row.authorization_expires_at});
    await accountAlert(c,workspace,'REAL',row.account_id,'EFFECT_UNKNOWN',Number(row.unknown)>0,now,{count:Number(row.unknown)});
    await accountAlert(c,workspace,'REAL',row.account_id,'BLOCKED_EFFECTS',Number(row.blocked)>0,now,{count:Number(row.blocked)});
   }
  }
  const prior=(await c.query("SELECT id,version FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='operational_metric' AND body->>'key'='private_storage_disk' ORDER BY updated_at DESC LIMIT 1",[workspace,environment])).rows[0];
  await putRecord(c,{id:prior?.id,version:prior?.version,workspaceId:workspace,environment,kind:'operational_metric',body:{key:'private_storage_disk',status:disk?'OBSERVED':'UNAVAILABLE',source:'MOUNTED_PRIVATE_STORAGE_STATFS',observed_at:now.toISOString(),expires_at:new Date(now.getTime()+180000).toISOString(),...(disk??{})}});
  const global=(kind:string,severity:'WARNING'|'CRITICAL',active:boolean,evidence:Record<string,unknown>={},resolution?:string)=>episodeAlert(c,{workspace,environment,kind,severity,active,now,evidence,resolution});
  const warningOpen=!!(await c.query("SELECT 1 FROM operational_alerts WHERE workspace_id=$1 AND environment=$2 AND kind='PRIVATE_STORAGE_DISK_WARNING' AND account_id IS NULL AND resolved_at IS NULL AND superseded_by IS NULL",[workspace,environment])).rowCount;
  const diskState=diskCondition(disk,warningOpen),diskEvidence=disk?{available_bytes:disk.available_bytes,total_bytes:disk.total_bytes}:{};
  if(disk){await global('PRIVATE_STORAGE_DISK_LOW','CRITICAL',diskState.critical,diskEvidence);await global('PRIVATE_STORAGE_DISK_WARNING','WARNING',diskState.warning,diskEvidence);}
  const old=(await c.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment=$2 AND status IN('READY','BLOCKED','UNKNOWN') AND not_before<now()-interval '30 minutes'",[workspace,environment])).rows[0].n;
  await global('QUEUE_OLDER_THAN_30_MINUTES','CRITICAL',old>0,{count:old});
  const pools=(await c.query(`SELECT p.id,p.breaker_open,p.continuity_mode,p.paused,p.archived_at,
   (SELECT count(*)::int FROM warmup_states s WHERE s.pool_id=p.id) AS members FROM warmup_pools p WHERE p.workspace_id=$1 AND p.environment=$2 AND p.enabled`,[workspace,environment])).rows;
  await global('WARMUP_BREAKER_OPEN','CRITICAL',pools.some(p=>p.breaker_open),{pools:pools.filter(p=>p.breaker_open).length},'PROTECTION_RECOVERED_OR_POOL_DISABLED');
  // V7.5 §6 (H11): schedule windows are produced only by the LEGACY
  // coordinator. QR pools run inside the worker profile pass and never write
  // them; empty, paused or archived pools have no scheduled activity.
  const overdue:Record<string,boolean>={health:false,reconcile:false,daily:false};
  for(const p of pools.filter(p=>p.continuity_mode==='LEGACY'&&!p.paused&&!p.archived_at&&p.members>0)){
   for(const [kind,minutes]of [['health',30],['reconcile',120],['daily',1500]]as const){const fresh=(await c.query("SELECT 1 FROM warmup_schedule_runs WHERE pool_id=$1 AND kind=$2 AND status='COMPLETED' AND finished_at>now()-($3*interval '1 minute')",[p.id,kind,minutes])).rowCount;if(!fresh)overdue[kind]=true;}
  }
  for(const kind of ['health','reconcile','daily'])await global('WARMUP_'+kind.toUpperCase()+'_OVERDUE','CRITICAL',overdue[kind]!,{},'NO_ACTIVE_LEGACY_SCHEDULE_OVERDUE');
  await global('CONFIRMED_ACCOUNT_RESTRICTION','CRITICAL',!!(await c.query('SELECT 1 FROM warmup_states WHERE workspace_id=$1 AND environment=$2 AND confirmed_block',[workspace,environment])).rowCount);
  const failed=(await c.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND body->>'status'='FAILED' AND NOT(body?'deleted_at')",[workspace,environment])).rows[0].n;
  await global('CHANNEL_PROVIDER_UNAVAILABLE','WARNING',failed>0,{count:failed});
  const plans=(await c.query(`SELECT p.planned_messages,p.local_date::text local_date,v.config,(SELECT count(*)::int FROM warmup_turns t JOIN warmup_conversations cv ON cv.id=t.conversation_id JOIN outbox o ON o.id=t.effect_id WHERE (t.sender_id=p.account_id OR t.recipient_id=p.account_id) AND cv.local_date=p.local_date AND o.status IN('DELIVERED','READ')) delivered FROM warmup_plans p JOIN warmup_profiles v ON v.id=p.profile_id WHERE p.workspace_id=$1 AND p.environment=$2 AND p.local_date>=CURRENT_DATE-3`,[workspace,environment])).rows;
  const daily={planned:0,delivered:0};for(const plan of plans){const today=localWindow(warmupProfileSchema.parse(plan.config),now).date,yesterday=new Date(Date.parse(today+'T00:00:00Z')-86400000).toISOString().slice(0,10);if(plan.local_date===yesterday){daily.planned+=plan.planned_messages;daily.delivered+=plan.delivered;}}
  await global('WARMUP_PLAN_DEVIATION','WARNING',daily.planned>0&&Math.abs(daily.planned-daily.delivered)/daily.planned>0.3,daily);
  const evidence=(await c.query("SELECT status,expires_at FROM operational_evidence WHERE workspace_id=$1 AND environment=$2 AND kind='backup_external' ORDER BY observed_at DESC LIMIT 1",[workspace,environment])).rows[0];
  const backup=backupCurrent({evidence,runs:backupRuns,now});
  await global('EXTERNAL_BACKUP_NOT_CURRENT','CRITICAL',!backup.current,{source:backup.source},'VERIFIED_BACKUP_CURRENT');
 });return scopes.length;
}

export async function deliverOperationalAlerts(fetcher:typeof fetch=publicEndpointFetch){
 await pool.query("UPDATE operational_alerts SET status='UNKNOWN',updated_at=now() WHERE status='SENDING' AND updated_at<now()-interval '2 minutes'");
 const candidates=(await pool.query("SELECT a.id FROM operational_alerts a JOIN integration_settings i ON i.workspace_id=a.workspace_id AND i.environment=a.environment AND i.key='alerts:default' AND i.enabled AND i.secret_fields->>'token'='true' AND COALESCE(i.config->>'endpoint','')<>'' WHERE a.status='PENDING' AND a.resolved_at IS NULL AND a.environment='REAL' ORDER BY a.created_at LIMIT 10")).rows;
 for(const candidate of candidates){const claim=await withTransaction(async c=>{
  const row=(await c.query("SELECT * FROM operational_alerts WHERE id=$1 AND status='PENDING' FOR UPDATE SKIP LOCKED",[candidate.id])).rows[0];if(!row)return;
  const config=await readIntegrationSettings(c,row.workspace_id,row.environment,'alerts:default');if(!config?.enabled||!config.secrets.token||!config.config.endpoint)return;
  await c.query("UPDATE operational_alerts SET status='SENDING',updated_at=now() WHERE id=$1",[row.id]);return{row,config};
 });if(!claim)continue;
 let status='UNKNOWN';
 try{const response=await fetcher(String(claim.config.config.endpoint),{method:'POST',redirect:'error',headers:{authorization:'Bearer '+claim.config.secrets.token,'content-type':'application/json','idempotency-key':claim.row.id},body:JSON.stringify({id:claim.row.id,workspace_id:claim.row.workspace_id,severity:claim.row.severity,code:claim.row.summary_code,account_id:claim.row.account_id??null,episode:claim.row.episode??null,evidence:claim.row.evidence??{},observed_at:claim.row.created_at}),signal:AbortSignal.timeout(10000)});status=response.ok?'ACCEPTED':response.status>=400&&response.status<500&&!([408,429].includes(response.status))?'FAILED':'UNKNOWN';await response.body?.cancel();}catch{/* Uncertain remote acceptance is never retried automatically. */}
 await withTransaction(async c=>{await c.query('UPDATE operational_alerts SET status=$2,updated_at=now() WHERE id=$1',[claim.row.id,status]);await appendEvent(c,{workspace_id:claim.row.workspace_id,environment:claim.row.environment,event_type:'operations.alert.'+status.toLowerCase(),aggregate_id:claim.row.id,payload:{code:claim.row.summary_code,recipient_receipt:'NOT_OBSERVED'}});});
 }return candidates.length;
}
