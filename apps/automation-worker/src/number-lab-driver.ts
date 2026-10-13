import {materializeNumberLabEffectResults} from './effect-results.js';
import {dispatchNumberLabOutbox} from '../../channel-worker/src/dispatch.js';
import {consumeNumberLabObservations} from '../../channel-worker/src/observations.js';
import {createNumberLabDispatch} from '../../channel-worker/src/catalog-simulator.js';
import {processNumberLabInbound} from './inbound.js';
import {storeNumberLabReceipt,type NumberLabMaterialReader,type NumberLabReceiptCustody} from '../../../packages/db/src/number-lab-material-custody.js';
import {PostgresNumberLabVisionAi,laboratoryVisionAttempt} from '../../../packages/ai-providers/src/laboratory-vision.js';
import {prepareLabReceiptAssessment} from './number-lab-receipts.js';
import {receiptReasonLabel} from '../../../packages/db/src/receipt-queue.js';
import {createHash} from 'node:crypto';
import {processNumberLabAgents} from './agents.js';
import {createNumberLabSeller} from './number-lab-seller.js';
import {z} from 'zod';
import type {DomainRecord} from '@commerce/contracts';
import {getRecord,putRecord,appendEvent} from '@commerce/db';
import {numberLabActionSchema,type NumberLabAction} from '../../../packages/contracts/src/number-laboratory.js';
import {compileNumberLabConfiguration} from '../../../packages/domain/src/laboratory/configuration-plan.js';
import {labHash,validateLabSnapshot,resolveNumberLab} from '../../../packages/domain/src/laboratory/number-lab.js';
import {NumberLabWorkerStore,openLabValue,sealLabValue,readNumberLabAttachment} from '../../../packages/db/src/number-laboratory.js';
import {createNumberLabMaterializer,type NumberLabMaterialPort} from '../../../packages/db/src/number-lab-materialization.js';
import {createNumberLabEngineRuntime,withNumberLabEngine,type NumberLabEngineIdentity,type NumberLabPhaseAuthority} from '../../../packages/db/src/number-lab-engine-runtime.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {currentProfileExecutor} from '../../../packages/db/src/profile-query-routing.js';
import {currentWorkerProfile} from '../../../packages/db/src/profile-worker-scope.js';
import {applyCommand,applyReceiptAssessment} from './commands.js';
import {processNumberLabWorkflows} from './workflows.js';

const inputSchema=z.object({workspaceId:z.string().min(1).max(256),runId:z.uuid(),operationId:z.uuid()}).strict();
type Input=z.infer<typeof inputSchema>;
function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
/** V7 F6 (RF-19.g): what the person reads in the test chat, from the engine's
 * own records (inbound messages and outbox effects of the run's conversation).
 * Text is the synthetic test conversation; no REAL data exists in the engine. */
export const transcriptEntrySchema=z.object({at:z.string().max(40),from:z.enum(['customer','business']),kind:z.string().max(20),text:z.string().max(4000).nullable(),
 material:z.string().max(160).nullable(),status:z.string().max(20).nullable(),purpose:z.string().max(40).nullable(),
 // RF-19.c: a file material carries its id and type so the chat can preview it
 // privately (GET /v2/number-tests/:id/materials/:material); links stay names.
 material_id:z.uuid().nullable().optional(),mime:z.string().max(100).nullable().optional(),
 // RF-19.d: an example receipt the tester attached (its attachment id), the
 // engine receipt it became and why it was decided.
 attachment_id:z.uuid().nullable().optional(),receipt_id:z.uuid().nullable().optional(),explanation:z.string().max(600).nullable().optional()}).strict();
