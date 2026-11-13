import {recordProfileExecutor} from './profile-record-context.js';
import type {CanonicalEvent,ProviderGroup} from '../../messaging/src/types.js';
import type {Body,DomainRecord} from '../../contracts/src/index.js';
import {canonicalIdentity} from '../../messaging/src/security.js';
import {groupMessageIdentity,sameGroupMessage} from '../../messaging/src/group-message-id.js';
import {hash,encrypt,decrypt,stableJson,appendEvent,type QueryExecutor} from './index.js';

export async function observeGroup(c:QueryExecutor,account:DomainRecord,snapshot:ProviderGroup,now=new Date()){
 if(!snapshot.complete||snapshot.runtime.engine!==String(account.body.engine??'SIMULATOR')||Date.parse(snapshot.observedAt)>now.getTime()+1000)throw new Error('GROUP_CAPABILITY_UNVERIFIED');
 // Same first lock as QR group planning, commands and final emission. Taking
 // a group row first would invert program/group locks during membership changes.
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`group-warmup:${account.workspace_id}:${account.environment}`]);
 // V7.4 C: a member is one of this profile's own lines only through an
 // explicit identity: its warm-up registration or the identity its own QR
 // session observed. Everyone else is an external participant; it keeps the
 // provider's opaque identity hash and never an account, grant or state.
 const own=new Map<string,string>();
 for(const row of (await c.query(`SELECT i.account_id,i.address_fingerprint FROM warmup_identities i JOIN records r ON r.id=i.account_id AND r.workspace_id=i.workspace_id AND r.environment=i.environment
  WHERE i.workspace_id=$1 AND i.environment=$2 AND r.kind='channel_account' AND NOT(r.body?'deleted_at') ORDER BY i.account_id`,[account.workspace_id,account.environment])).rows)own.set(row.address_fingerprint,row.account_id);
 for(const row of (await c.query(`SELECT s.account_id,s.observed_identity_ciphertext,s.expected_identity_fingerprint FROM channel_sessions s JOIN records r ON r.id=s.account_id AND r.workspace_id=s.workspace_id AND r.environment=s.environment
  WHERE s.workspace_id=$1 AND s.environment=$2 AND s.archived_at IS NULL AND s.observed_identity_ciphertext IS NOT NULL AND r.kind='channel_account' AND NOT(r.body?'deleted_at')
   AND r.body->>'ownership_confirmed_at' IS NOT NULL AND r.body->>'identity_fingerprint'=s.expected_identity_fingerprint ORDER BY s.account_id`,[account.workspace_id,account.environment])).rows){
  let raw:string;try{raw=decrypt(row.observed_identity_ciphertext);}catch{continue;}
  if(hash(raw)!==row.expected_identity_fingerprint)continue;
  const canonical=canonicalIdentity(raw);if(!/^wa:\d{6,18}$/.test(canonical))continue;
  const key=hash(canonical);if(own.has(key)&&own.get(key)!==row.account_id)throw new Error('GROUP_OWN_IDENTITY_AMBIGUOUS');
  own.set(key,row.account_id);
 }
 const members=snapshot.members.map(m=>({account_id:(m.verifiedIdentity?own.get(hash(canonicalIdentity(m.verifiedIdentity))):undefined)??null,identity_hash:hash(m.identity),verified_hash:m.verifiedIdentity?hash(canonicalIdentity(m.verifiedIdentity)):null,admin:m.admin,mapping_source:m.mappingSource})).sort((a,b)=>a.identity_hash.localeCompare(b.identity_hash));
 if(new Set(members.filter(m=>m.account_id).map(m=>m.account_id)).size!==members.filter(m=>m.account_id).length)throw new Error('GROUP_OWN_IDENTITY_AMBIGUOUS');
 const fingerprint=hash(snapshot.id);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`group:${account.workspace_id}:${account.environment}:${fingerprint}`]);
 const old=(await c.query('SELECT * FROM warmup_groups WHERE workspace_id=$1 AND environment=$2 AND provider=$3 AND group_fingerprint=$4 FOR UPDATE',[account.workspace_id,account.environment,account.body.provider,fingerprint])).rows[0];
 const permissions={admin_only:snapshot.adminOnly},changed=old&&(stableJson(old.members)!==stableJson(members)||stableJson(old.permissions)!==stableJson(permissions));
 const observations:Body=changed?{}:old?.capabilities?.observations??{};observations[account.id]={observed_at:now.toISOString(),runtime:snapshot.runtime};
 const capabilities={protocol:'v1',observations,all_members_resolved:members.every(m=>m.account_id&&m.verified_hash),own_members:members.filter(m=>m.account_id).length,external_members:members.filter(m=>!m.account_id).length,member_read:true,authenticated_receive:true};
 const row=(await c.query(`INSERT INTO warmup_groups(workspace_id,environment,provider,group_fingerprint,group_ciphertext,name,members,permissions,capabilities,observed_at,expires_at,source)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'provider_read') ON CONFLICT(workspace_id,environment,provider,group_fingerprint) DO UPDATE SET members=EXCLUDED.members,permissions=EXCLUDED.permissions,capabilities=EXCLUDED.capabilities,name=EXCLUDED.name,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,version=warmup_groups.version+$12 RETURNING *`,[account.workspace_id,account.environment,account.body.provider,fingerprint,encrypt(snapshot.id),snapshot.name,JSON.stringify(members),permissions,capabilities,now,new Date(now.getTime()+60000),changed?1:0])).rows[0];
 if(changed){await c.query("UPDATE warmup_programs SET status=CASE WHEN status='ARCHIVED' THEN status ELSE 'PAUSED' END,review_hash=NULL,version=version+1 WHERE group_id=$1",[row.id]);await c.query("UPDATE warmup_pools SET paused=true,version=version+1,breaker_reason='GROUP_MEMBERSHIP_CHANGED' WHERE group_id=$1",[row.id]);await c.query("UPDATE outbox SET status='CANCELLED',result=result||'{\"reason\":\"GROUP_MEMBERSHIP_CHANGED\"}'::jsonb,updated_at=now() WHERE workspace_id=$1 AND environment=$2 AND kind='warmup' AND payload->>'group_id'=$3 AND status IN('READY','BLOCKED')",[account.workspace_id,account.environment,row.id]);}
 await appendEvent(c,{workspace_id:account.workspace_id,environment:account.environment,event_type:'warmup.group_observed',aggregate_id:row.id,payload:{account_id:account.id,membership_version:row.version,changed:!!changed,members:members.length,resolved:capabilities.all_members_resolved,runtime:snapshot.runtime},occurred_at:now.toISOString()});
 return row;
}
/** `accountIds` are the profile's lines that take part (they send or give
 * receive evidence). By default every member must be one of them (the strict
 * rule of the earlier authorized mode). With `audience` (V7.4 C, QR groups)
 * the group may also hold members that only receive: external participants
 * without an account, and own lines that were not chosen to take part. */
