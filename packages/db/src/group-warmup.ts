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
 const members:string[]=group?.members?.map((m:Body)=>m.account_id).filter(Boolean).sort()??[];
 if(!group)blockers.push('GROUP_NOT_FOUND');else{const reason=groupEligibility(group,members,now,config.senderIds);if(reason)blockers.push(reason);}
 if(members.length<2||members.length>10)blockers.push('GROUP_SIZE_UNSUPPORTED');
 if(config.senderIds.some(id=>!members.includes(id)))blockers.push('SENDER_NOT_IN_GROUP');
 const states=members.length?(await db.query(`SELECT s.*,p.continuity_mode,p.paused AS pool_paused,p.breaker_open,p.enabled,p.archived_at FROM warmup_states s JOIN warmup_pools p ON p.id=s.pool_id WHERE s.workspace_id=$1 AND s.environment=$2 AND s.account_id=ANY($3::uuid[]) ORDER BY s.account_id`,[db.workspaceId,environment,members])).rows:[];
 if(states.length!==members.length)blockers.push('QR_ENROLLMENT_PENDING');
 if(states.some(s=>s.paused||s.confirmed_block||s.breaker_open||s.pool_paused&&s.pool_id!==target?.pool_id))blockers.push('MEMBER_PAUSED_OR_PROTECTED');
 const reservations=(await db.query('SELECT account_id,program_id FROM warmup_account_reservations WHERE account_id=ANY($1::uuid[]) ORDER BY account_id',[members])).rows;
 if(reservations.some(r=>r.program_id!==programId))blockers.push('NUMBER_ALREADY_RESERVED');
 const uncertain=(await db.query("SELECT count(*)::int count FROM outbox o JOIN warmup_turns t ON t.effect_id=o.id WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND (o.account_id=ANY($3::text[]) OR t.recipient_ids && $3::uuid[] OR o.contact_id=ANY($3::text[])) AND o.status IN('SENDING','UNKNOWN','SENT')",[db.workspaceId,environment,members])).rows[0].count;
 if(uncertain)blockers.push('WARMUP_RECONCILIATION_REQUIRED');
 try{await groupQrAuthorities(db,environment,members);}catch(e){blockers.push(e instanceof Error?e.message:'CURRENT_QR_AUTHORITY_REQUIRED');}
 const scripts=await libraryScripts(db,environment,config.libraryVersion),coverage=libraryCoverage(config,scripts);if(!coverage.sufficient)blockers.push('LIBRARY_COVERAGE_INSUFFICIENT');if(!libraryLimitsFeasible(config,scripts))blockers.push('LIBRARY_LIMITS_INFEASIBLE');
 const snapshot={config,membershipVersion:group?.version??null,members,states:states.map(s=>({id:s.account_id,pool:s.pool_id,episode:s.episode_id,identity:s.identity_id,paused:s.paused})),reservations,libraryHash:hash(stableJson(scripts))};
 return{config,groupName:group?.name??null,members,senders:config.senderIds,membershipVersion:group?.version??null,coverage,previewHash:hash(stableJson(snapshot)),blockers:[...new Set(blockers)],ready:blockers.length===0,
  outgoingBudget:groupDailyBudget(config,Math.min(14,...states.filter(s=>config.senderIds.includes(s.account_id)).map(s=>s.effective_days))+1,now),
  transition:states.filter(s=>s.continuity_mode!=='QR_GROUP').map(s=>({accountId:s.account_id,from:s.continuity_mode,effectiveDays:s.effective_days,historyPreserved:true})),ai:false};
}
export async function createGroupWarmup(db:ProfileExecutor,environment:Environment,operationId:string,config:GroupWarmupConfig,actor:string){
 return replay(db,environment,operationId,actor,{action:'create',config},async()=>{
  const p=await previewGroupWarmup(db,environment,config);need(p.membershipVersion,'GROUP_NOT_FOUND');
  const scripts=await libraryScripts(db,environment,config.libraryVersion),library=await persistLibrary(db,environment,config.libraryVersion,config.libraryVersion===BUNDLED_LIBRARY_VERSION?BUNDLED_LIBRARY_NAME:config.libraryVersion,scripts,actor,config.libraryVersion===BUNDLED_LIBRARY_VERSION?'BUNDLED':'IMPORTED');
  const profile=(await db.query('INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,$2,$3) RETURNING id',[db.workspaceId,environment,groupProfile(config)])).rows[0];
  const program=(await db.query("INSERT INTO warmup_programs(workspace_id,environment,actor_id,name,topology,purpose,group_id,profile_id,account_ids,content_ids,scope) VALUES($1,$2,$3,$4,'group','preparation',$5,$6,$7,$8,$9) RETURNING id,version,status",[db.workspaceId,environment,actor,config.name,config.groupId,profile.id,p.members,library.content_ids,{...config,mode:'QR_GROUP',membershipVersion:p.membershipVersion,libraryHash:library.sha256}])).rows[0];
  await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'warmup.program_created',aggregate_id:program.id,payload:{actor,version:program.version,mode:'QR_GROUP',external_effects:0}});return program;
 });
}
export function programConfig(program:Body){const {mode:_mode,membershipVersion:_membership,libraryHash:_library,...config}=program.scope;return groupWarmupConfigSchema.parse(config);}
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
  if(input.action==='pause'||input.action==='archive'){
   need(p.status!=='ARCHIVED'||input.action==='archive','WARMUP_ARCHIVED');
   await cancelGroupPending(db,environment,p.account_ids,input.action==='pause'?'PROGRAM_PAUSED':'PROGRAM_ARCHIVED');
   if(p.pool_id)await db.query('UPDATE warmup_pools SET paused=true,enabled=CASE WHEN $2 THEN false ELSE enabled END,archived_at=CASE WHEN $2 THEN now() ELSE archived_at END,version=version+1 WHERE id=$1',[p.pool_id,input.action==='archive']);
   if(input.action==='archive')await db.query('DELETE FROM warmup_account_reservations WHERE program_id=$1',[id]);
   await db.query('UPDATE warmup_programs SET status=$2,version=version+1,updated_at=now() WHERE id=$1',[id,input.action==='pause'?'PAUSED':'ARCHIVED']);
  }else{
   need(input.action==='start'?['DRAFT','ARCHIVED','COMPLETED'].includes(p.status):input.action==='resume'?p.status==='PAUSED':['DRAFT','PAUSED','ARCHIVED','COMPLETED'].includes(p.status),'WARMUP_ACTION_STATE_INVALID');
   const preview=await previewGroupWarmup(db,environment,config,id);need(preview.previewHash===input.previewHash,'WARMUP_PREVIEW_CHANGED');need(preview.ready,preview.blockers[0]??'WARMUP_NOT_READY');
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
   await db.query('UPDATE warmup_programs SET name=$2,group_id=$3,profile_id=$4,account_ids=$5,content_ids=$6,scope=$7,pool_id=$8,status=$9,review_hash=$10,version=version+1,updated_at=now() WHERE id=$1',[id,config.name,config.groupId,profile,preview.members,library.content_ids,{...config,mode:'QR_GROUP',membershipVersion:preview.membershipVersion,libraryHash:library.sha256},poolId,status,preview.previewHash]);
  }
  const result=await readGroupProgram(db,environment,id);await appendEvent(db,{workspace_id:db.workspaceId,environment,event_type:'warmup.program_'+input.action,aggregate_id:id,payload:{actor,version:result.version,status:result.status,operationId:input.operationId}});
  return{id,version:result.version,status:result.status};
 });
}
export async function requestGroupRefresh(db:ProfileExecutor,environment:Environment,operationId:string,accountIds:string[],actor:string){
 return replay(db,environment,operationId,actor,{action:'refresh_groups',accountIds},async()=>{await groupQrAuthorities(db,environment,accountIds);
  await db.query("INSERT INTO number_operations(id,workspace_id,environment,actor_id,action,input) VALUES($1,$2,$3,$4,'GROUP_REFRESH',$5)",[operationId,db.workspaceId,environment,actor,{account_ids:accountIds}]);return{id:operationId,state:'REQUESTED'};});
}
export async function listWarmupGroups(db:ProfileExecutor,environment:Environment){
 return(await db.query('SELECT id,name,version,members,permissions,capabilities,observed_at,expires_at FROM warmup_groups WHERE workspace_id=$1 AND environment=$2 AND retired_at IS NULL ORDER BY name,id LIMIT 100',[db.workspaceId,environment])).rows.map(g=>({...g,members:g.members.map((m:Body)=>({accountId:m.account_id,admin:m.admin,resolved:!!m.account_id})),eligible:!groupEligibility(g,g.members.map((m:Body)=>m.account_id),new Date()),reason:groupEligibility(g,g.members.map((m:Body)=>m.account_id),new Date()),capabilities:undefined}));
}
export async function groupWarmupOverview(db:ProfileExecutor,environment:Environment,id?:string,days=7){
 const programs=(await db.query("SELECT id,version,name,status,scope,pool_id,account_ids,created_at FROM warmup_programs WHERE workspace_id=$1 AND environment=$2 AND scope->>'mode'='QR_GROUP' AND ($3::uuid IS NULL OR id=$3) ORDER BY created_at DESC LIMIT 100",[db.workspaceId,environment,id??null])).rows;
 const numbers=(await db.query(`SELECT r.id,COALESCE(r.body->>'masked_number','Número') AS label,s.status,s.reason,s.group_required,s.effective_days,s.graduated_at,s.pool_id,(cs.observed_state='CONNECTED' AND cs.auth_state='VERIFIED' AND NOT cs.operational_pause) AS connected
  FROM records r LEFT JOIN warmup_states s ON s.account_id=r.id LEFT JOIN channel_sessions cs ON cs.account_id=r.id WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='channel_account' AND NOT(r.body?'deleted_at') ORDER BY r.id`,[db.workspaceId,environment])).rows;
 for(const p of programs){const stats=(await db.query(`SELECT v.local_date::text date,o.account_id,
  count(*) FILTER(WHERE o.status IN('SENT','DELIVERED','READ'))::int sent,count(*) FILTER(WHERE o.status IN('DELIVERED','READ'))::int delivered,
  count(*) FILTER(WHERE o.status IN('READY','BLOCKED'))::int pending,count(*) FILTER(WHERE o.status='UNKNOWN')::int uncertain,
  min(o.not_before) FILTER(WHERE o.status IN('READY','BLOCKED')) next_send
  FROM warmup_conversations v JOIN outbox o ON o.conversation_id=v.id::text WHERE v.pool_id=$1 AND v.local_date>=((now() AT TIME ZONE $2)::date-($3::int-1)) GROUP BY v.local_date,o.account_id ORDER BY v.local_date DESC,o.account_id`,[p.pool_id,p.scope.timezone,days])).rows;
  p.history=stats;p.numbers=numbers.filter(n=>p.account_ids.includes(n.id));p.config=programConfig(p);delete p.scope;
 }return{programs,numbers,ai:false};
}
