import {sessionRecoveryBlocker} from './session-supervisor.js';
import {observeChannelSession,sessionEvent} from '../../../packages/db/src/channel-sessions.js';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {withTransaction,query,pool,getRecord,putRecord,appendEvent,readOperationalSettings,encrypt,type QueryExecutor} from '@commerce/db';
import {readEffectiveHealth,currentEffectiveSignal,currentProviderHealthReady,effectiveHealthBlockers,type EffectiveHealthSelection} from '../../../packages/db/src/effective-health.js';
import type {DomainRecord,Body} from '@commerce/contracts';
import {providerFor,assertGatewayIsolation,accountIntegrationKey,type ProviderFactory} from './providers.js';
import {ownerId} from './dispatch.js';
import {onboardingEnabled,onboardingCode,onboardingFailure} from '../../../packages/messaging/src/onboarding.js';
import {ProviderError} from '../../../packages/messaging/src/types.js';
import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';
type OwnershipFence={owner_id:string;generation:number};
const leaseGenerations=new Map<string,Map<string,number>>();
/** Live V7 continuity of this account (record profile bound to the locked
 * account's own workspace): not revoked, not paused by a human; a commercial
 * grant only while its assignment revision is ACTIVE, a QR grant only for the
 * identity currently expected on the session. */