const previewMime=/^(?:image\/(?:png|jpeg|webp)|audio\/(?:mpeg|ogg|mp4|wav)|video\/mp4|application\/pdf)$/;
const decisionLabels:Record<string,string>={APPROVED:'Aprobado: se entrega lo comprado.',REJECTED:'Rechazado.',HUMAN_REVIEW:'Pasa a revisión de una persona.'};
/** Why a receipt was decided, in the operator's words (RF-19.d/g). */
function receiptExplanation(b:Record<string,any>,lab:Record<string,any>|undefined){
 const parts:string[]=[];const status=String(b.status??'');
 if(b.analysis_status==='HUMAN_REQUIRED')parts.push('Pasa a revisión de una persona: '+(receiptReasonLabel(b.analysis_dependency)??'la lectura automática no está disponible')+'.');
 else if(b.analysis_status==='HUMAN_REVIEWED')parts.push((decisionLabels[status]??status)+' Decisión de la persona que prueba.');
 else if(lab){parts.push(decisionLabels[status]??status);
  const reasons=(lab.reasons as string[]|undefined)?.filter(c=>c!=='HUMAN_APPROVAL_REQUIRED'||status!=='APPROVED').map(c=>receiptReasonLabel(c)).filter(Boolean)??[];
  if(reasons.length)parts.push('Motivos: '+reasons.join('; ')+'.');
  parts.push('Supone que la cuenta destino y el titular coinciden con tu cuenta (una prueba no usa tu cuenta real).');}
 else if(b.analysis_status==='PENDING')parts.push('Recibido; esperando la lectura.');
 return parts.join(' ').slice(0,600)||null;
}
async function readTranscript(db:ProfileExecutor,conversationId:string){
 const inbound=(await db.query(`SELECT created_at,body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='message' AND body->>'conversation_id'=$2 AND body->>'direction'='INBOUND' ORDER BY created_at DESC,id LIMIT 200`,[db.workspaceId,conversationId])).rows;
 const outbound=(await db.query(`SELECT o.created_at,o.status,o.payload,a.body->>'name' AS material,a.id::text AS material_id,a.body->>'kind' AS material_kind,a.body->>'mime_type' AS mime FROM outbox o LEFT JOIN records a ON a.workspace_id=o.workspace_id AND a.environment=o.environment AND a.kind='asset' AND a.id::text=o.payload->>'asset_id'
  WHERE o.workspace_id=$1 AND o.environment='SIMULATION' AND o.conversation_id::text=$2 ORDER BY o.created_at DESC LIMIT 200`,[db.workspaceId,conversationId])).rows;
 const at=(v:unknown)=>new Date(v as string).toISOString(),clip=(v:unknown)=>typeof v==='string'?v.slice(0,4000):null;
 const entries:z.infer<typeof transcriptEntrySchema>[]=[...inbound.map(r=>({at:at(r.created_at),from:'customer' as const,kind:String(r.body.kind??'text').slice(0,20),text:clip(r.body.text),material:null,status:null,purpose:null})),
  ...outbound.map(r=>({at:at(r.created_at),from:'business' as const,kind:String(r.payload?.kind??'text').slice(0,20),text:clip(r.payload?.text),material:typeof r.material==='string'?r.material.slice(0,160):null,status:String(r.status).slice(0,20),purpose:typeof r.payload?.purpose==='string'?r.payload.purpose.slice(0,40):null,
   ...(r.material_kind==='file'&&typeof r.mime==='string'&&previewMime.test(r.mime)?{material_id:String(r.material_id),mime:r.mime}:{})}))]
  .sort((x,y)=>x.at.localeCompare(y.at));
 // RF-19.d: each example receipt, as the customer sent it, with its decision.
 const receipts=(await db.query(`SELECT r.id::text,r.created_at,r.body AS receipt,a.body AS asset FROM records r LEFT JOIN records a ON a.workspace_id=r.workspace_id AND a.environment=r.environment AND a.kind='asset' AND a.id::text=r.body->>'asset_id'
  WHERE r.workspace_id=$1 AND r.environment='SIMULATION' AND r.kind='receipt' AND r.body->>'conversation_id'=$2 ORDER BY r.created_at DESC LIMIT 20`,[db.workspaceId,conversationId])).rows;
 for(const r of receipts){const a=r.asset??{},b=r.receipt,lab=b.lab_assessment;
  const attachment=typeof a.lab_attachment_id==='string'&&/^[a-f0-9-]{36}$/.test(a.lab_attachment_id)?a.lab_attachment_id:null;
  entries.push({at:at(r.created_at),from:'customer',kind:'receipt',text:null,material:'Comprobante',status:String(b.status??'').slice(0,20)||null,purpose:'receipt',
   ...(attachment&&typeof a.mime_type==='string'?{attachment_id:attachment,mime:a.mime_type}:{}),receipt_id:String(r.id),explanation:receiptExplanation(b,lab)});}
 entries.sort((x,y)=>x.at.localeCompare(y.at));entries.splice(0,Math.max(0,entries.length-200));
 const timers=(await db.query(`SELECT due_at,payload->>'purpose' AS purpose FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id::text=$2 AND status='PENDING' ORDER BY due_at LIMIT 10`,[db.workspaceId,conversationId])).rows
  .map(r=>({due_at:at(r.due_at),purpose:typeof r.purpose==='string'?r.purpose.slice(0,40):null}));
 const flow=(await db.query(`SELECT body->'flow_state'->>'status' AS status,body->'flow_state'->>'waiting_for' AS waiting_for,body->>'ai_status' AS ai_status FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='conversation' AND id::text=$2`,[db.workspaceId,conversationId])).rows[0];
 const word=(v:unknown)=>typeof v==='string'&&/^[A-Za-z_]{1,40}$/.test(v)?v:null;
 return{entries,timers,flow:{status:word(flow?.status),waiting_for:word(flow?.waiting_for),ai_status:word(flow?.ai_status)}};
}
const outcomeSchema=z.object({schema_version:z.literal(1),stage:z.enum(['ACTION_APPLIED','SETTLED']),
 action_sha256:z.string().regex(/^[a-f0-9]{64}$/),operation_state:z.enum(['APPLIED','FAILED']),run_state:z.enum(['RUNNING','PARTIAL']),
 result:z.object({execution_environment:z.literal('SIMULATION'),operation_class:z.literal('TEST'),simulation_id:z.uuid(),
  conversation_id:z.uuid().nullable(),variant_id:z.uuid().nullable(),release_id:z.uuid().nullable(),command_id:z.uuid().nullable(),
  state:z.enum(['SELECTION_REQUIRED','SELECTION_RECORDED','COMMAND_APPLIED','WORKFLOWS_APPLIED','DEPENDENCY_REQUIRED']),
  reason:z.string().regex(/^[A-Z_]+$/).nullable(),workflow_phase:z.enum(['PENDING','APPLIED','NOT_REQUIRED']),
  transport_phase:z.literal('APPLIED').optional(),transport_result:z.object({projected:z.number().int().min(0),sent:z.number().int().nonnegative(),inbound:z.number().int().nonnegative(),observations:z.number().int().nonnegative(),statuses:z.record(z.string(),z.number().int().nonnegative())}).strict().optional(),
  pending:z.array(z.enum(['WORKFLOWS','AI','TRANSPORT','ATTACHMENTS','AUTOMATIC_REPORT'])).max(5),
  transcript:z.array(transcriptEntrySchema).max(200).optional(),flow:z.object({status:z.string().max(40).nullable(),waiting_for:z.string().max(40).nullable(),ai_status:z.string().max(40).nullable()}).strict().optional(),timers:z.array(z.object({due_at:z.string().max(40),purpose:z.string().max(40).nullable()}).strict()).max(10).optional(),
  ai_phase:z.enum(['APPLIED','NOT_REQUIRED']).optional(),ai_result:z.object({processed:z.number().int().min(0).max(5),run_id:z.uuid().nullable(),status:z.enum(['RUNNING','AWAITING_EFFECT','COMPLETED','FAILED','DISCARDED']).nullable(),provider_state:z.enum(['SUCCEEDED','REJECTED','UNCERTAIN']).nullable(),human_review:z.boolean(),dependency:z.string().regex(/^[A-Z_]+$/).max(128).nullable().optional()}).strict().optional(),ai_network:z.literal('PROFILE_AI_ONLY').optional(),
  receipt_id:z.uuid().nullable().optional(),receipt_phase:z.enum(['APPLIED','HUMAN_REQUIRED']).optional(),receipt_result:z.object({status:z.string().regex(/^[A-Z_]+$/).max(40),analysis_status:z.string().regex(/^[A-Z_]+$/).max(40),dependency:z.string().regex(/^[A-Z0-9_]+$/).max(128).nullable(),ai:z.boolean()}).strict().optional(),
  external_effects:z.literal(0)}).strict()}).strict();
