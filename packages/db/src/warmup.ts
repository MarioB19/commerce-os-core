import {recordProfileExecutor} from './profile-record-context.js';
import type {CanonicalEvent} from '../../messaging/src/types.js';
import type {Environment,DomainRecord,Body} from '../../contracts/src/index.js';
import {canonicalIdentity} from '../../messaging/src/security.js';
import {isStandard15dPolicy,warmupProfileSchema,type WarmupProfile} from '../../domain/src/warmup/policy.js';
import {hash,encrypt,decrypt,appendEvent,type QueryExecutor} from './index.js';
import {readCurrentQrContinuity,continuousWarmupAuthorityBlock} from './continuous-warmup.js';
import {readEffectiveHealthBatch,currentEffectiveSignal,currentRestrictionClear,effectiveHealthBlockers} from './effective-health.js';

export async function warmupOverview(c:QueryExecutor,workspace:string,environment:Environment,resourceIds?:string[]){
 const pool=(await c.query('SELECT * FROM warmup_pools WHERE workspace_id=$1 AND environment=$2 AND program_id IS NULL ORDER BY created_at,id',[workspace,environment])).rows[0];
 if(!pool)return{installed:true,enabled:false,pool:null,accounts:[],plans:[],pair_stats:[],jobs:[],provider_verified:false};
 const states=(await c.query(`SELECT s.*,p.config profile,i.profile_verified_at,i.profile_operation_status,i.profile_review_requested_at,i.id IS NOT NULL identity_present FROM warmup_states s JOIN warmup_profiles p ON p.id=s.profile_id LEFT JOIN warmup_identities i ON i.id=s.identity_id WHERE s.pool_id=$1 AND ($2::text[] IS NULL OR s.account_id::text=ANY($2)) ORDER BY s.created_at`,[pool.id,resourceIds??null])).rows;
 const plans=(await c.query(`SELECT p.*, (SELECT count(*)::int FROM warmup_turns t JOIN outbox o ON o.id=t.effect_id WHERE (t.sender_id=p.account_id OR t.recipient_id=p.account_id) AND o.status IN('DELIVERED','READ') AND t.conversation_id IN(SELECT id FROM warmup_conversations WHERE local_date=p.local_date)) delivered_messages FROM warmup_plans p WHERE workspace_id=$1 AND environment=$2 AND ($3::text[] IS NULL OR p.account_id::text=ANY($3)) ORDER BY local_date DESC LIMIT 100`,[workspace,environment,resourceIds??null])).rows;
 const jobs=resourceIds?[]:(await c.query('SELECT kind,window_key,status,started_at,finished_at,result FROM warmup_schedule_runs WHERE pool_id=$1 ORDER BY started_at DESC LIMIT 12',[pool.id])).rows;
 // Match the scheduler's lifetime planned-conversation denominator. These are
 // distribution counters, never proof of delivery. Restricted clients need both peers.
 const pairStats=(await c.query(`WITH pairs AS (
  SELECT p.account_a,p.account_b,sum(p.conversations)::int conversations
  FROM warmup_pair_stats p JOIN warmup_states a ON a.account_id::text=p.account_a
  JOIN warmup_states b ON b.account_id::text=p.account_b
  WHERE p.workspace_id=$1 AND p.environment=$2 AND a.pool_id=$3 AND b.pool_id=$3
  GROUP BY p.account_a,p.account_b
 ),totals AS (
  SELECT endpoint.account_id,sum(p.conversations)::int total FROM pairs p
  CROSS JOIN LATERAL (VALUES(p.account_a),(p.account_b)) endpoint(account_id) GROUP BY endpoint.account_id
 ) SELECT p.*,a.total total_a,b.total total_b FROM pairs p
 JOIN totals a ON a.account_id=p.account_a JOIN totals b ON b.account_id=p.account_b
 WHERE $4::text[] IS NULL OR (p.account_a=ANY($4) AND p.account_b=ANY($4))
 ORDER BY p.conversations DESC,p.account_a,p.account_b`,[workspace,environment,pool.id,resourceIds??null])).rows;
 const providerEvidence=(await c.query("SELECT id,observed_at,expires_at,source,details FROM operational_evidence WHERE workspace_id=$1 AND environment=$2 AND kind='provider_capability' AND status='VERIFIED' AND observed_at<=now() AND expires_at>now() ORDER BY observed_at DESC",[workspace,environment])).rows.find(e=>states.length>=2&&states.every(s=>e.details.resource_ids?.includes(s.account_id))&&e.details.capabilities?.includes('text'));
 return{installed:true,enabled:pool.enabled,pool:resourceIds?{id:pool.id,enabled:pool.enabled,paused:pool.paused,breaker_open:pool.breaker_open}:pool,accounts:states.map(({identity_id:_identity,...s})=>s),plans,pair_stats:pairStats,jobs,provider_verified:!!providerEvidence,provider_evidence:providerEvidence?{id:providerEvidence.id,observed_at:providerEvidence.observed_at,expires_at:providerEvidence.expires_at,source:providerEvidence.source}:null};
}
export async function commercialWarmupGuard(c:QueryExecutor,account:DomainRecord){
 const state=(await c.query("SELECT s.status,s.paused,s.confirmed_block,s.pool_id,s.profile_ready_at,p.enabled,p.paused AS pool_paused,p.breaker_open,to_jsonb(p)->>'continuity_mode' AS continuity_mode,i.address_fingerprint,i.address_ciphertext,to_jsonb(i)->>'qr_verified_at' qr_verified_at,to_jsonb(i)->>'qr_command_id' qr_command_id,to_jsonb(i)->>'qr_identity_fingerprint' qr_identity_fingerprint FROM warmup_states s JOIN warmup_pools p ON p.id=s.pool_id LEFT JOIN warmup_identities i ON i.id=s.identity_id AND i.account_id=s.account_id WHERE s.account_id=$1 AND s.workspace_id=$2 AND s.environment=$3 AND (s.enrolled_at IS NOT NULL OR p.enabled)",[account.id,account.workspace_id,account.environment])).rows[0];
 if(isStandard15dPolicy(account.body.number_policy_version)&&!state)return 'ACCOUNT_PREPARATION_REQUIRED';
 if(state&&account.environment==='REAL'&&account.body.provider==='waha'&&!warmupIdentityMatches(account,state))return 'WARMUP_REGISTERED_IDENTITY_CHANGED';
 if(state?.continuity_mode==='QR_CONTINUOUS'&&['AWAITING_PEER','WARMING','AWAITING_CONTENT'].includes(state.status)
  &&!state.paused&&!state.confirmed_block&&state.enabled&&!state.pool_paused&&!state.breaker_open){
  const db=await recordProfileExecutor(c,account.workspace_id,account.environment);
  const own=await readCurrentQrContinuity(db,account.environment,account.id);
  if(own&&!own.revokedAt&&!own.humanPaused&&!own.protections.length){
   const now=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
   const matchesOrigin=(identity:Body,grant:typeof own|undefined)=>grant?.source.kind==='VERIFIED_QR_CONNECTION'&&identity.qr_verified_at&&new Date(identity.qr_verified_at)<=now&&identity.qr_command_id===grant.source.connectionId&&identity.qr_identity_fingerprint===grant.source.identityFingerprint;
   if(!state.profile_ready_at||new Date(state.profile_ready_at)>now||!matchesOrigin(state,own))return 'ACCOUNT_WARMING';
   const candidates=(await c.query(`SELECT r.*,i.address_fingerprint,i.address_ciphertext,to_jsonb(i)->>'qr_verified_at' qr_verified_at,to_jsonb(i)->>'qr_command_id' qr_command_id,to_jsonb(i)->>'qr_identity_fingerprint' qr_identity_fingerprint FROM warmup_states s
    JOIN records r ON r.id=s.account_id AND r.workspace_id=s.workspace_id AND r.environment=s.environment
    JOIN warmup_identities i ON i.id=s.identity_id AND i.account_id=s.account_id
    JOIN channel_sessions cs ON cs.account_id=s.account_id AND cs.workspace_id=s.workspace_id AND cs.environment=s.environment
    JOIN session_ownership o ON o.account_id=s.account_id::text AND o.workspace_id=s.workspace_id
    WHERE s.pool_id=$1 AND s.workspace_id=$2 AND s.environment=$3 AND s.account_id<>$4
     AND s.paused=false AND NOT s.confirmed_block AND s.profile_ready_at<=$5 AND s.status IN('AWAITING_PEER','WARMING','AWAITING_CONTENT','GRADUATED')
     AND r.body->>'status'='WORKING' AND NOT(r.body?'deleted_at') AND r.body->>'identity_verified'='true'
     AND cs.desired_state='RUNNING' AND NOT cs.operational_pause AND cs.observed_state='CONNECTED' AND cs.auth_state='VERIFIED'
     AND cs.archived_at IS NULL AND cs.health_expires_at>$5 AND NOT o.frozen AND o.lease_expires_at>$5
     AND NOT EXISTS(SELECT 1 FROM manual_controls m WHERE m.workspace_id=s.workspace_id
      AND (m.scope_type='workspace' AND m.scope_id=s.workspace_id OR m.scope_type='channel_account' AND m.scope_id=s.account_id::text)
      AND (m.paused OR m.suppressed OR m.takeover))
    ORDER BY s.account_id LIMIT 21`,[state.pool_id,account.workspace_id,account.environment,account.id,now])).rows;
   if(candidates.length>20)return 'WARMUP_PEER_INVENTORY_OVERFLOW';
   const health=await readEffectiveHealthBatch(c,{workspaceId:account.workspace_id,environment:account.environment,accountIds:candidates.map(p=>p.id),now});
   let eligible=false;
   for(const peer of candidates){
    const other=await readCurrentQrContinuity(db,account.environment,peer.id),h=health.get(peer.id)!;
    if(!continuousWarmupAuthorityBlock(own,other,{workspaceId:account.workspace_id,environment:account.environment,senderId:account.id,peerId:peer.id})
     &&matchesOrigin(peer,other)&&warmupIdentityMatches(peer,peer)&&currentEffectiveSignal(h,'session')?.status==='OK'
     &&currentEffectiveSignal(h,'transport')?.status==='OK'&&(currentEffectiveSignal(h,'transport')?.value as Body|undefined)?.identity_fingerprint===peer.body.identity_fingerprint&&currentRestrictionClear(h)&&!effectiveHealthBlockers(h).length){eligible=true;break;}
   }
   // D17: lack of an eligible own peer must not stop customer inbound. Other
   // commercial consent, health, pause and authority gates still run normally.
   if(!eligible)return null;
  }
 }
 if(state&&state.status!=='GRADUATED')return 'ACCOUNT_WARMING';
 return state&&account.environment==='REAL'&&account.body.provider==='waha'&&!warmupIdentityMatches(account,state)?'WARMUP_REGISTERED_IDENTITY_CHANGED':null;
}
/** A verified session is insufficient: its number must still be the registered own address. */
export function warmupIdentityMatches(account:DomainRecord,identity:{address_fingerprint?:string;address_ciphertext?:string}){
 if(account.environment==='SIMULATION')return true;
 if(!identity.address_ciphertext||!identity.address_fingerprint||typeof account.body.identity_fingerprint!=='string')return false;
 try{
  const registered=decrypt(identity.address_ciphertext),digits=/^wa:(\d{6,18})$/.exec(registered)?.[1];
  if(!digits||hash(registered)!==identity.address_fingerprint)return false;
  // These are exactly the telephone representations accepted by canonicalIdentity.
  // A provider may switch JID suffix while retaining the same verified number.
  const representations=[registered,...['','+'].flatMap(prefix=>['','@c.us','@s.whatsapp.net'].map(suffix=>prefix+digits+suffix))];
  return representations.some(value=>canonicalIdentity(value)===registered&&hash(value)===account.body.identity_fingerprint);
 }catch{return false;}
}
export async function classifyInternalWarmup(c:QueryExecutor,account:DomainRecord,identity:string|undefined,evidenceRef:string,observedAt:string,normalized?:CanonicalEvent){
 if(!identity)return false;
 const peer=(await c.query(`SELECT i.account_id FROM warmup_identities i JOIN warmup_states a ON a.account_id=$1 AND a.workspace_id=i.workspace_id AND a.environment=i.environment JOIN warmup_states b ON b.account_id=i.account_id AND b.pool_id=a.pool_id WHERE i.workspace_id=$2 AND i.environment=$3 AND i.address_fingerprint=$4 AND i.account_id<>a.account_id`,[account.id,account.workspace_id,account.environment,hash(canonicalIdentity(identity))])).rows[0];
 if(!peer)return false;
 await c.query(`INSERT INTO warmup_observations(workspace_id,environment,account_id,kind,evidence_ref,observed_at) VALUES($1,$2,$3,'INTERNAL_MESSAGE',$4,$5) ON CONFLICT DO NOTHING`,[account.workspace_id,account.environment,account.id,evidenceRef,observedAt]);
 let turn:Body|undefined;
 if(normalized?.providerMessageId){turn=(await c.query(`SELECT t.id,t.effect_id,t.conversation_id,t.position FROM warmup_turns t JOIN outbox o ON o.id=t.effect_id WHERE t.workspace_id=$1 AND t.environment=$2 AND t.sender_id=$3 AND t.recipient_id=$4 AND o.provider_message_id=$5`,[account.workspace_id,account.environment,peer.account_id,account.id,normalized.providerMessageId])).rows[0];
 if(turn)await c.query('UPDATE warmup_turns SET received_envelope_id=COALESCE(received_envelope_id,$2),received_at=COALESCE(received_at,$3) WHERE id=$1',[turn.id,evidenceRef,observedAt]);}
 await appendEvent(c,{workspace_id:account.workspace_id,environment:account.environment,event_type:'warmup.internal_message_observed',aggregate_id:account.id,payload:{peer_account_id:peer.account_id,evidence_ref:evidenceRef,provider_message_id:normalized?.providerMessageId??null,turn_id:turn?.id??null,effect_id:turn?.effect_id??null,conversation_id:turn?.conversation_id??null,correlated:!!turn},occurred_at:observedAt});return true;
}
/** Own-address verification compares the exact provider fingerprint, while routing uses canonical identity. */
export async function registerWarmupIdentity(c:QueryExecutor,account:DomainRecord,input:{provider_identity:string;name:string;about:string;avatar_asset_id?:string;ownership_evidence:string}){
 const identity=canonicalIdentity(input.provider_identity);
 if(!identity.startsWith('wa:')||account.body.identity_verified!==true||account.body.identity_conflict===true||![hash(input.provider_identity),hash(identity)].includes(account.body.identity_fingerprint))throw new Error('WARMUP_IDENTITY_NOT_VERIFIED');
 if(input.avatar_asset_id&&!((await c.query("SELECT id FROM records WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='asset' AND body->>'kind'='file' AND body->>'mime_type' LIKE 'image/%' AND body->>'status'='READY'",[input.avatar_asset_id,account.workspace_id,account.environment])).rowCount))throw new Error('WARMUP_AVATAR_INVALID');
 const existing=(await c.query('SELECT id,address_fingerprint FROM warmup_identities WHERE account_id=$1',[account.id])).rows[0];
 if(existing){if(existing.address_fingerprint!==hash(identity))throw new Error('WARMUP_IDENTITY_CONFLICT');return{id:existing.id,already_registered:true};}
 const row=(await c.query('INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id',[account.workspace_id,account.environment,account.id,hash(identity),encrypt(identity),encrypt({name:input.name,about:input.about,avatar_asset_id:input.avatar_asset_id}),input.ownership_evidence])).rows[0];return{id:row.id,already_registered:false};
}
export async function profileFor(c:QueryExecutor,id:string):Promise<WarmupProfile>{const row=(await c.query('SELECT config FROM warmup_profiles WHERE id=$1',[id])).rows[0];return warmupProfileSchema.parse({...row?.config,policy_version:row?.config?.policy_version??'legacy-30d/v1'});}