async function liveContinuityGrant(client:QueryExecutor,account:DomainRecord,identity:string){
 const db=await recordProfileExecutor(client,account.workspace_id,'REAL');
 return!!(await db.query(`SELECT 1 FROM continuous_authorizations c WHERE c.workspace_id=$1 AND c.environment='REAL' AND c.account_id=$2
  AND c.state->'revokedAt'='null'::jsonb AND c.state->'humanPaused'='false'::jsonb
  AND (c.state->'source'->>'kind'='VERIFIED_QR_CONNECTION' AND c.state->'source'->>'identityFingerprint'=$3
   OR c.state->'source'->>'kind'='COMMERCIAL_ASSIGNMENT' AND EXISTS(SELECT 1 FROM commercial_assignments a WHERE a.workspace_id=c.workspace_id
    AND a.environment=c.environment AND a.id=c.assignment_id AND a.account_id=c.account_id AND a.state='ACTIVE' AND a.revision=(c.state->'source'->>'assignmentRevision')::int))
  LIMIT 1`,[account.workspace_id,account.id,identity])).rowCount;
}
async function reconcileHealthyLease(client:QueryExecutor,input:{account:DomainRecord;ownership:Body;observedOwnership?:OwnershipFence;releaseFenced:boolean;health:EffectiveHealthSelection;identityFingerprint?:string;expectedIdentity?:string}){
 const {account,ownership,observedOwnership,releaseFenced,health,identityFingerprint,expectedIdentity}=input;
 const provider=String(account.body.provider),identityMatches=provider!=='waha'||!!identityFingerprint&&!!expectedIdentity&&identityFingerprint===expectedIdentity;
 if(!observedOwnership||!ownership?.live||!ownership.frozen||ownership.owner_id!==observedOwnership.owner_id||ownership.generation!==observedOwnership.generation||!identityMatches||!currentProviderHealthReady(health,provider)||effectiveHealthBlockers(health,['infrastructure']).length)return false;
 if(account.environment==='REAL'&&(await readOperationalSettings(client,account.workspace_id,'REAL')).release_hold)return false;
 const incidents=(await client.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='incident' AND body->>'account_id'=$3 AND body->>'reason'='CHANNEL_HEALTH_BLOCKED' AND body->>'status'='OPEN' FOR UPDATE",[account.workspace_id,account.environment,account.id])).rows;
 // V7 F3 (ADR-V7-03, D-17, RNF-01.d/f): a live permanent continuity grant of
 // this account (an ACTIVE commercial assignment, or the verified QR connection
 // of its current identity), neither revoked nor paused by a human, resumes the
 // ownership after a release, a worker takeover or a reconnection. It never
 // lifts a manual control, an open foreign incident or an uncertain effect,
 // checked below; each effect keeps its own authority at its dispatch gate.
 const continuity=account.environment==='REAL'&&!!expectedIdentity&&identityMatches?await liveContinuityGrant(client,account,expectedIdentity):false;
 const releaseCandidate=releaseFenced&&ownership.release_frozen===true&&account.environment==='REAL'&&(account.body.sending_enabled===true||continuity);
 const continuityCandidate=continuity&&!incidents.length;
 if(!incidents.length&&!releaseCandidate&&!continuityCandidate)return false;
 if(releaseCandidate||continuityCandidate){
  const policy=await readOperationalSettings(client,account.workspace_id,account.environment);
  if(policy.release_hold||policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations)return false;
 }
 if(releaseCandidate&&!continuity){
  const policy=await readOperationalSettings(client,account.workspace_id,account.environment);
  const grant=(await client.query("SELECT 1 FROM operation_authorizations auth WHERE auth.workspace_id=$1 AND auth.environment='REAL' AND auth.configuration_version=$2 AND auth.revoked_at IS NULL AND auth.expires_at>now() AND auth.scope->'account_ids' ? $3 AND ((auth.scope->>'mode'='product_assignment' AND EXISTS(SELECT 1 FROM commercial_assignments a WHERE a.id::text=auth.scope->>'assignment_id' AND a.account_id::text=$3 AND a.authorization_id=auth.id AND a.state='ACTIVE')) OR (auth.scope->>'mode'='channel_setup' AND EXISTS(SELECT 1 FROM records r WHERE r.id::text=$3 AND r.body->>'active_authorization_id'=auth.id::text))) LIMIT 1",[account.workspace_id,policy.version,account.id])).rowCount;
  if(!grant)return false;
 }
 const foreignControl=(await client.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='channel_account' AND scope_id=$2) OR (scope_type='workspace' AND scope_id=$1)) AND (paused OR suppressed OR takeover) LIMIT 1",[account.workspace_id,account.id])).rowCount;
 const foreignIncident=(await client.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='incident' AND body->>'account_id'=$3 AND body->>'status'='OPEN' AND body->>'reason' IS DISTINCT FROM 'CHANNEL_HEALTH_BLOCKED' LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount;
 const uncertainEffect=(await client.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND account_id=$2 AND status IN('SENDING','UNKNOWN') LIMIT 1",[account.workspace_id,account.id])).rowCount;
 const uncertainCommand=(await client.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND resource_id=$2 AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND (status='PENDING' OR (status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at'))) LIMIT 1",[account.workspace_id,account.id])).rowCount;
 if(foreignControl||foreignIncident||uncertainEffect||uncertainCommand)return false;
 const resumed=(await client.query("UPDATE session_ownership SET frozen=false,release_frozen=false,updated_at=now() WHERE account_id=$1 AND workspace_id=$2 AND owner_id=$3 AND generation=$4 AND frozen AND lease_expires_at>now() RETURNING account_id",[account.id,account.workspace_id,observedOwnership.owner_id,observedOwnership.generation])).rowCount;
 if(!resumed)return false;
 const resolvedAt=new Date().toISOString();
 for(const incident of incidents)await putRecord(client,{id:incident.id,workspaceId:incident.workspace_id,environment:incident.environment,kind:incident.kind,version:incident.version,body:{...incident.body,status:'RESOLVED',resolved_at:resolvedAt,resolved_by:'channel-health-readback',resolution_reason:'CURRENT_HEALTH_READBACK_VERIFIED'}});
 await putRecord(client,{workspaceId:account.workspace_id,environment:account.environment,kind:'health_signal',body:{account_id:account.id,dimension:'ownership',status:'OK',value:{owner_id:observedOwnership.owner_id,generation:observedOwnership.generation,frozen:false},source:'local_reconciliation',scope:'account',observed_at:resolvedAt,expires_at:new Date(Date.parse(resolvedAt)+30_000).toISOString()}});
 await appendEvent(client,{workspace_id:account.workspace_id,environment:account.environment,event_type:releaseCandidate?'channel.release_recovered':incidents.length?'channel.health_recovered':'channel.continuity_resumed',aggregate_id:account.id,actor:{type:'channel',id:observedOwnership.owner_id},payload:{authority:continuity?'V7_CONTINUITY':'LEGACY_GRANT',owner_id:observedOwnership.owner_id,generation:observedOwnership.generation,incident_ids:incidents.map(incident=>incident.id),evidence:{session_id:health.by_dimension.session?.id??null,transport_id:health.by_dimension.transport?.id??null,restriction_id:health.by_dimension.restriction?.id??null,quality_id:health.by_dimension.quality?.id??null}}});
 return true;
}
export async function recordHealth(account:DomainRecord,factory:ProviderFactory=providerFor,expectedFence?:OwnershipFence){const observedOwnership=expectedFence??(await query('SELECT owner_id,generation FROM session_ownership WHERE account_id=$1 AND workspace_id=$2',[account.id,account.workspace_id])).rows[0] as OwnershipFence|undefined;let signals:import('@commerce/messaging').HealthSignal[];try{const observe=async()=>{await assertGatewayIsolation(account);return(await factory(account)).health();};signals=account.environment==='REAL'?await withTransaction(async c=>{const policy=await readOperationalSettings(c,account.workspace_id,'REAL',{lock:'share'});if(policy.release_hold)throw new Error('RELEASE_HOLD_ACTIVE');return observe();}):await observe();}catch(error){if(error instanceof Error&&error.message==='RELEASE_HOLD_ACTIVE'){if(expectedFence)throw error;return [];}signals=[{dimension:'session',status:'UNKNOWN',value:'PROVIDER_CONFIGURATION_OR_CONNECTION_UNAVAILABLE',source:'provider_read',scope:'account',availability:'not_authorized',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60_000).toISOString()}];}
 const persisted=await withTransaction(async client=>{if(account.environment==='REAL'&&(await readOperationalSettings(client,account.workspace_id,'REAL',{lock:'share'})).release_hold)return false;await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+account.id]);const ownership=(await client.query('SELECT *,lease_expires_at>now() AS live FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 FOR UPDATE',[account.id,account.workspace_id])).rows[0];if(observedOwnership?(!ownership||ownership.owner_id!==observedOwnership.owner_id||ownership.generation!==observedOwnership.generation):!!ownership){await appendEvent(client,{workspace_id:account.workspace_id,environment:account.environment,event_type:'channel.health_late_result_observed',aggregate_id:account.id,payload:{reason:'OWNERSHIP_GENERATION_CHANGED'}});return;}const prior=(await client.query("SELECT s.provider_observed_at,r.body->>'last_lifecycle_at' AS lifecycle_at FROM channel_sessions s JOIN records r ON r.id=s.account_id WHERE s.account_id=$1",[account.id])).rows[0];const observedAt=signals.find(v=>v.dimension==='session')?.observedAt,observedMs=observedAt?Date.parse(observedAt):NaN,lifecycleMs=prior?.lifecycle_at?Date.parse(prior.lifecycle_at):NaN;if(observedAt&&(!Number.isFinite(observedMs)||observedMs>Date.now()||prior?.provider_observed_at&&observedMs<=new Date(prior.provider_observed_at).getTime()||Number.isFinite(lifecycleMs)&&(observedMs<lifecycleMs||observedMs===lifecycleMs&&!expectedFence)))return;if(ownership)await putRecord(client,{workspaceId:account.workspace_id,environment:account.environment,kind:'health_signal',body:{account_id:account.id,dimension:'ownership',status:ownership.frozen?'PAUSED':new Date(ownership.lease_expires_at)>new Date()?'OK':'UNKNOWN',value:{owner_id:ownership.owner_id,generation:ownership.generation,frozen:ownership.frozen},source:'local_probe',scope:'account',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+30000).toISOString()}});for(const signal of signals)await putRecord(client,{workspaceId:account.workspace_id,environment:account.environment,kind:'health_signal',body:{account_id:account.id,dimension:signal.dimension,status:signal.status,value:signal.value,source:signal.source,scope:signal.scope,availability:signal.availability,observed_at:signal.observedAt,expires_at:signal.expiresAt}});
 const current=await getRecord(client,account.workspace_id,'channel_account',account.id);if(current&&!current.body.deleted_at){await observeChannelSession(client,current,signals);const observedSession=signals.find(s=>s.dimension==='session'),effective=await readEffectiveHealth(client,{workspaceId:account.workspace_id,environment:account.environment,accountId:account.id}),transport=currentEffectiveSignal(effective,'transport'),identity=transport?.status==='OK'&&typeof transport.value==='object'&&transport.value!==null&&'identity_fingerprint' in transport.value?transport.value as {identity_fingerprint:string}:undefined;const expected=(await client.query('SELECT expected_identity_fingerprint FROM channel_sessions WHERE account_id=$1',[account.id])).rows[0]?.expected_identity_fingerprint??current.body.identity_fingerprint;const identityChanged=!!(identity&&expected&&expected!==identity.identity_fingerprint),blockers=effectiveHealthBlockers(effective,['infrastructure','session','transport','restriction','quality']),blocked=identityChanged||blockers.some(reason=>reason.endsWith('_BLOCKED')),providerReady=currentProviderHealthReady(effective,String(current.body.provider))&&!effectiveHealthBlockers(effective,['infrastructure']).length,incomplete=!blocked&&!providerReady,bad=blocked||incomplete;await putRecord(client,{id:current.id,workspaceId:current.workspace_id,environment:current.environment,kind:current.kind,version:current.version,body:{...current.body,health_status:blocked?'BLOCKED':incomplete?'UNKNOWN':'OK',health_checked_at:new Date().toISOString(),...(observedSession?{status:typeof observedSession.value==='string'&&['STOPPED','STARTING','SCAN_QR_CODE','WORKING','FAILED','PASSKEY_REQUIRED','PASSKEY_CONFIRMATION_REQUIRED'].includes(observedSession.value)?observedSession.value:'UNKNOWN'}:{}),...(account.body.provider==='waha'?{identity_verified:!!identity&&!identityChanged,identity_conflict:identityChanged,...(identity&&!identityChanged?{identity_fingerprint:identity.identity_fingerprint}:{})}:{})}});
 if(bad){await client.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE account_id=$1 AND workspace_id=$2',[account.id,account.workspace_id]);const existing=(await client.query(`SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='incident' AND body->>'account_id'=$3 AND body->>'reason'='CHANNEL_HEALTH_BLOCKED' AND body->>'status'='OPEN'`,[account.workspace_id,account.environment,account.id])).rows[0];if(!existing)await putRecord(client,{workspaceId:account.workspace_id,environment:account.environment,kind:'incident',body:{account_id:account.id,status:'OPEN',reason:'CHANNEL_HEALTH_BLOCKED',first_observed_at:new Date().toISOString(),runbook:'channel-disconnected',affected_capabilities:['automated_reply','manual_reply','campaign_send']}});}
 else await reconcileHealthyLease(client,{account:current,ownership,observedOwnership,releaseFenced:!!expectedFence,health:effective,identityFingerprint:identity?.identity_fingerprint,expectedIdentity:expected});
 }
 });return persisted===false?[]:signals;
}
// A new worker may claim an untouched, unlinked pilot. Lease expiry alone never isolates a live business session.
export async function acquireOwnership(account:DomainRecord,owner=ownerId,isolationEvidence?:string,commandId?:string){const result=await withTransaction(async client=>{
 if(account.environment==='REAL'&&(await readOperationalSettings(client,account.workspace_id,'REAL',{lock:'share'})).release_hold)return{acquired:false,reason:'RELEASE_HOLD_ACTIVE'};
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+account.id]);
 await client.query(`INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,$3,1,true,now()+interval '60 seconds') ON CONFLICT(account_id) DO NOTHING`,[account.id,account.workspace_id,owner]);
 const current=(await client.query('SELECT *,lease_expires_at>now() AS live FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 FOR UPDATE',[account.id,account.workspace_id])).rows[0];if(!current)throw new Error('OWNERSHIP_SCOPE_INVALID');
 if(current.owner_id!==owner){
  await client.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE account_id=$1',[account.id]);
  const uncertain=(await client.query(`SELECT (SELECT count(*) FROM outbox WHERE account_id=$1 AND status IN('SENDING','UNKNOWN'))::int AS effects,(SELECT count(*) FROM commands WHERE resource_id=$1 AND workspace_id=$2 AND kind='channel_command' AND id::text<>COALESCE($3,'') AND payload->>'type' IN('connect','disconnect','restart','logout') AND ((status='PENDING' AND result ? 'processing_owner') OR (status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at') AND (result->>'error' IN('CHANNEL_COMMAND_INTERRUPTED_REQUIRES_REVIEW','CHANNEL_OPERATION_FAILED','CHANNEL_TIMEOUT','OWNERSHIP_GENERATION_CHANGED') OR result->>'recovery'='NO_AUTOMATIC_RETRY'))))::int AS lifecycle`,[account.id,account.workspace_id,commandId??null])).rows[0];
  if(uncertain.effects||uncertain.lifecycle||current.live)return{acquired:false,reason:'OLD_OWNER_ISOLATION_AND_RECONCILIATION_REQUIRED'};
  if(!current.frozen)return{acquired:false,reason:'FREEZE_MUST_PRECEDE_TRANSFER'};
  const freshAccount=await getRecord(client,account.workspace_id,'channel_account',account.id);
  const historical=Number((await client.query("SELECT count(*) FROM outbox WHERE account_id=$1 AND environment='REAL'",[account.id])).rows[0].count);
  const cleanPilot=!!freshAccount&&freshAccount.environment==='REAL'&&freshAccount.body.provider==='waha'&&['NEW','STOPPED','DISCONNECTED','SCAN_QR_CODE'].includes(freshAccount.body.status??'NEW')&&!freshAccount.body.identity_fingerprint&&freshAccount.body.identity_verified!==true&&freshAccount.body.sending_enabled!==true&&!historical;
  const proof=await verifyIsolation(client,account,current,isolationEvidence);
  if(!proof&&!cleanPilot)return{acquired:false,reason:'VERIFIED_ISOLATION_PROOF_REQUIRED'};
  if(proof?.receiptId)await client.query('UPDATE ownership_isolation_receipts SET consumed_at=clock_timestamp() WHERE id=$1 AND consumed_at IS NULL',[proof.receiptId]);
  const evidence=proof?.reference??'automatic_unlinked_pilot';
  await client.query(`UPDATE session_ownership SET owner_id=$2,generation=generation+1,frozen=true,isolation_evidence=$3,lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE account_id=$1`,[account.id,owner,evidence]);
  await appendEvent(client,{workspace_id:account.workspace_id,environment:account.environment,event_type:'channel.ownership_transferred',aggregate_id:account.id,actor:{type:'channel',id:owner},payload:{previous_owner_id:current.owner_id,previous_generation:current.generation,generation:current.generation+1,method:proof?'verified_isolation':'automatic_unlinked_pilot',receipt_id:proof?.receiptId??null}});
 }
 const renewed=(await client.query(`UPDATE session_ownership SET lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE account_id=$1 AND owner_id=$2 RETURNING owner_id,generation`,[account.id,owner])).rows[0];return{acquired:true,generation:renewed.generation as number};
 });if(result.acquired){const leases=leaseGenerations.get(owner)??new Map<string,number>();leases.set(account.id,result.generation!);leaseGenerations.set(owner,leases);}return result;}
