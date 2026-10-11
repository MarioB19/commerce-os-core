import type {Body,DomainRecord} from '../../contracts/src/index.js';
import {randomUUID} from 'node:crypto';
import type {QueryExecutor} from './index.js';

export type RemarketingStage='AGREEMENT'|'COLLECTION';
export type RemarketingCycleStatus='OPEN'|'PAID'|'REPLIED'|'DECLINED'|'OPTED_OUT'|'HUMAN_REVIEW'|'CLOSED';
const recordId=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * A local `approved:true` marker never proves that the provider can send the
 * named template. REAL resolution requires immutable, current capability
 * evidence scoped to the exact channel account and name/language pair.
 */
export async function verifiedTemplateCapabilityEvidence(
 c:QueryExecutor,
 input:{workspaceId:string;environment:'REAL'|'SIMULATION';accountId:string;name:string;language:string;headerKind:'video';bodyTextSha256:string;evidenceId?:string},
):Promise<Body|undefined>{
 const rows=(await c.query(
  `SELECT id,source,evidence_ref,details,observed_at,expires_at FROM operational_evidence
   WHERE workspace_id=$1 AND environment=$2 AND kind='provider_capability' AND status='VERIFIED'
   AND observed_at<=now() AND expires_at>now() AND ($3::uuid IS NULL OR id=$3)
   ORDER BY observed_at DESC,created_at DESC`,
  [input.workspaceId,input.environment,input.evidenceId??null],
 )).rows;
 return rows.find(row=>
  Array.isArray(row.details?.resource_ids)&&row.details.resource_ids.includes(input.accountId)
  &&Array.isArray(row.details?.capabilities)&&row.details.capabilities.includes('template')
  &&Array.isArray(row.details?.approved_templates)&&row.details.approved_templates.some((item:Body)=>item?.name===input.name&&item?.language===input.language&&item?.header_kind===input.headerKind&&item?.body_text_sha256===input.bodyTextSha256),
 );
}

/**
 * A contact keeps one durable quota even when they explicitly switch product
 * or phone. Keep the cycle's stable slot identities/timing snapshot, but bind
 * each still-pending slot to the newly selected offer's content by position so
 * media, price-adjacent copy and seller context can never cross products.
 */
function rebindCyclePolicyContent(current:Body,next:Body):Body{
 const currentSlots=Array.isArray(current?.slots)?current.slots as Body[]:[];
 const nextSlots=Array.isArray(next?.slots)?next.slots as Body[]:[];
 if(!currentSlots.length||currentSlots.length!==nextSlots.length)throw new Error('REMARKETING_POLICY_REBIND_INVALID');
 const slots=currentSlots.map(slot=>{
  const replacement=nextSlots.find(candidate=>Number(candidate.position)===Number(slot.position));
  if(!replacement?.stages)throw new Error('REMARKETING_POLICY_REBIND_INVALID');
  return{...slot,stages:structuredClone(replacement.stages)};
 });
 return{...structuredClone(current),slots};
}

async function orderContactId(c:QueryExecutor,order:DomainRecord):Promise<string|undefined>{
 const direct=String(order.body.contact_id??'');if(recordId.test(direct))return direct;
 const conversationId=String(order.body.conversation_id??'');if(!recordId.test(conversationId))return;
 const row=(await c.query(
  `SELECT body->>'contact_id' contact_id FROM records
   WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='conversation'`,
  [conversationId,order.workspace_id,order.environment],
 )).rows[0];
 const inherited=String(row?.contact_id??'');return recordId.test(inherited)?inherited:undefined;
}

export async function buyerExcluded(
 c:QueryExecutor,
 input:Pick<DomainRecord,'workspace_id'|'environment'>&{contact_id:string},
):Promise<boolean>{
 return !!(await c.query(
  'SELECT 1 FROM commercial_buyer_exclusions WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3',
  [input.workspace_id,input.environment,input.contact_id],
 )).rowCount;
}

/**
 * Mark a contact as a buyer without suppressing inbound support. The caller
 * owns the commercial transaction and supplies the receipt that established
 * the first positive payment.
 */