export function groupEligibility(group:Body,accountIds:string[],now=new Date(),senderIds=accountIds,options:{audience?:boolean}={}){
 const members:Body[]=group.members??[],own=members.filter(m=>m.account_id),unique=new Set(own.map(m=>m.account_id));
 if(group.retired_at)return 'GROUP_RETIRED';
 if(unique.size!==own.length)return 'GROUP_MEMBER_UNRESOLVED';
 if(options.audience){
  if(!accountIds.length||new Set(accountIds).size!==accountIds.length||accountIds.some(id=>!unique.has(id))||senderIds.some(id=>!accountIds.includes(id)))return 'GROUP_PARTICIPANT_NOT_IN_GROUP';
 }else{
  if(!group.capabilities?.all_members_resolved||members.some(m=>!m.account_id))return 'GROUP_MEMBER_UNRESOLVED';
  if(unique.size!==accountIds.length||accountIds.some(id=>!unique.has(id)))return 'GROUP_ALL_MEMBERS_REQUIRED';
 }
 if(group.permissions?.admin_only&&members.some(m=>senderIds.includes(m.account_id)&&!m.admin))return 'GROUP_SEND_PERMISSION_REQUIRED';
 if(new Date(group.expires_at).getTime()<=now.getTime()||new Date(group.observed_at)>now)return 'GROUP_MEMBERSHIP_STALE';
 if(accountIds.some(id=>!group.capabilities.observations?.[id]))return 'GROUP_SHARED_IDENTITY_UNVERIFIED';
 if(accountIds.some(id=>{const t=Date.parse(group.capabilities.observations[id].observed_at);return !Number.isFinite(t)||now.getTime()-t<0||now.getTime()-t>=60000;}))return 'GROUP_MEMBERSHIP_STALE';
 return null;
}
/** Always consumes group traffic, including unknown/retired groups and self echoes. */
export async function classifyGroupEvent(c:QueryExecutor,account:DomainRecord,e:CanonicalEvent,envelopeId:string){
 const groupId=e.groupId??(/@g\.us$/.test(e.identity??'')?String(e.identity).replace(/^opaque:/,''):null);
 if(!groupId)return false;
 if(e.type==='group_membership')await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`group-warmup:${account.workspace_id}:${account.environment}`]);
 const group=(await c.query('SELECT * FROM warmup_groups WHERE workspace_id=$1 AND environment=$2 AND provider=$3 AND group_fingerprint=$4',[account.workspace_id,account.environment,account.body.provider,hash(groupId)])).rows[0];
 const classification=!group?'UNKNOWN_GROUP':group.retired_at?'RETIRED_GROUP':e.fromMe?'SELF_ECHO':e.type==='group_membership'?'MEMBERSHIP_CHANGED':e.type==='ack'&&!e.participantIdentity?'GLOBAL_ACK':'GROUP_EVENT';
 await c.query('INSERT INTO warmup_group_events(workspace_id,environment,account_id,group_fingerprint,canonical_key,envelope_id,classification,observed_at,event_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[account.workspace_id,account.environment,account.id,hash(groupId),e.key,envelopeId,classification,e.providerAt,encrypt(e)]);
 if(group&&e.type==='group_membership'){
  await c.query("UPDATE warmup_groups SET expires_at=LEAST(expires_at,now()),version=version+1 WHERE id=$1",[group.id]);
  await c.query("UPDATE warmup_programs SET review_hash=NULL,version=version+1,status=CASE WHEN status='ARCHIVED' THEN status ELSE 'PAUSED' END WHERE group_id=$1",[group.id]);
  await c.query("UPDATE warmup_pools SET paused=true,version=version+1,breaker_reason='GROUP_MEMBERSHIP_CHANGED' WHERE group_id=$1",[group.id]);
  await c.query("UPDATE outbox SET status='CANCELLED',result=result||'{\"reason\":\"GROUP_MEMBERSHIP_CHANGED\"}'::jsonb,updated_at=now() WHERE workspace_id=$1 AND environment=$2 AND kind='warmup' AND payload->>'group_id'=$3 AND status IN('READY','BLOCKED')",[account.workspace_id,account.environment,group.id]);
 }
 if(group&&classification==='GROUP_EVENT')await correlateGroupEvents(c,group.id);
 return true;
}
/** Hash of each own identity (warm-up registration, group member identity and
 * verified phone) → the own accounts that claim it. A hash claimed by two
 * accounts is ambiguous and never authenticates an author. */
