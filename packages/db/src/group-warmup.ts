import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {bindProfileEnvironment} from './profile-environment.js';
import {uuid,hash,stableJson,appendEvent,decrypt} from './index.js';
import type {Body} from '../../contracts/src/index.js';
import {continuousAuthorizationSchema,type ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
import {groupWarmupConfigSchema,groupWarmupCommandSchema,type GroupWarmupConfig,type LibraryScript,libraryImportSchema} from '../../contracts/src/group-warmup.js';
import {bundledGroupLibrary,bundledLibraryManifest,BUNDLED_LIBRARY_VERSION,BUNDLED_LIBRARY_NAME} from '../../domain/src/warmup/group-library.js';
import {validateLibrary,messageHash,libraryCoverage,groupProfile,groupDailyBudget,libraryLimitsFeasible} from '../../domain/src/warmup/group-policy.js';
import {groupEligibility} from './warmup-groups.js';
import {canonicalIdentity} from '../../messaging/src/security.js';
import {lockedContinuousWorkerProfile} from './continuous-commercial.js';
type Environment='REAL'|'SIMULATION';
export function warmupError(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode});}
function need(v:unknown,c:string):asserts v{if(!v)warmupError(c);}
export async function lockWarmupProfile(db:ProfileExecutor,environment:Environment){
 await bindProfileEnvironment(db,environment);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`group-warmup:${db.workspaceId}:${environment}`]);
}
/** Same latest QR source for API and workers. Does not create authority or
 * change a human pause. Ciphertexts are decrypted only to compare own identity. */
export async function groupQrAuthorities(db:ProfileExecutor,environment:Environment,ids:string[]){
 const role=(await db.query('SELECT current_user AS role')).rows[0].role;
 if(role==='commerce_api'){const profile=(await db.query("SELECT id FROM profiles WHERE id=$1 AND state='ACTIVE' FOR SHARE",[db.workspaceId])).rows[0];need(profile,'PROFILE_SUSPENDED');}
 else await lockedContinuousWorkerProfile(db);
 const rows=(await db.query(`SELECT a.state,s.*,r.body,i.address_fingerprint,i.qr_verified_at FROM channel_sessions s
  JOIN records r ON r.id=s.account_id AND r.workspace_id=s.workspace_id AND r.environment=s.environment
  JOIN warmup_identities i ON i.account_id=s.account_id AND i.workspace_id=s.workspace_id AND i.environment=s.environment
  JOIN LATERAL(SELECT c.id FROM commands c WHERE c.workspace_id=s.workspace_id AND c.environment=s.environment AND c.resource_id=s.account_id::text
   AND c.kind='channel_command' AND c.payload->>'type'='connect' AND c.status='APPLIED' ORDER BY c.created_at DESC,c.id DESC LIMIT 1) latest ON true
  JOIN continuous_authorizations a ON a.workspace_id=s.workspace_id AND a.environment=s.environment AND a.account_id=s.account_id AND a.qr_command_id=latest.id
  WHERE s.workspace_id=$1 AND s.environment=$2 AND s.account_id=ANY($3::uuid[]) AND s.archived_at IS NULL FOR SHARE OF s,r,a`,[db.workspaceId,environment,ids])).rows;
 need(rows.length===ids.length,'CURRENT_QR_AUTHORITY_REQUIRED');const grants=new Map<string,ContinuousAuthorization>();
 for(const row of rows){const g=continuousAuthorizationSchema.parse(row.state);
  need(g.source.kind==='VERIFIED_QR_CONNECTION'&&g.accountId===row.account_id&&g.workspaceId===db.workspaceId&&g.environment===environment,'QR_SCOPE_CHANGED');
  need(!g.revokedAt&&!g.humanPaused&&!g.protections.length,'QR_AUTHORITY_PAUSED_OR_PROTECTED');
  need(g.source.kind==='VERIFIED_QR_CONNECTION'&&row.expected_identity_fingerprint===g.source.identityFingerprint&&row.body.identity_fingerprint===g.source.identityFingerprint,'QR_IDENTITY_CHANGED');
  need(row.desired_state==='RUNNING'&&!row.operational_pause&&row.observed_state==='CONNECTED'&&row.auth_state==='VERIFIED'&&row.body.status==='WORKING'&&!row.body.deleted_at&&row.body.identity_verified&&!row.body.identity_conflict,'MEMBER_NOT_CONNECTED');
  need(row.health_expires_at instanceof Date&&row.health_expires_at>new Date(),'MEMBER_HEALTH_STALE');
  need(row.body.provider===(environment==='REAL'?'waha':'simulator'),'GROUP_PROVIDER_UNSUPPORTED');
  const raw=decrypt(row.observed_identity_ciphertext);need(hash(raw)===row.expected_identity_fingerprint&&hash(canonicalIdentity(raw))===row.address_fingerprint,'QR_OBSERVED_IDENTITY_CHANGED');
  grants.set(row.account_id,g);
 }return grants;
}