async function assertFence(client:QueryExecutor,account:DomainRecord,fence:OwnershipFence,lock=true){const row=(await client.query('SELECT 1 FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 AND owner_id=$3 AND generation=$4 AND lease_expires_at>now()'+(lock?' FOR UPDATE':''),[account.id,account.workspace_id,fence.owner_id,fence.generation])).rows[0];if(!row)throw new Error('OWNERSHIP_GENERATION_CHANGED');}
export async function processChannelCommands(limit=10,factory:ProviderFactory=providerFor,owner=ownerId){let count=0;
 const commands=(await query(`SELECT * FROM commands WHERE status='PENDING' AND kind='channel_command' ORDER BY created_at LIMIT $1`,[limit])).rows;
 for(const candidate of commands){const claim=await withTransaction(async c=>{if(candidate.environment==='REAL'&&(await readOperationalSettings(c,candidate.workspace_id,'REAL',{lock:'share'})).release_hold)return;await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+candidate.resource_id]);const busy=(await c.query("SELECT 1 FROM commands WHERE resource_id=$1 AND kind='channel_command' AND status='PENDING' AND result ? 'processing_owner' LIMIT 1",[candidate.resource_id])).rows[0];if(busy)return;const cmd=(await c.query(`SELECT * FROM commands WHERE id=$1 AND status='PENDING' FOR UPDATE SKIP LOCKED`,[candidate.id])).rows[0];if(!cmd||cmd.result?.processing_owner)return;const account=await getRecord(c,cmd.workspace_id,'channel_account',cmd.resource_id);if(!account)throw new Error('ACCOUNT_NOT_FOUND');await c.query(`UPDATE commands SET result=$2,updated_at=now() WHERE id=$1`,[cmd.id,{processing_owner:owner,started_at:new Date().toISOString()}]);return{cmd,account};});if(!claim)continue;
 let result:Body;let error:string|undefined;let fence:OwnershipFence|undefined;let remoteAttempted=false;try{
  const p=claim.cmd.payload;const type=p.type;if(claim.account.body.deleted_at)throw new Error('CHANNEL_ACCOUNT_DELETED');
  if(type==='resolve_effect'){const effect=(await query('SELECT * FROM outbox WHERE id=$1 AND workspace_id=$2 AND account_id=$3',[p.effect_id,claim.account.workspace_id,claim.account.id])).rows[0];if(!effect||effect.status!=='UNKNOWN')throw new Error('UNKNOWN_EFFECT_REQUIRED');if(!p.evidence||!['confirm_sent','confirm_not_sent','keep_unknown'].includes(p.outcome))throw new Error('RECONCILIATION_EVIDENCE_REQUIRED');const status=p.outcome==='confirm_sent'?'SENT':p.outcome==='confirm_not_sent'?'CANCELLED':'UNKNOWN';await withTransaction(async c=>{await c.query("UPDATE outbox SET status=$2,provider_message_id=COALESCE($3,provider_message_id),result=result||$4::jsonb,updated_at=now() WHERE id=$1 AND status='UNKNOWN'",[effect.id,status,p.provider_message_id??null,JSON.stringify({resolution:{actor_id:claim.cmd.actor_id,evidence:p.evidence,outcome:p.outcome,command_id:claim.cmd.id}})]);await appendEvent(c,{workspace_id:effect.workspace_id,environment:effect.environment,event_type:'effect.reconciled',aggregate_id:effect.conversation_id,causation_id:claim.cmd.id,actor:{type:'human',id:claim.cmd.actor_id},payload:{effect_id:effect.id,status,evidence:p.evidence}});});result={effect_id:effect.id,status};}
  else if(type==='resolve_incident'){const incident=await getRecord(pool,claim.account.workspace_id,'incident',p.incident_id);if(!incident||incident.body.account_id!==claim.account.id)throw new Error('INCIDENT_NOT_FOUND');await putRecord(pool,{id:incident.id,workspaceId:incident.workspace_id,environment:incident.environment,kind:incident.kind,version:incident.version,body:{...incident.body,status:'RESOLVED',resolved_at:new Date().toISOString(),resolved_by:claim.cmd.actor_id,resolution_reason:p.reason}});result={incident_id:incident.id,status:'RESOLVED'};}
  else if(type==='transfer_ownership'){const target=String(p.owner_id??owner);const acquired=await acquireOwnership(claim.account,target,p.isolation_evidence,claim.cmd.id);if(!acquired.acquired)throw new Error(acquired.reason);result={status:'TRANSFERRED_FROZEN',owner_id:target};}
  else if(type==='freeze'){await query(`UPDATE session_ownership SET frozen=true,release_frozen=false,updated_at=now() WHERE account_id=$1 AND workspace_id=$2`,[claim.account.id,claim.account.workspace_id]);result={status:'FROZEN'};}
  else if(type==='resume'){
   const acquired=await acquireOwnership(claim.account,owner,p.isolation_evidence,claim.cmd.id);if(!acquired.acquired)throw new Error(acquired.reason);fence={owner_id:owner,generation:acquired.generation!};
   await withTransaction(async c=>{const policy=await readOperationalSettings(c,claim.account.workspace_id,claim.account.environment,{lock:'share'});await assertFence(c,claim.account,fence!);const account=await getRecord(c,claim.account.workspace_id,'channel_account',claim.account.id);if(claim.account.environment==='REAL'&&(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations||account?.body.sending_enabled!==true))throw new Error('REAL_LIFECYCLE_AUTHORIZATION_REQUIRED');await c.query(`UPDATE session_ownership SET frozen=false,release_frozen=false,lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE account_id=$1 AND owner_id=$2 AND generation=$3`,[claim.account.id,owner,fence!.generation]);await c.query("UPDATE manual_controls SET paused=false,version=version+1,updated_at=now() WHERE workspace_id=$1 AND scope_type='channel_account' AND scope_id=$2",[claim.account.workspace_id,claim.account.id]);});result={status:'RESUMED'};
  }
  else if(type==='check_health'){
   // A replacement worker may read the provider only after claiming the
   // generation with an installer-attested isolation receipt. The same fenced
   // read can then reconcile only its own health incident; no lifecycle or
   // outbound operation is authorized by this command.
   const acquired=await acquireOwnership(claim.account,owner,undefined,claim.cmd.id);
   if(!acquired.acquired)throw new Error(acquired.reason);
   fence={owner_id:owner,generation:acquired.generation!};
   const signals=await recordHealth(claim.account,factory,fence);
   result={status:'CHECKED',signals:signals.length};
  }
  else if(type==='sync_inbox'){
   if(claim.account.environment!=='REAL'||claim.account.body.provider!=='waha'||!p.identity_fingerprint||claim.account.body.identity_fingerprint!==p.identity_fingerprint)throw new Error('HISTORY_ACCOUNT_IDENTITY_CHANGED');
   await assertGatewayIsolation(claim.account);
   const acquired=await acquireOwnership(claim.account,owner,undefined,claim.cmd.id);if(!acquired.acquired)throw new Error(acquired.reason);fence={owner_id:owner,generation:acquired.generation!};
   const captured=await withTransaction(async c=>{const policy=await readOperationalSettings(c,claim.account.workspace_id,'REAL',{lock:'share'});if(policy.release_hold)throw new Error('RELEASE_HOLD_ACTIVE');const provider=await factory(claim.account);if(!provider.recentInbound)throw new Error('HISTORY_ENGINE_UNSUPPORTED');
   const signals=await provider.health();if(!signals.some(s=>s.dimension==='session'&&s.value==='WORKING')||!signals.some(s=>s.dimension==='transport'&&s.status==='OK'&&(s.value as Body)?.identity_fingerprint===p.identity_fingerprint))throw new Error('HISTORY_ACCOUNT_IDENTITY_CHANGED');
   const captured=await provider.recentInbound({since:p.since,until:p.until,limit:p.limit});
   const after=await provider.health();if(!after.some(s=>s.dimension==='transport'&&s.status==='OK'&&(s.value as Body)?.identity_fingerprint===p.identity_fingerprint))throw new Error('HISTORY_ACCOUNT_IDENTITY_CHANGED');return captured;});
   await withTransaction(async c=>{await assertFence(c,claim.account,fence!);const current=await getRecord(c,claim.account.workspace_id,'channel_account',claim.account.id);if(!current||current.body.deleted_at||current.body.identity_fingerprint!==p.identity_fingerprint)throw new Error('HISTORY_ACCOUNT_IDENTITY_CHANGED');await appendEvent(c,{workspace_id:claim.account.workspace_id,environment:claim.account.environment,event_type:'channel.history.observed',aggregate_id:claim.account.id,causation_id:claim.cmd.id,actor:{type:'channel',id:owner},payload:{source:'provider_history',since:p.since,until:p.until,count:captured.messages.length,truncated:captured.truncated,identity_fingerprint:p.identity_fingerprint,messages_ciphertext:encrypt(captured.messages)}});});
   result={status:'CAPTURED',count:captured.messages.length,truncated:captured.truncated,source:'provider_history',external_mutations:0};
  }
  else if(type==='get_qr'){result={status:'USE_AUTHENTICATED_EPHEMERAL_QR_ROUTE'};}
  else if(['connect','disconnect','restart','logout'].includes(type)){
   if(claim.account.environment==='SIMULATION'&&claim.account.body.provider!=='simulator')throw new Error('SIMULATION_EXTERNAL_PROVIDER_DENIED');
   if(['connect','restart'].includes(type)&&claim.account.environment==='REAL'&&!onboardingEnabled((await readOperationalSettings(pool,claim.account.workspace_id,claim.account.environment)).body))throw new Error('QR_OPERATION_NOT_AUTHORIZED');
   await withTransaction(async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+claim.account.id]);
    const uncertain=(await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND resource_id=$2 AND id<>$3 AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at')",[claim.account.workspace_id,claim.account.id,claim.cmd.id])).rowCount;
    if(uncertain)throw new Error('COMMAND_RECONCILIATION_REQUIRED');
    if(p.automatic_recovery){const s=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 FOR UPDATE',[claim.account.id])).rows[0];if(!s||s.revision!==p.session_revision)throw new Error('SESSION_CONFIGURATION_CHANGED');const block=await sessionRecoveryBlocker(c,claim.account,s,claim.cmd.id);if(block)throw new Error(block);}
   });
   await assertGatewayIsolation(claim.account);
   const ownership=await acquireOwnership(claim.account,owner,p.isolation_evidence,claim.cmd.id);if(!ownership.acquired)throw new Error(ownership.reason);fence={owner_id:owner,generation:ownership.generation!};
   const status=await withTransaction(async c=>{const policy=await readOperationalSettings(c,claim.account.workspace_id,claim.account.environment,{lock:'share'});if(claim.account.environment==='REAL'&&policy.release_hold)throw new Error('RELEASE_HOLD_ACTIVE');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+claim.account.id]);if(['connect','restart'].includes(type)&&claim.account.environment==='REAL'&&!onboardingEnabled(policy.body))throw new Error('QR_OPERATION_NOT_AUTHORIZED');await assertFence(c,claim.account,fence!,false);if(p.automatic_recovery){const s=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 FOR UPDATE',[claim.account.id])).rows[0];if(s.revision!==p.session_revision)throw new Error('SESSION_CONFIGURATION_CHANGED');const blocker=await sessionRecoveryBlocker(c,claim.account,s,claim.cmd.id);if(blocker)throw new Error(blocker);}if(type==='disconnect'||type==='logout')await c.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE account_id=$1',[claim.account.id]);
   remoteAttempted=true;
   const remote=claim.account.body.provider==='cloud'?{status:(await (await factory(claim.account)).health()).some(s=>s.dimension==='transport'&&s.status==='OK')?'WORKING':'UNKNOWN'}:await (await factory(claim.account)).lifecycle(type==='connect'?'start':type==='disconnect'?'stop':type);
   const status=type==='disconnect'||type==='logout'?'STOPPED':remote.status==='WORKING'?'WORKING':remote.status;
   await assertFence(c,claim.account,fence!);const current=await getRecord(c,claim.account.workspace_id,'channel_account',claim.account.id);if(current)await putRecord(c,{id:current.id,workspaceId:current.workspace_id,environment:current.environment,kind:current.kind,version:current.version,body:{...current.body,status,last_lifecycle_at:new Date().toISOString(),last_lifecycle_error:null,...(['connect','restart'].includes(type)?{unlinked_at:null}:{}),...(['disconnect','logout'].includes(type)?{identity_verified:false}:{}),...(type==='logout'?{identity_verified:false,identity_fingerprint:claim.account.body.identity_fingerprint??null,identity_conflict:false,sending_enabled:false,unlinked_at:new Date().toISOString()}:{} )}});
   if(type==='logout'){const session=(await c.query("UPDATE channel_sessions SET credential_generation=credential_generation+1,backup_status='PREVIOUS_GENERATION_ONLY',recovery_stage='AWAITING_NEW_QR',revision=revision+1 WHERE account_id=$1 RETURNING *",[claim.account.id])).rows[0];if(session)await sessionEvent(c,session,'logout_confirmed',claim.cmd.actor_id,'provider_response',{command_id:claim.cmd.id,credential_generation:session.credential_generation,authentication_verified:false});}
   await c.query(`UPDATE session_ownership SET frozen=$2,lease_expires_at=now()+interval '60 seconds',updated_at=now() WHERE account_id=$1 AND owner_id=$3 AND generation=$4`,[claim.account.id,claim.account.environment==='REAL'||type==='disconnect'||type==='logout',owner,fence!.generation]);return status;});if(!['disconnect','logout'].includes(type))await recordHealth(claim.account,factory,fence);result={status};
  }else throw new Error('CHANNEL_COMMAND_UNSUPPORTED');
 }catch(e){const failure=onboardingFailure(onboardingCode(e,String(claim.cmd.payload.type)),String(claim.cmd.payload.type),claim.account.body.status,claim.cmd.id);error=failure.error.code;result={error,remote_outcome:remoteAttempted?'UNKNOWN':'NOT_ATTEMPTED',message:failure.error.message,diagnostic:failure.error.diagnostic,...(e instanceof ProviderError&&e.httpStatus?{upstream_http_status:e.httpStatus}:{})};await withTransaction(async c=>{const owns=(await c.query('SELECT * FROM session_ownership WHERE account_id=$1 AND workspace_id=$2 AND owner_id=$3 FOR UPDATE',[claim.account.id,claim.account.workspace_id,owner])).rows[0];if(!owns||fence&&owns.generation!==fence.generation)return;await c.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE account_id=$1 AND owner_id=$2 AND generation=$3',[claim.account.id,owner,owns.generation]);if(remoteAttempted&&['connect','restart','disconnect','logout'].includes(claim.cmd.payload.type)){const current=await getRecord(c,claim.account.workspace_id,'channel_account',claim.account.id);if(current)await putRecord(c,{id:current.id,workspaceId:current.workspace_id,environment:current.environment,kind:current.kind,version:current.version,body:{...current.body,status:'UNKNOWN',health_status:'BLOCKED',identity_verified:false,last_lifecycle_error:failure.error.diagnostic}});}});}

 await withTransaction(async c=>{const completion=await c.query("UPDATE commands SET status=$2,result=$3,updated_at=now() WHERE id=$1 AND status='PENDING' AND result->>'processing_owner'=$4",[claim.cmd.id,error?'FAILED':'APPLIED',result,owner]);await appendEvent(c,{workspace_id:claim.account.workspace_id,environment:claim.account.environment,event_type:completion.rowCount?'channel.command_completed':'channel.command_late_result_observed',aggregate_id:claim.account.id,causation_id:claim.cmd.id,actor:{type:'channel',id:owner},payload:{type:claim.cmd.payload.type,status:error?'FAILED':'APPLIED',result}});});count++;
 }return count;
}
export async function heartbeatOwnership(owner=ownerId){
 const leases=[...(leaseGenerations.get(owner)??[])].map(([account_id,generation])=>({account_id,generation}));if(!leases.length)return;
 // Only a generation acquired in this process may renew. A delayed heartbeat is
 // not a provider reconnect or an ownership transfer; explicit freezes remain
 // frozen, and an expired frozen/paused/stopped account needs explicit review.
 await withTransaction(async c=>{
  const renewed=(await c.query(`WITH eligible AS MATERIALIZED (
   SELECT o.account_id,o.lease_expires_at<=now() AS recovered
   FROM session_ownership o JOIN records r ON r.id::text=o.account_id
   JOIN channel_sessions s ON s.account_id=r.id
   WHERE o.owner_id=$1 AND NOT(r.body?'deleted_at') AND s.archived_at IS NULL
    AND EXISTS(SELECT 1 FROM jsonb_to_recordset($2::jsonb) AS l(account_id text,generation integer) WHERE l.account_id=o.account_id AND l.generation=o.generation)
    AND (o.lease_expires_at>now() OR (NOT o.frozen AND NOT s.operational_pause AND s.desired_state='RUNNING'))
   FOR UPDATE OF o SKIP LOCKED
  ) UPDATE session_ownership o SET lease_expires_at=now()+interval '60 seconds',updated_at=now()
   FROM eligible e WHERE o.account_id=e.account_id
   RETURNING o.account_id,o.workspace_id,o.generation,e.recovered`,[owner,JSON.stringify(leases)])).rows;
  for(const row of renewed.filter(row=>row.recovered)){
   const account=await getRecord(c,row.workspace_id,'channel_account',row.account_id);
   if(account)await appendEvent(c,{workspace_id:account.workspace_id,environment:account.environment,event_type:'channel.ownership_lease_recovered',aggregate_id:account.id,actor:{type:'channel',id:owner},payload:{generation:row.generation,source:'same_process_generation_heartbeat',provider_calls:0,authorization_changed:false}});
  }
 });
}
export async function collectHealth(factory:ProviderFactory=providerFor,_owner=ownerId){
 const rows=await withTransaction(async c=>{
  // Acquire policy authority before any health-claim row locks. All workers
  // visit workspaces in the same order, including mixed REAL/SIMULATION scopes.
  const scopes=(await c.query(`SELECT DISTINCT r.workspace_id,r.environment FROM channel_sessions s JOIN records r ON r.id=s.account_id WHERE r.kind='channel_account' AND NOT(r.body?'deleted_at') AND (s.last_health_at IS NULL OR s.last_health_at<now()-interval '25 seconds') AND (s.health_probe_until IS NULL OR s.health_probe_until<now()) ORDER BY r.workspace_id,r.environment`)).rows;
  const selected:DomainRecord[]=[];
  for(const scope of scopes){
   if(selected.length>=20)break;
   const policy=scope.environment==='REAL'?await readOperationalSettings(c,scope.workspace_id,'REAL',{lock:'share'}):null;if(policy?.release_hold)continue;
   const frozen=!!policy&&policy.body.dispatch_frozen===true&&policy.body.real_sends_enabled===false&&policy.body.allow_real_operations===false;
   const disabled=scope.environment==='REAL'?new Set((await c.query(`SELECT key FROM integration_settings WHERE workspace_id=$1 AND environment='REAL' AND enabled=false`,[scope.workspace_id])).rows.map(row=>row.key)):new Set<string>();
   const candidates=(await c.query(`SELECT r.* FROM channel_sessions s JOIN records r ON r.id=s.account_id WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='channel_account' AND NOT(r.body?'deleted_at') AND (s.last_health_at IS NULL OR s.last_health_at<now()-interval '25 seconds') AND (s.health_probe_until IS NULL OR s.health_probe_until<now())
    AND NOT ($3::boolean AND s.desired_state='STOPPED' AND s.operational_pause AND NOT s.recovery_enabled
     AND EXISTS(SELECT 1 FROM session_ownership o WHERE o.account_id=r.id::text AND o.workspace_id=r.workspace_id AND o.frozen)
     AND EXISTS(SELECT 1 FROM integration_settings i WHERE i.workspace_id=r.workspace_id AND i.environment=r.environment AND i.key=(r.body->>'provider')||':'||COALESCE(r.body->>'gateway_ref',upper(r.body->>'provider')) AND i.enabled))
    ORDER BY s.last_health_at NULLS FIRST,r.id`,[scope.workspace_id,scope.environment,frozen])).rows as DomainRecord[];
   const ids=candidates.filter(account=>!disabled.has(accountIntegrationKey(account))).map(account=>account.id);
   if(!ids.length)continue;
   const claimed=(await c.query(`SELECT account_id FROM channel_sessions WHERE account_id=ANY($1::uuid[]) AND (last_health_at IS NULL OR last_health_at<now()-interval '25 seconds') AND (health_probe_until IS NULL OR health_probe_until<now()) ORDER BY array_position($1::uuid[],account_id) FOR UPDATE SKIP LOCKED LIMIT $2`,[ids,20-selected.length])).rows.map(row=>row.account_id);
   if(!claimed.length)continue;
   await c.query("UPDATE channel_sessions SET health_probe_until=now()+interval '60 seconds',health_probe_owner=$2 WHERE account_id=ANY($1::uuid[])",[claimed,_owner]);
   selected.push(...(await c.query('SELECT * FROM records WHERE id=ANY($1::uuid[]) ORDER BY array_position($1::uuid[],id)',[claimed])).rows);
  }
  return selected;
 });
 let cursor=0;await Promise.all(Array.from({length:4},async()=>{while(cursor<rows.length){const account=rows[cursor++];try{await recordHealth(account,factory);}catch{/* next bounded pass can retry a read */}finally{await query('UPDATE channel_sessions SET health_probe_until=NULL WHERE account_id=$1 AND health_probe_owner=$2',[account.id,_owner]);}}}));return rows.length;
}

async function verifyIsolation(client:QueryExecutor,account:DomainRecord,current:Body,reference?:string):Promise<{receiptId?:string;reference:string}|undefined>{
 const isUuid=!!reference&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(reference);
 const copyReceipt=(await client.query('SELECT id FROM public.read_copy_source_isolation_receipt($1::uuid,$2,$3,$4,$5::uuid)',[account.id,account.workspace_id,current.owner_id,current.generation,isUuid?reference:null])).rows[0];
 if(copyReceipt&&(!reference||isUuid))return{receiptId:copyReceipt.id,reference:copyReceipt.id};
 const receipt=(await client.query(`SELECT id FROM ownership_isolation_receipts WHERE account_id=$1 AND workspace_id=$2 AND previous_owner_id=$3 AND generation=$4 AND method='container_stopped_and_access_revoked' AND consumed_at IS NULL AND verified_at<=now() AND verified_at>now()-interval '24 hours' AND ($5::uuid IS NULL OR id=$5) ORDER BY verified_at DESC LIMIT 1 FOR UPDATE`,[account.id,account.workspace_id,current.owner_id,current.generation,isUuid?reference:null])).rows[0];
 if(receipt&&(!reference||isUuid))return{receiptId:receipt.id,reference:receipt.id};
 if(!reference||isUuid)return;
 // Compatibility for older installations. New deployments attest isolation in the owner-written table.
 const root=process.env.OWNERSHIP_PROOF_DIR,key=process.env.OWNERSHIP_PROOF_KEY;if(!root||!key||!/^[-a-zA-Z0-9_]{8,128}$/.test(reference))return;try{const proof=JSON.parse(await readFile(join(root,reference+'.json'),'utf8'));const data=proof.data;const expected=createHmac('sha256',key).update(JSON.stringify(data)).digest();const supplied=Buffer.from(String(proof.signature),'hex');if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return;return data.account_id===account.id&&data.previous_owner_id===current.owner_id&&data.previous_generation===current.generation&&['credential_revocation','network_isolation','container_stopped_and_access_revoked'].includes(data.method)&&/^[a-f0-9]{64}$/.test(data.evidence_sha256??'')&&Date.now()-Date.parse(data.verified_at)>=0&&Date.now()-Date.parse(data.verified_at)<300000?{reference}:undefined;}catch{return;}
}

/** A crashed lifecycle request may have reached the gateway: never retry it automatically. */
export async function recoverChannelCommands(ageSeconds=90){return withTransaction(async client=>{const rows=(await client.query(`UPDATE commands SET status='FAILED',result=result||jsonb_build_object('error','CHANNEL_COMMAND_INTERRUPTED_REQUIRES_REVIEW','recovery','NO_AUTOMATIC_RETRY'),updated_at=now() WHERE kind='channel_command' AND status='PENDING' AND result ? 'processing_owner' AND updated_at<now()-($1*interval '1 second') RETURNING *`,[ageSeconds])).rows;for(const cmd of rows)await appendEvent(client,{workspace_id:cmd.workspace_id,environment:cmd.environment,event_type:'channel.command_interrupted',aggregate_id:cmd.resource_id,causation_id:cmd.id,payload:{command_id:cmd.id,type:cmd.payload.type,reason:'REMOTE_LIFECYCLE_OUTCOME_REQUIRES_REVIEW'}});return rows.length;});}

export async function discoverSessionOwnership(owner=ownerId){
 // Existing leases are maintained by their process-local generation heartbeat.
 // Discovery must never bypass that fence by adopting another generation.
 const rows=(await query("SELECT r.* FROM records r JOIN channel_sessions s ON s.account_id=r.id LEFT JOIN session_ownership o ON o.account_id=r.id::text WHERE o.owner_id IS NULL AND NOT(r.body?'deleted_at') AND s.recovery_enabled AND s.desired_state='RUNNING' AND NOT s.operational_pause AND s.archived_at IS NULL ORDER BY s.updated_at,r.id LIMIT 20")).rows;
 for(const a of rows)await acquireOwnership(a,owner);return rows.length;
}
