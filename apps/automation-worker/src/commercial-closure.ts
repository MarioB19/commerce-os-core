import type {Body,DomainRecord} from '@commerce/contracts';
import type {QueryExecutor} from '@commerce/db';
const accepted=new Set(['SENT','DELIVERED','READ']),delivered=new Set(['DELIVERED','READ']);
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function money(value:unknown){need(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0,'COMMERCIAL_CLOSURE_TERMS_INVALID');return BigInt(value);}
function test(body:Body,environment:string){return environment==='SIMULATION'||body.commercial_classification==='TEST'||body.is_test===true||!!body.simulation_id||!!body.number_flow_test_id||!!body.launch_test_scope_id;}
export type ClosureOrderFacts={order:DomainRecord;contributions:Body[];reconciliation:Body|null;fulfillments:Body[];termsVerified:boolean};
/** Decision over locked native facts; caller-supplied body status is insufficient. */
export function evaluateCommercialClosure(conversation:DomainRecord,orders:ClosureOrderFacts[],effects:Body[]){
 need(!conversation.body.privacy_erased,'COMMERCIAL_CLOSURE_SOURCE_ERASED');
 need(!effects.some(e=>['SENDING','UNKNOWN'].includes(e.status)),'CONVERSATION_HAS_IN_FLIGHT_EFFECTS');
 const isTest=test(conversation.body,conversation.environment),proofs:Body[]=[];
 for(const facts of orders){
  const {order,contributions,reconciliation,fulfillments}=facts,b=order.body;
  need(order.workspace_id===conversation.workspace_id&&order.environment===conversation.environment&&b.conversation_id===conversation.id,'COMMERCIAL_CLOSURE_SCOPE_MISMATCH');
  need(test(b,order.environment)===isTest,'COMMERCIAL_CLOSURE_TEST_MISMATCH');
  if(isTest){proofs.push({order_id:order.id,order_version:order.version,classification:'TEST'});continue;}
  const active=!!b.committed_at||contributions.length>0||fulfillments.length>0||!!b.reconciliation||b.sale_status==='RECOGNIZED'||b.reconciliation_status==='RECONCILED'||['COMMITTED','RECEIPT_APPROVED','RECONCILED'].includes(b.status);
  if(!active){proofs.push({order_id:order.id,order_version:order.version,classification:'UNCOMMITTED'});continue;}
  need(facts.termsVerified,'COMMERCIAL_CLOSURE_TERMS_CHANGED');const due=money(b.amount_minor);need(/^[A-Z]{3}$/.test(b.currency??'')&&b.offer_snapshot&&money(b.offer_snapshot.base_amount_minor)===due&&b.offer_snapshot.currency===b.currency&&Array.isArray(b.offer_snapshot.fulfillment),'COMMERCIAL_CLOSURE_TERMS_INVALID');
  let paid=0n;const payments:Body[]=[];
  for(const p of contributions){
   need(p.receipt_status==='APPROVED'&&!['FALSE','TEST'].includes(p.receipt_classification)&&!p.duplicate_of&&p.receipt_conversation_id===conversation.id&&p.currency===b.currency&&p.extracted_currency===b.currency&&p.asset_ready===true&&p.asset_sha256===p.evidence_sha256&&p.recognition_verified===true,'COMMERCIAL_CLOSURE_PAYMENT_UNVERIFIED');
   need(/^[1-9][0-9]*$/.test(String(p.amount_minor))&&BigInt(p.amount_minor)<=BigInt(Number.MAX_SAFE_INTEGER)&&String(p.extracted_amount)===String(p.amount_minor),'COMMERCIAL_CLOSURE_PAYMENT_UNVERIFIED');
   paid+=BigInt(p.amount_minor);payments.push({contribution_id:p.id,revision:p.revision,receipt_id:p.receipt_id,amount_minor:String(p.amount_minor)});
  }
  let reconciled=0n;
  if(reconciliation){need(reconciliation.verified===true&&reconciliation.currency===b.currency,'COMMERCIAL_CLOSURE_RECONCILIATION_UNVERIFIED');reconciled=money(reconciliation.amount_minor);}
  const settled=paid>reconciled?paid:reconciled;need(settled>=due,'COMMERCIAL_COMMITMENT_REQUIRES_HUMAN_RESOLUTION');
  const required:Body[]=b.offer_snapshot.fulfillment.filter((item:Body)=>{need(['commitment_accepted','receipt_approved','reconciled'].includes(item.release_on)&&typeof item.asset_id==='string','COMMERCIAL_CLOSURE_TERMS_INVALID');return b.offer_snapshot.positive_payment_unlocks_all===true&&settled>0n||item.min_amount_minor===undefined||settled>=money(item.min_amount_minor);});
  const used=new Set<string>(),delivery:Body[]=[];
  for(const item of required){
   const candidates=fulfillments.filter(f=>f.body.asset_id===item.asset_id&&(item.release_on==='commitment_accepted'?f.body.release_on===item.release_on:['receipt_approved','reconciled'].includes(f.body.release_on)));
   need(candidates.length===1&&!used.has(candidates[0].id),'COMMERCIAL_CLOSURE_DELIVERY_UNVERIFIED');const f=candidates[0];used.add(f.id);
   need(f.body.conversation_id===conversation.id&&delivered.has(f.effect_status)&&f.body.status===f.effect_status&&!!f.provider_message_id&&f.effect_accepted===true&&f.effect_conversation_id===conversation.id&&f.effect_payload?.fulfillment_id===f.id,'COMMERCIAL_CLOSURE_DELIVERY_UNVERIFIED');
   const grantRequired=f.asset_kind==='access'&&['webhook','link'].includes(f.asset_adapter)||!!f.body.grant_effect_id;
   need(typeof f.asset_kind==='string','COMMERCIAL_CLOSURE_DELIVERY_UNVERIFIED');
   if(grantRequired)need(!!f.body.grant_effect_id&&f.effect_payload.grant_effect_id===f.body.grant_effect_id&&accepted.has(f.grant_status)&&!!f.grant_provider_message_id&&f.grant_accepted===true&&f.grant_conversation_id===conversation.id&&f.grant_payload?.kind==='grant'&&f.grant_payload?.asset_id===item.asset_id&&f.grant_payload?.grant_id===f.id&&f.grant_has_access===true,'COMMERCIAL_CLOSURE_GRANT_UNVERIFIED');
   else need(f.effect_payload.asset_id===item.asset_id,'COMMERCIAL_CLOSURE_DELIVERY_UNVERIFIED');
   delivery.push({fulfillment_id:f.id,effect_id:f.body.effect_id,...(grantRequired?{grant_effect_id:f.body.grant_effect_id}:{})});
  }
  need(fulfillments.every(f=>used.has(f.id)),'COMMERCIAL_CLOSURE_DELIVERY_UNVERIFIED');
  proofs.push({order_id:order.id,order_version:order.version,classification:'RESOLVED',currency:b.currency,due_minor:due.toString(),paid_minor:paid.toString(),reconciled_minor:reconciled.toString(),payments,reconciliation_command_id:reconciliation?.command_id??null,delivery});
 }
 if(!isTest)need(!effects.some(e=>['READY','BLOCKED'].includes(e.status)&&(e.payload?.fulfillment_id||e.payload?.kind==='grant')),'COMMERCIAL_CLOSURE_PENDING_DELIVERY');
 return{schema_version:1,kind:'EXPLICIT_HUMAN_COMMERCIAL_CLOSURE',classification:isTest?'TEST':'COMMERCIAL',orders:proofs};
}
/** Must run in the canonical command transaction under the conversation mutex. */
export async function assertCommercialClosure(db:QueryExecutor,conversation:DomainRecord,cmd:Body){
 need(typeof cmd.actor_id==='string'&&cmd.actor_id.length>0&&typeof cmd.payload?.reason==='string'&&cmd.payload.reason.trim().length>0,'HUMAN_CLOSURE_EVIDENCE_REQUIRED');
 const native=(await db.query(`SELECT id FROM commands WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='conversation_command' AND resource_id=$4 AND actor_id=$5 AND status='PENDING' AND payload=$6::jsonb FOR SHARE`,[cmd.id,conversation.workspace_id,conversation.environment,conversation.id,cmd.actor_id,cmd.payload])).rows;
 need(native.length===1,'HUMAN_CLOSURE_COMMAND_REQUIRED');
 const scope=[conversation.workspace_id,conversation.environment,conversation.id];
 const orders=(await db.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 ORDER BY id FOR SHARE",scope)).rows as DomainRecord[];
 const effects=(await db.query('SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 ORDER BY id FOR UPDATE',scope)).rows;
 const facts:ClosureOrderFacts[]=[];
 const hasCustody=(await db.query("SELECT to_regprocedure('public.verify_commercial_resolution(uuid,text,uuid)') IS NOT NULL ready")).rows[0]?.ready===true;
 async function retained(orderId:string,kind:string,sourceId:string){return hasCustody&&(await db.query('SELECT verify_commercial_resolution($1,$2,$3) verified',[orderId,kind,sourceId])).rows[0]?.verified===true;}
 for(const order of orders){
  const termsVerified=(await db.query("SELECT 1 FROM record_versions WHERE record_id=$1 AND workspace_id=$2 AND environment=$3 AND kind='order' AND version=1 AND body->'amount_minor'=$4::jsonb AND body->'currency'=$5::jsonb AND body->'offer_snapshot'=$6::jsonb",[order.id,conversation.workspace_id,conversation.environment,JSON.stringify(order.body.amount_minor??null),JSON.stringify(order.body.currency??null),JSON.stringify(order.body.offer_snapshot??null)])).rows.length===1;
  const contributions=(await db.query(`SELECT p.*,r.body->>'status' receipt_status,r.body->>'commercial_classification' receipt_classification,r.body->>'duplicate_of' duplicate_of,r.body->>'conversation_id' receipt_conversation_id,r.body->'extraction'->>'amount_minor' extracted_amount,COALESCE(r.body->'extraction'->>'currency',o.body->>'currency') extracted_currency,a.body->>'sha256' asset_sha256,(a.body->>'status'='READY' AND length(a.body->>'storage_key')>0) asset_ready,
   false recognition_verified
   FROM payment_contributions p JOIN records o ON o.id=p.order_id AND o.workspace_id=p.workspace_id AND o.environment=p.environment AND o.kind='order'
   JOIN records r ON r.id=p.receipt_id AND r.workspace_id=p.workspace_id AND r.environment=p.environment AND r.kind='receipt'
   JOIN records a ON a.id::text=r.body->>'asset_id' AND a.workspace_id=p.workspace_id AND a.environment=p.environment AND a.kind='asset'
   WHERE p.workspace_id=$1 AND p.environment=$2 AND p.order_id=$3 ORDER BY p.id FOR SHARE OF p,r,a`,[...scope.slice(0,2),order.id])).rows;
  // Do not let a missing/corrupt referenced receipt or asset disappear in a join.
  need(Number((await db.query('SELECT count(*) n FROM payment_contributions WHERE workspace_id=$1 AND environment=$2 AND order_id=$3',[...scope.slice(0,2),order.id])).rows[0].n)===contributions.length,'COMMERCIAL_CLOSURE_PAYMENT_UNVERIFIED');
  for(const p of contributions){
   p.recognition_verified=await retained(order.id,'PAYMENT',p.id);
   if(!p.recognition_verified)p.recognition_verified=(await db.query(`SELECT 1 FROM domain_events e WHERE e.workspace_id=$1 AND e.environment=$2 AND e.aggregate_id=$3 AND e.event_type IN('sale.recognized','sale.contribution_corrected') AND e.causation_id=$4 AND e.payload->>'contribution_id'=$5 AND e.payload->>'receipt_id'=$6 AND e.payload->>'revision'=$7 AND e.payload->>'amount_minor'=$8 AND e.payload->>'currency'=$9`,[conversation.workspace_id,conversation.environment,order.id,p.provenance?.cause,p.id,p.receipt_id,String(p.revision),String(p.amount_minor),p.currency])).rows.length>0;
  }
  let reconciliation:Body|null=null;
  if(order.body.reconciliation){
   const r=order.body.reconciliation;
   // Preserve the live path's asset lock even when the command/event is retained.
   await db.query("SELECT id FROM records WHERE id::text=$1 AND workspace_id=$2 AND environment=$3 AND kind='asset' FOR SHARE",[r.evidence_asset_id,conversation.workspace_id,conversation.environment]);
   const historical=await retained(order.id,'RECONCILIATION',r.command_id);
   const proof=historical?[{id:r.command_id}]:(await db.query(`SELECT c.id FROM commands c JOIN records a ON a.id::text=c.payload->>'evidence_asset_id' AND a.workspace_id=c.workspace_id AND a.environment=c.environment AND a.kind='asset'
    WHERE c.id::text=$1 AND c.workspace_id=$2 AND c.environment=$3 AND c.kind='order_reconcile' AND c.resource_id=$4 AND c.status='APPLIED' AND c.actor_id=$5 AND c.payload->>'amount_minor'=$6 AND c.payload->>'currency'=$7 AND c.payload->>'evidence_asset_id'=$8 AND c.payload->>'reason'=$9 AND c.result->>'order_id'=$4 AND c.result->>'status'='RECONCILED' AND a.body->>'status'='READY' AND length(a.body->>'storage_key')>0 AND a.body->>'sha256' ~ '^[a-f0-9]{64}$'
    AND EXISTS(SELECT 1 FROM domain_events e WHERE e.workspace_id=c.workspace_id AND e.environment=c.environment AND e.aggregate_id=$10 AND e.event_type='order.reconciled' AND e.causation_id=c.id::text AND e.recorded_at=c.updated_at AND e.payload->>'order_id'=$4 AND e.payload->>'amount_minor'=$6 AND e.payload->>'currency'=$7 AND e.payload->>'evidence_asset_id'=$8 AND e.payload->>'actor_id'=c.actor_id) FOR SHARE OF c,a`,[r.command_id,conversation.workspace_id,conversation.environment,order.id,r.actor_id,String(order.body.reconciled_amount_minor),order.body.reconciled_currency,r.evidence_asset_id,r.reason,conversation.id])).rows;
   reconciliation={command_id:r.command_id,amount_minor:order.body.reconciled_amount_minor,currency:order.body.reconciled_currency,verified:proof.length===1};
  }
  await db.query("SELECT a.id FROM records a WHERE a.workspace_id=$1 AND a.environment=$2 AND a.kind='asset' AND a.id::text IN(SELECT f.body->>'asset_id' FROM records f WHERE f.workspace_id=$1 AND f.environment=$2 AND f.kind='fulfillment' AND f.body->>'order_id'=$3) ORDER BY a.id FOR SHARE",[...scope.slice(0,2),order.id]);
  const fulfillments=(await db.query(`SELECT f.*,a.body->>'kind' asset_kind,a.body->>'adapter' asset_adapter FROM records f LEFT JOIN records a ON a.id::text=f.body->>'asset_id' AND a.workspace_id=f.workspace_id AND a.environment=f.environment AND a.kind='asset' WHERE f.workspace_id=$1 AND f.environment=$2 AND f.kind='fulfillment' AND f.body->>'order_id'=$3 ORDER BY f.id FOR SHARE OF f`,[...scope.slice(0,2),order.id])).rows;
  for(const f of fulfillments){
   const e=effects.find(e=>e.id===f.body.effect_id),g=effects.find(e=>e.id===f.body.grant_effect_id);
   const historical=await retained(order.id,'DELIVERY',f.id);
   async function confirmed(e:Body|undefined){if(historical)return true;return !!e&&!!e.provider_message_id&&(await db.query("SELECT id FROM effect_attempts WHERE effect_id=$1 AND status IN('SENT','DELIVERED','READ') AND finished_at IS NOT NULL AND result->>'provider_message_id'=$2 ORDER BY id",[e.id,e.provider_message_id])).rows.length>0;}
   Object.assign(f,{effect_status:e?.status,provider_message_id:e?.provider_message_id,effect_payload:e?.payload,effect_conversation_id:e?.conversation_id,effect_accepted:await confirmed(e),grant_status:g?.status,grant_provider_message_id:g?.provider_message_id,grant_payload:g?.payload,grant_conversation_id:g?.conversation_id,grant_has_access:typeof g?.result?.access_ciphertext==='string'&&g.result.access_ciphertext.length>0,grant_accepted:await confirmed(g)});
  }
  facts.push({order,contributions,reconciliation,fulfillments,termsVerified});
 }
 return evaluateCommercialClosure(conversation,facts,effects);
}
