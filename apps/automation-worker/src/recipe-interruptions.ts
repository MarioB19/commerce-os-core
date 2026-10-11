import type {Body,DomainRecord} from '@commerce/contracts';
import type {QueryExecutor} from '@commerce/db';
import {event,proposeEffect,save} from './shared.js';

const activeInterruptionStatuses=new Set(['AWAITING_SELLER_REPLY','AWAITING_SELLER_CONFIRMATION']);
const transportConfirmedStatuses=new Set(['SENT','DELIVERED','READ']);

/**
 * Supersede only recipe effects that have never entered transport. The durable
 * cancelled rows remain the immutable resume source and preserve the original
 * causal chain for any SENDING/UNKNOWN predecessor.
 */
export async function interruptPendingRecipeEffects(client:QueryExecutor,conversation:DomainRecord,cause:string){
 const current=conversation.body.recipe_interruption;
 if(activeInterruptionStatuses.has(String(current?.status))||conversation.body.flow_state?.status!=='WAITING')return conversation;
 const token=cause;
 const cancelled=(await client.query(
  `UPDATE outbox SET status='CANCELLED',
    result=COALESCE(result,'{}'::jsonb)||jsonb_build_object('reason','CUSTOMER_INTERRUPTED_RECIPE','superseded_before_send',true,'recipe_resume_token',$3::text),
    updated_at=now()
   WHERE workspace_id=$1 AND conversation_id=$2 AND status IN('READY','BLOCKED') AND attempts=0
    AND payload ? 'workflow_recipe_step' AND payload->>'actor_kind' IS DISTINCT FROM 'human'
   RETURNING id,dispatch_sequence,payload`,
  [conversation.workspace_id,conversation.id,token],
 )).rows.sort((a,b)=>Number(a.dispatch_sequence)-Number(b.dispatch_sequence));
 if(!cancelled.length)return conversation;
 const interruption:Body={
  token,
  status:'AWAITING_SELLER_REPLY',
  interrupted_at_sequence:Number(conversation.body.sequence??0),
  pending_effect_ids:cancelled.map(effect=>effect.id),
  pending_recipe_steps:cancelled.map(effect=>Number(effect.payload.workflow_recipe_step)),
 };
 const updated=await save(client,conversation,{...conversation.body,recipe_interruption:interruption});
 await event(client,updated,'workflow.recipe_interrupted',{token,effect_ids:interruption.pending_effect_ids,recipe_steps:interruption.pending_recipe_steps},cause);
 return updated;
}

/** Re-propose the exact unsent suffix only after the seller reply is accepted by transport. */
export async function resumeRecipeAfterSellerConfirmation(client:QueryExecutor,conversation:DomainRecord,sellerEffect:Body){
 const interruption=conversation.body.recipe_interruption;
 if(!interruption||interruption.status!=='AWAITING_SELLER_CONFIRMATION'||interruption.seller_effect_id!==sellerEffect.id||!transportConfirmedStatuses.has(String(sellerEffect.status)))return conversation;
 const pendingIds=Array.isArray(interruption.pending_effect_ids)?interruption.pending_effect_ids.filter((id:unknown):id is string=>typeof id==='string'):[];
 if(!pendingIds.length)return conversation;
 const originals=(await client.query(
  `SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND conversation_id=$3 AND id=ANY($4::uuid[]) ORDER BY dispatch_sequence`,
  [conversation.workspace_id,conversation.environment,conversation.id,pendingIds],
 )).rows;
 if(originals.length!==pendingIds.length||originals.some(effect=>effect.status!=='CANCELLED'||Number(effect.attempts)!==0||effect.result?.recipe_resume_token!==interruption.token||effect.result?.superseded_before_send!==true)){
  await event(client,conversation,'workflow.recipe_resume_blocked',{token:interruption.token,reason:'PENDING_EFFECT_SNAPSHOT_CHANGED'},sellerEffect.id);
  return save(client,conversation,{...conversation.body,recipe_interruption:{...interruption,status:'HUMAN_REVIEW',reason:'PENDING_EFFECT_SNAPSHOT_CHANGED'}});
 }
 let predecessorId=String(sellerEffect.id);
 const resumedEffectIds:string[]=[];
 for(const [index,original] of originals.entries()){
  const logicalKey=`recipe-resume:${interruption.token}:${index+1}`;
  const payload:Body={...original.payload,resumed_from_effect_id:original.id,recipe_resume_token:interruption.token};
  let resumed=await proposeEffect(client,conversation,payload,logicalKey,{predecessorId});
  if(!resumed)resumed=(await client.query('SELECT * FROM outbox WHERE workspace_id=$1 AND logical_key=$2',[conversation.workspace_id,logicalKey])).rows[0];
  if(!resumed)throw new Error('RECIPE_RESUME_EFFECT_NOT_PROPOSED');
  resumedEffectIds.push(resumed.id);predecessorId=resumed.id;
 }
 const updated=await save(client,conversation,{...conversation.body,recipe_interruption:{...interruption,status:'RESUMED',resumed_effect_ids:resumedEffectIds,resumed_after_effect_id:sellerEffect.id}});
 await event(client,updated,'workflow.recipe_resumed',{token:interruption.token,seller_effect_id:sellerEffect.id,effect_ids:resumedEffectIds,recipe_steps:interruption.pending_recipe_steps},sellerEffect.id);
 return updated;
}
