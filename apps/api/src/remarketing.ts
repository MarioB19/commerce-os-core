import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {hash,pool,stableJson,uuid,type QueryExecutor} from '../../../packages/db/src/index.js';
import {normalizeRemarketingPolicy} from '../../../packages/domain/src/sales/remarketing.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {remarketingCycleStatusSchema,remarketingReprogramApplyInputSchema,remarketingReprogramPreviewInputSchema,remarketingTransportTemplateSchema,type Body} from '../../../packages/contracts/src/index.js';
import {audit,envOf,fail,mutate,offerReadPermission,parseBody,principal,resourcePermitted,scopedRecord,sanitize,writePermission} from './context.js';

const id=z.string().uuid();

async function cycleFor(req:FastifyRequest,client:QueryExecutor,cycleId:string,lock=false){
 const p=principal(req);
 const row=(await client.query(
  `SELECT * FROM commercial_remarketing_cycles WHERE id=$1 AND workspace_id=$2 AND environment=$3${lock?' FOR UPDATE':''}`,
  [cycleId,p.workspace_id,envOf(req)],
 )).rows[0];
 if(!row||!resourcePermitted(p,row.source_offer_version_id))throw fail(404,'NOT_FOUND');
 return row;
}

function authorizeCycleRead(req:FastifyRequest){
 const p=principal(req);offerReadPermission(p);assertPermission(p,'sales:read');return p;
}
function authorizeCyclePreview(req:FastifyRequest){
 const p=principal(req);writePermission(p,'offer');assertPermission(p,p.service?'sales:read':'sales:operate');return p;
}
function authorizeCycleReprogram(req:FastifyRequest){
 const p=principal(req);writePermission(p,'offer');assertPermission(p,p.service?'assignments:authorize':'sales:operate');return p;
}

async function clock(client:QueryExecutor,conversation:Body):Promise<Date>{
 if(conversation.environment==='SIMULATION'&&conversation.body?.simulation_id){
  const simulation=(await client.query("SELECT body FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION' AND kind='simulation'",[conversation.body.simulation_id,conversation.workspace_id])).rows[0];
  const virtual=Date.parse(simulation?.body?.virtual_now??'');if(Number.isFinite(virtual))return new Date(virtual);
 }
 return new Date();
}

function mergeReprogrammedTiming(cycle:Body,target:ReturnType<typeof normalizeRemarketingPolicy>){
 const sourceSlots=Array.isArray(cycle.policy_snapshot?.slots)?cycle.policy_snapshot.slots as Body[]:[];
 try{return normalizeRemarketingPolicy({
  schema_version:target.schema_version,
  policy_id:target.policy_id,
  policy_revision:target.policy_revision,
  slots:target.slots.map(slot=>{
   const source=sourceSlots.find(candidate=>String(candidate.id)===slot.id);
   if(!source)throw new Error('REMARKETING_SOURCE_SLOT_MISSING');
   return{id:slot.id,position:slot.position,enabled:slot.enabled,delay:slot.delay,...(slot.warning_acknowledged!==undefined?{warning_acknowledged:slot.warning_acknowledged}:{}),stages:source.stages};
  }),
 });}catch{throw fail(409,'REMARKETING_SOURCE_CONTENT_REQUIRED','La reprogramación conserva el contenido ya autorizado. Completa los medios y textos del snapshot original o inicia un ciclo nuevo con la oferta publicada.');}
}