async function replay<T>(db:ProfileExecutor,environment:Environment,operationId:string,actor:string,input:unknown,work:()=>Promise<T>):Promise<T>{
 await lockWarmupProfile(db,environment);const digest=hash(stableJson(input));
 const old=(await db.query('SELECT * FROM warmup_program_operations WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,environment,operationId])).rows[0];
 if(old){need(old.actor_id===actor&&old.request_hash===digest,'OPERATION_ID_CONFLICT');return old.result;}
 const result=await work();await db.query('INSERT INTO warmup_program_operations(id,workspace_id,environment,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',[operationId,db.workspaceId,environment,actor,digest,result]);return result;
}
export async function libraryScripts(db:ProfileExecutor,environment:Environment,version:string):Promise<LibraryScript[]>{
 if(version===BUNDLED_LIBRARY_VERSION)return [...bundledGroupLibrary];
 const release=(await db.query('SELECT content_ids FROM warmup_library_releases WHERE workspace_id=$1 AND environment=$2 AND version=$3',[db.workspaceId,environment,version])).rows[0];need(release,'LIBRARY_NOT_FOUND');
 return (await db.query('SELECT body FROM warmup_content WHERE workspace_id=$1 AND environment=$2 AND id=ANY($3::uuid[]) ORDER BY array_position($3::uuid[],id)',[db.workspaceId,environment,release.content_ids])).rows.map(r=>r.body);
}
async function persistLibrary(db:ProfileExecutor,environment:Environment,version:string,name:string,scripts:LibraryScript[],actor:string,source:'BUNDLED'|'IMPORTED'){
 const old=(await db.query('SELECT * FROM warmup_library_releases WHERE workspace_id=$1 AND environment=$2 AND version=$3',[db.workspaceId,environment,version])).rows[0];
 const sha=hash(stableJson(scripts));if(old){need(old.sha256===sha,'LIBRARY_VERSION_IMMUTABLE');return old;}
 let manifest:ReturnType<typeof validateLibrary>;try{manifest=validateLibrary(scripts);}catch(error){if(error instanceof Error&&error.message.startsWith('LIBRARY_'))warmupError(error.message,400);throw error;}const ids:string[]=[];
 for(const body of scripts){const digest=hash(stableJson(body));let row=(await db.query('SELECT id FROM warmup_content WHERE workspace_id=$1 AND environment=$2 AND content_hash=$3',[db.workspaceId,environment,digest])).rows[0];
  if(!row)row=(await db.query("INSERT INTO warmup_content(workspace_id,environment,content_hash,body,approved_by,origin,policy_version,message_hashes) VALUES($1,$2,$3,$4,$5,'LIBRARY',$6,$7) RETURNING id",[db.workspaceId,environment,digest,body,actor,version,body.turns.map(t=>messageHash(t.text))])).rows[0];ids.push(row.id);
 }
 return(await db.query('INSERT INTO warmup_library_releases(workspace_id,environment,version,name,source,content_ids,manifest,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',[db.workspaceId,environment,version,name,source,ids,manifest,sha,actor])).rows[0];
}
export async function listWarmupLibraries(db:ProfileExecutor,environment:Environment){
 const rows=(await db.query('SELECT version,name,source,manifest,sha256,created_at FROM warmup_library_releases WHERE workspace_id=$1 AND environment=$2 ORDER BY created_at DESC',[db.workspaceId,environment])).rows;
 return [{version:BUNDLED_LIBRARY_VERSION,name:BUNDLED_LIBRARY_NAME,source:'BUNDLED',manifest:bundledLibraryManifest,sha256:hash(stableJson(bundledGroupLibrary))},...rows.filter(r=>r.version!==BUNDLED_LIBRARY_VERSION)];
}
export async function importWarmupLibrary(db:ProfileExecutor,input:z.infer<typeof libraryImportSchema>,actor:string){
 const {environment,operationId}=input;need(input.version!==BUNDLED_LIBRARY_VERSION,'BUNDLED_LIBRARY_RESERVED');
 return replay(db,environment,operationId,actor,input,async()=>{const release=await persistLibrary(db,environment,input.version,input.name,input.scripts,actor,'IMPORTED');
  await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'warmup.library_imported',aggregate_id:release.id,payload:{version:release.version,sha256:release.sha256,manifest:release.manifest,actor}});return{version:release.version,manifest:release.manifest,sha256:release.sha256};});
}
export async function previewGroupWarmup(db:ProfileExecutor,environment:Environment,raw:GroupWarmupConfig,programId?:string){
 const config=groupWarmupConfigSchema.parse(raw),blockers:string[]=[];const target=programId?await readGroupProgram(db,environment,programId):null;const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 const group=(await db.query('SELECT * FROM warmup_groups WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,environment,config.groupId])).rows[0];
 // V7.4 C/D: participants are this profile's lines whose owner asked for
 // warm-up. Own lines declared ready and external members only receive.
 const audience=group?await groupAudience(db,environment,group):{participants:[] as string[],ownReady:[] as string[],external:0,total:0,externalDigest:hash('[]'),unresolvedObservers:[] as string[]},members:string[]=audience.participants;
 if(audience.unresolvedObservers.length)blockers.push('GROUP_OWN_LINE_UNRESOLVED');
 if(config.senderIds.some(id=>audience.ownReady.includes(id)))blockers.push('SENDER_WARMUP_NOT_REQUESTED');
 else if(config.senderIds.some(id=>!members.includes(id)))blockers.push('SENDER_NOT_IN_GROUP');
 if(members.length<2||members.length>10)blockers.push('GROUP_SIZE_UNSUPPORTED');
 if(!group)blockers.push('GROUP_NOT_FOUND');else if(!blockers.length){const reason=groupEligibility(group,members,now,config.senderIds,{audience:true});if(reason)blockers.push(reason);}
 const states=members.length?(await db.query(`SELECT s.*,p.continuity_mode,p.paused AS pool_paused,p.breaker_open,p.enabled,p.archived_at FROM warmup_states s JOIN warmup_pools p ON p.id=s.pool_id WHERE s.workspace_id=$1 AND s.environment=$2 AND s.account_id=ANY($3::uuid[]) ORDER BY s.account_id`,[db.workspaceId,environment,members])).rows:[];
 if(states.length!==members.length)blockers.push('QR_ENROLLMENT_PENDING');
 if(states.some(s=>s.paused||s.confirmed_block||s.breaker_open||s.pool_paused&&s.pool_id!==target?.pool_id))blockers.push('MEMBER_PAUSED_OR_PROTECTED');
 const reservations=(await db.query('SELECT account_id,program_id FROM warmup_account_reservations WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',[members])).rows;
 if(reservations.some(r=>r.program_id!==programId))blockers.push('NUMBER_ALREADY_RESERVED');
 const uncertain=(await db.query("SELECT count(*)::int count FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND (o.account_id=ANY($3::text[]) OR t.recipient_ids && $3::uuid[] OR o.contact_id=ANY($3::text[])) AND o.status IN('SENDING','UNKNOWN','SENT')",[db.workspaceId,environment,members])).rows[0].count;
 if(uncertain)blockers.push('WARMUP_RECONCILIATION_REQUIRED');
 try{await groupQrAuthorities(db,environment,members);}catch(e){blockers.push(e instanceof Error?e.message:'CURRENT_QR_AUTHORITY_REQUIRED');}
 const scripts=await libraryScripts(db,environment,config.libraryVersion),coverage=libraryCoverage(config,scripts);if(!coverage.sufficient)blockers.push('LIBRARY_COVERAGE_INSUFFICIENT');if(!libraryLimitsFeasible(config,scripts))blockers.push('LIBRARY_LIMITS_INFEASIBLE');
 const snapshot={config,membershipVersion:group?.version??null,members,audience:{ownReady:audience.ownReady,external:audience.external,externalDigest:audience.externalDigest},states:states.map(s=>({id:s.account_id,pool:s.pool_id,episode:s.episode_id,identity:s.identity_id,paused:s.paused})),reservations,libraryHash:hash(stableJson(scripts))};
 return{config,groupName:group?.name??null,members,senders:config.senderIds,membershipVersion:group?.version??null,
  audience:{participants:members.length,senders:config.senderIds.length,receiveOnly:Math.max(0,members.length-config.senderIds.length),ownReady:audience.ownReady.length,external:audience.external,total:audience.total,consentRequired:audience.external>0},coverage,previewHash:hash(stableJson(snapshot)),blockers:[...new Set(blockers)],ready:blockers.length===0,
  outgoingBudget:groupDailyBudget(config,Math.min(14,...states.filter(s=>config.senderIds.includes(s.account_id)).map(s=>s.effective_days))+1,now),
  transition:states.filter(s=>s.continuity_mode!=='QR_GROUP').map(s=>({accountId:s.account_id,from:s.continuity_mode,effectiveDays:s.effective_days,historyPreserved:true})),ai:false};
}
export async function createGroupWarmup(db:ProfileExecutor,environment:Environment,operationId:string,config:GroupWarmupConfig,actor:string){
 return replay(db,environment,operationId,actor,{action:'create',config},async()=>{
  const p=await previewGroupWarmup(db,environment,config);need(p.membershipVersion,'GROUP_NOT_FOUND');
  const scripts=await libraryScripts(db,environment,config.libraryVersion),library=await persistLibrary(db,environment,config.libraryVersion,config.libraryVersion===BUNDLED_LIBRARY_VERSION?BUNDLED_LIBRARY_NAME:config.libraryVersion,scripts,actor,config.libraryVersion===BUNDLED_LIBRARY_VERSION?'BUNDLED':'IMPORTED');
  const profile=(await db.query('INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,$2,$3) RETURNING id',[db.workspaceId,environment,groupProfile(config)])).rows[0];
  const program=(await db.query("INSERT INTO warmup_programs(workspace_id,environment,actor_id,name,topology,purpose,group_id,profile_id,account_ids,content_ids,scope) VALUES($1,$2,$3,$4,'group','preparation',$5,$6,$7,$8,$9) RETURNING id,version,status",[db.workspaceId,environment,actor,config.name,config.groupId,profile.id,p.members,library.content_ids,{...config,mode:'QR_GROUP',membershipVersion:p.membershipVersion,libraryHash:library.sha256,audience:{external:p.audience.external,ownReady:p.audience.ownReady,total:p.audience.total,membershipVersion:p.membershipVersion}}])).rows[0];
  await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'warmup.program_created',aggregate_id:program.id,payload:{actor,version:program.version,mode:'QR_GROUP',external_effects:0}});return program;
 });
}
export function programConfig(program:Body){const {mode:_mode,membershipVersion:_membership,libraryHash:_library,audience:_audience,...config}=program.scope;return groupWarmupConfigSchema.parse(config);}
export async function readGroupProgram(db:ProfileExecutor,environment:Environment,id:string,lock=false){const row=(await db.query(`SELECT * FROM warmup_programs WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND scope->>'mode'='QR_GROUP'${lock?' FOR UPDATE':''}`,[db.workspaceId,environment,id])).rows[0];need(row,'WARMUP_PROGRAM_NOT_FOUND');return row;}
export async function cancelGroupPending(db:ProfileExecutor,environment:Environment,ids:string[],reason:string){
 const result=await db.query(`UPDATE outbox o SET status='CANCELLED',result=result||jsonb_build_object('reason',$4::text),updated_at=now()
  WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND o.status IN('READY','BLOCKED') AND
  (o.account_id=ANY($3::text[]) OR o.contact_id=ANY($3::text[]) OR EXISTS(SELECT 1 FROM warmup_turns t WHERE t.effect_id=o.id AND t.recipient_ids && $3::uuid[]))`,[db.workspaceId,environment,ids,reason]);
 await db.query(`UPDATE warmup_content_usage u SET released_at=now() WHERE u.workspace_id=$1 AND u.environment=$2 AND u.account_id=ANY($3::uuid[]) AND u.released_at IS NULL
  AND EXISTS(SELECT 1 FROM warmup_turns t WHERE t.conversation_id=u.conversation_id)
  AND NOT EXISTS(SELECT 1 FROM warmup_turns t JOIN outbox o ON o.id=t.effect_id WHERE t.conversation_id=u.conversation_id AND (o.status<>'CANCELLED' OR o.attempts>0))`,[db.workspaceId,environment,ids]);return result;
}
export async function commandGroupWarmup(db:ProfileExecutor,environment:Environment,id:string,input:z.infer<typeof groupWarmupCommandSchema>,actor:string){
 return replay(db,environment,input.operationId,actor,{id,...input},async()=>{
  const p=await readGroupProgram(db,environment,id,true);need(p.version===input.expectedVersion,'WARMUP_VERSION_CONFLICT');
  const config=input.config??programConfig(p);
  if(input.action==='recover'){
   // V7.5 §2 (H02): the same review again, inside this locked transaction.
   const review=await previewGroupRecovery(db,environment,id);
   need(review.recoveryHash===input.recoveryHash,'WARMUP_RECOVERY_CHANGED');need(review.ready,review.blockers[0]??'WARMUP_RECOVERY_NOT_READY');
   const recovered=(await db.query('UPDATE warmup_pools SET breaker_open=false,breaker_reason=NULL,breaker_reviewed_until=clock_timestamp(),version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND breaker_open RETURNING breaker_reviewed_until',[p.pool_id,db.workspaceId,environment])).rows[0];
   need(recovered,'WARMUP_PROTECTION_NOT_OPEN');
   await db.query('UPDATE warmup_programs SET version=version+1,updated_at=now() WHERE id=$1',[id]);
   await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'warmup.protection_recovered',aggregate_id:id,payload:{actor,operationId:input.operationId,reason:input.reason,poolId:p.pool_id,
    reviewedUntil:new Date(recovered.breaker_reviewed_until).toISOString(),openedAt:review.protection.openedAt,reviewedFailures:review.failures,lines:review.lines,programStatus:p.status,resumed:false,external_effects:0}});
  }else if(input.action==='pause'||input.action==='archive'){
   need(p.status!=='ARCHIVED'||input.action==='archive','WARMUP_ARCHIVED');
   await cancelGroupPending(db,environment,p.account_ids,input.action==='pause'?'PROGRAM_PAUSED':'PROGRAM_ARCHIVED');
   if(p.pool_id)await db.query('UPDATE warmup_pools SET paused=true,enabled=CASE WHEN $2 THEN false ELSE enabled END,archived_at=CASE WHEN $2 THEN now() ELSE archived_at END,version=version+1 WHERE id=$1',[p.pool_id,input.action==='archive']);
   if(input.action==='archive')await db.query('DELETE FROM warmup_account_reservations WHERE program_id=$1',[id]);
   await db.query('UPDATE warmup_programs SET status=$2,version=version+1,updated_at=now() WHERE id=$1',[id,input.action==='pause'?'PAUSED':'ARCHIVED']);
  }else{
   need(input.action==='start'?['DRAFT','ARCHIVED','COMPLETED'].includes(p.status):input.action==='resume'?p.status==='PAUSED':['DRAFT','PAUSED','ARCHIVED','COMPLETED'].includes(p.status),'WARMUP_ACTION_STATE_INVALID');
   const preview=await previewGroupWarmup(db,environment,config,id);need(preview.previewHash===input.previewHash,'WARMUP_PREVIEW_CHANGED');need(preview.ready,preview.blockers[0]??'WARMUP_NOT_READY');
   // V7.4 C: being in a group does not prove that people outside this profile
   // agreed to this activity. Sending starts only with the owner's explicit
   // confirmation, bound to this program and to the membership just reviewed.
   if(input.action!=='configure'&&preview.audience.external>0)need(input.audienceConfirmed===true,'EXTERNAL_AUDIENCE_CONFIRMATION_REQUIRED');
   const reviewedAudience={external:preview.audience.external,ownReady:preview.audience.ownReady,total:preview.audience.total,membershipVersion:preview.membershipVersion,
    ...(input.action!=='configure'&&preview.audience.external>0?{consentConfirmedBy:actor,consentConfirmedAt:new Date().toISOString(),consentStatement:'EXTERNAL_PARTICIPANTS_AGREED_TO_GROUP_ACTIVITY'}:{})};
   const library=await persistLibrary(db,environment,config.libraryVersion,config.libraryVersion===BUNDLED_LIBRARY_VERSION?BUNDLED_LIBRARY_NAME:config.libraryVersion,await libraryScripts(db,environment,config.libraryVersion),actor,config.libraryVersion===BUNDLED_LIBRARY_VERSION?'BUNDLED':'IMPORTED');
   const profile=input.action==='configure'?(await db.query('INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,$2,$3) RETURNING id',[db.workspaceId,environment,groupProfile(config)])).rows[0].id:p.profile_id;
   // All recipients are reserved, including own lines not selected to send.
   await db.query('SELECT account_id FROM warmup_states WHERE account_id=ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',[preview.members]);
   await cancelGroupPending(db,environment,[...new Set([...p.account_ids,...preview.members])],'GROUP_PROGRAM_CHANGED');
   await db.query('DELETE FROM warmup_account_reservations WHERE program_id=$1',[id]);
   const status=input.action==='configure'?'PAUSED':'ACTIVE';
   for(const member of preview.members)await db.query('INSERT INTO warmup_account_reservations(account_id,program_id) VALUES($1,$2)',[member,id]);
   const poolId=p.pool_id??uuid();
   if(!p.pool_id)await db.query("INSERT INTO warmup_pools(id,workspace_id,environment,profile_id,topology,purpose,program_id,group_id,continuity_mode,enabled,paused,allow_small_pool_concentration) VALUES($1,$2,$3,$4,'group','preparation',$5,$6,'QR_GROUP',true,$7,true)",[poolId,db.workspaceId,environment,profile,id,config.groupId,status!=='ACTIVE']);
   else await db.query('UPDATE warmup_pools SET profile_id=$2,group_id=$3,enabled=true,paused=$4,archived_at=NULL,version=version+1 WHERE id=$1',[poolId,profile,config.groupId,status!=='ACTIVE']);
   await db.query("UPDATE warmup_states SET pool_id=$2,profile_id=$3,group_required=false,status=CASE WHEN status='GRADUATED' THEN status ELSE 'WARMING' END,reason='GROUP_SELECTED',version=version+1 WHERE account_id=ANY($1::uuid[])",[preview.members,poolId,profile]);
   // Removed senders/recipients wait; no automatic fallback to direct checks.
   await db.query("UPDATE warmup_states SET group_required=true,reason='GROUP_SELECTION_REQUIRED' WHERE pool_id=$1 AND NOT(account_id=ANY($2::uuid[]))",[poolId,preview.members]);
   await db.query('UPDATE warmup_programs SET name=$2,group_id=$3,profile_id=$4,account_ids=$5,content_ids=$6,scope=$7,pool_id=$8,status=$9,review_hash=$10,version=version+1,updated_at=now() WHERE id=$1',[id,config.name,config.groupId,profile,preview.members,library.content_ids,{...config,mode:'QR_GROUP',membershipVersion:preview.membershipVersion,libraryHash:library.sha256,audience:reviewedAudience},poolId,status,preview.previewHash]);
   if(reviewedAudience.consentConfirmedBy)await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'warmup.audience_consent_confirmed',aggregate_id:id,payload:{actor,external:reviewedAudience.external,membershipVersion:reviewedAudience.membershipVersion,operationId:input.operationId,external_effects:0}});
  }
  const result=await readGroupProgram(db,environment,id);await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'warmup.program_'+input.action,aggregate_id:id,payload:{actor,version:result.version,status:result.status,operationId:input.operationId}});
  return{id,version:result.version,status:result.status};
 });
}
/** V7.5 §2 (H02): what a person reviews before recovering a protection.
 * Per own line: current healthy read, verified identity, live and unfrozen
 * ownership, no confirmed restriction; plus current QR authority, no
 * uncertain warm-up effect and the failures being reviewed. The hash covers
 * stable facts only (not the read timestamps), so a fresh read between the
 * preview and the command does not invalidate it; a change of state does. */
