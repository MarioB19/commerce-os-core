import {nextRemarketingTime} from '../../../packages/domain/src/sales/remarketing.js';
import {buyerExcluded,cancelPendingRemarketingForContact,getRecord,openRemarketingCycle,uuid,type QueryExecutor,type RemarketingStage} from '@commerce/db';
import type {Body,DomainRecord} from '@commerce/contracts';
import type {FlowState} from '../../../packages/domain/src/sales/workflow.js';
import {event,gated,nowFor,save,commercialContext} from './shared.js';

export type ConfirmedAnchor={node_id?:string;effect_id?:string;fulfillment_release_on?:string};
/** Only the final message's transport acceptance qualifies; grant creation does not. */
export async function confirmedAnchor(client:QueryExecutor,conversation:DomainRecord,anchor:ConfirmedAnchor):Promise<{at:string;effect_ids:string[]}|undefined>{
 const effects=anchor.effect_id
  ?(await client.query(`SELECT * FROM outbox WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND conversation_id=$4`,[anchor.effect_id,conversation.workspace_id,conversation.environment,conversation.id])).rows
  :anchor.fulfillment_release_on
  ?(await client.query(`SELECT o.* FROM records f LEFT JOIN outbox o ON o.id::text=f.body->>'effect_id' AND o.workspace_id=f.workspace_id AND o.environment=f.environment WHERE f.workspace_id=$1 AND f.environment=$2 AND f.kind='fulfillment' AND f.body->>'conversation_id'=$3 AND f.body->>'release_on'=$4`,[conversation.workspace_id,conversation.environment,conversation.id,anchor.fulfillment_release_on])).rows
  :(await client.query(`SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 AND payload->>'workflow_node_id'=$4 AND payload->>'workflow_runtime_version'=$5 ORDER BY dispatch_sequence DESC LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id,anchor.node_id,conversation.body.workflow_runtime_version??conversation.body.workflow_version_id])).rows;
 if(!effects.length||effects.some(e=>!e.id||!['SENT','DELIVERED','READ'].includes(e.status)||!e.provider_message_id))return;
 const instants=effects.map(e=>new Date(e.result?.accepted_at??e.updated_at).getTime());
 if(instants.some(t=>!Number.isFinite(t)))return;
 return{at:new Date(Math.max(...instants)).toISOString(),effect_ids:effects.map(e=>e.id)};
}
export async function collectionEligibility(client:QueryExecutor,conversation:DomainRecord,followup=false,hasEligibleTemplate=false):Promise<string|undefined>{
 if(conversation.body.sponsorship_id)return'SPONSORED_CORE_NO_DEBT';
 if(conversation.body.collection_stop_reason||conversation.body.followup_stop_reason&&followup)return String(conversation.body.collection_stop_reason??conversation.body.followup_stop_reason);
 if(conversation.body.ai_status==='HUMAN_REVIEW'||conversation.body.flow_state?.status==='HUMAN_REVIEW'||await gated(client,conversation))return'HUMAN_OR_OPERATION_CONTROL';
 const contact=await getRecord(client,conversation.workspace_id,'contact',conversation.body.contact_id);
 if(contact?.body.status==='SUPPRESSED')return'CONTACT_SUPPRESSED';
 if(await buyerExcluded(client,{workspace_id:conversation.workspace_id,environment:conversation.environment,contact_id:conversation.body.contact_id}))return'BUYER_EXCLUDED';
 const order=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];
 if(!order?.body.committed_at)return'COMMITMENT_REQUIRED';
 if(order.body.receipt_status&&order.body.receipt_status!=='NONE'||order.body.sale_status==='RECOGNIZED'||Number(order.body.sale_amount_minor)>0||order.body.reconciliation_status==='RECONCILED')return'RECEIPT_RECEIVED';
 // A document waiting for extraction also cancels collection; it cannot race media analysis.
 const receipt=(await client.query(`SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='receipt' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rowCount;
 if(receipt)return'RECEIPT_RECEIVED';
 if(followup){
  if(!await confirmedAnchor(client,conversation,{fulfillment_release_on:'commitment_accepted'}))return'CORE_NOT_CONFIRMED';
  const now=await nowFor(client,conversation),last=new Date(conversation.body.last_inbound_at??0).getTime();
  if((!Number.isFinite(last)||last>now.getTime()||now.getTime()-last>=24*3600_000)&&!hasEligibleTemplate)return'FOLLOWUP_WINDOW_CLOSED';
 }
 return;
}
export async function remarketingEligibility(client:QueryExecutor,conversation:DomainRecord,stage:RemarketingStage,hasEligibleTemplate=false):Promise<string|undefined>{
 if(stage==='COLLECTION')return collectionEligibility(client,conversation,true,hasEligibleTemplate);
 if(conversation.body.sponsorship_id)return'SPONSORED_CORE_NO_DEBT';
 if(conversation.body.collection_stop_reason||conversation.body.followup_stop_reason)return String(conversation.body.collection_stop_reason??conversation.body.followup_stop_reason);
 if(conversation.body.ai_status==='HUMAN_REVIEW'||conversation.body.flow_state?.status==='HUMAN_REVIEW'||await gated(client,conversation))return'HUMAN_OR_OPERATION_CONTROL';
 const contact=await getRecord(client,conversation.workspace_id,'contact',conversation.body.contact_id);
 if(contact?.body.status==='SUPPRESSED')return'CONTACT_SUPPRESSED';
 if(await buyerExcluded(client,{workspace_id:conversation.workspace_id,environment:conversation.environment,contact_id:conversation.body.contact_id}))return'BUYER_EXCLUDED';
 const order=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1`,[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];
 if(order?.body.committed_at)return'AGREEMENT_ACCEPTED';
 if(order?.body.receipt_status&&order.body.receipt_status!=='NONE'||order?.body.sale_status==='RECOGNIZED'||Number(order?.body.sale_amount_minor)>0)return'RECEIPT_RECEIVED';
 const now=await nowFor(client,conversation),last=new Date(conversation.body.last_inbound_at??0).getTime();
 if((!Number.isFinite(last)||last>now.getTime()||now.getTime()-last>=24*3600_000)&&!hasEligibleTemplate)return'FOLLOWUP_WINDOW_CLOSED';
 return;
}
export async function armConfirmedWait(client:QueryExecutor,conversation:DomainRecord,state:FlowState):Promise<boolean>{
 const wait=state.pending_anchor;if(!wait)return false;
 if(wait.purpose==='collection'){
  const reason=await collectionEligibility(client,conversation);
  if(reason){delete state.pending_anchor;state.waiting_for='receipt_approved';await event(client,conversation,'workflow.confirmed_wait_cancelled',{node_id:wait.node_id,reason});return true;}
 }
 const anchor=await confirmedAnchor(client,conversation,wait.anchor);if(!anchor)return false;
 const due=new Date(new Date(anchor.at).getTime()+wait.seconds*1000).toISOString();
 await client.query(`INSERT INTO timers(id,workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,$2,$3,$4,'workflow_wait',$5,$6,$7) ON CONFLICT(workspace_id,logical_key) DO NOTHING`,[uuid(),conversation.workspace_id,conversation.environment,conversation.id,{...await commercialContext(client,conversation),node_id:wait.node_id,workflow_version_id:conversation.body.workflow_version_id,purpose:wait.purpose??null,anchor_at:anchor.at,anchor_effect_ids:anchor.effect_ids},due,wait.key]);
 state.wake_at=due;state.waiting_for='timer';delete state.pending_anchor;
 await event(client,conversation,'workflow.confirmed_wait_scheduled',{node_id:wait.node_id,due_at:due,anchor_at:anchor.at,anchor_effect_ids:anchor.effect_ids,delay_seconds:wait.seconds},wait.key);
 return true;
}
export async function armFollowups(client:QueryExecutor,conversation:DomainRecord):Promise<DomainRecord>{
 const plan=conversation.body.followup_plan;if(plan?.status!=='AWAITING_COLLECTION_ACK')return conversation;
 const stage:RemarketingStage=plan.stage==='awaiting_agreement'?'AGREEMENT':'COLLECTION';
 const reason=plan.policy_snapshot?await remarketingEligibility(client,conversation,stage):await collectionEligibility(client,conversation,true);
 if(reason&&reason!=='CORE_NOT_CONFIRMED')return save(client,conversation,{...conversation.body,followup_plan:{...plan,status:'CANCELLED',reason}});
 const anchor=await confirmedAnchor(client,conversation,plan.anchor_effect_id?{effect_id:plan.anchor_effect_id}:{node_id:plan.anchor_node_id});if(!anchor)return conversation;
 let touches:Body[]=plan.touches??[];
 let cycle:Body|undefined;
 if(plan.policy_snapshot){
  const configuredMaximum=Number(plan.policy_snapshot.maximum??(plan.policy_snapshot.slots??[]).filter((slot:Body)=>slot.enabled).length);
  cycle=await openRemarketingCycle(client,conversation,{policySnapshot:plan.policy_snapshot,stage,anchorAt:anchor.at,maxAttempts:configuredMaximum,reanchor:plan.resume_after_customer_reply===true});
  // The open cycle is the source of truth. Publishing or selecting a newer
  // offer never mutates an in-flight contact's content, windows or quota.
  const snapshot=cycle.policy_snapshot??plan.policy_snapshot;
  const consumed=new Set((await client.query('SELECT slot_id FROM commercial_remarketing_attempts WHERE cycle_id=$1',[cycle.id])).rows.map(row=>String(row.slot_id)));
  touches=(snapshot.slots??[]).filter((slot:Body)=>slot.enabled&&!consumed.has(String(slot.id))).map((slot:Body)=>({...slot,...slot.stages?.[plan.stage],after_seconds:slot.after_seconds??slot.delay_seconds}));
  await cancelPendingRemarketingForContact(client,conversation,`REMARKETING_${stage}_REPROGRAMMED`);
 }
 // RF-10.d: reminders land only inside the variant's allowed local hours.
 const window=plan.policy_snapshot?((cycle?.policy_snapshot??plan.policy_snapshot) as Body).window:undefined;
 for(const [index,touch] of touches.entries()){
  const due=nextRemarketingTime(new Date(new Date(anchor.at).getTime()+touch.after_seconds*1000),window).toISOString();
  const timerId=uuid();
  await client.query(`INSERT INTO timers(id,workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,$2,$3,$4,'followup',$5,$6,$7) ON CONFLICT(workspace_id,logical_key) DO NOTHING`,[timerId,conversation.workspace_id,conversation.environment,conversation.id,{...await commercialContext(client,conversation),...touch,...(window?{window}:{}),purpose:plan.policy_snapshot?'remarketing':'followup',plan_key:plan.key,touch_index:Number(touch.position??index+1),slot_id:touch.id,stage,cycle_id:cycle?.id??null,workflow_runtime_version:plan.workflow_runtime_version,anchor_at:anchor.at,anchor_effect_ids:anchor.effect_ids},due,cycle?`remarketing:${cycle.id}:${stage}:${touch.id}:${cycle.revision}`:`${plan.key}:${touch.id}:${plan.anchor_effect_id??'initial'}`]);
 }
 await event(client,conversation,plan.policy_snapshot?'remarketing.plan_scheduled':'followup.plan_scheduled',{plan_key:plan.key,cycle_id:cycle?.id??null,stage:plan.stage??null,touches:touches.map((t:Body)=>({id:t.id,after_seconds:t.after_seconds})),anchor_at:anchor.at,anchor_effect_ids:anchor.effect_ids});
 return save(client,conversation,{...conversation.body,followup_plan:{...plan,status:touches.length?'SCHEDULED':'DISABLED',cycle_id:cycle?.id??null,anchor_at:anchor.at,anchor_effect_ids:anchor.effect_ids,resume_after_customer_reply:false}});
}
