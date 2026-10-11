import {getRecord,type QueryExecutor} from '@commerce/db';
import type {Body,DomainRecord} from '@commerce/contracts';
import {approvedBenefitTotal,activeLaunchTest} from '../../../packages/db/src/launch-test-scope.js';
import {save,create,event,cancelPending,proposeEffect,gated} from './shared.js';

async function inboundEvidence(c:QueryExecutor,conversation:DomainRecord,id:string,after?:Date){
 const message=await getRecord(c,conversation.workspace_id,'message',id);
 if(!message||message.environment!==conversation.environment||message.body.conversation_id!==conversation.id||message.body.direction!=='INBOUND'||!message.body.text?.trim())throw new Error('BENEFICIARY_INBOUND_EVIDENCE_REQUIRED');
 if(after&&Date.parse(message.body.provider_at??message.created_at)<after.getTime())throw new Error('CONFIRMATION_MUST_FOLLOW_DELIVERY');
 return message;
}
async function orderFor(c:QueryExecutor,conversation:DomainRecord){return(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3",[conversation.workspace_id,conversation.environment,conversation.id])).rows[0] as DomainRecord|undefined;}

/** Durable operator commands; every message uses the existing outbox authorization boundary. */
export async function applyMclSponsorshipCommand(c:QueryExecutor,cmd:Body){
 const p=cmd.payload??{};
 let row=(await c.query('SELECT * FROM mcl_sponsorships WHERE workspace_id=$1 AND environment=$2 AND id=$3',[cmd.workspace_id,cmd.environment,cmd.resource_id])).rows[0];
 if(!row)throw new Error('SPONSORSHIP_NOT_FOUND');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[row.sponsor_conversation_id]);
 const beneficiaryId=p.beneficiary_conversation_id??row.beneficiary_conversation_id;
 if(beneficiaryId&&beneficiaryId!==row.sponsor_conversation_id)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[beneficiaryId]);
 row=(await c.query('SELECT * FROM mcl_sponsorships WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
 if(row.revision!==p.expected_version)throw new Error('VERSION_CONFLICT');
 const sponsor=await getRecord(c,row.workspace_id,'conversation',row.sponsor_conversation_id);
 const order=await getRecord(c,row.workspace_id,'order',row.order_id);
 if(!sponsor||!order||sponsor.environment!==row.environment||order.environment!==row.environment)throw new Error('SPONSORSHIP_SCOPE_INVALID');
 if(!row.eligible||await approvedBenefitTotal(c,order)<=10700||order.body.currency!=='MXN')throw new Error('SPONSORSHIP_NOT_ELIGIBLE');
 if(row.test_scope_id&&!await activeLaunchTest(c,order))throw new Error('LAUNCH_TEST_SCOPE_INACTIVE');
 const beneficiary=beneficiaryId?await getRecord(c,row.workspace_id,'conversation',beneficiaryId):undefined;
 if(!beneficiary||beneficiary.environment!==row.environment||beneficiary.id===sponsor.id||beneficiary.body.contact_id===sponsor.body.contact_id)throw new Error('DISTINCT_BENEFICIARY_REQUIRED');
 if(row.test_scope_id){
  const scope=(await c.query('SELECT participants FROM mcl_test_scopes WHERE id=$1',[row.test_scope_id])).rows[0];
  if(!scope?.participants.some((x:Body)=>x.contact_id===beneficiary.body.contact_id&&x.role==='beneficiary'))throw new Error('TEST_BENEFICIARY_NOT_IN_SCOPE');
 }
 if(p.action==='assign'){
  if(row.status!=='WAITING_BENEFICIARY')throw new Error('SPONSORSHIP_ALREADY_ASSIGNED');
  if(p.eligibility_confirmed!==true)throw new Error('BENEFICIARY_ELIGIBILITY_REQUIRED');
  await inboundEvidence(c,beneficiary,p.consent_message_id);
  const ownOrder=await orderFor(c,beneficiary);
  if(!ownOrder||ownOrder.body.offer_version_id!==order.body.offer_version_id)throw new Error('BENEFICIARY_MATCHING_OFFER_REQUIRED');
  if(ownOrder.body.committed_at||ownOrder.body.sponsored_by||Number(ownOrder.body.sale_amount_minor)>0||beneficiary.body.sponsorship_id)throw new Error('BENEFICIARY_HAS_COMMERCIAL_OBLIGATION');
  if(ownOrder&&(await c.query('SELECT 1 FROM payment_contributions WHERE order_id=$1',[ownOrder.id])).rowCount)throw new Error('BENEFICIARY_HAS_PAYMENT_HISTORY');
  if((await c.query('SELECT 1 FROM mcl_sponsorships WHERE workspace_id=$1 AND environment=$2 AND beneficiary_contact_id=$3',[row.workspace_id,row.environment,beneficiary.body.contact_id])).rowCount)throw new Error('BENEFICIARY_ALREADY_ASSIGNED');
  await cancelPending(c,beneficiary,'SPONSORED_WITHOUT_PAYMENT');
  if((await c.query("SELECT 1 FROM outbox WHERE conversation_id=$1 AND status IN ('SENDING','UNKNOWN')",[beneficiary.id])).rowCount)throw new Error('BENEFICIARY_HAS_IN_FLIGHT_EFFECT');
  await save(c,beneficiary,{...beneficiary.body,sponsorship_id:row.id,payment_obligation:false,ai_pending:false,active_ai_run_id:null,stage:'ACTIVE',flow_state:{...(beneficiary.body.flow_state??{}),status:'FINISHED',waiting_for:null}});
  if(ownOrder)await save(c,ownOrder,{...ownOrder.body,sponsored_by:row.id,payment_obligation:false,amount_minor:0,status:'SPONSORED'});
  await c.query("UPDATE mcl_sponsorships SET status='ASSIGNED',beneficiary_conversation_id=$2,beneficiary_contact_id=$3,consent_message_id=$4,assigned_by=$5,assigned_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",[row.id,beneficiary.id,beneficiary.body.contact_id,p.consent_message_id,cmd.actor_id]);
 }else if(p.action==='deliver'){
  if(row.status!=='ASSIGNED'||row.delivery_effect_id)throw new Error('SPONSORSHIP_NOT_AWAITING_DELIVERY');
  if(await gated(c,beneficiary))throw new Error('BENEFICIARY_CONTROLS_BLOCK_DELIVERY');
  const inboundAt=Date.parse(beneficiary.body.last_inbound_at??'');
  if(!Number.isFinite(inboundAt)||Date.now()-inboundAt>=86400000)throw new Error('BENEFICIARY_CUSTOMER_WINDOW_CLOSED');
  const asset=await getRecord(c,row.workspace_id,'asset',row.core_asset_id);
  if(!asset||asset.environment!==row.environment||asset.body.status!=='READY'||!['access','link'].includes(asset.body.kind))throw new Error('SPONSORED_CORE_NOT_READY');
  const beneficiaryOrder=await orderFor(c,beneficiary);if(!beneficiaryOrder)throw new Error('BENEFICIARY_ORDER_REQUIRED');
  const fulfillment=await create(c,beneficiary,'fulfillment',{order_id:beneficiaryOrder.id,conversation_id:beneficiary.id,sponsorship_id:row.id,asset_id:asset.id,release_on:'sponsored',status:'PROPOSED',access_verification_status:'UNVERIFIED',adapter:asset.body.adapter??asset.body.kind,attempts:0,payment_obligation:false});
  const notice=await proposeEffect(c,beneficiary,{kind:'text',text:'Tu Core de Mi Ciclo Listo es patrocinado 💛 No tienes que pagar nada. Aquí recibirás el acceso; cuando entres, confirma si pudiste abrir y descargar el PDF de tu grado.',purpose:'sponsorship',sponsorship_id:row.id},`mcl-sponsor-intro:${row.id}`);
  if(!notice)throw new Error('SPONSORED_DELIVERY_BLOCKED');
  const grant=asset.body.kind==='access'?await proposeEffect(c,beneficiary,{kind:'grant',asset_id:asset.id,grant_id:fulfillment.id,purpose:'sponsorship',sponsorship_id:row.id},`mcl-sponsor-grant:${row.id}`,{predecessorId:notice.id}):undefined;
  if(asset.body.kind==='access'&&!grant)throw new Error('SPONSORED_DELIVERY_BLOCKED');
  const effect=await proposeEffect(c,beneficiary,{kind:'text',purpose:'sponsorship',sponsorship_id:row.id,fulfillment_id:fulfillment.id,...(grant?{grant_effect_id:grant.id}:{asset_id:asset.id,text:asset.body.url})},`mcl-sponsor-core:${row.id}`,{predecessorId:grant?.id??notice.id});
  if(!effect)throw new Error('SPONSORED_DELIVERY_BLOCKED');
  await save(c,fulfillment,{...fulfillment.body,effect_id:effect.id,...(grant?{grant_effect_id:grant.id}:{})});
  await c.query("UPDATE mcl_sponsorships SET status='DELIVERY_PENDING',fulfillment_id=$2,delivery_effect_id=$3,revision=revision+1,updated_at=now() WHERE id=$1",[row.id,fulfillment.id,effect.id]);
 }else if(p.action==='confirm_receipt'){
  if(row.status!=='DELIVERY_PENDING'||!p.opened_core||!p.downloaded_pdf)throw new Error('CORE_AND_PDF_CONFIRMATION_REQUIRED');
  const effect=(await c.query("SELECT * FROM outbox WHERE id=$1 AND conversation_id=$2 AND status IN ('SENT','DELIVERED','READ') AND provider_message_id IS NOT NULL",[row.delivery_effect_id,beneficiary.id])).rows[0];
  if(!effect)throw new Error('CONFIRMED_PROVIDER_SEND_REQUIRED');
  const sent=(await c.query("SELECT min(finished_at) sent_at FROM effect_attempts WHERE effect_id=$1 AND status='SENT' AND finished_at IS NOT NULL",[effect.id])).rows[0]?.sent_at;
  if(!sent)throw new Error('CONFIRMED_PROVIDER_ATTEMPT_REQUIRED');
  await inboundEvidence(c,beneficiary,p.confirmation_message_id,new Date(sent));
  const fulfillment=await getRecord(c,row.workspace_id,'fulfillment',row.fulfillment_id);
  if(!fulfillment)throw new Error('SPONSORED_FULFILLMENT_NOT_FOUND');
  await save(c,fulfillment,{...fulfillment.body,access_verification_status:'CONFIRMED_BY_RECIPIENT',verification:{message_id:p.confirmation_message_id,opened_core:true,downloaded_pdf:true,reviewed_by:cmd.actor_id,reviewed_at:new Date().toISOString()}});
  await c.query("UPDATE mcl_sponsorships SET status='RECEIPT_CONFIRMED',confirmation_message_id=$2,confirmed_by=$3,confirmed_at=now(),revision=revision+1,updated_at=now() WHERE id=$1",[row.id,p.confirmation_message_id,cmd.actor_id]);
 }else if(p.action==='notify_sponsor'){
  if(row.status!=='RECEIPT_CONFIRMED'||!row.confirmed_at||row.notice_effect_id)throw new Error('BENEFICIARY_RECEIPT_NOT_CONFIRMED');
  if(await gated(c,sponsor))throw new Error('SPONSOR_CONTROLS_BLOCK_NOTICE');
  const effect=await proposeEffect(c,sponsor,{kind:'text',purpose:'sponsorship_notice',text:'Tu apoyo ya llegó 💛 La beneficiaria confirmó que recibió el Core de Mi Ciclo Listo, pudo abrir el portal y descargar su PDF. No tiene obligación de pago. Gracias por compartir estas herramientas.',sponsorship_id:row.id},`mcl-sponsor-notice:${row.id}`);
  if(!effect)throw new Error('SPONSOR_NOTICE_BLOCKED');
  await c.query("UPDATE mcl_sponsorships SET status='NOTICE_PENDING',notice_effect_id=$2,revision=revision+1,updated_at=now() WHERE id=$1",[row.id,effect.id]);
 }else throw new Error('SPONSORSHIP_ACTION_INVALID');
 await event(c,sponsor,'mcl.sponsorship_'+p.action,{sponsorship_id:row.id,actor_id:cmd.actor_id},cmd.id);
 return {sponsorship_id:row.id,status:(await c.query('SELECT status FROM mcl_sponsorships WHERE id=$1',[row.id])).rows[0].status};
}
