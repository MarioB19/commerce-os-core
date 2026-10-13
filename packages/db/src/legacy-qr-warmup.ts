import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {recordProfileExecutor} from './profile-record-context.js';
import type {QueryExecutor} from './index.js';
import {decrypt,hash,stableJson} from './index.js';
import {canonicalIdentity} from '../../messaging/src/security.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {continuousAuthorizationSchema,type ContinuousAuthorization} from '../../contracts/src/continuous-authorization.js';
import {legacyQrAdoptionSchema,legacyQrSnapshot,legacyQrSnapshotSchema,adoptionDigest,type LegacyQrSnapshot} from '../../domain/src/warmup/continuity-adoption.js';
import {lockedContinuousWorkerProfile} from './continuous-commercial.js';
const id=z.uuid().transform(v=>v.toLowerCase()),env=z.enum(['REAL','SIMULATION']);
type Environment=z.infer<typeof env>;
export class LegacyQrError extends Error{constructor(code:string){super(code);this.name='LegacyQrError';}}
function need(value:unknown,code:string):asserts value{if(!value)throw new LegacyQrError(code);}
async function now(db:ProfileExecutor){const value=(await db.query('SELECT clock_timestamp() AS now')).rows[0]?.now;need(value instanceof Date&&Number.isFinite(value.getTime()),'QR_ADOPTION_CLOCK_REQUIRED');return value;}
function owner(db:ProfileExecutor,authority:ProfileAuthority,mutation:boolean,at:Date){authorizeProfileAction(authority,{workspaceId:db.workspaceId,scope:mutation?'warmup:write':'warmup:read',mutation},at);need(authority.credential.kind==='session'&&authority.membership.role==='owner','QR_ADOPTION_OWNER_SESSION_REQUIRED');}
async function lock(db:ProfileExecutor,environment:Environment,accountId:string){env.parse(environment);id.parse(accountId);need((await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended(jsonb_build_array('qr-adoption',$1::text,$2::text,$3::uuid)::text,0)) AS acquired",[db.workspaceId,environment,accountId])).rows[0]?.acquired===true,'QR_ADOPTION_BUSY');}
async function currentGrant(db:ProfileExecutor,environment:Environment,accountId:string){
 const row=(await db.query(`SELECT a.state,s.observed_identity_ciphertext,s.expected_identity_fingerprint FROM channel_sessions s
 JOIN LATERAL (SELECT c.id FROM commands c WHERE c.workspace_id=s.workspace_id AND c.environment=s.environment AND c.resource_id=s.account_id::text
 AND c.kind='channel_command' AND c.payload->>'type'='connect' AND c.status='APPLIED' ORDER BY c.created_at DESC,c.id DESC LIMIT 1) current ON true
 JOIN continuous_authorizations a ON a.workspace_id=s.workspace_id AND a.environment=s.environment AND a.account_id=s.account_id AND a.qr_command_id=current.id
 WHERE s.workspace_id=$1 AND s.environment=$2 AND s.account_id=$3 AND s.archived_at IS NULL FOR SHARE OF a,s`,[db.workspaceId,environment,accountId])).rows[0];
 need(row,'QR_ADOPTION_CURRENT_CONNECTION_REQUIRED');const grant=continuousAuthorizationSchema.parse(row.state);
 need(grant.workspaceId===db.workspaceId&&grant.environment===environment&&grant.accountId===accountId&&grant.source.kind==='VERIFIED_QR_CONNECTION','QR_ADOPTION_SCOPE_CHANGED');
 need(!grant.revokedAt&&!grant.humanPaused&&!grant.protections.length,'QR_ADOPTION_AUTHORITY_BLOCKED');
 await db.query('SELECT lock_continuous_human_scope($1,$2,$3,$4)',[db.workspaceId,environment,accountId,grant.source]);
 need((await db.query('SELECT continuous_human_pause($1,$2,$3,$4) AS paused',[db.workspaceId,environment,accountId,grant.source])).rows[0]?.paused===false,'QR_ADOPTION_AUTHORITY_BLOCKED');
 need(typeof row.observed_identity_ciphertext==='string'&&row.observed_identity_ciphertext.length<=2048,'QR_ADOPTION_IDENTITY_REQUIRED');
 const raw=decrypt(row.observed_identity_ciphertext),canonical=canonicalIdentity(raw);
 need(raw.length<=256&&hash(raw)===grant.source.identityFingerprint&&row.expected_identity_fingerprint===grant.source.identityFingerprint&&/^wa:\d{6,18}$/.test(canonical),'QR_ADOPTION_IDENTITY_CHANGED');
 return{grant,canonical};
}
async function latest(db:ProfileExecutor,environment:Environment,accountId:string){return(await db.query('SELECT * FROM warmup_continuity_adoptions WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 ORDER BY version DESC LIMIT 1 FOR SHARE',[db.workspaceId,environment,accountId])).rows[0];}
async function snapshot(db:ProfileExecutor,environment:Environment,accountId:string,prior?:LegacyQrSnapshot){
 const row=(await db.query(`SELECT s.*,p.continuity_mode,p.authorization_id,p.archived_at,p.topology,p.purpose,p.program_id,p.group_id,pr.config,i.address_fingerprint,i.address_ciphertext
 FROM warmup_states s JOIN warmup_pools p ON p.id=s.pool_id AND p.workspace_id=s.workspace_id AND p.environment=s.environment
 JOIN warmup_profiles pr ON pr.id=s.profile_id AND pr.workspace_id=s.workspace_id AND pr.environment=s.environment
 JOIN warmup_identities i ON i.id=s.identity_id AND i.account_id=s.account_id AND i.workspace_id=s.workspace_id AND i.environment=s.environment
 WHERE s.workspace_id=$1 AND s.environment=$2 AND s.account_id=$3 FOR SHARE OF s,p`,[db.workspaceId,environment,accountId])).rows[0];
 need(row&&row.continuity_mode==='LEGACY'&&!row.archived_at,'QR_ADOPTION_LEGACY_PARTICIPANT_REQUIRED');
 const episode=row.episode_id?(await db.query('SELECT policy_version,account_id,identity_fingerprint,closed_at FROM warmup_episodes WHERE id=$1 AND workspace_id=$2 AND environment=$3',[row.episode_id,db.workspaceId,environment])).rows[0]:null;
 need(episode?episode.account_id===accountId&&!episode.closed_at&&episode.policy_version===(row.config.policy_version??'legacy-30d/v1'):(row.config.policy_version??'legacy-30d/v1')==='legacy-30d/v1','QR_ADOPTION_EPISODE_CHANGED');
 const {grant,canonical}=await currentGrant(db,environment,accountId);
 need(!episode||grant.source.kind==='VERIFIED_QR_CONNECTION'&&episode.identity_fingerprint===grant.source.identityFingerprint,'QR_ADOPTION_EPISODE_IDENTITY_CHANGED');
 need(row.address_fingerprint===hash(canonical)&&decrypt(row.address_ciphertext)===canonical,'QR_ADOPTION_HISTORICAL_IDENTITY_CHANGED');
 let contentIds:string[];
 if(prior)contentIds=prior.content.map(x=>x.id);
 else{
  const auth=(await db.query('SELECT scope,revoked_at FROM operation_authorizations WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR SHARE',[row.authorization_id,db.workspaceId,environment])).rows[0];
  need(auth&&!auth.revoked_at&&auth.scope?.mode==='warmup'&&auth.scope.pool_id===row.pool_id&&auth.scope.account_ids?.includes(accountId),'QR_ADOPTION_HISTORICAL_SCOPE_REQUIRED');
  contentIds=z.array(id).min(1).max(1000).parse(auth.scope.content_ids);
 }
 const content=(await db.query("SELECT id,content_hash,body,origin FROM warmup_content WHERE workspace_id=$1 AND environment=$2 AND id=ANY($3::uuid[]) AND origin='HUMAN_REVIEWED' ORDER BY id",[db.workspaceId,environment,contentIds])).rows;
 need(content.length===contentIds.length,'QR_ADOPTION_CONTENT_CHANGED');
 const group=row.group_id?(await db.query('SELECT version FROM warmup_groups WHERE id=$1 AND workspace_id=$2 AND environment=$3',[row.group_id,db.workspaceId,environment])).rows[0]:null;
 need(!row.group_id||group,'QR_ADOPTION_GROUP_CHANGED');
 const review=legacyQrSnapshot({workspaceId:db.workspaceId,environment,accountId,stateVersion:row.version,poolId:row.pool_id,profileId:row.profile_id,episodeId:row.episode_id,topology:row.topology,purpose:row.purpose,programId:row.program_id,groupId:row.group_id,groupVersion:group?.version??null,identityFingerprint:grant.source.kind==='VERIFIED_QR_CONNECTION'?grant.source.identityFingerprint:'',grantId:grant.id,connectionId:grant.source.kind==='VERIFIED_QR_CONNECTION'?grant.source.connectionId:'',config:row.config,content});
 return{...review,grant,topology:row.topology,purpose:row.purpose,programId:row.program_id,groupId:row.group_id};
}
export async function reviewLegacyQrAdoption(db:ProfileExecutor,environment:Environment,accountId:string,authority:ProfileAuthority){
 owner(db,authority,false,await now(db));accountId=id.parse(accountId);await lock(db,environment,accountId);
 need(!await latest(db,environment,accountId),'QR_ADOPTION_ALREADY_EXISTS');const reviewed=await snapshot(db,environment,accountId);owner(db,authority,false,await now(db));return{snapshot:reviewed.snapshot,sha256:reviewed.sha256};
}
async function insert(db:ProfileExecutor,review:Awaited<ReturnType<typeof snapshot>>,input:{operationId:string;actorId:string;requestHash:string;prior?:any}){
 const s=review.snapshot,previous=input.prior;
 const row=(await db.query(`INSERT INTO warmup_continuity_adoptions(id,workspace_id,environment,account_id,pool_id,profile_id,episode_id,version,previous_id,origin,operation_id,actor_id,grant_id,identity_fingerprint,policy_version,snapshot,request_sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,[randomUUID(),db.workspaceId,s.environment,s.accountId,s.poolId,s.profileId,s.episodeId,previous?previous.version+1:1,previous?.id??null,previous?'QR_RELINK':'MIGRATION_QR',input.operationId,input.actorId,s.grantId,s.identityFingerprint,s.policyVersion,s,input.requestHash])).rows[0];
 need(row&&stableJson(row.snapshot)===stableJson(s),'QR_ADOPTION_WRITE_UNCONFIRMED');
 await db.query('INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,payload) VALUES($1,$2,$3,$4,$5,$5,$6)',[randomUUID(),db.workspaceId,s.environment,previous?'warmup.continuity.relinked':'warmup.continuity.adopted',s.accountId,{adoption_id:row.id,operation_id:input.operationId,previous_id:previous?.id??null,grant_id:s.grantId,snapshot_sha256:review.sha256,policy_version:s.policyVersion,episode_id:s.episodeId}]);return row;
}
export async function adoptLegacyQrWarmup(db:ProfileExecutor,environment:Environment,raw:unknown,authority:ProfileAuthority){
 owner(db,authority,true,await now(db));const command=legacyQrAdoptionSchema.parse(raw);await lock(db,environment,command.accountId);
 const requestHash=adoptionDigest({environment,workspaceId:db.workspaceId,actorId:authority.membership.userId,...command});
 const replay=(await db.query('SELECT * FROM warmup_continuity_adoptions WHERE workspace_id=$1 AND environment=$2 AND operation_id=$3',[db.workspaceId,environment,command.operationId])).rows[0];
 if(replay){need(replay.request_sha256===requestHash,'QR_ADOPTION_OPERATION_CONFLICT');owner(db,authority,true,await now(db));return replay;}
 need(!await latest(db,environment,command.accountId),'QR_ADOPTION_ALREADY_EXISTS');const review=await snapshot(db,environment,command.accountId);
 need(review.snapshot.stateVersion===command.expectedStateVersion&&review.sha256===command.snapshotSha256,'QR_ADOPTION_REVIEW_CHANGED');owner(db,authority,true,await now(db));return insert(db,review,{operationId:command.operationId,actorId:authority.membership.userId,requestHash});
}
export type LegacyQrAuthority={kind:'LEGACY'}|{kind:'ADOPTED';adoptionId:string;grant:ContinuousAuthorization;contentIds:string[];snapshot:LegacyQrSnapshot}|{kind:'BLOCKED';reason:string};
/** A missing adoption is the only legacy result. A stale, revoked or changed
 * adoption never falls back to the pool's temporal permission. */
export async function currentLegacyQrAuthority(db:ProfileExecutor,environment:Environment,accountId:string):Promise<LegacyQrAuthority>{
 accountId=id.parse(accountId);await lock(db,environment,accountId);let previous=await latest(db,environment,accountId);if(!previous)return{kind:'LEGACY'};
 // Only an existing adoption needs the live worker profile (role/state lock).
 await lockedContinuousWorkerProfile(db);
 try{
  const prior=legacyQrSnapshotSchema.parse(previous.snapshot),review=await snapshot(db,environment,accountId,prior);
  const comparable=(s:LegacyQrSnapshot)=>{const{stateVersion:_state,grantId:_grant,connectionId:_connection,...rest}=s;return rest;};
  need(stableJson(comparable(prior))===stableJson(comparable(review.snapshot)),'QR_ADOPTION_PROGRAM_OR_IDENTITY_CHANGED');
  if(prior.grantId!==review.grant.id){previous=await insert(db,review,{operationId:randomUUID(),actorId:previous.actor_id,requestHash:adoptionDigest({previous:previous.id,snapshot:review.snapshot}),prior:previous});}
  return{kind:'ADOPTED',adoptionId:previous.id,grant:review.grant,contentIds:prior.content.map(x=>x.id),snapshot:review.snapshot};
 }catch(error){if(error instanceof LegacyQrError)return{kind:'BLOCKED',reason:error.message};throw error;}
}

/** Legacy fixtures can run before transition016; once it exists, adoption is
 * read only through the live profile executor. A blocked participant is not a
 * legacy participant and cannot borrow the pool's temporal permission. */
export async function legacyPoolAuthorities(executor:QueryExecutor,workspaceId:string,environment:Environment,accountIds:readonly string[]){
 const result=new Map<string,LegacyQrAuthority>();
 if(!(await executor.query("SELECT to_regclass('public.warmup_continuity_adoptions') AS present")).rows[0]?.present)return result;
 // Worker transactions planning one explicit pool bind to that pool's own
 // profile (never a convenience selection); an established scope must match.
 const db=(executor as ProfileExecutor).workspaceId===workspaceId?executor as ProfileExecutor:await recordProfileExecutor(executor,workspaceId,env.parse(environment));
 need(db,'QR_ADOPTION_PROFILE_CONTEXT_REQUIRED');
 for(const accountId of accountIds)result.set(accountId,await currentLegacyQrAuthority(db,environment,accountId));return result;
}

/** Bind every participant of a newly planned adopted/mixed conversation. The
 * SQL guard requires the new effect and exact native conversation membership. */
export async function bindLegacyWarmupEffectOrigins(db:QueryExecutor,scope:{workspaceId:string;environment:Environment;effectId:string;accountIds:readonly string[]},origins:ReadonlyMap<string,LegacyQrAuthority>,legacyAuthorizationId:string|null){
 if(!scope.accountIds.some(account=>origins.get(account)?.kind==='ADOPTED'))return;
 need(new Set(scope.accountIds).size===scope.accountIds.length&&scope.accountIds.length>=2&&scope.accountIds.length<=20,'QR_EFFECT_PARTICIPANTS_REQUIRED');
 for(const account of [...scope.accountIds].sort()){
  const origin=origins.get(account);need(origin?.kind!=='BLOCKED','QR_EFFECT_PARTICIPANT_BLOCKED');
  const adopted=origin?.kind==='ADOPTED'?origin:null;need(adopted||legacyAuthorizationId,'QR_EFFECT_PARTICIPANT_AUTHORITY_REQUIRED');
  await db.query('INSERT INTO warmup_effect_origins(effect_id,workspace_id,environment,participant_id,adoption_id,grant_id,legacy_authorization_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[id.parse(scope.effectId),scope.workspaceId,env.parse(scope.environment),id.parse(account),adopted?.adoptionId??null,adopted?.grant.id??null,adopted?null:id.parse(legacyAuthorizationId)]);
 }
}
/** Pure native readback for the final gate. This does not relink old effects or
 * grant permission; the gate still revalidates each fixed source and readiness. */
export async function readLegacyWarmupEffectOrigins(db:ProfileExecutor,environment:Environment,effectId:string){
 env.parse(environment);effectId=id.parse(effectId);
 const rows=(await db.query(`SELECT o.*,a.snapshot,a.policy_version,a.pool_id,a.profile_id,a.episode_id FROM warmup_effect_origins o
 LEFT JOIN warmup_continuity_adoptions a ON a.id=o.adoption_id AND a.workspace_id=o.workspace_id AND a.environment=o.environment
 WHERE o.workspace_id=$1 AND o.environment=$2 AND o.effect_id=$3 ORDER BY o.participant_id`,[db.workspaceId,environment,effectId])).rows;
 // Historical effects have no origins; bound origins need the live worker profile.
 if(rows.length)await lockedContinuousWorkerProfile(db);
 return rows;
}

/** Final-gate authority only; health/readiness/rates/causal receipts stay in the
 * channel gate. Does not adopt/relink, mutate origins, or refresh an old effect. */
export async function validateLegacyWarmupEffectOrigins(db:ProfileExecutor,scope:{environment:Environment;effectId:string;senderId:string;accountIds:readonly string[];poolId:string;profileId:string;contentId:string;policyVersion:string;purpose:string;groupId:string|null;groupVersion:number|null;configurationVersion:number}){
 const blocked=(reason:string)=>({kind:'BLOCKED' as const,reason});
 const effect=(await db.query('SELECT * FROM outbox WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR SHARE',[id.parse(scope.effectId),db.workspaceId,env.parse(scope.environment)])).rows[0];
 if(!effect||effect.kind!=='warmup'||effect.account_id!==scope.senderId)return blocked('QR_EFFECT_SCOPE_CHANGED');
 const origins=await readLegacyWarmupEffectOrigins(db,scope.environment,scope.effectId);
 if(!origins.length)return effect.continuous_authorization_id?blocked('QR_EFFECT_ORIGINS_REQUIRED'):{kind:'HISTORICAL' as const};
 if(origins.length!==scope.accountIds.length||new Set(scope.accountIds).size!==scope.accountIds.length||origins.some(row=>!scope.accountIds.includes(row.participant_id)))return blocked('QR_EFFECT_PARTICIPANTS_CHANGED');
 const temporal=new Map<string,any>();
 for(const origin of origins){
  if(origin.adoption_id){
   try{
    const prior=legacyQrSnapshotSchema.parse(origin.snapshot);
    if(prior.poolId!==scope.poolId||prior.profileId!==scope.profileId||prior.policyVersion!==scope.policyVersion||prior.purpose!==scope.purpose||prior.groupId!==scope.groupId||prior.groupVersion!==scope.groupVersion||!prior.content.some(c=>c.id===scope.contentId)||prior.grantId!==origin.grant_id)return blocked('QR_EFFECT_ADOPTION_CHANGED');
    const current=await snapshot(db,scope.environment,origin.participant_id,prior);
    const fixed=(s:LegacyQrSnapshot)=>{const{stateVersion:_version,...rest}=s;return rest;};
    if(stableJson(fixed(current.snapshot))!==stableJson(fixed(prior)))return blocked('QR_EFFECT_ADOPTION_CHANGED');
    if(origin.participant_id===scope.senderId&&(effect.continuous_authorization_id!==origin.grant_id||effect.authorization_id))return blocked('QR_EFFECT_ADOPTION_CHANGED');
   }catch(error){if(error instanceof LegacyQrError)return blocked(error.message);throw error;}
  }else{
   let auth=temporal.get(origin.legacy_authorization_id);
   if(!auth){auth=(await db.query('SELECT * FROM read_locked_operation_authorization($1,$2,$3)',[origin.legacy_authorization_id,db.workspaceId,scope.environment])).rows[0];if(auth)temporal.set(auth.id,auth);}
   const permission=auth?.scope;
   if(!auth||auth.configuration_version!==scope.configurationVersion||permission.mode!=='warmup'||permission.pool_id!==scope.poolId||!permission.account_ids?.includes(origin.participant_id)||!permission.content_ids?.includes(scope.contentId)||permission.policy_version&&permission.policy_version!==scope.policyVersion||scope.groupId&&(permission.group_id!==scope.groupId||permission.membership_version!==scope.groupVersion||permission.purpose!==scope.purpose))return blocked('QR_EFFECT_LEGACY_CHANGED');
   if(origin.participant_id===scope.senderId&&(effect.authorization_id!==auth.id||effect.continuous_authorization_id))return blocked('QR_EFFECT_LEGACY_CHANGED');
  }
 }
 for(const auth of temporal.values()){
  const used=(await db.query(`SELECT count(*)::int total,count(*) FILTER(WHERE account_id=$3)::int sender FROM outbox o WHERE workspace_id=$4 AND environment=$5 AND id<>$2 AND status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN') AND
   (authorization_id=$1 OR EXISTS(SELECT 1 FROM warmup_effect_origins x WHERE x.effect_id=o.id AND x.legacy_authorization_id=$1 AND x.workspace_id=o.workspace_id AND x.environment=o.environment))`,[auth.id,effect.id,scope.senderId,db.workspaceId,scope.environment])).rows[0];
  if(!Number.isSafeInteger(auth.scope.max_messages)||!used||used.total>=auth.scope.max_messages)return blocked('AUTHORIZATION_MESSAGE_LIMIT');
  if(scope.groupId&&origins.some(o=>o.participant_id===scope.senderId&&o.legacy_authorization_id===auth.id)&&(!Number.isSafeInteger(auth.scope.sender_limits?.[scope.senderId])||used.sender>=auth.scope.sender_limits[scope.senderId]))return blocked('AUTHORIZATION_MESSAGE_LIMIT');
 }
 const checkedAt=await now(db);
 if([...temporal.values()].some(auth=>!Number.isFinite(new Date(auth.expires_at).getTime())||new Date(auth.expires_at)<=checkedAt))return blocked('QR_EFFECT_LEGACY_EXPIRED');
 return{kind:'BOUND' as const,origins,temporalExpiresAt:temporal.size?new Date(Math.min(...[...temporal.values()].map(auth=>new Date(auth.expires_at).getTime()))):null};
}