async function ownIdentityOwners(c:QueryExecutor,workspaceId:string,environment:string,groupId:string){
 const owners=new Map<string,Set<string>>(),add=(h:unknown,id:unknown)=>{if(typeof h!=='string'||!h||typeof id!=='string'||!id)return;const set=owners.get(h)??new Set<string>();set.add(id);owners.set(h,set);};
 const group=(await c.query('SELECT members FROM warmup_groups WHERE id=$1 AND workspace_id=$2 AND environment=$3',[groupId,workspaceId,environment])).rows[0];
 const ids=new Set<string>();for(const m of (group?.members??[]) as Body[])if(m.account_id){ids.add(String(m.account_id));add(m.identity_hash,m.account_id);add(m.verified_hash,m.account_id);}
 for(const r of (await c.query('SELECT account_id::text AS account_id,address_fingerprint FROM warmup_identities WHERE workspace_id=$1 AND environment=$2 AND account_id::text=ANY($3::text[])',[workspaceId,environment,[...ids]])).rows)add(r.address_fingerprint,r.account_id);
 return owners;
}
/** V7.5.1: `workspaceId` limits correlation to the profile the caller's transaction is bound to. */
export async function correlateGroupEvents(c:QueryExecutor,groupId?:string,workspaceId?:string){
 const events=(await c.query(`SELECT e.*,g.id group_id FROM warmup_group_events e JOIN warmup_groups g ON g.workspace_id=e.workspace_id AND g.environment=e.environment AND g.group_fingerprint=e.group_fingerprint WHERE NOT e.correlated AND e.classification='GROUP_EVENT' AND ($1::uuid IS NULL OR g.id=$1) AND ($2::text IS NULL OR e.workspace_id=$2) ORDER BY e.last_reconciled_at NULLS FIRST,e.observed_at LIMIT 200 FOR UPDATE OF e SKIP LOCKED`,[groupId??null,workspaceId??null])).rows;
 for(const row of events){
  await c.query('UPDATE warmup_group_events SET last_reconciled_at=now() WHERE id=$1',[row.id]);
  const e=JSON.parse(decrypt(row.event_ciphertext))as CanonicalEvent;if(!e.providerMessageId||e.fromMe)continue;
  const turns=(await c.query(`SELECT t.*,o.status,o.provider_message_id,v.group_id,v.membership_version,v.member_ids FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id JOIN outbox o ON o.id=t.effect_id JOIN warmup_identities i ON i.account_id=t.sender_id WHERE v.group_id=$1 AND o.provider_message_id=$2 AND t.workspace_id=$3 AND t.environment=$4 AND (( $5='message' AND $6=ANY(t.recipient_ids) AND (i.address_fingerprint=$7 OR EXISTS(SELECT 1 FROM warmup_groups g,jsonb_array_elements(g.members) m WHERE g.id=v.group_id AND m->>'account_id'=t.sender_id::text AND m->>'identity_hash'=$7))) OR ($5='ack' AND t.sender_id=$6))`,[row.group_id,e.providerMessageId,row.workspace_id,row.environment,e.type,row.account_id,hash(e.senderIdentity??'')])).rows;
  // V7.5.3 (F3): the sender's own session and each receiving session
  // serialize the same group message differently (direction flag and the
  // author's JID or LID). A stored effect ID with the same chat and message
  // ID is the same message only when both authors resolve to the turn's
  // sender and the observed chat is this group. Literal matches keep their
  // V7.4 path above; this never matches by text and never crosses groups.
  let match:'LITERAL'|'CANONICAL'|'TEXT_EVIDENCE'=turns.length?'LITERAL':'CANONICAL';
  if(!turns.length){
   const provider=String((await c.query("SELECT body->>'provider' AS provider FROM records WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='channel_account'",[row.account_id,row.workspace_id,row.environment])).rows[0]?.provider??'');
   const observed=groupMessageIdentity(provider,e.providerMessageId);
   if(observed?.structured&&hash(observed.chat!)===row.group_fingerprint&&(e.type!=='message'||observed.fromMe===false)){
    const candidates=(await c.query(`SELECT t.*,o.status,o.provider_message_id,v.group_id,v.membership_version,v.member_ids FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id JOIN outbox o ON o.id=t.effect_id
     JOIN records sa ON sa.id::text=o.account_id AND sa.workspace_id=o.workspace_id AND sa.environment=o.environment AND sa.kind='channel_account'
     WHERE v.group_id=$1 AND t.workspace_id=$2 AND t.environment=$3 AND o.kind='warmup' AND o.provider_message_id IS NOT NULL AND strpos(o.provider_message_id,$4)>0
      AND sa.body->>'provider'=$5 AND (($6='message' AND $7=ANY(t.recipient_ids)) OR ($6='ack' AND t.sender_id=$7)) LIMIT 20`,
     [row.group_id,row.workspace_id,row.environment,'_'+observed.messageId+'_',provider,e.type,row.account_id])).rows
     .filter((t:any)=>sameGroupMessage(provider,t.provider_message_id,e.providerMessageId)==='CANONICAL');
    const authors=candidates.length?await ownIdentityOwners(c,row.workspace_id,row.environment,row.group_id):new Map<string,Set<string>>();
    const authoredBy=(raw:string|null|undefined,sender:string)=>{const owners=raw?authors.get(hash(canonicalIdentity(raw))):undefined;return!!owners&&owners.size===1&&owners.has(sender);};
    for(const t of candidates){
     const stored=groupMessageIdentity(provider,t.provider_message_id);
     if(!stored?.structured||!authoredBy(stored.participant,t.sender_id)||!authoredBy(observed.participant,t.sender_id))continue;
     if(e.type==='message'&&!authoredBy(e.senderIdentity,t.sender_id))continue;
     turns.push(t);
    }
   }
  }
  // V7.5.1: a send whose provider answer was never recorded (SENDING/UNKNOWN,
  // no provider ID) is reconciled only by positive evidence: an own line
  // received, in the same group, a message from the turn's sender identity
  // with the turn's exact text, within the claim window. Exactly one turn
  // must match; absence of evidence never credits anything.
  if(!turns.length&&e.type==='message'&&typeof e.text==='string'&&e.senderIdentity){
   const candidates=(await c.query(`SELECT t.*,o.status,o.provider_message_id,o.payload->>'text' AS sent_text,v.group_id,v.membership_version,v.member_ids FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id JOIN outbox o ON o.id=t.effect_id JOIN warmup_identities i ON i.account_id=t.sender_id
    WHERE v.group_id=$1 AND t.workspace_id=$2 AND t.environment=$3 AND o.kind='warmup' AND o.provider_message_id IS NULL AND o.status IN('SENDING','UNKNOWN') AND o.claimed_at IS NOT NULL
     AND $4::timestamptz BETWEEN o.claimed_at-interval '5 seconds' AND o.claimed_at+interval '10 minutes' AND $5=ANY(t.recipient_ids)
     AND (i.address_fingerprint=$6 OR EXISTS(SELECT 1 FROM warmup_groups g,jsonb_array_elements(g.members) m WHERE g.id=v.group_id AND m->>'account_id'=t.sender_id::text AND m->>'identity_hash'=$6)) FOR UPDATE OF o`,
    [row.group_id,row.workspace_id,row.environment,row.observed_at,row.account_id,hash(e.senderIdentity)])).rows.filter((t:any)=>t.sent_text===e.text);
   if(candidates.length===1){
    const t=candidates[0];await recordProfileExecutor(c,row.workspace_id,row.environment);
    const updated=(await c.query(`UPDATE outbox SET status='SENT',provider_message_id=$2,result=result||jsonb_build_object('reconciled','GROUP_EVENT_EVIDENCE','evidence_receiver',$3::text,'evidence_observed_at',$4::text),updated_at=now() WHERE id=$1 AND provider_message_id IS NULL AND status IN('SENDING','UNKNOWN') RETURNING id`,[t.effect_id,e.providerMessageId,row.account_id,new Date(row.observed_at).toISOString()])).rowCount;
    if(updated){
     await c.query("UPDATE effect_attempts SET status='SENT',result=result||jsonb_build_object('reconciled','GROUP_EVENT_EVIDENCE','provider_message_id',$2::text),finished_at=COALESCE(finished_at,now()) WHERE effect_id=$1 AND status IN('SENDING','UNKNOWN')",[t.effect_id,e.providerMessageId]);
     await appendEvent(c,{workspace_id:row.workspace_id,environment:row.environment,event_type:'warmup.effect_reconciled_from_group_event',aggregate_id:t.effect_id,payload:{effect_id:t.effect_id,evidence_receiver:row.account_id,evidence_event:row.id,external_effects:0}});
     turns.push({...t,status:'SENT',provider_message_id:e.providerMessageId});match='TEXT_EVIDENCE';
    }
   }
  }
  if(turns.length!==1)continue;const turn=turns[0];
  let receiver=row.account_id;
  if(e.type==='ack'){
   if(!['DELIVERED','READ','PLAYED'].includes(e.status??'')||!e.participantIdentity)continue;
   const member=(await c.query('SELECT account_id FROM warmup_identities WHERE workspace_id=$1 AND environment=$2 AND address_fingerprint=$3',[row.workspace_id,row.environment,hash(e.participantIdentity)])).rows[0]
    ??(await c.query("SELECT m->>'account_id' AS account_id FROM warmup_groups g,jsonb_array_elements(g.members) m WHERE g.id=$1 AND m->>'account_id' IS NOT NULL AND (m->>'identity_hash'=$2 OR m->>'verified_hash'=$2)",[row.group_id,hash(e.participantIdentity)])).rows[0];receiver=member?.account_id;
  }
  if(!receiver||receiver===turn.sender_id||!turn.recipient_ids.includes(receiver))continue;
  const inserted=(await c.query(`INSERT INTO warmup_group_receipts(effect_id,receiver_id,sender_id,group_id,membership_version,provider_message_id,delivery_source,envelope_id,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING effect_id`,[turn.effect_id,receiver,turn.sender_id,turn.group_id,turn.membership_version,e.providerMessageId,e.type==='message'?'authenticated_receive':'participant_ack',row.envelope_id,e.providerAt])).rowCount;
  await c.query('UPDATE warmup_group_events SET correlated=true WHERE id=$1',[row.id]);
  if(inserted)await appendEvent(c,{workspace_id:row.workspace_id,environment:row.environment,event_type:'warmup.group_receipt_correlated',aggregate_id:turn.effect_id,payload:{effect_id:turn.effect_id,receiver_id:receiver,sender_id:turn.sender_id,group_id:turn.group_id,group_event_id:row.id,delivery_source:e.type==='message'?'authenticated_receive':'participant_ack',match,external_effects:0}});
  const receipts=(await c.query('SELECT DISTINCT receiver_id FROM warmup_group_receipts WHERE effect_id=$1 AND group_id=$2 AND membership_version=$3',[turn.effect_id,turn.group_id,turn.membership_version])).rows;
  if(turn.recipient_ids.every((id:string)=>receipts.some(r=>r.receiver_id===id))){await recordProfileExecutor(c,row.workspace_id,row.environment);await c.query("UPDATE outbox SET status='DELIVERED',result=result||jsonb_build_object('group_delivery_confirmed',true,'delivery_source','per_recipient_evidence'),updated_at=now() WHERE id=$1 AND status='SENT'",[turn.effect_id]);}
 }
 return events.length;
}