export async function previewGroupRecovery(db:ProfileExecutor,environment:Environment,id:string){
 const p=await readGroupProgram(db,environment,id),blockers:string[]=[];
 const pool=p.pool_id?(await db.query('SELECT * FROM warmup_pools WHERE id=$1 AND workspace_id=$2 AND environment=$3',[p.pool_id,db.workspaceId,environment])).rows[0]:null;
 const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 if(!pool)blockers.push('WARMUP_POOL_NOT_FOUND');else if(!pool.breaker_open)blockers.push('WARMUP_PROTECTION_NOT_OPEN');
 if(p.status==='ARCHIVED')blockers.push('WARMUP_ARCHIVED');
 const members:string[]=p.account_ids;
 const rows=(await db.query(`SELECT r.id,r.body,s.observed_state,s.auth_state,s.operational_pause,s.desired_state,o.frozen,o.freeze_reason,COALESCE(o.lease_expires_at>clock_timestamp(),false) AS live,ws.confirmed_block,ws.paused AS member_paused
  FROM records r LEFT JOIN channel_sessions s ON s.account_id=r.id AND s.workspace_id=r.workspace_id AND s.environment=r.environment
  LEFT JOIN session_ownership o ON o.account_id=r.id::text AND o.workspace_id=r.workspace_id LEFT JOIN warmup_states ws ON ws.account_id=r.id
  WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='channel_account' AND r.id=ANY($3::uuid[]) ORDER BY r.id`,[db.workspaceId,environment,members])).rows;
 if(rows.length!==members.length)blockers.push('WARMUP_MEMBER_NOT_FOUND');
 const lines=rows.map(row=>{const b=row.body as Body,checked=Date.parse(String(b.health_checked_at??''));
  const health=Number.isFinite(checked)&&checked<=now.getTime()+1000&&now.getTime()-checked<90_000&&b.status==='WORKING'&&b.health_status==='OK'?'CURRENT':'NOT_CURRENT';
  const identity=environment==='SIMULATION'&&b.provider==='simulator'?'VERIFIED':b.identity_verified===true&&!b.identity_conflict?'VERIFIED':'NOT_VERIFIED';
  const ownership=environment==='SIMULATION'?'NOT_APPLICABLE':!row.frozen&&row.live?'OPERATIONAL':row.frozen?'FROZEN':'EXPIRED';
  return{accountId:row.id as string,health,identity,ownership,freezeReason:(row.freeze_reason as string|null)??null,restricted:!!row.confirmed_block,paused:!!row.member_paused||!!row.operational_pause};});
 if(lines.some(l=>l.health!=='CURRENT'))blockers.push('LINE_HEALTH_NOT_CURRENT');
 if(lines.some(l=>l.identity!=='VERIFIED'))blockers.push('LINE_IDENTITY_NOT_VERIFIED');
 if(lines.some(l=>!['OPERATIONAL','NOT_APPLICABLE'].includes(l.ownership)))blockers.push('LINE_OWNERSHIP_NOT_OPERATIONAL');
 if(lines.some(l=>l.restricted))blockers.push('CONFIRMED_RESTRICTION');
 if(lines.some(l=>l.paused))blockers.push('MEMBER_PAUSED');
 const reviewedUntil=pool?.breaker_reviewed_until?new Date(pool.breaker_reviewed_until):null;
 const failures=(await db.query(`SELECT account_id,kind,observed_at,evidence_ref FROM warmup_observations WHERE workspace_id=$1 AND environment=$2 AND account_id=ANY($3::uuid[]) AND kind IN('FAILED','CONFIRMED_BLOCK')
  AND observed_at>$4 AND ($5::timestamptz IS NULL OR observed_at>$5) ORDER BY observed_at,account_id LIMIT 200`,[db.workspaceId,environment,members,new Date(now.getTime()-86400000),reviewedUntil])).rows
  .map(r=>({accountId:r.account_id as string,kind:r.kind as string,observedAt:new Date(r.observed_at).toISOString(),source:String(r.evidence_ref).split(':')[0]}));
 if(failures.some(f=>f.kind==='CONFIRMED_BLOCK'))blockers.push('CONFIRMED_RESTRICTION');
 const uncertain=(await db.query("SELECT count(*)::int count FROM outbox o WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND (o.account_id=ANY($3::text[]) OR o.contact_id=ANY($3::text[])) AND o.status IN('SENDING','UNKNOWN')",[db.workspaceId,environment,members])).rows[0].count;
 if(uncertain)blockers.push('WARMUP_RECONCILIATION_REQUIRED');
 try{await groupQrAuthorities(db,environment,members);}catch(e){blockers.push(e instanceof Error?e.message:'CURRENT_QR_AUTHORITY_REQUIRED');}
 const protection={open:!!pool?.breaker_open,reason:(pool?.breaker_reason as string|null)??null,openedAt:pool?.breaker_opened_at?new Date(pool.breaker_opened_at).toISOString():null,reviewedUntil:reviewedUntil?.toISOString()??null};
 const unique=[...new Set(blockers)];
 return{programId:id,programVersion:p.version as number,programStatus:p.status as string,protection,failures,lines,uncertainEffects:uncertain as number,blockers:unique,ready:unique.length===0,
  recoveryHash:hash(stableJson({program:p.id,version:p.version,pool:pool?.version??null,protection:{open:protection.open,openedAt:protection.openedAt,reviewedUntil:protection.reviewedUntil},failures,lines,uncertain,blockers:unique})),
  resumes:false,externalEffects:0};
}
/** V7.5 §3 (H03): requested status vs what the engine can do now. */
/** Gate answers that clear by themselves within seconds (fresh group read,
 * rate window, planned spacing, a busy lock); they do not mean «blocked». */