async function preview(req:FastifyRequest,client:QueryExecutor,cycle:Body,offerId:string,previewedAt:string){
 const offer=await scopedRecord(req,'offer',offerId,client);
 if(offer.body.status!=='PUBLISHED'||offer.body.archived_at)throw fail(409,'PUBLISHED_OFFER_REQUIRED','Selecciona una versión publicada y vigente.');
 const conversation=(await client.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='conversation'",[cycle.source_conversation_id,cycle.workspace_id,cycle.environment])).rows[0];
 if(!conversation)throw fail(409,'REMARKETING_CONVERSATION_MISSING');
 if(offer.body.product_id!==conversation.body.product_id)throw fail(409,'REMARKETING_PRODUCT_MISMATCH','La oferta debe pertenecer al producto fijado en el recorrido.');
 if(!offer.body.sales_flow?.remarketing)throw fail(409,'REMARKETING_POLICY_REQUIRED','La oferta no contiene la política de tres recordatorios.');
 const requestedPolicy=normalizeRemarketingPolicy(offer.body.sales_flow.remarketing);
 const originalIds=(cycle.policy_snapshot?.slots??[]).map((slot:Body)=>String(slot.id)).sort();
 const targetIds=requestedPolicy.slots.map(slot=>slot.id).sort();
 if(stableJson(originalIds)!==stableJson(targetIds))throw fail(409,'REMARKETING_SLOT_IDS_CHANGED','La reprogramación debe conservar los tres IDs estables.');
 const policy=mergeReprogrammedTiming(cycle,requestedPolicy);
 const attempts=(await client.query('SELECT id,slot_id,status,reserved_at,updated_at FROM commercial_remarketing_attempts WHERE cycle_id=$1 ORDER BY reserved_at',[cycle.id])).rows;
 const consumed=new Set(attempts.map((attempt:Body)=>String(attempt.slot_id)));
 const now=await clock(client,conversation),anchor=new Date(cycle.anchor_at),lastInbound=Date.parse(conversation.body.last_inbound_at??'');
 const channelClosesAt=Number.isFinite(lastInbound)?new Date(lastInbound+24*3600_000):undefined;
 let remaining=Math.max(0,Math.max(Number(cycle.consumed_attempts),policy.maximum)-Number(cycle.consumed_attempts));
 const slots=policy.slots.map(slot=>{
  const dueAt=new Date(anchor.getTime()+slot.after_seconds*1000);
  let disposition:string;
  if(consumed.has(slot.id))disposition='PRESERVE_CONSUMED';
  else if(!slot.enabled)disposition='DISABLED';
  else if(dueAt<=now)disposition='SKIP_OVERDUE';
  else if(remaining<=0)disposition='QUOTA_BLOCKED';
  else{disposition='SCHEDULE';remaining--;}
  const outsideWindow=!!channelClosesAt&&dueAt>=channelClosesAt;
  const content=slot.stages[cycle.stage==='AGREEMENT'?'awaiting_agreement':'awaiting_payment'];
  const template=remarketingTransportTemplateSchema.safeParse(content?.template);
  const transport=!outsideWindow?'CURRENT_WINDOW_POSSIBLE':!template.success?'OUTSIDE_24H_REQUIRES_ELIGIBLE_TEMPLATE_OR_NEW_INBOUND':content?.medium!=='video'?'OUTSIDE_24H_TEMPLATE_MEDIA_UNSUPPORTED':'OUTSIDE_24H_TEMPLATE_REQUIRES_CURRENT_PROVIDER_EVIDENCE';
  return{id:slot.id,position:slot.position,enabled:slot.enabled,delay:slot.delay,after_seconds:slot.after_seconds,due_at:dueAt.toISOString(),disposition,transport};
 });
 const structural={cycle_id:cycle.id,cycle_revision:Number(cycle.revision),offer_version_id:offer.id,policy,stage:cycle.stage,anchor_at:new Date(cycle.anchor_at).toISOString(),consumed_slot_ids:[...consumed].sort(),previewed_at:previewedAt};
 return{cycle_id:cycle.id,cycle_revision:Number(cycle.revision),contact_id:cycle.contact_id,source_conversation_id:cycle.source_conversation_id,source_offer_version_id:cycle.source_offer_version_id,content_source_offer_version_id:cycle.source_offer_version_id,target_timing_offer_version_id:offer.id,stage:cycle.stage,status:cycle.status,anchor_at:new Date(cycle.anchor_at).toISOString(),previewed_at:previewedAt,preview_expires_at:new Date(Date.parse(previewedAt)+5*60_000).toISOString(),preview_hash:hash(stableJson(structural)),current_maximum:Number(cycle.max_attempts),target_maximum:policy.maximum,effective_maximum:Math.max(Number(cycle.consumed_attempts),policy.maximum),consumed_attempts:Number(cycle.consumed_attempts),attempts:sanitize(attempts),slots,policy_snapshot:policy,commercial_delay_changes_channel_permission:false,content_changes_applied:false};
}

export async function remarketingRoutes(app:FastifyInstance){
	 app.get('/v1/remarketing-cycles',async req=>{
	  const p=authorizeCycleRead(req);const query=z.object({contact_id:id.optional(),status:remarketingCycleStatusSchema.optional()}).parse(req.query??{});
  const rows=(await pool.query(
   `SELECT c.*,(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',a.id,'slot_id',a.slot_id,'stage',a.stage,'status',a.status,'reserved_at',a.reserved_at,'updated_at',a.updated_at) ORDER BY a.reserved_at),'[]'::jsonb) FROM commercial_remarketing_attempts a WHERE a.cycle_id=c.id) attempts
    FROM commercial_remarketing_cycles c WHERE c.workspace_id=$1 AND c.environment=$2 AND ($3::uuid IS NULL OR c.contact_id=$3) AND ($4::text IS NULL OR c.status=$4) ORDER BY c.updated_at DESC LIMIT 100`,
   [p.workspace_id,envOf(req),query.contact_id??null,query.status??null],
  )).rows.filter(row=>resourcePermitted(p,row.source_offer_version_id));
  return{data:sanitize(rows),meta:{total:rows.length}};
	 });
	 app.post('/v1/remarketing-cycles/:id/reprogram/preview',async req=>{
	  authorizeCyclePreview(req);const input=remarketingReprogramPreviewInputSchema.parse(parseBody(req)),cycle=await cycleFor(req,pool,id.parse((req.params as Body).id));
  if(cycle.status!=='OPEN')throw fail(409,'REMARKETING_CYCLE_CLOSED');
  const previewedAt=new Date().toISOString();return{data:await preview(req,pool,cycle,input.offer_version_id,previewedAt)};
	 });
	 app.post('/v1/remarketing-cycles/:id/reprogram',async req=>{
	  authorizeCycleReprogram(req);const input=remarketingReprogramApplyInputSchema.parse(parseBody(req));const cycleId=id.parse((req.params as Body).id);
  const result=await mutate(req,'remarketing.reprogram:'+cycleId,async client=>{
   const cycle=await cycleFor(req,client,cycleId,true);if(cycle.status!=='OPEN')throw fail(409,'REMARKETING_CYCLE_CLOSED');if(Number(cycle.revision)!==input.expected_revision)throw fail(409,'VERSION_CONFLICT');
   if(Date.now()-Date.parse(input.previewed_at)>5*60_000||Date.parse(input.previewed_at)>Date.now()+60_000)throw fail(409,'REMARKETING_PREVIEW_EXPIRED','Genera una vista previa nueva.');
   const plan=await preview(req,client,cycle,input.offer_version_id,input.previewed_at);if(plan.preview_hash!==input.preview_hash)throw fail(409,'REMARKETING_PREVIEW_CHANGED','El ciclo cambió; genera una vista previa nueva.');
   const conversation=(await client.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND kind='conversation' FOR UPDATE",[cycle.source_conversation_id,cycle.workspace_id,cycle.environment])).rows[0];if(!conversation)throw fail(409,'REMARKETING_CONVERSATION_MISSING');
   const followup=conversation.body.followup_plan;if(!followup||followup.status!=='SCHEDULED'||followup.cycle_id!==cycle.id)throw fail(409,'REMARKETING_PLAN_INACTIVE');
   await client.query("UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND environment=$2 AND status='PENDING' AND kind='followup' AND payload->>'cycle_id'=$3",[cycle.workspace_id,cycle.environment,cycle.id]);
   const nextRevision=Number(cycle.revision)+1;
   await client.query('UPDATE commercial_remarketing_cycles SET policy_snapshot=$2,max_attempts=$3,revision=$4,updated_at=now() WHERE id=$1',[cycle.id,plan.policy_snapshot,plan.effective_maximum,nextRevision]);
   const planKey=String(followup.key),stageKey=cycle.stage==='AGREEMENT'?'awaiting_agreement':'awaiting_payment';
   await client.query("UPDATE records SET body=jsonb_set(body,'{followup_plan}',(body->'followup_plan')||$2::jsonb),version=version+1,updated_at=now() WHERE id=$1",[conversation.id,{policy_snapshot:plan.policy_snapshot,content_offer_version_id:cycle.source_offer_version_id,reprogrammed_timing_offer_version_id:input.offer_version_id,reprogrammed_at:new Date().toISOString()}]);
   const order=(await client.query("SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1",[cycle.workspace_id,cycle.environment,conversation.id])).rows[0];
   const commercial={physical_chat_id:conversation.body.physical_chat_id,assignment_id:conversation.body.assignment_id,assignment_revision:conversation.body.assignment_revision,binding_id:conversation.body.binding_id,product_id:conversation.body.product_id,journey_id:conversation.id,order_id:order?.id,offer_version_id:conversation.body.offer_version_id,workflow_version_id:conversation.body.workflow_version_id,agent_version_id:conversation.body.agent_version_id};
   let scheduled=0,skipped=0;
   for(const item of plan.slots){if(item.disposition!=='SCHEDULE'){if(item.disposition==='SKIP_OVERDUE')skipped++;continue;}const slot=(plan.policy_snapshot.slots as Body[]).find(candidate=>candidate.id===item.id)!;const content=slot.stages[stageKey];const inserted=await client.query(
    `INSERT INTO timers(id,workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,$2,$3,$4,'followup',$5,$6,$7) ON CONFLICT(workspace_id,logical_key) DO NOTHING`,
    [uuid(),cycle.workspace_id,cycle.environment,conversation.id,{...commercial,...slot,...content,purpose:'remarketing',plan_key:planKey,touch_index:slot.position,slot_id:slot.id,stage:cycle.stage,cycle_id:cycle.id,workflow_runtime_version:followup.workflow_runtime_version,anchor_at:plan.anchor_at,reprogrammed:true},item.due_at,`remarketing:${cycle.id}:${cycle.stage}:${slot.id}:${nextRevision}`],
   );scheduled+=inserted.rowCount??0;}
   const futureExternalEffectsPossible=cycle.environment==='REAL'&&scheduled>0;
   await audit(client,req,'remarketing.reprogrammed',cycle.id,{content_offer_version_id:cycle.source_offer_version_id,timing_offer_version_id:input.offer_version_id,content_changes_applied:false,previous_revision:cycle.revision,revision:nextRevision,scheduled,skipped_overdue:skipped,consumed_attempts:cycle.consumed_attempts,external_effects:false,future_external_effects_possible:futureExternalEffectsPossible},cycle.environment);
   return{data:{...plan,cycle_revision:nextRevision,applied:true,scheduled,skipped_overdue:skipped,external_effects:false,future_external_effects_possible:futureExternalEffectsPossible}};
  });return{data:result.data};
 });
}