export async function excludeRecognizedBuyer(
 c:QueryExecutor,
 order:DomainRecord,
 receiptId:string,
 source:'receipt_recognition'|'receipt_sales_backfill'='receipt_recognition',
):Promise<{created:boolean;contact_id?:string}>{
 const contactId=await orderContactId(c,order);
 // Historical/imported orders may predate contacts. Their financial evidence
 // remains valid, but there is no durable buyer identity to exclude.
 if(!contactId)return{created:false};
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commercial-contact:${order.workspace_id}:${order.environment}:${contactId}`]);
 const inserted=(await c.query(
  `INSERT INTO commercial_buyer_exclusions(
    workspace_id,environment,contact_id,first_order_id,first_receipt_id,recognized_at,source,metadata
   ) VALUES($1,$2,$3,$4,$5,COALESCE(($6::text)::timestamptz,now()),$7,$8)
   ON CONFLICT(workspace_id,environment,contact_id) DO NOTHING RETURNING contact_id`,
  [order.workspace_id,order.environment,contactId,order.id,receiptId,order.body.sale_effective_at??null,source,{definition:'receipt_sales_v1'}],
 )).rows[0];
 await c.query(
  `UPDATE commercial_remarketing_cycles
   SET status='PAID',closed_at=now(),close_reason='BUYER_RECOGNIZED',revision=revision+1,updated_at=now()
   WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3 AND status='OPEN'`,
  [order.workspace_id,order.environment,contactId],
 );
 return{created:!!inserted,contact_id:contactId};
}

export async function cancelAutomaticRemarketingForBuyer(c:QueryExecutor,order:DomainRecord,reason='BUYER_RECOGNIZED'):Promise<{timers:number;effects:number}>{
 const contactId=await orderContactId(c,order);if(!contactId)return{timers:0,effects:0};
 const timers=await c.query(
  `UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND environment=$2 AND status='PENDING'
   AND kind='followup' AND conversation_id IN(
    SELECT id::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'contact_id'=$3
   ) RETURNING id`,
  [order.workspace_id,order.environment,contactId],
 );
 const effects=await c.query(
  `UPDATE outbox SET status='CANCELLED',result=jsonb_build_object('reason',$4::text),updated_at=now()
   WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3 AND status IN('READY','BLOCKED')
   AND payload->>'purpose' IN('followup','remarketing') RETURNING id`,
  [order.workspace_id,order.environment,contactId,reason],
 );
 return{timers:timers.rowCount??0,effects:effects.rowCount??0};
}

export async function cancelPendingRemarketingForContact(c:QueryExecutor,conversation:DomainRecord,reason:string):Promise<{timers:string[];effects:string[]}>{
 const contactId=String(conversation.body.contact_id??'');if(!contactId)return{timers:[],effects:[]};
 const timers=await c.query(
  `UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND environment=$2 AND status='PENDING'
   AND kind='followup' AND conversation_id IN(
    SELECT id::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'contact_id'=$3
   ) RETURNING id`,
  [conversation.workspace_id,conversation.environment,contactId],
 );
 const effects=await c.query(
  `UPDATE outbox SET status='CANCELLED',result=jsonb_build_object('reason',$4::text,'superseded_before_send',true),updated_at=now()
   WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3 AND status IN('READY','BLOCKED')
   AND payload->>'purpose' IN('followup','remarketing') RETURNING id`,
  [conversation.workspace_id,conversation.environment,contactId,reason],
 );
 return{timers:timers.rows.map(row=>String(row.id)),effects:effects.rows.map(row=>String(row.id))};
}

export async function openRemarketingCycle(
 c:QueryExecutor,
 conversation:DomainRecord,
 input:{policySnapshot:Body;stage:RemarketingStage;anchorAt:string;maxAttempts:number;reanchor?:boolean},
):Promise<Body>{
 const contactId=String(conversation.body.contact_id??'');
 const offerId=String(conversation.body.offer_version_id??'');
 if(!contactId||!offerId)throw new Error('COMMERCIAL_CONTEXT_REQUIRED');
 if(!Number.isInteger(input.maxAttempts)||input.maxAttempts<0||input.maxAttempts>3)throw new Error('REMARKETING_MAX_ATTEMPTS_INVALID');
 const anchor=new Date(input.anchorAt);if(!Number.isFinite(anchor.getTime()))throw new Error('REMARKETING_ANCHOR_INVALID');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commercial-contact:${conversation.workspace_id}:${conversation.environment}:${contactId}`]);
 if(await buyerExcluded(c,{workspace_id:conversation.workspace_id,environment:conversation.environment,contact_id:contactId}))throw new Error('BUYER_EXCLUDED');
 let cycle=(await c.query(
  `SELECT * FROM commercial_remarketing_cycles
   WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3 AND status='OPEN' FOR UPDATE`,
  [conversation.workspace_id,conversation.environment,contactId],
 )).rows[0];
 if(!cycle){
  cycle=(await c.query(
   `INSERT INTO commercial_remarketing_cycles(
     id,workspace_id,environment,contact_id,source_conversation_id,source_offer_version_id,
     policy_snapshot,max_attempts,stage,anchor_at
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
   [randomUUID(),conversation.workspace_id,conversation.environment,contactId,conversation.id,offerId,input.policySnapshot,input.maxAttempts,input.stage,anchor.toISOString()],
  )).rows[0];
  return cycle;
 }
 // A stage transition reanchors pending work but deliberately keeps the
 // policy snapshot and max quota captured when the cycle opened. An explicit
 // conversation/offer switch also keeps those timings and IDs, while replacing
 // only slot content so no product's media or copy is sent for another.
 if(cycle.stage!==input.stage||cycle.source_conversation_id!==conversation.id||input.reanchor&&new Date(cycle.anchor_at).getTime()!==anchor.getTime()){
  const sourceChanged=cycle.source_conversation_id!==conversation.id;
  const sourceOfferId=sourceChanged?offerId:cycle.source_offer_version_id;
  const policySnapshot=sourceChanged&&cycle.source_offer_version_id!==offerId
   ?rebindCyclePolicyContent(cycle.policy_snapshot,input.policySnapshot)
   :cycle.policy_snapshot;
  cycle=(await c.query(
   `UPDATE commercial_remarketing_cycles SET source_conversation_id=$2,source_offer_version_id=$3,
    policy_snapshot=$4,stage=$5,anchor_at=$6,
    revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,
   [cycle.id,conversation.id,sourceOfferId,policySnapshot,input.stage,anchor.toISOString()],
  )).rows[0];
 }
 return cycle;
}