type Outcome=z.infer<typeof outcomeSchema>;
type Captured=Awaited<ReturnType<typeof captureControl>>;

async function captureControl(db:ProfileExecutor,key:Uint8Array,installed:NumberLabEngineIdentity,input:Input,live:boolean){
  const native=(await db.query(`SELECT current_user AS role,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolcanlogin,
   EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships FROM pg_roles r WHERE rolname=current_user`)).rows[0];
  need(native?.role==='commerce_number_lab'&&['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolcanlogin','memberships'].every(k=>native[k]===false),'LAB_CONTROL_IDENTITY_REQUIRED');
  await db.query('SELECT commerce_number_lab.lock_profile($1)',[input.workspaceId]);
  const row=(await db.query(`SELECT r.*,o.state AS operation_state,o.action_ciphertext,o.expected_version
   FROM commerce_number_lab.runs r JOIN commerce_number_lab.operations o ON o.workspace_id=r.workspace_id AND o.run_id=r.id
   WHERE r.workspace_id=$1 AND r.id=$2 AND o.id=$3 FOR SHARE OF r,o`,[input.workspaceId,input.runId,input.operationId])).rows[0];
  need(row&&row.engine_sha256===installed.engineSha256,'LAB_DRIVER_CONTROL_REQUIRED');
  const value=openLabValue({workspaceId:input.workspaceId,runId:input.runId,purpose:'snapshot'},row.snapshot_ciphertext,key) as Parameters<typeof compileNumberLabConfiguration>[0]&{receipt_policies?:Record<string,unknown>};
  const snapshot=validateLabSnapshot(value.snapshot),plan=compileNumberLabConfiguration({...value,snapshot},input.runId);
  need(plan.snapshot_sha256===row.snapshot_sha256&&plan.engine_sha256===installed.engineSha256,'LAB_DRIVER_CAPTURE_CHANGED');
  const action=numberLabActionSchema.parse(openLabValue({workspaceId:input.workspaceId,runId:input.runId,purpose:'action',operationId:input.operationId},row.action_ciphertext,key));
  const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  need(Number.isFinite(now)&&(!live||row.operation_state==='INTENT'&&Number(row.version)===Number(row.expected_version)&&new Date(row.expires_at).getTime()>now),'LAB_DRIVER_CONTROL_NOT_LIVE');
  return{snapshot,plan,action,actionSha256:labHash(action),virtualNow:new Date(row.virtual_now).toISOString(),mode:String(row.mode),operationState:String(row.operation_state),expiresAt:new Date(row.expires_at).getTime(),receiptPolicies:value.receipt_policies??{}};
}
async function readControl(pool:ProfilePool,key:Uint8Array,installed:NumberLabEngineIdentity,input:Input,live:boolean){
 return withProfileTransaction(pool,input.workspaceId,db=>captureControl(db,key,installed,input,live));
}
async function seedIdentity(db:ProfileExecutor,id:NumberLabEngineIdentity){
 const rows=(await db.query(`SELECT current_database() AS database,current_user AS role,r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolcanlogin,r.rolinherit,
  EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,m.installation_id::text,m.database_name,m.engine_sha256
  FROM pg_roles r CROSS JOIN commerce_number_lab_engine.installation m WHERE rolname=current_user AND m.singleton`)).rows,r=rows[0];
 need(rows.length===1&&r.role==='commerce_lab_engine_seed'&&r.database===id.database&&r.database_name===id.database&&r.installation_id===id.installationId&&r.engine_sha256===id.engineSha256
  &&['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolcanlogin','rolinherit','memberships'].every(k=>r[k]===false),'LAB_SEED_IDENTITY_REQUIRED');
}
function receipt(input:Input,c:Captured,stage:Outcome['stage'],raw:unknown,key:Uint8Array){
 const value=outcomeSchema.parse(openLabValue({workspaceId:input.workspaceId,runId:input.runId,purpose:'result',operationId:input.operationId},raw,key));
 need(value.stage===stage&&value.action_sha256===c.actionSha256&&value.result.simulation_id===input.runId,'LAB_DRIVER_RECEIPT_CHANGED');
 const variant=c.plan.variants.find(v=>v.variant_id===value.result.variant_id);
 need(value.result.variant_id===null?value.result.release_id===null:variant?.release_id===value.result.release_id,'LAB_DRIVER_RECEIPT_CHANGED');
 return value;
}
async function writeReceipt(db:ProfileExecutor,input:Input,c:Captured,outcome:Outcome,key:Uint8Array){
 await db.query(`INSERT INTO commerce_number_lab_engine.driver_receipts(run_id,operation_id,workspace_id,stage,snapshot_sha256,action_sha256,result_ciphertext)
  VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.runId,input.operationId,db.workspaceId,outcome.stage,c.plan.snapshot_sha256,c.actionSha256,
  sealLabValue({workspaceId:input.workspaceId,runId:input.runId,purpose:'result',operationId:input.operationId},outcome,key)]);
}
/** A pure restriction of the public action vocabulary, not an executor or permission. */
export function numberLabDriverDependency(action:NumberLabAction,mode:string,attachments=false):string|null{
 if(mode!=='CHAT')return'AUTOMATIC_DRIVER_REQUIRED';
 // RF-19.d: receipts need the laboratory's receipt custody; without it the
 // driver says so instead of fabricating a reading.
 if((action.type==='receipt'||action.type==='review_receipt')&&!attachments)return'LAB_ATTACHMENT_DRIVER_REQUIRED';
 if(action.type==='message'&&action.text.length>4096)return'CANONICAL_MESSAGE_LIMIT';
 return null;
}
interface LabReceiptAsset {attachment_id:string;mime_type:string;size_bytes:number;sha256:string;storage_key:string}
const derivedId=(purpose:string,operationId:string)=>{const h=createHash('sha256').update('commerce.number-lab.'+purpose+':'+operationId).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);};
async function applyAction(db:ProfileExecutor,input:Input,c:Captured,receiptAsset?:LabReceiptAsset|null):Promise<Outcome>{
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['commerce.number-lab.driver:'+input.runId]);
 let simulation=await getRecord(db,db.workspaceId,'simulation',input.runId);
 const receiptWork=c.action.type==='receipt'||c.action.type==='review_receipt';
 const dependency=numberLabDriverDependency(c.action,c.mode,receiptAsset!==undefined)??((c.action.type==='continue'||c.action.type==='advance'||receiptWork)&&!simulation?.body.conversation_id?'LAB_CONVERSATION_REQUIRED':null)
  ??(c.action.type==='receipt'&&!receiptAsset?'LAB_ATTACHMENT_NOT_FOUND':null);
 if(simulation)need(simulation.environment==='SIMULATION'&&simulation.body.lab_run_id===input.runId&&simulation.body.lab_snapshot_sha256===c.plan.snapshot_sha256&&simulation.body.account_id===c.plan.account_id,'LAB_DRIVER_SIMULATION_CHANGED');
 const base:Outcome={schema_version:1,stage:'ACTION_APPLIED',action_sha256:c.actionSha256,operation_state:dependency?'FAILED':'APPLIED',run_state:'PARTIAL',
  result:{execution_environment:'SIMULATION',operation_class:'TEST',simulation_id:input.runId,conversation_id:simulation?.body.conversation_id??null,
   variant_id:simulation?.body.lab_variant_id??null,release_id:simulation?.body.lab_release_id??null,command_id:null,
   state:dependency?'DEPENDENCY_REQUIRED':'SELECTION_RECORDED',reason:dependency,workflow_phase:'NOT_REQUIRED',pending:['AI','TRANSPORT','ATTACHMENTS','AUTOMATIC_REPORT'],external_effects:0}};
 if(dependency)return base;
 if(!simulation){
  const assignments=(await db.query("SELECT a.id AS assignment_id,a.product_id,b.body->>'offer_version_id' AS offer_version_id,b.body->>'workflow_version_id' AS workflow_version_id FROM commercial_assignments a JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding' WHERE a.workspace_id=$1 AND a.environment='SIMULATION' AND a.account_id=$2 AND a.state='ACTIVE' ORDER BY a.id FOR SHARE OF a,b",[db.workspaceId,c.plan.account_id])).rows;
  need(assignments.length===c.plan.variants.length&&assignments.every(a=>c.plan.variants.some(v=>v.roots.product_id===a.product_id&&v.roots.offer_id===a.offer_version_id&&v.roots.workflow_id===a.workflow_version_id)),'LAB_DRIVER_ASSIGNMENTS_CHANGED');
  simulation=await putRecord(db,{id:input.runId,workspaceId:db.workspaceId,environment:'SIMULATION',kind:'simulation',body:{status:'RUNNING',mode:'NUMBER_FLOW_TEST_V1',virtual_now:c.virtualNow,account_id:c.plan.account_id,lab_run_id:input.runId,lab_snapshot_sha256:c.plan.snapshot_sha256,source:{account:c.snapshot.account},assignments,external_effects:false,isolation:{transport:'simulator',external_network:false,real_mutation:false,bank:'LAB_PLACEHOLDER',access:'LAB_ONLY'}}});
  // This is the new canonical driver event, not a reconstructed historical API
  // event or human approval. Its cause is the authenticated control operation.
  await appendEvent(db,{workspace_id:db.workspaceId,environment:'SIMULATION',event_type:'number.flow_test_started',aggregate_id:simulation.id,correlation_id:simulation.id,causation_id:input.operationId,actor:{type:'number_laboratory'},payload:{source_account_id:c.snapshot.account.id,snapshot_sha256:c.plan.snapshot_sha256,external_effects:false}});
 }
 need(new Date(simulation.body.virtual_now).toISOString()===c.virtualNow,'LAB_DRIVER_CLOCK_CHANGED');
 const selected=c.action.type==='select_variant'?{variant_id:c.action.variant_id,origin:c.action.origin}:simulation.body.lab_variant_id?{variant_id:String(simulation.body.lab_variant_id),origin:simulation.body.lab_origin as 'EXPLICIT'|'ADVERTISEMENT'}:{};
 const resolved=resolveNumberLab(c.snapshot,input.runId,selected);
 need(resolved.state!=='BLOCKED','LAB_DRIVER_ROUTING_BLOCKED');
 const saveSimulation=async(body:DomainRecord['body'])=>{simulation=await putRecord(db,{id:simulation!.id,workspaceId:db.workspaceId,environment:'SIMULATION',kind:'simulation',version:simulation!.version,body});};
 if(resolved.state==='SELECTION_REQUIRED'){
  if(c.action.type==='message'){
   need(!simulation.body.lab_pending_message,'LAB_SELECTION_PENDING_MESSAGE');
   await saveSimulation({...simulation.body,lab_pending_message:{text:c.action.text,operation_id:input.operationId}});
  }else need(c.action.type==='select_variant','LAB_SELECTION_REQUIRED');
  return{...base,result:{...base.result,state:'SELECTION_REQUIRED',reason:resolved.reason}};
 }
 need('release'in resolved,'LAB_DRIVER_ROUTE_SNAPSHOT_REQUIRED');
 const variant=c.plan.variants.find(v=>v.variant_id===resolved.release.variant_id&&v.release_id===resolved.release.id);need(variant,'LAB_DRIVER_ROUTE_NOT_CAPTURED');
 base.result.variant_id=variant.variant_id;base.result.release_id=variant.release_id;
 await saveSimulation({...simulation.body,lab_variant_id:variant.variant_id,lab_release_id:variant.release_id,lab_origin:selected.origin??'EXPLICIT'});
 const text=c.action.type==='message'?c.action.text:c.action.type==='select_variant'?simulation.body.lab_pending_message?.text:undefined;
 let conversation=simulation.body.conversation_id?await getRecord(db,db.workspaceId,'conversation',simulation.body.conversation_id):undefined;
 // RF-19.d: the customer sends a receipt / the tester decides one under review,
 // through the canonical receipt commands of the engine.
 if(c.action.type==='receipt'||c.action.type==='review_receipt'){
  need(conversation&&conversation.environment==='SIMULATION'&&conversation.body.simulation_id===input.runId,'LAB_CONVERSATION_REQUIRED');
  let kind:string,resource:string,payload:Record<string,unknown>;
  if(c.action.type==='receipt'){
   need(receiptAsset&&receiptAsset.attachment_id===c.action.attachment_id,'LAB_ATTACHMENT_REQUIRED');
   const asset=await putRecord(db,{id:derivedId('receipt-asset',input.operationId),workspaceId:db.workspaceId,environment:'SIMULATION',kind:'asset',
    body:{kind:'file',name:'Comprobante de prueba',mime_type:receiptAsset.mime_type,size_bytes:receiptAsset.size_bytes,sha256:receiptAsset.sha256,storage_key:receiptAsset.storage_key,status:'READY',purpose:'receipt_evidence',lab_snapshot:true,lab_attachment_id:receiptAsset.attachment_id}});
   kind='conversation_command';resource=conversation.id;payload={type:'receipt_received',asset_id:asset.id};
  }else{
   const receipt=await getRecord(db,db.workspaceId,'receipt',c.action.receipt_id);
   need(receipt&&receipt.environment==='SIMULATION'&&receipt.body.conversation_id===conversation.id,'LAB_RECEIPT_NOT_FOUND');
   kind='receipt_review';resource=receipt.id;payload={decision:c.action.decision,reason:c.action.reason,expected_version:receipt.version};
  }
  const command={id:input.operationId,workspace_id:db.workspaceId,environment:'SIMULATION',kind,resource_id:resource,actor_id:'number-laboratory',status:'PENDING',payload};
  await db.query('INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,status,payload,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[command.id,command.workspace_id,command.environment,command.kind,command.resource_id,command.actor_id,command.status,command.payload,command.id]);
  const result=await applyCommand(db,command) as {receipt_id?:string};
  await db.query("UPDATE commands SET status='APPLIED',result=$2,updated_at=clock_timestamp() WHERE id=$1",[command.id,result]);
  return{...base,result:{...base.result,conversation_id:conversation.id,command_id:command.id,state:'COMMAND_APPLIED',reason:null,workflow_phase:'PENDING',
   receipt_id:typeof result?.receipt_id==='string'?result.receipt_id:null,pending:['WORKFLOWS',...base.result.pending]}};
 }
 if(c.action.type==='select_variant'&&!text)return base;
 need(text!==undefined||conversation,'LAB_CONVERSATION_REQUIRED');
 const start=!!text&&(!conversation||conversation.body.offer_version_id!==variant.roots.offer_id);
 const command={id:input.operationId,workspace_id:db.workspaceId,environment:'SIMULATION',kind:start?'simulation_start':'simulation_advance',resource_id:simulation.id,actor_id:'number-laboratory',status:'PENDING',
  payload:start?{account_id:c.plan.account_id,offer_version_id:variant.roots.offer_id,workflow_version_id:variant.roots.workflow_id,initial_message:text,flow_test_mode:'ROUTING_SELECTION'}:
   {seconds:c.action.type==='advance'?c.action.hours*3600:0,...(text?{message:text}:{})}};
 await db.query('INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,status,payload,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[command.id,command.workspace_id,command.environment,command.kind,command.resource_id,command.actor_id,command.status,command.payload,command.id]);
 const result=await applyCommand(db,command);
 await db.query("UPDATE commands SET status='APPLIED',result=$2,updated_at=clock_timestamp() WHERE id=$1",[command.id,result]);
 simulation=await getRecord(db,db.workspaceId,'simulation',input.runId);need(simulation,'LAB_SIMULATION_REQUIRED');
 conversation=await getRecord(db,db.workspaceId,'conversation',simulation.body.conversation_id);
 need(conversation&&conversation.environment==='SIMULATION'&&conversation.body.simulation_id===input.runId&&conversation.body.account_id===c.plan.account_id
  &&conversation.body.offer_version_id===variant.roots.offer_id&&conversation.body.workflow_version_id===variant.roots.workflow_id
  &&conversation.body.agent_version_id===variant.roots.agent_id,'LAB_DRIVER_ROUTE_CHANGED');
 if(simulation.body.lab_pending_message){const body={...simulation.body};delete body.lab_pending_message;await saveSimulation(body);}
 return{...base,result:{...base.result,conversation_id:conversation.id,command_id:command.id,state:'COMMAND_APPLIED',reason:null,workflow_phase:'PENDING',pending:['WORKFLOWS',...base.result.pending]}};
}

/** Private factory. HTTP can pass IDs only; the installed pools, keys, material
 * broker and canonical functions are never replaceable through an operation. */
export interface NumberLabDriverSellerConfiguration {readonly workspaceId:string;readonly enterprisePool:ProfilePool;readonly custodyKey:Uint8Array;readonly grants:Readonly<Record<string,string>>;readonly visionGrants?:Readonly<Record<string,string>>;readonly maximumMicrousd:number;readonly timeoutMs?:number;readonly fetcher?:typeof fetch;readonly clock?:()=>number}
// Two simultaneous control connections are required by cached AI + the native
// phase authority. A smaller/exhausted pool fails closed; late acquisition is
// released unused after the outer lock has unwound, never used by a timed-out phase.
function boundedControlPool(pool:ProfilePool):ProfilePool{return{connect:()=>new Promise((resolve,reject)=>{
 let done=false;const timer=setTimeout(()=>{done=true;reject(Error('LAB_CONTROL_CONNECTION_TIMEOUT'));},2000);
 void Promise.resolve().then(()=>pool.connect()).then(connection=>{if(done){connection.release();return;}done=true;clearTimeout(timer);resolve(connection);},error=>{if(done)return;done=true;clearTimeout(timer);reject(error);});
})};}
export function createNumberLabDriver(options:{controlPool:ProfilePool;seedPool:ProfilePool;enginePool:ProfilePool;identity:NumberLabEngineIdentity;key:Uint8Array;materials:NumberLabMaterialPort;seller?:NumberLabDriverSellerConfiguration;transport?:{key:Uint8Array;reader?:NumberLabMaterialReader};receipts?:{custody:NumberLabReceiptCustody}}){
 options={...options,controlPool:boundedControlPool(options.controlPool)};
 const key=new Uint8Array(options.key),installed=Object.freeze({...options.identity});need(key.length===32,'LAB_CIPHER_KEY');
 const transport=options.transport?Object.freeze({...options.transport,key:new Uint8Array(options.transport.key)}):undefined;if(transport)need(transport.key.length===32,'LAB_DISPATCH_CONFIGURATION');
 const seller=options.seller?Object.freeze({...options.seller,custodyKey:new Uint8Array(options.seller.custodyKey),grants:Object.freeze(z.record(z.uuid(),z.uuid()).parse(options.seller.grants)),visionGrants:Object.freeze(z.record(z.uuid(),z.uuid()).parse(options.seller.visionGrants??{}))}):undefined;
 const receipts=options.receipts?Object.freeze({...options.receipts}):undefined;
 const materializer=createNumberLabMaterializer({...options,key,identity:installed}),store=new NumberLabWorkerStore(options.controlPool,key);
 const input=(raw:unknown)=>{need(!currentProfileExecutor()&&!currentWorkerProfile(),'LAB_DRIVER_OUTER_SCOPE');return inputSchema.parse(raw);};
 const inspect=async(i:Input,c:Captured,close:boolean)=>withProfileTransaction(options.seedPool,'number-lab:'+i.runId,async db=>{
  await db.query("SELECT pg_catalog.set_config('app.environment','SIMULATION',true)");await seedIdentity(db,installed);
  const execution=(await db.query(`SELECT * FROM commerce_number_lab_engine.executions WHERE run_id=$1 AND operation_id=$2 ${close?'FOR UPDATE':''}`,[i.runId,i.operationId])).rows[0];
  if(!execution){need(!close,'LAB_DRIVER_RECEIPT_REQUIRED');return null;}
  need(execution.snapshot_sha256===c.plan.snapshot_sha256&&execution.engine_sha256===installed.engineSha256,'LAB_DRIVER_CAPTURE_CHANGED');
  const rows=(await db.query(`SELECT * FROM commerce_number_lab_engine.driver_receipts WHERE run_id=$1 AND operation_id=$2 ORDER BY stage`,[i.runId,i.operationId])).rows;
  need(rows.length<=2,'LAB_DRIVER_RECEIPT_CHANGED');let value:Outcome|null=null;
  for(const r of rows){need(r.snapshot_sha256===c.plan.snapshot_sha256&&r.action_sha256===c.actionSha256,'LAB_DRIVER_RECEIPT_CHANGED');const o=receipt(i,c,r.stage,r.result_ciphertext,key);if(!value||o.stage==='SETTLED')value=o;}
  if(close){need(value,'LAB_DRIVER_RECEIPT_REQUIRED');need(execution.state==='INTENT'||execution.state===value.operation_state,'LAB_DRIVER_EXECUTION_CHANGED');
   if(execution.state==='INTENT')await db.query('UPDATE commerce_number_lab_engine.executions SET state=$3 WHERE run_id=$1 AND operation_id=$2',[i.runId,i.operationId,value.operation_state]);
  }
  await seedIdentity(db,installed);return value;
 });
 const settle=async(i:Input,c:Captured)=>{const value=await inspect(i,c,true);need(value,'LAB_DRIVER_RECEIPT_REQUIRED');return store.finish(i.workspaceId,i.runId,i.operationId,{state:value.operation_state,runState:value.run_state,result:value.result});};
 return Object.freeze({
  async observe(raw:unknown){const i=input(raw),c=await readControl(options.controlPool,key,installed,i,false);return{operation_state:c.operationState,receipt:await inspect(i,c,false),read_only:true as const};},
  async reconcile(raw:unknown){const i=input(raw),c=await readControl(options.controlPool,key,installed,i,false);return settle(i,c);},
  async execute(raw:unknown){
   const i=input(raw),prepared=await materializer.prepare(i);
   if(prepared.state!=='READY'){const c=await readControl(options.controlPool,key,installed,i,false);return{state:'ALREADY_ATTEMPTED' as const,receipt:await inspect(i,c,false),read_only:true as const};}
   const c=await readControl(options.controlPool,key,installed,i,true);
   need(prepared.plan_sha256===c.plan.sha256&&prepared.account_id===c.plan.account_id,'LAB_DRIVER_CAPTURE_CHANGED');
   const binding={runId:i.runId,operationId:i.operationId,snapshotSha256:c.plan.snapshot_sha256};
   const authority:NumberLabPhaseAuthority={async withAuthority(binding,work){
    need(binding.runId===i.runId&&binding.operationId===i.operationId&&binding.snapshotSha256===c.plan.snapshot_sha256,'LAB_DRIVER_CAPTURE_CHANGED');
    return withProfileTransaction(options.controlPool,i.workspaceId,async db=>{
     const current=await captureControl(db,key,installed,i,true);
     need(current.plan.sha256===c.plan.sha256&&current.actionSha256===c.actionSha256,'LAB_DRIVER_CAPTURE_CHANGED');
     return work(async()=>{const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
      need(Number.isFinite(now)&&current.expiresAt>now,'LAB_DRIVER_CONTROL_NOT_LIVE');});
    });
   }};
   const runtime=createNumberLabEngineRuntime(options.enginePool,installed,authority);
   // RF-19.d: the example receipt is copied into laboratory custody before the
   // engine phase (no file I/O inside a transaction). Undefined = no custody.
   let receiptAsset:LabReceiptAsset|null|undefined=receipts&&(c.action.type==='receipt'||c.action.type==='review_receipt')?null:undefined,receiptBytes:Buffer|undefined;
   if(receipts&&c.action.type==='receipt'){const attachmentId=c.action.attachment_id;
    const found=await withProfileTransaction(options.controlPool,i.workspaceId,db=>readNumberLabAttachment(db,i.runId,attachmentId,key));
    if(found){const stored=await storeNumberLabReceipt(receipts.custody,{id:found.id,sha256:found.sha256,bytes:found.bytes});receiptBytes=found.bytes;
     receiptAsset={attachment_id:found.id,mime_type:found.mime_type,size_bytes:found.size_bytes,sha256:found.sha256,storage_key:stored.storage_key};}}
   try{
   const applied=await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(async db=>{const outcome=await applyAction(db,i,c,receiptAsset);await writeReceipt(db,i,c,outcome,key);return outcome;}));
   await readControl(options.controlPool,key,installed,i,true);
   if(applied.result.workflow_phase==='PENDING')await processNumberLabWorkflows(await runtime.lease(binding),25);
   // RF-19.d: read the receipt as production would (vision with the profile's
   // key), then decide it with the captured rules; a missing grant or a failed
   // reading leaves it to the tester, exactly like a person in production.
   let receiptPhase:'APPLIED'|'HUMAN_REQUIRED'|undefined,receiptResult:{status:string;analysis_status:string;dependency:string|null;ai:boolean}|undefined;
   if(c.action.type==='receipt'&&applied.operation_state==='APPLIED'&&applied.result.receipt_id&&receiptAsset&&receiptBytes){
    const variant=c.plan.variants.find(v=>v.variant_id===applied.result.variant_id&&v.release_id===applied.result.release_id);need(variant,'LAB_RECEIPT_RELEASE_CHANGED');
    const release=c.snapshot.candidates.find(x=>x.release.variant_id===variant.variant_id&&x.release.id===variant.release_id)?.release;need(release,'LAB_RECEIPT_RELEASE_CHANGED');
    const policy=c.receiptPolicies[variant.variant_id],grantId=seller?.visionGrants[variant.variant_id],attemptId=laboratoryVisionAttempt(i.runId,i.operationId);
    let reading:{state:'SUCCEEDED';value:unknown}|{state:'HUMAN_REQUIRED';dependency:string};
    if(!policy)reading={state:'HUMAN_REQUIRED',dependency:'RECEIPT_POLICY_REQUIRED'};
    else if(!seller||!grantId)reading={state:'HUMAN_REQUIRED',dependency:'RECEIPT_AI_GRANT_REQUIRED'};
    else{try{const v=await new PostgresNumberLabVisionAi({controlPool:options.controlPool,enterprisePool:seller.enterprisePool,custodyKey:seller.custodyKey,maximumMicrousd:seller.maximumMicrousd,
      binding:{workspaceId:i.workspaceId,runId:i.runId,operationId:i.operationId,variantId:variant.variant_id,releaseId:variant.release_id,snapshotSha256:c.plan.snapshot_sha256,attemptId,grantId},
      ...(seller.timeoutMs?{timeoutMs:seller.timeoutMs}:{}),...(seller.fetcher?{fetcher:seller.fetcher}:{}),...(seller.clock?{clock:seller.clock}:{})})
      .invoke({attachmentId:receiptAsset.attachment_id,sha256:receiptAsset.sha256,mimeType:receiptAsset.mime_type as 'image/png'},receiptBytes);
     reading=v.invocation.state==='SUCCEEDED'?{state:'SUCCEEDED',value:v.invocation.value}:{state:'HUMAN_REQUIRED',dependency:v.invocation.code};}
    catch{reading={state:'HUMAN_REQUIRED',dependency:'RECEIPT_AI_RECONCILE_REQUIRED'};}}
    receiptResult=await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(async db=>{
     const r=await getRecord(db,db.workspaceId,'receipt',applied.result.receipt_id!);need(r&&r.environment==='SIMULATION'&&r.body.conversation_id===applied.result.conversation_id&&r.body.analysis_status==='PENDING','LAB_RECEIPT_CHANGED');
     if(reading.state==='SUCCEEDED'){
      const asset=await getRecord(db,db.workspaceId,'asset',r.body.asset_id),order=await getRecord(db,db.workspaceId,'order',r.body.order_id),sim=await getRecord(db,db.workspaceId,'simulation',i.runId);
      need(asset&&order&&sim,'LAB_RECEIPT_CHANGED');
      const prepared=prepareLabReceiptAssessment({policy,receipt:r,asset,order,release,observedAt:new Date(sim.body.virtual_now).toISOString(),duplicate:!!r.body.duplicate_of,document:reading.value,cause:attemptId});
      await applyReceiptAssessment(db,r,prepared,attemptId);
      const after=await getRecord(db,db.workspaceId,'receipt',r.id);need(after,'LAB_RECEIPT_CHANGED');
      await putRecord(db,{id:after.id,workspaceId:db.workspaceId,environment:'SIMULATION',kind:'receipt',version:after.version,body:{...after.body,lab_assessment:prepared.laboratory}});
     }else await putRecord(db,{id:r.id,workspaceId:db.workspaceId,environment:'SIMULATION',kind:'receipt',version:r.version,body:{...r.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:reading.dependency}});
     const final=await getRecord(db,db.workspaceId,'receipt',r.id);need(final,'LAB_RECEIPT_CHANGED');
     return{status:String(final.body.status),analysis_status:String(final.body.analysis_status),dependency:typeof final.body.analysis_dependency==='string'?final.body.analysis_dependency:null,ai:reading.state==='SUCCEEDED'};
    }));
    receiptPhase=receiptResult.analysis_status==='COMPLETED'?'APPLIED':'HUMAN_REQUIRED';
    await processNumberLabWorkflows(await runtime.lease(binding),25);
   }
   let aiPhase:'APPLIED'|'NOT_REQUIRED'|undefined,aiResult:Awaited<ReturnType<typeof processNumberLabAgents>>|undefined;
   if(seller&&Object.keys(seller.grants).length&&applied.operation_state==='APPLIED'&&applied.result.conversation_id){
    need(seller.workspaceId===i.workspaceId,'LAB_SELLER_PROFILE_CHANGED');
    const variant=c.plan.variants.find(v=>v.variant_id===applied.result.variant_id&&v.release_id===applied.result.release_id);need(variant,'LAB_SELLER_RELEASE_CHANGED');
    const grantId=seller.grants[variant.variant_id];need(grantId,'LAB_SELLER_GRANT_REQUIRED');
    const sellerHandle=createNumberLabSeller({...seller,controlPool:options.controlPool,
     binding:{...i,snapshotSha256:c.plan.snapshot_sha256,variantId:variant.variant_id,releaseId:variant.release_id,grantId,
      conversationId:applied.result.conversation_id,accountId:c.plan.account_id,offerId:variant.roots.offer_id,agentId:variant.roots.agent_id}});
    aiResult=await processNumberLabAgents(await runtime.lease(binding),sellerHandle,1);aiPhase=aiResult.processed?'APPLIED':'NOT_REQUIRED';
   }
   let transportResult:{projected:number;sent:number;inbound:number;observations:number;statuses:Record<string,number>}|undefined;
   if(transport&&applied.operation_state==='APPLIED'&&applied.result.conversation_id){
    const variant=c.plan.variants.find(v=>v.variant_id===applied.result.variant_id&&v.release_id===applied.result.release_id);need(variant,'LAB_DISPATCH_RELEASE_CHANGED');
    const dispatchHandle=()=>createNumberLabDispatch({...transport,binding:{...binding,accountId:c.plan.account_id,conversationId:applied.result.conversation_id!,variantId:variant.variant_id},materials:variant.materials.map(m=>({...m,kind:z.enum(['file','link','access']).parse(m.kind)}))});
    let sent=0,inbound=0,observations=0,projected=0;
    const pump=async()=>{sent+=await dispatchNumberLabOutbox(await runtime.lease(binding),dispatchHandle(),20);
     inbound+=await processNumberLabInbound(await runtime.lease(binding),dispatchHandle(),100);
     observations+=await consumeNumberLabObservations(await runtime.lease(binding),dispatchHandle(),100);
     projected+=await materializeNumberLabEffectResults(await runtime.lease(binding),dispatchHandle(),100);};
    await pump();
    // As the production worker's next ticks would: what the simulated ACKs
    // unlock (confirmed follow-ups, the next flow unit) runs before the
    // tester sees the conversation. Bounded; single-step pauses still hold.
    for(let round=0;round<3;round++){const w=await processNumberLabWorkflows(await runtime.lease(binding),25);if(!w.workflows&&!w.timers)break;await pump();}
    const statuses=await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(async db=>Object.fromEntries((await db.query("SELECT status,count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 GROUP BY status",[p.workspaceId,applied.result.conversation_id])).rows.map(r=>[r.status,r.n]))));
    transportResult={sent,inbound,observations,projected,statuses};
   }
   const view=applied.result.conversation_id?await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(db=>readTranscript(db,applied.result.conversation_id!))):undefined;
   await readControl(options.controlPool,key,installed,i,true);
   const transportComplete=!!transportResult&&Object.keys(transportResult.statuses).every(status=>['DELIVERED','READ','FAILED','CANCELLED'].includes(status));
   const final=outcomeSchema.parse({...applied,stage:'SETTLED',run_state:applied.operation_state==='FAILED'?'PARTIAL':'RUNNING',result:{...applied.result,
    ...(applied.result.workflow_phase==='PENDING'?{state:'WORKFLOWS_APPLIED',workflow_phase:'APPLIED'}:{}),...(aiPhase?{ai_phase:aiPhase,ai_result:aiResult,ai_network:'PROFILE_AI_ONLY'}:{}),...(transportResult?{transport_phase:'APPLIED',transport_result:transportResult}:{}),...(receiptPhase?{receipt_phase:receiptPhase,receipt_result:receiptResult}:{}),...(view?{transcript:view.entries,timers:view.timers,flow:view.flow}:{}),pending:applied.result.pending.filter(p=>p!=='WORKFLOWS'&&(!aiPhase||p!=='AI')&&(!transportComplete||p!=='TRANSPORT')&&(!receiptPhase||p!=='ATTACHMENTS'))}});
   await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(db=>writeReceipt(db,i,c,final,key)));
   return settle(i,c);
   }finally{receiptBytes?.fill(0);}
  },
 });
}
