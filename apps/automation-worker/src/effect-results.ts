import {query,withTransaction,getRecord,putRecord,setRemarketingAttemptStatus} from '@commerce/db';
import {summarizeDelivery} from '../../../packages/domain/src/sales/delivery-status.js';
import {save} from './shared.js';
import {resumeRecipeAfterSellerConfirmation} from './recipe-interruptions.js';
import {resumeClosingSaleAfterDelivery,resumePrepaymentAfterDelivery} from './workflows.js';

/** Channel owns execution rows; automation projects their durable facts into sales records. */
export async function materializeEffectResults(limit=100) {
 const rows=(await query(`SELECT o.* FROM outbox o WHERE o.kind<>'warmup' AND COALESCE(o.payload->>'kind','text') NOT IN('grant','warmup')
 AND o.status IN('SENT','DELIVERED','READ','FAILED','UNKNOWN','CANCELLED') AND (
 NOT EXISTS(SELECT 1 FROM records m WHERE m.workspace_id=o.workspace_id AND m.environment=o.environment AND m.kind='message' AND m.body->>'effect_id'=o.id::text)
 OR EXISTS(SELECT 1 FROM records m WHERE m.workspace_id=o.workspace_id AND m.environment=o.environment AND m.kind='message' AND m.body->>'effect_id'=o.id::text AND m.body->>'status' IS DISTINCT FROM o.status)
 OR EXISTS(SELECT 1 FROM records f WHERE f.workspace_id=o.workspace_id AND f.environment=o.environment AND f.kind='fulfillment' AND f.id::text=o.payload->>'fulfillment_id' AND (f.body->>'status' IS DISTINCT FROM o.status OR f.body->>'delivery_projection_version' IS DISTINCT FROM '2')))
 ORDER BY o.updated_at LIMIT $1`,[limit])).rows;
 for(const effect of rows) await withTransaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[effect.conversation_id]);
  const current=(await client.query('SELECT * FROM outbox WHERE id=$1',[effect.id])).rows[0];
  if(!current||current.kind==='warmup'||['grant','warmup'].includes(current.payload.kind))return;
  const message=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='message' AND body->>'effect_id'=$3`,[current.workspace_id,current.environment,current.id])).rows[0];
  const body={conversation_id:current.conversation_id,contact_id:current.contact_id,account_id:current.account_id,direction:'OUTBOUND',kind:current.payload.kind,text:current.payload.text??'',asset_id:current.payload.asset_id,status:current.status,effect_id:current.id,provider_message_id:current.provider_message_id,stage_at_creation:current.payload.stage_at_creation??null};
  if(!message)await putRecord(client,{workspaceId:current.workspace_id,environment:current.environment,kind:'message',body});
  else if(message.body.status!==current.status)await save(client,message,{...message.body,status:current.status});
  if(current.payload.purpose==='seller_reply'&&['SENT','DELIVERED','READ'].includes(current.status)){
   const conversation=await getRecord(client,current.workspace_id,'conversation',current.conversation_id);
   if(conversation&&conversation.environment===current.environment)await resumeRecipeAfterSellerConfirmation(client,conversation,current);
  }
  if(current.payload.remarketing_attempt_id){
   const scope={attemptId:current.payload.remarketing_attempt_id,workspaceId:current.workspace_id,environment:current.environment};
   if(['DELIVERED','READ'].includes(current.status))await setRemarketingAttemptStatus(client,scope,'DELIVERED',{effect_id:current.id,delivery_status:current.status});
   else if(current.status==='SENT')await setRemarketingAttemptStatus(client,scope,'SENT',{effect_id:current.id});
   else if(current.status==='UNKNOWN')await setRemarketingAttemptStatus(client,scope,'UNKNOWN',{effect_id:current.id});
   else if(['FAILED','CANCELLED'].includes(current.status))await setRemarketingAttemptStatus(client,scope,'CANCELLED',{effect_id:current.id,reason:current.result?.reason??current.status});
  }
  if(!current.payload.fulfillment_id){
   if(Number(current.payload.workflow_recipe_step)===9){const conversation=await getRecord(client,current.workspace_id,'conversation',current.conversation_id);if(conversation&&conversation.environment===current.environment)await resumeClosingSaleAfterDelivery(client,conversation,current.id);}
   return;
  }
  const fulfillment=await getRecord(client,current.workspace_id,'fulfillment',current.payload.fulfillment_id);
  if(!fulfillment||fulfillment.environment!==current.environment)return;
  const asset=await getRecord(client,current.workspace_id,'asset',fulfillment.body.asset_id);
  await save(client,fulfillment,{...fulfillment.body,status:current.status,attempts:current.attempts,delivery_projection_version:2,
   ...(['access','link'].includes(asset?.body.kind)?{access_verification_status:fulfillment.body.access_verification_status??'UNVERIFIED'}:{})});
  const order=await getRecord(client,current.workspace_id,'order',fulfillment.body.order_id);
  if(!order||order.environment!==current.environment)return;
  const all=(await client.query(`SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='fulfillment' AND body->>'order_id'=$3`,[current.workspace_id,current.environment,order.id])).rows.map(r=>r.body);
  await save(client,order,{...order.body,fulfillment_status:summarizeDelivery(all.map(f=>f.status)),delivery_projection_version:2});
  const conversation=await getRecord(client,current.workspace_id,'conversation',current.conversation_id);
  if(conversation&&conversation.environment===current.environment){await resumePrepaymentAfterDelivery(client,conversation,current.id);await resumeClosingSaleAfterDelivery(client,conversation,current.id);}
 });
 return rows.length;
}