const transientGateReasons=new Set(['GROUP_FRESH_READ_REQUIRED','WARMUP_RATE_LIMIT','WARMUP_CAUSAL_SPACING','GROUP_WARMUP_BUSY','CHAT_LOCK_BUSY','DISPATCH_CAPACITY_BUSY','OWNERSHIP_NOT_CONFIRMED','GROUP_OBSERVATION_FAILED','RELEASE_HOLD_ACTIVE']);
/** V7.5.3 (F3/A05): the next turn the engine would send, with its causal
 * dependency. `predecessor` is the status of the turn it waits for. */
export type GroupProgramHead={not_before:string;status:string;reason:string|null;predecessor:string|null};
export function effectiveProgramState(input:{status:string;pool:Body|null;numbers:Body[];history:Body[];senderIds:string[];config:{timezone:string;startHour:number;endHour:number};now:Date;head?:GroupProgramHead|null}){
 const {status,pool,numbers,history,now}=input,senders=numbers.filter(n=>input.senderIds.includes(n.id));
 const local=Number(new Intl.DateTimeFormat('en-US',{timeZone:input.config.timezone,hour:'2-digit',hourCycle:'h23'}).format(now));
 const inWindow=local>=input.config.startHour&&local<input.config.endHour;
 const pending=history.reduce((n,h)=>n+Number(h.pending??0),0),uncertain=history.reduce((n,h)=>n+Number(h.uncertain??0),0),sentNoAck=history.reduce((n,h)=>n+Math.max(0,Number(h.sent??0)-Number(h.delivered??0)),0);
 const next=history.map(h=>h.next_send).filter(Boolean).map(v=>new Date(v as string)).sort((a,b)=>a.getTime()-b.getTime())[0]??null;
 const reasons:string[]=[];let state:string;let nextAction:string|null=null;
 if(status==='DRAFT'){state='DRAFT';nextAction='CONFIGURE_AND_START';}
 else if(status==='ARCHIVED'){state='ARCHIVED';}
 else if(status==='COMPLETED'){state='COMPLETED';}
 else if(pool?.breaker_open){state='PROTECTED';reasons.push(String(pool.breaker_reason??'PROTECTION_OPEN'));nextAction='REVIEW_AND_RECOVER_PROTECTION';}
 else if(status==='PAUSED'){state='PAUSED_BY_HUMAN';nextAction='REVIEW_AND_RESUME';}
 else if(senders.some(n=>!n.connected)){state='NEEDS_CONNECTION';reasons.push('LINE_NOT_CONNECTED');nextAction='CHECK_NUMBER_CONNECTION';}
 else if(senders.some(n=>n.ownership&&!['OPERATIONAL','NOT_APPLICABLE'].includes(String(n.ownership)))){state='NEEDS_OWNERSHIP';reasons.push('LINE_OWNERSHIP_NOT_OPERATIONAL');nextAction='RECONCILE_NUMBER_OWNERSHIP';}
 else if(senders.some(n=>['GROUP_MEMBERSHIP_STALE','GROUP_FRESH_READ_REQUIRED','GROUP_CAPABILITY_UNVERIFIED'].includes(String(n.reason)))){state='GROUP_READ_STALE';reasons.push('GROUP_MEMBERSHIP_STALE');nextAction='REFRESH_GROUPS';}
 else if(!inWindow){state='WAITING_WINDOW';reasons.push('QUIET_HOURS');}
 else if(uncertain>0){state='UNCERTAIN';reasons.push('EFFECT_UNCERTAIN');}
 else if(sentNoAck>0&&pending===0){state='WAITING_ACK';reasons.push('ACK_PENDING');}
 else if(pending>0){
  // V7.5.3 (A05): a due turn that cannot leave is not «sending». A turn
  // waiting for its predecessor's receipts says so; a gate refusal says
  // which one. Only a future, unblocked turn is shown as the next send.
  const head=input.head,due=head?Date.parse(head.not_before)<=now.getTime():false;
  // Callers without the head (older read models) infer the same wait from
  // the aggregates: something left but is unconfirmed while due turns wait.
  const inferred=input.head===undefined&&sentNoAck>0&&!!next&&next.getTime()<=now.getTime();
  if(head?.predecessor==='SENT'||inferred){state='WAITING_RECEIPT';reasons.push('PEER_RECEIPT_PENDING');}
  else if(head?.predecessor&&['SENDING','UNKNOWN'].includes(head.predecessor)){state='UNCERTAIN';reasons.push('EFFECT_UNCERTAIN');}
  else if(head&&due&&head.status==='BLOCKED'&&head.reason&&!transientGateReasons.has(head.reason)){state='BLOCKED';reasons.push(head.reason);}
  else state='RUNNING';
 }
 else{state='WAITING_PLAN';reasons.push(...new Set(senders.map(n=>String(n.reason??'')).filter(r=>r&&r!=='GROUP_SELECTED')));}
 const upcoming=input.head?new Date(input.head.not_before):next;
 return{state,reasons,observedAt:now.toISOString(),nextAction,nextSend:state==='RUNNING'&&upcoming&&upcoming.getTime()>now.getTime()?{at:upcoming.toISOString(),conditional:false}:null};
}
export type GroupLineState='READY'|'VERIFICATION_PENDING'|'HEALTH_PENDING'|'NOT_CONNECTED'|'PAUSED'|'IDENTITY_CONFLICT'|'UNSUPPORTED';
/** V7.4 B: which managed lines can read their groups now. Reading groups is
 * a provider read through a connected, identity-confirmed own session; it does
 * not need a warm-up registration, and it never depends on the other members
 * of a group having a session here. A line that is connected but whose
 * identity or health confirmation is still in flight is a verifiable wait,
 * not a request to scan again. */
