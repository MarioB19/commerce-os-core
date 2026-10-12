import {materializeNumberLabEffectResults} from './effect-results.js';
import {dispatchNumberLabOutbox} from '../../channel-worker/src/dispatch.js';
import {consumeNumberLabObservations} from '../../channel-worker/src/observations.js';
import {createNumberLabDispatch} from '../../channel-worker/src/catalog-simulator.js';
import {processNumberLabInbound} from './inbound.js';
import type {NumberLabMaterialReader} from '../../../packages/db/src/number-lab-material-custody.js';
import {processNumberLabAgents} from './agents.js';
import {createNumberLabSeller} from './number-lab-seller.js';
import {z} from 'zod';
import type {DomainRecord} from '@commerce/contracts';
import {getRecord,putRecord,appendEvent} from '@commerce/db';
import {numberLabActionSchema,type NumberLabAction} from '../../../packages/contracts/src/number-laboratory.js';
import {compileNumberLabConfiguration} from '../../../packages/domain/src/laboratory/configuration-plan.js';
import {labHash,validateLabSnapshot,resolveNumberLab} from '../../../packages/domain/src/laboratory/number-lab.js';
import {NumberLabWorkerStore,openLabValue,sealLabValue} from '../../../packages/db/src/number-laboratory.js';
import {createNumberLabMaterializer,type NumberLabMaterialPort} from '../../../packages/db/src/number-lab-materialization.js';
import {createNumberLabEngineRuntime,withNumberLabEngine,type NumberLabEngineIdentity,type NumberLabPhaseAuthority} from '../../../packages/db/src/number-lab-engine-runtime.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import {currentProfileExecutor} from '../../../packages/db/src/profile-query-routing.js';
import {currentWorkerProfile} from '../../../packages/db/src/profile-worker-scope.js';
import {applyCommand} from './commands.js';
import {processNumberLabWorkflows} from './workflows.js';

