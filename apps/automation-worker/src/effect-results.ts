import {withNumberLabEngine,type NumberLabEngineLease} from '../../../packages/db/src/number-lab-engine-runtime.js';
import type {ProfileQuery} from '../../../packages/db/src/profile-context.js';
import {bindNumberLabDispatch,type NumberLabDispatch} from '../../channel-worker/src/catalog-simulator.js';
import {query,withTransaction,getRecord,putRecord,setRemarketingAttemptStatus,type QueryExecutor} from '@commerce/db';
import {summarizeDelivery} from '../../../packages/domain/src/sales/delivery-status.js';
import {save} from './shared.js';
import {resumeRecipeAfterSellerConfirmation} from './recipe-interruptions.js';
import {resumeClosingSaleAfterDelivery,resumePrepaymentAfterDelivery} from './workflows.js';

/** Terminal effects whose sales projection is missing or stale.
 * V7 forces RLS on records and outbox (docs/adr-v7-dispatch-rls-index.md): a
 * join qual is an index condition only when it is leakproof, and body->>… or
 * uuid::text are not. The previous correlated form re-scanned every message
 * record (and every fulfillment) once per terminal effect on each 250 ms pass;
 * with production data that was 150k buffers and ~2 s per pass, a full core of
 * PostgreSQL (docs/adr-v7-1-worker-loop-budget.md). The text identifiers are
 * converted to uuid inside materialized CTEs (canonical lowercase form only, the
 * exact strings uuid::text produces) and joined by uuid=uuid/text=text with hash joins, so
 * each table is read once per pass (fulfillments by primary key). Same rows, same
 * order: a text id that is not the canonical form of the effect id never matched. */
const CANONICAL_UUID="'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
export const PENDING_EFFECT_RESULTS=(scope:string)=>`WITH terminal AS MATERIALIZED (SELECT o.id,o.workspace_id,o.environment,o.status,
 CASE WHEN o.payload->>'fulfillment_id' ~ ${CANONICAL_UUID} THEN (o.payload->>'fulfillment_id')::uuid END AS fulfillment_uuid
 FROM outbox o WHERE o.kind<>'warmup' ${scope} AND COALESCE(o.payload->>'kind','text') NOT IN('grant','warmup')
 AND o.status IN('SENT','DELIVERED','READ','FAILED','UNKNOWN','CANCELLED')),
 messages AS MATERIALIZED (SELECT m.workspace_id,m.environment,(m.body->>'effect_id')::uuid AS effect_uuid,array_agg(m.body->>'status') AS statuses
 FROM records m WHERE m.kind='message' AND m.body->>'effect_id' ~ ${CANONICAL_UUID} GROUP BY 1,2,3),
 fulfillments AS MATERIALIZED (SELECT f.id,f.workspace_id,f.environment,f.body->>'status' AS status,f.body->>'delivery_projection_version' AS projection_version
 FROM records f WHERE f.kind='fulfillment' AND f.id IN (SELECT t.fulfillment_uuid FROM terminal t)),
 stale AS MATERIALIZED (SELECT t.id FROM terminal t
 LEFT JOIN messages m ON m.workspace_id=t.workspace_id AND m.environment=t.environment AND m.effect_uuid=t.id
 LEFT JOIN fulfillments f ON f.id=t.fulfillment_uuid AND f.workspace_id=t.workspace_id AND f.environment=t.environment
 WHERE m.effect_uuid IS NULL
 OR EXISTS(SELECT 1 FROM unnest(m.statuses) AS s(status) WHERE s.status IS DISTINCT FROM t.status)
 OR (f.id IS NOT NULL AND (f.status IS DISTINCT FROM t.status OR f.projection_version IS DISTINCT FROM '2')))
 SELECT o.* FROM stale s JOIN outbox o ON o.id=s.id ORDER BY o.updated_at LIMIT $1`;
/** Channel owns execution rows; automation projects their durable facts into sales records. */
async function materializeEffectResultsImpl(store:{query:ProfileQuery;transaction<T>(work:(db:QueryExecutor)=>Promise<T>):Promise<T>},limit:number,lab?:ReturnType<typeof bindNumberLabDispatch>) {
 const rows=(await store.query(PENDING_EFFECT_RESULTS(lab?"AND o.workspace_id=$2 AND o.environment='SIMULATION' AND o.account_id=$3 AND o.conversation_id=$4":''),lab?[limit,lab.scope.workspaceId,lab.scope.accountId,lab.scope.conversationId]:[limit])).rows;
 for(const effect of rows) await store.transaction(async client=>{
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[effect.conversation_id]);
  const current=(await client.query('SELECT * FROM outbox WHERE id=$1',[effect.id])).rows[0];
  if(!current||current.kind==='warmup'||['grant','warmup'].includes(current.payload.kind))return;
  const message=(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='message' AND body->>'effect_id'=$3`,[current.workspace_id,current.environment,current.id])).rows[0];
  const body={conversation_id:current.conversation_id,contact_id:current.contact_id,account_id:current.account_id,direction:'OUTBOUND',kind:current.payload.kind,text:current.payload.text??'',asset_id:current.payload.asset_id,status:current.status,effect_id:current.id,provider_message_id:current.provider_message_id,stage_at_creation:current.payload.stage_at_creation??null,...(lab?await lab.projection(current,client):{})};
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

export async function materializeEffectResults(limit=100){return materializeEffectResultsImpl({query,transaction:work=>withTransaction(work)},limit);}
export async function materializeNumberLabEffectResults(lease:NumberLabEngineLease,handle:NumberLabDispatch,limit=100){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw Error('LAB_ENGINE_BATCH_LIMIT');
 return withNumberLabEngine(lease,ports=>materializeEffectResultsImpl({query:ports.query,transaction:work=>ports.transaction(work)},limit,bindNumberLabDispatch(handle,ports)));
}