/** Called twice by the shared dispatcher. Reservation is durable and idempotent per effect + endpoint. */
export async function reserveWarmupRate(c:QueryExecutor,effect:Body,accountIds:string[],limit:number,now:Date){
 const window=new Date(Math.floor(now.getTime()/60000)*60000);
 for(const id of [...accountIds].sort())await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`warmup-rate:${id}`]);
 const missing:string[]=[];
 for(const id of accountIds){
  const existing=(await c.query('SELECT window_start FROM warmup_rate_reservations WHERE effect_id=$1 AND account_id=$2',[effect.id,id])).rows[0];
  if(existing&&new Date(existing.window_start).getTime()===window.getTime())continue;
  const row=(await c.query('SELECT used FROM warmup_rate_buckets WHERE account_id=$1 AND window_start=$2',[id,window])).rows[0];if(Number(row?.used??0)>=limit)return false;missing.push(id);
 }
 // A boundary-crossing final guard consumes the new minute too; old consumption is retained.
 for(const id of missing){await c.query('INSERT INTO warmup_rate_buckets(account_id,window_start,used) VALUES($1,$2,1) ON CONFLICT(account_id,window_start) DO UPDATE SET used=warmup_rate_buckets.used+1',[id,window]);await c.query('INSERT INTO warmup_rate_reservations(effect_id,account_id,window_start) VALUES($1,$2,$3) ON CONFLICT(effect_id,account_id) DO UPDATE SET window_start=EXCLUDED.window_start',[effect.id,id,window]);}return true;
}