export async function groupReadableLines(db:ProfileExecutor,environment:Environment,ids?:string[]){
 const rows=(await db.query(`SELECT r.id,r.body,s.desired_state,s.operational_pause,s.observed_state,s.auth_state,s.health_expires_at,s.archived_at,clock_timestamp() AS now
  FROM records r LEFT JOIN channel_sessions s ON s.account_id=r.id AND s.workspace_id=r.workspace_id AND s.environment=r.environment AND s.archived_at IS NULL
  WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='channel_account' AND NOT(r.body?'deleted_at') AND ($3::uuid[] IS NULL OR r.id=ANY($3::uuid[])) ORDER BY r.id`,[db.workspaceId,environment,ids??null])).rows;
 return rows.map(row=>{const b=row.body as Body,fresh=row.health_expires_at instanceof Date&&row.health_expires_at>row.now;
  const state:GroupLineState=b.provider!==(environment==='REAL'?'waha':'simulator')?'UNSUPPORTED':b.identity_conflict===true?'IDENTITY_CONFLICT'
   :b.removal_requested_at||!row.desired_state||row.desired_state!=='RUNNING'?'NOT_CONNECTED':row.operational_pause?'PAUSED'
   :row.observed_state!=='CONNECTED'?'NOT_CONNECTED':!fresh?'HEALTH_PENDING'
   :row.auth_state!=='VERIFIED'||b.status!=='WORKING'||b.identity_verified!==true||!b.identity_fingerprint||(b.registered_by==='v7_quick'&&!b.ownership_confirmed_at)?'VERIFICATION_PENDING':'READY';
  return{accountId:row.id as string,state};});
}
export async function requestGroupRefresh(db:ProfileExecutor,environment:Environment,operationId:string,accountIds:string[],actor:string){
 return replay(db,environment,operationId,actor,{action:'refresh_groups',accountIds},async()=>{
  const lines=await groupReadableLines(db,environment,accountIds);need(lines.length===accountIds.length,'ACCOUNT_SCOPE_INVALID');
  const ready=lines.filter(l=>l.state==='READY').map(l=>l.accountId);
  if(!ready.length)warmupError(lines.some(l=>l.state==='VERIFICATION_PENDING'||l.state==='HEALTH_PENDING')?'GROUP_LINES_VERIFICATION_PENDING':lines.some(l=>l.state==='PAUSED')?'GROUP_LINES_PAUSED':lines.some(l=>l.state==='IDENTITY_CONFLICT')?'GROUP_LINES_IDENTITY_CONFLICT':'GROUP_LINES_NOT_CONNECTED');
  // One profile-wide read at a time: a second click, tab or agent joins the
  // running operation instead of queueing another pass over the provider.
  const running=(await db.query("SELECT id,state FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND action='GROUP_REFRESH' AND NOT(input?'group_id') AND state IN('REQUESTED','RESERVED','PREPARING') ORDER BY created_at LIMIT 1",[db.workspaceId,environment])).rows[0];
  if(running)return{id:running.id,state:'REQUESTED',joined:true,lines};
  await db.query("INSERT INTO number_operations(id,workspace_id,environment,actor_id,action,input) VALUES($1,$2,$3,$4,'GROUP_REFRESH',$5)",[operationId,db.workspaceId,environment,actor,{account_ids:ready,skipped:lines.filter(l=>l.state!=='READY')}]);return{id:operationId,state:'REQUESTED',joined:false,lines};});
}
/** The profile's lines seen in a group, with the owner's warm-up choice. */
async function groupOwnLines(db:ProfileExecutor,environment:Environment,ids:string[]){
 const rows=ids.length?(await db.query("SELECT id,COALESCE(body->>'warmup_mode','REQUIRED') AS mode FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT(body?'deleted_at') AND id=ANY($3::uuid[]) ORDER BY id",[db.workspaceId,environment,ids])).rows:[];
 return new Map<string,'REQUIRED'|'DECLARED_READY'>(rows.map(r=>[r.id,r.mode==='DECLARED_READY'?'DECLARED_READY':'REQUIRED']));
}
/** Audience of a group as the review shows it: lines that take part in the
 * warm-up, own lines that only receive (declared ready) and external members. */