export async function reserveRemarketingAttempt(
 c:QueryExecutor,
 input:{cycleId:string;workspaceId:string;environment:'REAL'|'SIMULATION';contactId:string;slotId:string;conversationId:string;timerId:string;stage:RemarketingStage},
):Promise<{attempt?:Body;reason?:string;cycle?:Body}>{
 const cycle=(await c.query(
  'SELECT * FROM commercial_remarketing_cycles WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',
  [input.cycleId,input.workspaceId,input.environment],
 )).rows[0];
 if(!cycle)return{reason:'REMARKETING_CYCLE_MISSING'};
 if(cycle.contact_id!==input.contactId||cycle.source_conversation_id!==input.conversationId||cycle.stage!==input.stage)return{reason:'REMARKETING_SCOPE_INVALID',cycle};
 const timer=(await c.query(
  `SELECT 1 FROM timers WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND conversation_id=$4
   AND kind='followup' AND payload->>'cycle_id'=$5 AND payload->>'slot_id'=$6
   AND payload->>'stage'=$7`,
  [input.timerId,input.workspaceId,input.environment,input.conversationId,input.cycleId,input.slotId,input.stage],
 )).rows[0];
 if(!timer)return{reason:'REMARKETING_SCOPE_INVALID',cycle};
 if(cycle.status!=='OPEN')return{reason:`REMARKETING_CYCLE_${cycle.status}`};
 if(await buyerExcluded(c,{workspace_id:cycle.workspace_id,environment:cycle.environment,contact_id:cycle.contact_id}))return{reason:'BUYER_EXCLUDED',cycle};
 const prior=(await c.query('SELECT * FROM commercial_remarketing_attempts WHERE cycle_id=$1 AND slot_id=$2',[cycle.id,input.slotId])).rows[0];
 if(prior)return prior.timer_id===input.timerId&&prior.status==='RESERVED'
  ?{attempt:prior,cycle}
  :{attempt:prior,reason:prior.status==='CANCELLED'?'REMARKETING_SLOT_ALREADY_CONSUMED':'REMARKETING_SLOT_ALREADY_RESERVED',cycle};
 if(Number(cycle.consumed_attempts)>=Number(cycle.max_attempts))return{reason:'REMARKETING_QUOTA_EXHAUSTED',cycle};
 const attempt=(await c.query(
  `INSERT INTO commercial_remarketing_attempts(
    id,cycle_id,workspace_id,environment,contact_id,slot_id,stage,timer_id,conversation_id,metadata
   ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [randomUUID(),cycle.id,cycle.workspace_id,cycle.environment,cycle.contact_id,input.slotId,input.stage,input.timerId,input.conversationId,{cycle_revision:cycle.revision}],
 )).rows[0];
 const updated=(await c.query(
  `UPDATE commercial_remarketing_cycles SET consumed_attempts=consumed_attempts+1,revision=revision+1,updated_at=now()
   WHERE id=$1 RETURNING *`,[cycle.id],
 )).rows[0];
 return{attempt,cycle:updated};
}

export async function setRemarketingAttemptStatus(
 c:QueryExecutor,
 scope:{attemptId:string;workspaceId:string;environment:'REAL'|'SIMULATION'},
 status:'PROPOSED'|'SENT'|'DELIVERED'|'UNKNOWN'|'CANCELLED',
 metadata:Body={},
):Promise<void>{
 const attempt=(await c.query(
  'SELECT id,status FROM commercial_remarketing_attempts WHERE id=$1 AND workspace_id=$2 AND environment=$3 FOR UPDATE',
  [scope.attemptId,scope.workspaceId,scope.environment],
 )).rows[0];
 if(!attempt)return;
 const effects=(await c.query(
  `SELECT status FROM outbox WHERE workspace_id=$1 AND environment=$2
   AND payload->>'remarketing_attempt_id'=$3`,
  [scope.workspaceId,scope.environment,scope.attemptId],
 )).rows.map(row=>String(row.status));
 let projected=status;
 if(effects.length){
  const accepted=new Set(['SENT','DELIVERED','READ']);
  if(effects.some(value=>value==='UNKNOWN'||value==='SENDING'))projected='UNKNOWN';
  else if(effects.some(value=>accepted.has(value)))projected=effects.every(value=>value==='DELIVERED'||value==='READ')?'DELIVERED':'SENT';
  else if(effects.some(value=>value==='FAILED'||value==='CANCELLED'))projected='CANCELLED';
  else projected='PROPOSED';
 }
 await c.query(
  `UPDATE commercial_remarketing_attempts SET status=CASE
    WHEN status='DELIVERED' THEN status
    WHEN $2='DELIVERED' THEN $2
    WHEN status='SENT' AND $2='CANCELLED' THEN status
    ELSE $2
   END,metadata=metadata||$5::jsonb,updated_at=now()
   WHERE id=$1 AND workspace_id=$3 AND environment=$4`,
  [scope.attemptId,projected,scope.workspaceId,scope.environment,metadata],
 );
}

export async function closeRemarketingCycle(
 c:QueryExecutor,
 conversation:DomainRecord,
 status:Exclude<RemarketingCycleStatus,'OPEN'>,
 reason:string,
):Promise<void>{
 const contactId=String(conversation.body.contact_id??'');if(!contactId)return;
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`commercial-contact:${conversation.workspace_id}:${conversation.environment}:${contactId}`]);
 await c.query(
  `UPDATE commercial_remarketing_cycles SET status=$4,closed_at=now(),close_reason=$5,revision=revision+1,updated_at=now()
   WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3 AND status='OPEN'`,
  [conversation.workspace_id,conversation.environment,contactId,status,reason],
 );
}