const inputSchema=z.object({workspaceId:z.string().min(1).max(256),runId:z.uuid(),operationId:z.uuid()}).strict();
type Input=z.infer<typeof inputSchema>;
function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const outcomeSchema=z.object({schema_version:z.literal(1),stage:z.enum(['ACTION_APPLIED','SETTLED']),
 action_sha256:z.string().regex(/^[a-f0-9]{64}$/),operation_state:z.enum(['APPLIED','FAILED']),run_state:z.enum(['RUNNING','PARTIAL']),
 result:z.object({execution_environment:z.literal('SIMULATION'),operation_class:z.literal('TEST'),simulation_id:z.uuid(),
  conversation_id:z.uuid().nullable(),variant_id:z.uuid().nullable(),release_id:z.uuid().nullable(),command_id:z.uuid().nullable(),
  state:z.enum(['SELECTION_REQUIRED','SELECTION_RECORDED','COMMAND_APPLIED','WORKFLOWS_APPLIED','DEPENDENCY_REQUIRED']),
  reason:z.string().regex(/^[A-Z_]+$/).nullable(),workflow_phase:z.enum(['PENDING','APPLIED','NOT_REQUIRED']),
  transport_phase:z.literal('APPLIED').optional(),transport_result:z.object({projected:z.number().int().min(0),sent:z.number().int().nonnegative(),inbound:z.number().int().nonnegative(),observations:z.number().int().nonnegative(),statuses:z.record(z.string(),z.number().int().nonnegative())}).strict().optional(),
  pending:z.array(z.enum(['WORKFLOWS','AI','TRANSPORT','ATTACHMENTS','AUTOMATIC_REPORT'])).max(5),
  ai_phase:z.enum(['APPLIED','NOT_REQUIRED']).optional(),ai_result:z.object({processed:z.number().int().min(0).max(5),run_id:z.uuid().nullable(),status:z.enum(['RUNNING','AWAITING_EFFECT','COMPLETED','FAILED','DISCARDED']).nullable(),provider_state:z.enum(['SUCCEEDED','REJECTED','UNCERTAIN']).nullable(),human_review:z.boolean(),dependency:z.string().regex(/^[A-Z_]+$/).max(128).nullable().optional()}).strict().optional(),ai_network:z.literal('PROFILE_AI_ONLY').optional(),external_effects:z.literal(0)}).strict()}).strict();
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
  const value=openLabValue({workspaceId:input.workspaceId,runId:input.runId,purpose:'snapshot'},row.snapshot_ciphertext,key) as Parameters<typeof compileNumberLabConfiguration>[0];
  const snapshot=validateLabSnapshot(value.snapshot),plan=compileNumberLabConfiguration({...value,snapshot},input.runId);
  need(plan.snapshot_sha256===row.snapshot_sha256&&plan.engine_sha256===installed.engineSha256,'LAB_DRIVER_CAPTURE_CHANGED');
  const action=numberLabActionSchema.parse(openLabValue({workspaceId:input.workspaceId,runId:input.runId,purpose:'action',operationId:input.operationId},row.action_ciphertext,key));
  const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
  need(Number.isFinite(now)&&(!live||row.operation_state==='INTENT'&&Number(row.version)===Number(row.expected_version)&&new Date(row.expires_at).getTime()>now),'LAB_DRIVER_CONTROL_NOT_LIVE');
  return{snapshot,plan,action,actionSha256:labHash(action),virtualNow:new Date(row.virtual_now).toISOString(),mode:String(row.mode),operationState:String(row.operation_state),expiresAt:new Date(row.expires_at).getTime()};
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
export function numberLabDriverDependency(action:NumberLabAction,mode:string):string|null{
 if(mode!=='CHAT')return'AUTOMATIC_DRIVER_REQUIRED';
 if(action.type==='receipt'||action.type==='review_receipt')return'LAB_ATTACHMENT_DRIVER_REQUIRED';
 if(action.type==='message'&&action.text.length>4096)return'CANONICAL_MESSAGE_LIMIT';
 return null;
}
async function applyAction(db:ProfileExecutor,input:Input,c:Captured):Promise<Outcome>{
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['commerce.number-lab.driver:'+input.runId]);
 let simulation=await getRecord(db,db.workspaceId,'simulation',input.runId);
 const dependency=numberLabDriverDependency(c.action,c.mode)??((c.action.type==='continue'||c.action.type==='advance')&&!simulation?.body.conversation_id?'LAB_CONVERSATION_REQUIRED':null);
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
export interface NumberLabDriverSellerConfiguration {readonly workspaceId:string;readonly enterprisePool:ProfilePool;readonly custodyKey:Uint8Array;readonly grants:Readonly<Record<string,string>>;readonly maximumMicrousd:number;readonly timeoutMs?:number;readonly fetcher?:typeof fetch;readonly clock?:()=>number}
// Two simultaneous control connections are required by cached AI + the native
// phase authority. A smaller/exhausted pool fails closed; late acquisition is
// released unused after the outer lock has unwound, never used by a timed-out phase.
function boundedControlPool(pool:ProfilePool):ProfilePool{return{connect:()=>new Promise((resolve,reject)=>{
 let done=false;const timer=setTimeout(()=>{done=true;reject(Error('LAB_CONTROL_CONNECTION_TIMEOUT'));},2000);
 void Promise.resolve().then(()=>pool.connect()).then(connection=>{if(done){connection.release();return;}done=true;clearTimeout(timer);resolve(connection);},error=>{if(done)return;done=true;clearTimeout(timer);reject(error);});
})};}
export function createNumberLabDriver(options:{controlPool:ProfilePool;seedPool:ProfilePool;enginePool:ProfilePool;identity:NumberLabEngineIdentity;key:Uint8Array;materials:NumberLabMaterialPort;seller?:NumberLabDriverSellerConfiguration;transport?:{key:Uint8Array;reader?:NumberLabMaterialReader}}){
 options={...options,controlPool:boundedControlPool(options.controlPool)};
 const key=new Uint8Array(options.key),installed=Object.freeze({...options.identity});need(key.length===32,'LAB_CIPHER_KEY');
 const transport=options.transport?Object.freeze({...options.transport,key:new Uint8Array(options.transport.key)}):undefined;if(transport)need(transport.key.length===32,'LAB_DISPATCH_CONFIGURATION');
 const seller=options.seller?Object.freeze({...options.seller,custodyKey:new Uint8Array(options.seller.custodyKey),grants:Object.freeze(z.record(z.uuid(),z.uuid()).parse(options.seller.grants))}):undefined;
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
   const applied=await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(async db=>{const outcome=await applyAction(db,i,c);await writeReceipt(db,i,c,outcome,key);return outcome;}));
   await readControl(options.controlPool,key,installed,i,true);
   if(applied.result.workflow_phase==='PENDING')await processNumberLabWorkflows(await runtime.lease(binding),25);
   let aiPhase:'APPLIED'|'NOT_REQUIRED'|undefined,aiResult:Awaited<ReturnType<typeof processNumberLabAgents>>|undefined;
   if(seller&&applied.operation_state==='APPLIED'&&applied.result.conversation_id){
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
    const sent=await dispatchNumberLabOutbox(await runtime.lease(binding),dispatchHandle(),20);
    const inbound=await processNumberLabInbound(await runtime.lease(binding),dispatchHandle(),100);
    const observations=await consumeNumberLabObservations(await runtime.lease(binding),dispatchHandle(),100);
    const projected=await materializeNumberLabEffectResults(await runtime.lease(binding),dispatchHandle(),100);
    const statuses=await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(async db=>Object.fromEntries((await db.query("SELECT status,count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 GROUP BY status",[p.workspaceId,applied.result.conversation_id])).rows.map(r=>[r.status,r.n]))));
    transportResult={sent,inbound,observations,projected,statuses};
   }
   await readControl(options.controlPool,key,installed,i,true);
   const transportComplete=!!transportResult&&Object.keys(transportResult.statuses).every(status=>['DELIVERED','READ','FAILED','CANCELLED'].includes(status));
   const final=outcomeSchema.parse({...applied,stage:'SETTLED',run_state:applied.operation_state==='FAILED'?'PARTIAL':'RUNNING',result:{...applied.result,
    ...(applied.result.workflow_phase==='PENDING'?{state:'WORKFLOWS_APPLIED',workflow_phase:'APPLIED'}:{}),...(aiPhase?{ai_phase:aiPhase,ai_result:aiResult,ai_network:'PROFILE_AI_ONLY'}:{}),...(transportResult?{transport_phase:'APPLIED',transport_result:transportResult}:{}),pending:applied.result.pending.filter(p=>p!=='WORKFLOWS'&&(!aiPhase||p!=='AI')&&(!transportComplete||p!=='TRANSPORT'))}});
   await withNumberLabEngine(await runtime.lease(binding),p=>p.transaction(db=>writeReceipt(db,i,c,final,key)));
   return settle(i,c);
  },
 });
}
