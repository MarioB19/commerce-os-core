import type {CanonicalEvent,ProviderGroup} from '../../messaging/src/types.js';
import type {Body,DomainRecord} from '../../contracts/src/index.js';
import {canonicalIdentity} from '../../messaging/src/security.js';
import {hash,encrypt,decrypt,stableJson,appendEvent,type QueryExecutor} from './index.js';

export async function observeGroup(c:QueryExecutor,account:DomainRecord,snapshot:ProviderGroup,now=new Date()){
 if(!snapshot.complete||snapshot.runtime.engine!==String(account.body.engine??'SIMULATOR')||Date.parse(snapshot.observedAt)>now.getTime()+1000)throw new Error('GROUP_CAPABILITY_UNVERIFIED');
 const identities=(await c.query('SELECT account_id,address_fingerprint,address_ciphertext FROM warmup_identities WHERE workspace_id=$1 AND environment=$2',[account.workspace_id,account.environment])).rows;
 const members=snapshot.members.map(m=>({account_id:identities.find(i=>m.verifiedIdentity&&i.address_fingerprint===hash(canonicalIdentity(m.verifiedIdentity)))?.account_id??null,identity_hash:hash(m.identity),verified_hash:m.verifiedIdentity?hash(canonicalIdentity(m.verifiedIdentity)):null,admin:m.admin,mapping_source:m.mappingSource})).sort((a,b)=>a.identity_hash.localeCompare(b.identity_hash));
 const fingerprint=hash(snapshot.id);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`group:${account.workspace_id}:${account.environment}:${fingerprint}`]);
 const old=(await c.query('SELECT * FROM warmup_groups WHERE workspace_id=$1 AND environment=$2 AND provider=$3 AND group_fingerprint=$4 FOR UPDATE',[account.workspace_id,account.environment,account.body.provider,fingerprint])).rows[0];
 const permissions={admin_only:snapshot.adminOnly},changed=old&&(stableJson(old.members)!==stableJson(members)||stableJson(old.permissions)!==stableJson(permissions));
 const observations:Body=changed?{}:old?.capabilities?.observations??{};observations[account.id]={observed_at:now.toISOString(),runtime:snapshot.runtime};
 const capabilities={protocol:'v1',observations,all_members_resolved:members.every(m=>m.account_id&&m.verified_hash),member_read:true,authenticated_receive:true};
 const row=(await c.query(`INSERT INTO warmup_groups(workspace_id,environment,provider,group_fingerprint,group_ciphertext,name,members,permissions,capabilities,observed_at,expires_at,source)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'provider_read') ON CONFLICT(workspace_id,environment,provider,group_fingerprint) DO UPDATE SET members=EXCLUDED.members,permissions=EXCLUDED.permissions,capabilities=EXCLUDED.capabilities,name=EXCLUDED.name,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at,version=warmup_groups.version+$12 RETURNING *`,[account.workspace_id,account.environment,account.body.provider,fingerprint,encrypt(snapshot.id),snapshot.name,JSON.stringify(members),permissions,capabilities,now,new Date(now.getTime()+60000),changed?1:0])).rows[0];
 if(changed){await c.query("UPDATE warmup_programs SET status=CASE WHEN status='ARCHIVED' THEN status ELSE 'PAUSED' END,review_hash=NULL,version=version+1 WHERE group_id=$1",[row.id]);await c.query("UPDATE warmup_pools SET paused=true,version=version+1,breaker_reason='GROUP_MEMBERSHIP_CHANGED' WHERE group_id=$1",[row.id]);}
 await appendEvent(c,{workspace_id:account.workspace_id,environment:account.environment,event_type:'warmup.group_observed',aggregate_id:row.id,payload:{account_id:account.id,membership_version:row.version,changed:!!changed,members:members.length,resolved:capabilities.all_members_resolved,runtime:snapshot.runtime},occurred_at:now.toISOString()});
 return row;
}
export function groupEligibility(group:Body,accountIds:string[],now=new Date()){
 const members:Body[]=group.members??[],unique=new Set(members.map(m=>m.account_id));
 if(group.retired_at)return 'GROUP_RETIRED';
 if(!group.capabilities?.all_members_resolved||members.some(m=>!m.account_id))return 'GROUP_MEMBER_UNRESOLVED';
 if(unique.size!==members.length||unique.size!==accountIds.length||accountIds.some(id=>!unique.has(id)))return 'GROUP_ALL_MEMBERS_REQUIRED';
 if(group.permissions?.admin_only&&members.some(m=>!m.admin))return 'GROUP_SEND_PERMISSION_REQUIRED';
 if(new Date(group.expires_at).getTime()<=now.getTime()||new Date(group.observed_at)>now)return 'GROUP_MEMBERSHIP_STALE';
 if(accountIds.some(id=>!group.capabilities.observations?.[id]))return 'GROUP_SHARED_IDENTITY_UNVERIFIED';
 if(accountIds.some(id=>{const t=Date.parse(group.capabilities.observations[id].observed_at);return !Number.isFinite(t)||now.getTime()-t<0||now.getTime()-t>=60000;}))return 'GROUP_MEMBERSHIP_STALE';
 return null;
}
/** Always consumes group traffic, including unknown/retired groups and self echoes. */
export async function classifyGroupEvent(c:QueryExecutor,account:DomainRecord,e:CanonicalEvent,envelopeId:string){
 const groupId=e.groupId??(/@g\.us$/.test(e.identity??'')?String(e.identity).replace(/^opaque:/,''):null);
 if(!groupId)return false;
 const group=(await c.query('SELECT * FROM warmup_groups WHERE workspace_id=$1 AND environment=$2 AND provider=$3 AND group_fingerprint=$4',[account.workspace_id,account.environment,account.body.provider,hash(groupId)])).rows[0];
 const classification=!group?'UNKNOWN_GROUP':group.retired_at?'RETIRED_GROUP':e.fromMe?'SELF_ECHO':e.type==='group_membership'?'MEMBERSHIP_CHANGED':e.type==='ack'&&!e.participantIdentity?'GLOBAL_ACK':'GROUP_EVENT';
 await c.query('INSERT INTO warmup_group_events(workspace_id,environment,account_id,group_fingerprint,canonical_key,envelope_id,classification,observed_at,event_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',[account.workspace_id,account.environment,account.id,hash(groupId),e.key,envelopeId,classification,e.providerAt,encrypt(e)]);
 if(group&&e.type==='group_membership'){
  await c.query("UPDATE warmup_groups SET expires_at=LEAST(expires_at,now()),version=version+1 WHERE id=$1",[group.id]);
  await c.query("UPDATE warmup_programs SET review_hash=NULL,version=version+1,status=CASE WHEN status='ARCHIVED' THEN status ELSE 'PAUSED' END WHERE group_id=$1",[group.id]);
  await c.query("UPDATE warmup_pools SET paused=true,version=version+1,breaker_reason='GROUP_MEMBERSHIP_CHANGED' WHERE group_id=$1",[group.id]);
 }
 if(group&&classification==='GROUP_EVENT')await correlateGroupEvents(c,group.id);
 return true;
}
export async function correlateGroupEvents(c:QueryExecutor,groupId?:string){
 const events=(await c.query(`SELECT e.*,g.id group_id FROM warmup_group_events e JOIN warmup_groups g ON g.workspace_id=e.workspace_id AND g.environment=e.environment AND g.group_fingerprint=e.group_fingerprint WHERE NOT e.correlated AND e.classification='GROUP_EVENT' AND ($1::uuid IS NULL OR g.id=$1) ORDER BY e.last_reconciled_at NULLS FIRST,e.observed_at LIMIT 200 FOR UPDATE OF e SKIP LOCKED`,[groupId??null])).rows;
 for(const row of events){
  await c.query('UPDATE warmup_group_events SET last_reconciled_at=now() WHERE id=$1',[row.id]);
  const e=JSON.parse(decrypt(row.event_ciphertext))as CanonicalEvent;if(!e.providerMessageId||e.fromMe)continue;
  const turns=(await c.query(`SELECT t.*,o.status,o.provider_message_id,v.group_id,v.membership_version,v.member_ids FROM warmup_turns t JOIN warmup_conversations v ON v.id=t.conversation_id JOIN outbox o ON o.id=t.effect_id JOIN warmup_identities i ON i.account_id=t.sender_id WHERE v.group_id=$1 AND o.provider_message_id=$2 AND t.workspace_id=$3 AND t.environment=$4 AND (( $5='message' AND $6=ANY(t.recipient_ids) AND (i.address_fingerprint=$7 OR EXISTS(SELECT 1 FROM warmup_groups g,jsonb_array_elements(g.members) m WHERE g.id=v.group_id AND m->>'account_id'=t.sender_id::text AND m->>'identity_hash'=$7))) OR ($5='ack' AND t.sender_id=$6))`,[row.group_id,e.providerMessageId,row.workspace_id,row.environment,e.type,row.account_id,hash(e.senderIdentity??'')])).rows;
  if(turns.length!==1)continue;const turn=turns[0];
  let receiver=row.account_id;
  if(e.type==='ack'){
   if(!['DELIVERED','READ','PLAYED'].includes(e.status??'')||!e.participantIdentity)continue;
   const member=(await c.query('SELECT account_id FROM warmup_identities WHERE workspace_id=$1 AND environment=$2 AND address_fingerprint=$3',[row.workspace_id,row.environment,hash(e.participantIdentity)])).rows[0];receiver=member?.account_id;
  }
  if(!receiver||receiver===turn.sender_id||!turn.recipient_ids.includes(receiver))continue;
  await c.query(`INSERT INTO warmup_group_receipts(effect_id,receiver_id,sender_id,group_id,membership_version,provider_message_id,delivery_source,envelope_id,observed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[turn.effect_id,receiver,turn.sender_id,turn.group_id,turn.membership_version,e.providerMessageId,e.type==='message'?'authenticated_receive':'participant_ack',row.envelope_id,e.providerAt]);
  await c.query('UPDATE warmup_group_events SET correlated=true WHERE id=$1',[row.id]);
  const receipts=(await c.query('SELECT DISTINCT receiver_id FROM warmup_group_receipts WHERE effect_id=$1 AND group_id=$2 AND membership_version=$3',[turn.effect_id,turn.group_id,turn.membership_version])).rows;
  if(turn.recipient_ids.every((id:string)=>receipts.some(r=>r.receiver_id===id)))await c.query("UPDATE outbox SET status='DELIVERED',result=result||jsonb_build_object('group_delivery_confirmed',true,'delivery_source','per_recipient_evidence'),updated_at=now() WHERE id=$1 AND status='SENT'",[turn.effect_id]);
 }
 return events.length;
}