export async function groupAudience(db:ProfileExecutor,environment:Environment,group:Body){
 const all:Body[]=group.members??[],ownIds=[...new Set(all.map(m=>m.account_id).filter(Boolean))].sort() as string[],modes=await groupOwnLines(db,environment,ownIds);
 const participants=ownIds.filter(id=>modes.get(id)==='REQUIRED'),ownReady=ownIds.filter(id=>modes.get(id)==='DECLARED_READY');
 const external=all.filter(m=>!m.account_id||!modes.has(m.account_id));
 // A line that read the group is one of its members by construction. When the
 // provider gave no explicit mapping for it, that line shows up as external:
 // say so instead of offering a group it could never send to.
 const unresolvedObservers=Object.keys(group.capabilities?.observations??{}).filter(id=>!ownIds.includes(id));
 return{participants,ownReady,external:external.length,total:all.length,externalDigest:hash(stableJson(external.map(m=>m.identity_hash).sort())),unresolvedObservers};
}
export async function listWarmupGroups(db:ProfileExecutor,environment:Environment){
 const rows=(await db.query('SELECT id,name,version,members,permissions,capabilities,observed_at,expires_at,retired_at FROM warmup_groups WHERE workspace_id=$1 AND environment=$2 AND retired_at IS NULL ORDER BY name,id LIMIT 100',[db.workspaceId,environment])).rows,now=new Date(),result=[];
 for(const g of rows){const audience=await groupAudience(db,environment,g),reason=audience.unresolvedObservers.length?'GROUP_OWN_LINE_UNRESOLVED':audience.participants.length<2?'GROUP_SIZE_UNSUPPORTED':groupEligibility(g,audience.participants,now,audience.participants,{audience:true});
  result.push({id:g.id,name:g.name,version:g.version,permissions:g.permissions,observed_at:g.observed_at,expires_at:g.expires_at,
   members:g.members.map((m:Body)=>{const kind=m.account_id&&audience.participants.includes(m.account_id)?'own':m.account_id&&audience.ownReady.includes(m.account_id)?'own_ready':'external';return{accountId:kind==='external'?null:m.account_id,admin:m.admin,resolved:kind!=='external',kind};}),
   audience:{participants:audience.participants.length,ownReady:audience.ownReady.length,external:audience.external,total:audience.total},eligible:!reason,reason});}
 return result;
}
export async function groupWarmupOverview(db:ProfileExecutor,environment:Environment,id?:string,days=7){
 const clock=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 const programs=(await db.query("SELECT id,version,name,status,scope,pool_id,account_ids,created_at FROM warmup_programs WHERE workspace_id=$1 AND environment=$2 AND scope->>'mode'='QR_GROUP' AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 100",[db.workspaceId,environment,id??null])).rows;
 const numbers=(await db.query(`SELECT r.id,COALESCE(r.body->>'masked_number','Número') AS label,r.body->>'name' AS alias,CASE WHEN r.body->>'warmup_mode'='DECLARED_READY' THEN 'DECLARED_READY' ELSE 'REQUIRED' END AS warmup_mode,s.status,s.reason,s.group_required,s.effective_days,s.graduated_at,s.pool_id,COALESCE(cs.observed_state='CONNECTED' AND cs.auth_state='VERIFIED' AND NOT cs.operational_pause AND cs.archived_at IS NULL AND cs.health_expires_at>clock_timestamp(),false) AS connected,
   CASE WHEN r.environment='SIMULATION' THEN 'NOT_APPLICABLE' WHEN o.account_id IS NULL THEN 'NONE' WHEN NOT o.frozen AND o.lease_expires_at>clock_timestamp() THEN 'OPERATIONAL' WHEN o.frozen THEN 'FROZEN' ELSE 'EXPIRED' END AS ownership,o.freeze_reason
  FROM records r LEFT JOIN warmup_states s ON s.account_id=r.id LEFT JOIN channel_sessions cs ON cs.account_id=r.id LEFT JOIN session_ownership o ON o.account_id=r.id::text AND o.workspace_id=r.workspace_id WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='channel_account' AND NOT(r.body?'deleted_at') ORDER BY r.id`,[db.workspaceId,environment])).rows;
 for(const p of programs){const stats=(await db.query(`SELECT v.local_date::text date,o.account_id,
  count(*) FILTER(WHERE o.status IN('SENT','DELIVERED','READ'))::int sent,count(*) FILTER(WHERE o.status IN('DELIVERED','READ'))::int delivered,
  count(*) FILTER(WHERE o.status IN('READY','BLOCKED') AND o.expires_at>clock_timestamp())::int pending,count(*) FILTER(WHERE o.status IN('UNKNOWN','SENDING'))::int uncertain,
  count(*) FILTER(WHERE o.status IN('READY','BLOCKED') AND o.expires_at<=clock_timestamp())::int expired,
  min(o.not_before) FILTER(WHERE o.status IN('READY','BLOCKED') AND o.expires_at>clock_timestamp()) next_send
  FROM warmup_conversations v JOIN outbox o ON o.conversation_id=v.id::text WHERE v.pool_id=$1 AND v.local_date>=((now() AT TIME ZONE $2)::date-($3::int-1)) GROUP BY v.local_date,o.account_id ORDER BY v.local_date DESC,o.account_id`,[p.pool_id,p.scope.timezone,days])).rows;
  p.history=stats;p.numbers=numbers.filter(n=>p.account_ids.includes(n.id));p.config=programConfig(p);p.audience=p.scope.audience??null;delete p.scope;
  const pool=p.pool_id?(await db.query('SELECT breaker_open,breaker_reason,breaker_opened_at,breaker_reviewed_until,paused,enabled FROM warmup_pools WHERE id=$1',[p.pool_id])).rows[0]??null:null;
  p.protection=pool?{open:pool.breaker_open,reason:pool.breaker_reason,openedAt:pool.breaker_opened_at?new Date(pool.breaker_opened_at).toISOString():null,reviewedUntil:pool.breaker_reviewed_until?new Date(pool.breaker_reviewed_until).toISOString():null}:null;
  const head=p.pool_id?(await db.query(`SELECT o.not_before,o.status,o.result->>'reason' AS reason,pr.status AS predecessor FROM warmup_conversations v JOIN outbox o ON o.conversation_id=v.id::text
   LEFT JOIN outbox pr ON pr.id=o.predecessor_id AND pr.workspace_id=o.workspace_id
   WHERE v.pool_id=$1 AND o.workspace_id=$2 AND o.environment=$3 AND o.kind='warmup' AND o.status IN('READY','BLOCKED') AND o.expires_at>clock_timestamp()
   ORDER BY o.not_before,o.dispatch_sequence LIMIT 1`,[p.pool_id,db.workspaceId,environment])).rows[0]??null:null;
  p.effective=effectiveProgramState({status:p.status,pool,numbers:p.numbers,history:stats,senderIds:p.config.senderIds,config:p.config,now:clock,
   head:head?{not_before:new Date(head.not_before).toISOString(),status:String(head.status),reason:head.reason??null,predecessor:head.predecessor??null}:null});
 }
 const lines=await groupReadableLines(db,environment),last=(await db.query("SELECT id,state,result->>'reason' AS reason,result->'accounts' AS accounts,created_at,updated_at FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND action='GROUP_REFRESH' AND NOT(input?'group_id') ORDER BY created_at DESC LIMIT 1",[db.workspaceId,environment])).rows[0]??null;
 return{programs,numbers:numbers.map(n=>({...n,line:lines.find(l=>l.accountId===n.id)?.state??'NOT_CONNECTED'})),refresh:last,ai:false};
}
