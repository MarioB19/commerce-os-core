import {unlink} from 'node:fs/promises';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,getRecord,putRecord,uuid,hash,stableJson,type QueryExecutor} from '../../../packages/db/src/index.js';
import {listAssignments,activeAt,type CommercialAssignment} from '../../../packages/db/src/commercial-assignments.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import type {Body,DomainRecord} from '../../../packages/contracts/src/index.js';
import {numberFlowTestActionSchema,numberFlowTestResetSchema,numberFlowTestStartSchema} from '../../../packages/contracts/src/numbers.js';
import {principal,envOf,parseBody,mutate,fail,audit,command,assertResource,sanitize} from './context.js';
import {cloneSimulationGraph} from './simulation-snapshots.js';
import {numberFlowSourceState} from './number-flow-state.js';

const id=z.string().uuid();

function authorize(req:FastifyRequest,write=true){
 const p=principal(req);
 if(envOf(req)!=='SIMULATION')throw fail(400,'SIMULATION_ONLY');
 if(p.service){
  for(const scope of ['simulations:run','channels:read','assignments:read','workflows:read','products:read'])assertPermission(p,scope);
  if(p.resource_ids)throw fail(403,'SIMULATION_WORKSPACE_SCOPE_REQUIRED');
  if(p.allowed_environments&&!p.allowed_environments.includes('REAL'))throw fail(403,'ENVIRONMENT_FORBIDDEN');
 }else assertPermission(p,write?'channels:manage':'channels:manage');
 return p;
}

async function testRecord(req:FastifyRequest,c:QueryExecutor=pool){
 const p=authorize(req,req.method!=='GET'),testId=id.parse((req.params as Body).id);
 const test=await getRecord(c,p.workspace_id,'simulation',testId);
 if(!test||test.environment!=='SIMULATION'||test.body.mode!=='NUMBER_FLOW_TEST_V1')throw fail(404,'NOT_FOUND');
 assertResource(p,test.id);return test;
}

function mappedId(graph:Awaited<ReturnType<typeof cloneSimulationGraph>>,source:string|undefined,code:string){
 const value=source?graph.mapped.get(source):undefined;if(!value)throw fail(409,code);return value;
}

function assignmentRoots(assignment:CommercialAssignment){
 const values:Array<{kind:string;id:string|undefined}>=[
  {kind:'product',id:assignment.product_id},
  {kind:'offer',id:assignment.body.offer_version_id},
  {kind:'workflow',id:assignment.body.workflow_version_id},
  {kind:'agent',id:assignment.body.agent_version_id},
  {kind:'acquisition_campaign',id:assignment.body.campaign_id},
  {kind:'ad_set',id:assignment.body.ad_set_id},
  {kind:'ad',id:assignment.body.ad_id},
  ...(assignment.body.entry_rules??[]).filter((rule:Body)=>['ad','campaign'].includes(String(rule.kind))&&id.safeParse(rule.value).success).map((rule:Body)=>({kind:rule.kind==='ad'?'ad':'acquisition_campaign',id:String(rule.value)})),
 ];
 return values.filter((value):value is {kind:string;id:string}=>Boolean(value.id));
}

async function createTest(req:FastifyRequest,c:QueryExecutor,sourceAccountId:string,contactName:string,createdFiles:string[],startMode:'EMPTY'|'SEEDED'='EMPTY',initialMessage?:string,previousTestId?:string){
 const p=principal(req),now=new Date().toISOString();assertResource(p,sourceAccountId);
 await c.query('SELECT id FROM records WHERE workspace_id=$1 AND environment=\'REAL\' AND kind=\'channel_account\' AND id=$2 FOR SHARE',[p.workspace_id,sourceAccountId]);
 const source=await getRecord(c,p.workspace_id,'channel_account',sourceAccountId);
 if(!source||source.environment!=='REAL'||source.body.deleted_at)throw fail(404,'NOT_FOUND');
 const assignments=(await listAssignments(c,p.workspace_id,'REAL',{account_id:source.id,status:'ACTIVE'})).filter(candidate=>activeAt(candidate,now));
 if(!assignments.length)throw fail(409,'FLOW_TEST_ASSIGNMENTS_REQUIRED','Este número no tiene productos vigentes para probar.');
 if(assignments.length>20)throw fail(409,'FLOW_TEST_TOO_MANY_ASSIGNMENTS');
 for(const item of assignments){
  if(!item.body.offer_version_id||!item.body.workflow_version_id)throw fail(409,'FLOW_TEST_ASSIGNMENT_INCOMPLETE');
  await c.query('SELECT id FROM commercial_assignments WHERE id=$1 FOR SHARE',[item.id]);
 }
 const roots=[...new Map(assignments.flatMap(assignmentRoots).map(root=>[root.kind+':'+root.id,root])).values()];
 const graph=await cloneSimulationGraph(c,p,roots,createdFiles);
 for(const item of assignments){
  const product=graph.sources.get(item.product_id),offer=graph.sources.get(item.body.offer_version_id),workflow=graph.sources.get(item.body.workflow_version_id);
  if(!product||!offer||!workflow||offer.body.product_id!==product.id||workflow.body.product_id&&workflow.body.product_id!==product.id||offer.body.status!=='PUBLISHED'||offer.body.archived_at||workflow.body.status!=='PUBLISHED'||workflow.body.archived_at)throw fail(409,'FLOW_TEST_ASSIGNMENT_INCOMPATIBLE');
 }
 const sourceName=String(source.body.alias??source.body.name??'Número');
 const account=await putRecord(c,{workspaceId:p.workspace_id,environment:'SIMULATION',kind:'channel_account',body:{name:'Prueba aislada · '+sourceName,alias:'Prueba · '+sourceName,provider:'simulator',status:'WORKING',sending_enabled:false,lab_snapshot:true,flow_test_transport:'ISOLATED_SIMULATOR',source_snapshot:{version:source.version,content_hash:hash(stableJson(source.body))}}});
 const manifests:Body[]=[];
 for(const[index,item]of assignments.entries()){
  const assignmentId=uuid(),productId=mappedId(graph,item.product_id,'FLOW_TEST_PRODUCT_REQUIRED'),offerId=mappedId(graph,item.body.offer_version_id,'FLOW_TEST_OFFER_REQUIRED'),workflowId=mappedId(graph,item.body.workflow_version_id,'FLOW_TEST_WORKFLOW_REQUIRED'),agentId=item.body.agent_version_id?mappedId(graph,item.body.agent_version_id,'FLOW_TEST_SELLER_REQUIRED'):undefined;
  const entryRules=(item.body.entry_rules??[]).map((rule:Body)=>({
   kind:rule.kind,
   value:rule.kind==='link'
    ?`https://simulation.invalid/entry/${hash(String(rule.value??'')).slice(0,24)}`
    :['ad','campaign'].includes(String(rule.kind))&&graph.mapped.has(String(rule.value))?graph.mapped.get(String(rule.value)):rule.value,
  }));
  const bindingBody:Body={account_id:account.id,product_id:productId,offer_version_id:offerId,workflow_version_id:workflowId,...(agentId?{agent_version_id:agentId}:{}),entry_rules:entryRules,valid_from:now,source:'number_flow_test_snapshot_v1',evidence:'Copia aislada de una asignación vigente; no autoriza transporte real.',confidence:'observed',assignment_id:assignmentId,assignment_revision:1,lab_source:{assignment_id:item.id,revision:item.revision,binding_id:item.binding_id,content_hash:hash(stableJson(item.body))}};
  const binding=await putRecord(c,{workspaceId:p.workspace_id,environment:'SIMULATION',kind:'binding',body:bindingBody});
  await c.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision,state) VALUES($1,$2,'SIMULATION',$3,$4,$5,1,'ACTIVE')",[assignmentId,p.workspace_id,account.id,productId,binding.id]);
  await c.query("INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,1,$2,'ACTIVE',$3,'NUMBER_FLOW_TEST_SNAPSHOT')",[assignmentId,binding.id,p.user.id]);
  const product=graph.sources.get(item.product_id)!,offer=graph.sources.get(item.body.offer_version_id)!,workflow=graph.sources.get(item.body.workflow_version_id)!,agent=item.body.agent_version_id?graph.sources.get(item.body.agent_version_id):undefined;
  manifests.push({selection_key:`ruta-${index+1}`,assignment_id:assignmentId,product_id:productId,offer_version_id:offerId,workflow_version_id:workflowId,...(agentId?{agent_version_id:agentId}:{}),product_name:product.body.name,offer_name:offer.body.name??product.body.name,workflow_name:workflow.body.name,seller_name:agent?.body.name??'Vendedor determinista',entry_rules:entryRules,source:{assignment_id:item.id,revision:item.revision,binding_id:item.binding_id}});
 }
 const manifestHash=hash(stableJson(assignments.map(item=>({id:item.id,revision:item.revision,binding_id:item.binding_id,body:item.body}))));
 let test=await putRecord(c,{workspaceId:p.workspace_id,environment:'SIMULATION',kind:'simulation',body:{mode:'NUMBER_FLOW_TEST_V1',status:startMode==='EMPTY'?'READY':'PENDING',start_mode:startMode,virtual_now:now,account_id:account.id,contact_name:contactName,assignments:manifests,materials:graph.materials.map(material=>({id:material.id,name:material.name,kind:material.kind,mime_type:material.mime_type,size_bytes:material.size_bytes,content:material.content})),source:{account:{id:source.id,version:source.version,name:sourceName,content_hash:hash(stableJson(source.body))},assignment_manifest_hash:manifestHash,snapshot_at:now},isolation:{transport:'simulator',external_network:false,real_mutation:false,bank:'LAB_PLACEHOLDER',access:'LAB_ONLY'},external_effects:false,...(previousTestId?{previous_test_id:previousTestId}:{})}});
 const start=startMode==='SEEDED'?await command(c,req,'simulation_start',test.id,{account_id:account.id,contact_name:contactName,initial_message:initialMessage??'Hola, quiero información',flow_test_mode:'ROUTING_SELECTION'},'SIMULATION'):undefined;
 if(start)test=await putRecord(c,{id:test.id,workspaceId:p.workspace_id,environment:'SIMULATION',kind:'simulation',version:test.version,body:{...test.body,last_command_id:start.id}});
 await audit(c,req,'number.flow_test_started',test.id,{source_account_id:source.id,start_mode:startMode,assignment_count:manifests.length,resource_count:graph.sources.size,manifest_hash:manifestHash,external_effects:false},'SIMULATION');
 return{test,command:start};
}

async function related(c:QueryExecutor,test:DomainRecord){
 const conversations=(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='conversation' AND body->>'account_id'=$2 ORDER BY created_at,id",[test.workspace_id,test.body.account_id])).rows as DomainRecord[];
 const root=conversations.find(row=>row.id===test.body.conversation_id),contactId=root?.body.contact_id??conversations[0]?.body.contact_id;
 const scoped=contactId?conversations.filter(row=>row.body.contact_id===contactId):conversations;
 const chat=contactId?(await c.query("SELECT * FROM physical_chats WHERE workspace_id=$1 AND environment='SIMULATION' AND account_id=$2 AND contact_id=$3",[test.workspace_id,test.body.account_id,contactId])).rows[0]:undefined;
 const active=scoped.find(row=>row.id===chat?.active_journey_id&&row.body.routing_state==='RESOLVED')??[...scoped].reverse().find(row=>row.body.routing_state==='RESOLVED')??root??scoped.at(-1);
 return{conversations:scoped,root,contactId,chat,active};
}

function publicEntryRule(rule:Body){
 const kind=String(rule.kind??'rule');
 if(kind==='keyword')return{kind,value:sanitize({text:String(rule.value??'')}).text};
 if(kind==='link')return{kind,value:'Enlace configurado · valor protegido'};
 return{kind,value:'Referencia configurada'};
}
function publicAssignment(value:Body){return{selection_key:value.selection_key,product_name:value.product_name,offer_name:value.offer_name,workflow_name:value.workflow_name,seller_name:value.seller_name,entry_rules:(value.entry_rules??[]).map(publicEntryRule)};}

function transcriptTime(value:unknown){const parsed=Date.parse(String(value));return Number.isFinite(parsed)?parsed:0;}
export function compareFlowTranscript(a:Body,b:Body){
 const time=transcriptTime(a.at)-transcriptTime(b.at);if(time)return time;
 const aSequence=a.dispatch_sequence===null||a.dispatch_sequence===undefined?null:Number(a.dispatch_sequence),bSequence=b.dispatch_sequence===null||b.dispatch_sequence===undefined?null:Number(b.dispatch_sequence);
 if(aSequence!==null&&bSequence!==null&&aSequence!==bSequence)return aSequence-bSequence;
 if(aSequence===null&&bSequence!==null)return-1;if(aSequence!==null&&bSequence===null)return 1;
 return String(a.id).localeCompare(String(b.id));
}

/**
 * Preserve the durable order between outbound effects even when provider or
 * database clocks move backwards, then merge inbound messages by time. The
 * normalized times make the final comparator total and transitive.
 */
export function orderFlowTranscript(items:Body[]){
 const causalTimes=new Map<string,number>();let floor=Number.NEGATIVE_INFINITY;
 const effects=items.filter(item=>item.dispatch_sequence!==null&&item.dispatch_sequence!==undefined).sort((a,b)=>Number(a.dispatch_sequence)-Number(b.dispatch_sequence)||String(a.id).localeCompare(String(b.id)));
 for(const item of effects){const observed=transcriptTime(item.at);floor=Math.max(Number.isFinite(floor)?floor+1:observed,observed);causalTimes.set(String(item.id),floor);}
 return items.map(item=>causalTimes.has(String(item.id))?{...item,at:new Date(causalTimes.get(String(item.id))!).toISOString()}:item).sort(compareFlowTranscript).map(item=>causalTimes.has(String(item.id))?{...item,at:items.find(original=>String(original.id)===String(item.id))!.at}:item);
}

async function view(c:QueryExecutor,test:DomainRecord){
 const relations=await related(c,test),conversationIds=relations.conversations.map(row=>row.id);
 const messages=conversationIds.length?(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='message' AND body->>'conversation_id'=ANY($2::text[]) ORDER BY COALESCE((body->>'provider_at')::timestamptz,created_at),created_at",[test.workspace_id,conversationIds])).rows:[];
 const effects=conversationIds.length?(await c.query("SELECT id,conversation_id,status,payload,dispatch_sequence,not_before,expires_at,created_at,result FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=ANY($2::text[]) ORDER BY dispatch_sequence,id",[test.workspace_id,conversationIds])).rows:[];
 const timers=conversationIds.length?(await c.query("SELECT id,conversation_id,kind,due_at,status,payload FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=ANY($2::text[]) ORDER BY due_at,id",[test.workspace_id,conversationIds])).rows:[];
 const orders=conversationIds.length?(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='order' AND body->>'conversation_id'=ANY($2::text[]) ORDER BY created_at",[test.workspace_id,conversationIds])).rows:[];
 const receipts=conversationIds.length?(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='receipt' AND body->>'conversation_id'=ANY($2::text[]) ORDER BY created_at",[test.workspace_id,conversationIds])).rows:[];
 const fulfillments=conversationIds.length?(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='fulfillment' AND body->>'conversation_id'=ANY($2::text[]) ORDER BY created_at,id",[test.workspace_id,conversationIds])).rows:[];
 const resources=[test.id,...conversationIds],commands=(await c.query("SELECT id,kind,resource_id,status,result,created_at,updated_at FROM commands WHERE workspace_id=$1 AND environment='SIMULATION' AND (resource_id=ANY($2::text[]) OR id=$3) ORDER BY created_at DESC LIMIT 30",[test.workspace_id,resources,test.body.last_command_id??null])).rows;
 const now=Date.parse(test.body.virtual_now),next=timers.find((timer:Body)=>timer.status==='PENDING'&&timer.kind==='followup')??timers.find((timer:Body)=>timer.status==='PENDING');
 const manifest:Body[]=test.body.assignments??[],selected=relations.active?manifest.find(item=>item.assignment_id===relations.active!.body.assignment_id):undefined,sourceState=await numberFlowSourceState(c,test);
 const assetIds=[...new Set([...messages.map((message:DomainRecord)=>message.body.asset_id),...effects.map((effect:Body)=>effect.payload?.asset_id)].filter(Boolean).map(String))];
 const assets=assetIds.length?(await c.query("SELECT id,body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='asset' AND id::text=ANY($2::text[])",[test.workspace_id,assetIds])).rows:[];
 const assetById=new Map(assets.map((asset:Body)=>[String(asset.id),asset.body]));
 const transcript=[
  ...messages.filter((message:DomainRecord)=>!message.body.effect_id).map((message:DomainRecord)=>{const assetId=message.body.asset_id??null,asset=assetId?assetById.get(String(assetId)):undefined;return{id:message.id,direction:message.body.direction,kind:message.body.kind,text:message.body.text,status:message.body.status,at:message.body.provider_at??message.created_at,conversation_id:message.body.conversation_id,dispatch_sequence:null,asset_id:assetId,mime_type:asset?.mime_type??message.body.media?.mime_type??null,name:asset?.name??message.body.media?.filename??null,stage:message.body.stage_at_creation??null,simulated:true,technical:{message_id:message.id,provider_event_key:message.body.provider_event_key??null}};}),
  ...effects.map((effect:Body)=>{const assetId=effect.payload?.asset_id??null,asset=assetId?assetById.get(String(assetId)):undefined;return{id:effect.id,direction:'OUTBOUND',kind:effect.payload?.kind??effect.payload?.type??'text',text:effect.payload?.text??'',status:effect.status,at:effect.created_at,conversation_id:effect.conversation_id,dispatch_sequence:Number(effect.dispatch_sequence),asset_id:assetId,mime_type:asset?.mime_type??null,name:asset?.name??null,stage:effect.payload?.stage_at_creation??null,simulated:true,technical:{effect_id:effect.id,workflow_node_id:effect.payload?.workflow_node_id??null,purpose:effect.payload?.purpose??null}};}),
 ];
 const orderedTranscript=orderFlowTranscript(transcript);
 const empty=relations.conversations.length===0&&messages.length===0&&effects.length===0&&timers.length===0&&orders.length===0&&receipts.length===0;
 const availableActions=empty?['message','question','select_product']:relations.active?.body.flow_state?.waiting_for==='simulation_continue'?['continue']:relations.active?.body.routing_state==='RESOLVED'?['message','question','accept','receipt','approve_receipt','advance','next_reminder']:['message','question','select_product','advance','next_reminder'];
 return sanitize({id:test.id,version:test.version,status:test.body.status,start_mode:test.body.start_mode??'SEEDED',empty,available_actions:availableActions,virtual_now:test.body.virtual_now,source:{name:test.body.source?.account?.name,version:test.body.source?.account?.version,snapshot_at:test.body.source?.snapshot_at,assignment_manifest_hash:test.body.source?.assignment_manifest_hash,...sourceState},assignments:manifest.map(publicAssignment),materials:test.body.materials??[],active_route:selected?publicAssignment(selected):null,routing:{state:relations.active?.body.routing_state??(test.body.status==='PENDING'?'STARTING':'AWAITING_MESSAGE'),reason:relations.active?.body.routing_reason??null,conversation_count:relations.conversations.length},transcript:orderedTranscript,timers:timers.map((timer:Body)=>({id:timer.id,kind:timer.kind,status:timer.status,due_at:timer.due_at,remaining_seconds:Math.max(0,Math.ceil((Date.parse(timer.due_at)-now)/1000)),purpose:timer.payload?.purpose??null})),next_reminder:next?{timer_id:next.id,due_at:next.due_at,seconds:Math.max(0,Math.ceil((Date.parse(next.due_at)-now)/1000)),kind:next.kind}:null,orders:orders.map((order:DomainRecord)=>({id:order.id,status:order.body.status,product_id:order.body.product_id,amount_minor:order.body.amount_minor,currency:order.body.currency,receipt_status:order.body.receipt_status,sale_status:order.body.sale_status,sale_amount_minor:order.body.sale_amount_minor,sale_currency:order.body.sale_currency})),receipts:receipts.map((receipt:DomainRecord)=>({id:receipt.id,status:receipt.body.status,amount_minor:receipt.body.extraction?.amount_minor,currency:receipt.body.extraction?.currency,analysis_status:receipt.body.analysis_status})),fulfillments:fulfillments.map((fulfillment:DomainRecord)=>({id:fulfillment.id,status:fulfillment.body.status,release_on:fulfillment.body.release_on,asset_id:fulfillment.body.asset_id,effect_id:fulfillment.body.effect_id})),commands,pending_action:commands.some((item:Body)=>item.status==='PENDING'),isolation:test.body.isolation,external_effects:false});
}

async function ensureIdle(c:QueryExecutor,test:DomainRecord,conversations:DomainRecord[]){
 const resources=[test.id,...conversations.map(row=>row.id)],pending=(await c.query("SELECT id FROM commands WHERE workspace_id=$1 AND environment='SIMULATION' AND (resource_id=ANY($2::text[]) OR id=$3) AND status='PENDING' LIMIT 1",[test.workspace_id,resources,test.body.last_command_id??null])).rows[0];
 if(pending)throw fail(409,'FLOW_TEST_ACTION_PENDING','Espera el resultado de la acción anterior antes de continuar.');
 if(test.body.status==='RESET')throw fail(409,'FLOW_TEST_RESET');
}

async function syncActive(c:QueryExecutor,test:DomainRecord,relations:Awaited<ReturnType<typeof related>>){
 let current=test;const active=relations.active;
 if(active&&active.body.simulation_id!==test.id)await putRecord(c,{id:active.id,workspaceId:active.workspace_id,environment:'SIMULATION',kind:'conversation',version:active.version,body:{...active.body,simulation_id:test.id,commercial_classification:'TEST'}});
 if(active&&test.body.conversation_id!==active.id)current=await putRecord(c,{id:test.id,workspaceId:test.workspace_id,environment:'SIMULATION',kind:'simulation',version:test.version,body:{...test.body,conversation_id:active.id,status:'RUNNING'}});
 return{test:current,active};
}

export async function numberFlowTestRoutes(app:FastifyInstance){
 app.post('/v1/channel-accounts/:id/flow-tests',async(req,reply)=>{
  authorize(req);const input=numberFlowTestStartSchema.parse(parseBody(req)),createdFiles:string[]=[];
  try{const result=await mutate(req,'number.flow-test.start:'+(req.params as Body).id,async c=>{const created=await createTest(req,c,id.parse((req.params as Body).id),input.contact_name,createdFiles,input.start_mode,input.initial_message);return{data:{...await view(c,created.test),command_id:created.command?.id??null},status:201};});reply.code(result.status??201);return{data:result.data};}catch(error){await Promise.allSettled(createdFiles.map(path=>unlink(path)));throw error;}
 });
 app.get('/v1/channel-accounts/:id/flow-tests/latest',async req=>{
  const p=authorize(req,false),sourceId=id.parse((req.params as Body).id);assertResource(p,sourceId);
  const test=(await pool.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='simulation' AND body->>'mode'='NUMBER_FLOW_TEST_V1' AND body->'source'->'account'->>'id'=$2 ORDER BY created_at DESC LIMIT 1",[p.workspace_id,sourceId])).rows[0] as DomainRecord|undefined;
  return{data:test?await view(pool,test):null};
 });
 app.get('/v1/number-flow-tests/:id',async req=>{const test=await testRecord(req);return{data:await view(pool,test)};});
 app.post('/v1/number-flow-tests/:id/actions',async(req,reply)=>{
  authorize(req);const input=numberFlowTestActionSchema.parse(parseBody(req));const result=await mutate(req,'number.flow-test.action:'+(req.params as Body).id,async c=>{
   let test=await testRecord(req,c);const relations=await related(c,test);await ensureIdle(c,test,relations.conversations);const synced=await syncActive(c,test,relations);test=synced.test;const target=synced.active;let seconds=0,message:string|undefined,selectedManifest:Body|undefined,cmd:Body;
   if(target?.body.flow_state?.waiting_for==='simulation_continue'&&input.type!=='continue')throw fail(409,'FLOW_TEST_CONTINUE_REQUIRED','Continúa el flujo visible antes de enviar otra acción; el mensaje no fue consumido.');
   if(input.type==='select_product'){
    const item=(test.body.assignments??[]).find((candidate:Body)=>candidate.selection_key===input.selection_key);if(!item)throw fail(404,'FLOW_TEST_ROUTE_NOT_FOUND');
    selectedManifest=item;
    const rule=(item.entry_rules??[]).find((candidate:Body)=>candidate.kind==='keyword');
    if(rule)message=String(rule.value);else{
     if(relations.chat)await c.query('UPDATE physical_chats SET selected_assignment_id=$2,selection_at=$3,revision=revision+1 WHERE id=$1',[relations.chat.id,item.assignment_id,test.body.virtual_now]);
     message=`Quiero información sobre ${item.product_name}`;
     await audit(c,req,'number.flow_test_product_selected',test.id,{selection_key:item.selection_key,mode:'EXPLICIT_LAB_SELECTION',external_effects:false},'SIMULATION');
    }
   }else if(input.type==='message'||input.type==='question')message=input.text;
   else if(input.type==='accept'){
    if(!target||target.body.routing_state!=='RESOLVED')throw fail(409,'FLOW_TEST_PRODUCT_SELECTION_REQUIRED');
    const workflow=target.body.workflow_version_id?await getRecord(c,test.workspace_id,'workflow',target.body.workflow_version_id):undefined;
    const commitment=workflow?.body.nodes?.find((node:Body)=>node.type==='commitment');message=input.text??commitment?.config?.accepted_phrases?.[0]??'Sí, acepto el acuerdo';
   }else if(input.type==='receipt'){
    if(!target||target.body.routing_state!=='RESOLVED')throw fail(409,'FLOW_TEST_PRODUCT_SELECTION_REQUIRED');
    const asset=await putRecord(c,{workspaceId:test.workspace_id,environment:'SIMULATION',kind:'asset',body:{name:'Comprobante sintético de laboratorio',kind:'file',mime_type:'image/png',size_bytes:0,sha256:hash(`${test.id}:${req.headers['idempotency-key']}:receipt`),storage_key:'simulation-'+uuid(),status:'READY',lab_snapshot:true,synthetic_receipt:true}});
    cmd=await command(c,req,'conversation_command',target.id,{type:'receipt_received',asset_id:asset.id,extraction:{is_receipt:true,amount_minor:input.amount_minor,currency:input.currency,destination_suffix:null,bank:'SIMULATION',reference:'lab-'+hash(`${test.id}:${req.headers['idempotency-key']}`).slice(0,20),status:'completed',confidence:1,contradictions:[]}},'SIMULATION');
    test=await putRecord(c,{id:test.id,workspaceId:test.workspace_id,environment:'SIMULATION',kind:'simulation',version:test.version,body:{...test.body,last_command_id:cmd.id}});
    await audit(c,req,'number.flow_test_receipt_attached',test.id,{amount_minor:input.amount_minor,currency:input.currency,external_effects:false},'SIMULATION');
    reply.code(202);return{data:{test_id:test.id,command_id:cmd.id,external_effects:false},status:202};
   }else if(input.type==='approve_receipt'){
    if(!target||target.body.routing_state!=='RESOLVED')throw fail(409,'FLOW_TEST_PRODUCT_SELECTION_REQUIRED');
    const receipt=(await c.query(
     `SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='receipt'
      AND body->>'conversation_id'=$2 AND body->>'status'='HUMAN_REVIEW'
      ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`,
     [test.workspace_id,target.id],
    )).rows[0] as DomainRecord|undefined;
    if(!receipt)throw fail(409,'FLOW_TEST_RECEIPT_REVIEW_REQUIRED','Adjunta y procesa primero un comprobante sintético pendiente de revisión.');
    if(!Number.isSafeInteger(receipt.body.extraction?.amount_minor)||Number(receipt.body.extraction.amount_minor)<=0||!/^[A-Z]{3}$/.test(String(receipt.body.extraction?.currency??'')))throw fail(409,'FLOW_TEST_RECEIPT_EXTRACTION_REQUIRED');
    cmd=await command(c,req,'receipt_review',receipt.id,{decision:'APPROVED',reason:'Aprobación explícita del comprobante sintético en laboratorio aislado.',expected_version:receipt.version},'SIMULATION');
    test=await putRecord(c,{id:test.id,workspaceId:test.workspace_id,environment:'SIMULATION',kind:'simulation',version:test.version,body:{...test.body,last_command_id:cmd.id}});
    await audit(c,req,'number.flow_test_receipt_approval_requested',test.id,{receipt_id:receipt.id,external_effects:false},'SIMULATION');
    reply.code(202);return{data:{test_id:test.id,command_id:cmd.id,external_effects:false},status:202};
   }else if(input.type==='advance')seconds=input.seconds;
   else if(input.type==='continue'){
    if(target?.body.flow_state?.waiting_for!=='simulation_continue')throw fail(409,'FLOW_TEST_CONTINUE_NOT_AVAILABLE','El flujo no espera una continuación visible. Relee las acciones disponibles.');
   }
   else{
    const ids=relations.conversations.map(row=>row.id),timer=ids.length?(await c.query("SELECT * FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=ANY($2::text[]) AND status='PENDING' ORDER BY CASE WHEN kind='followup' THEN 0 ELSE 1 END,due_at,id LIMIT 1",[test.workspace_id,ids])).rows[0]:undefined;
    if(!timer)throw fail(409,'FLOW_TEST_REMINDER_NOT_PENDING');seconds=Math.max(0,Math.ceil((Date.parse(timer.due_at)-Date.parse(test.body.virtual_now))/1000));
   }
   if(!test.body.conversation_id){
    if(!message||!['message','question','select_product'].includes(input.type))throw fail(409,'FLOW_TEST_REQUIRES_FIRST_MESSAGE','Escribe o elige una ruta para iniciar el laboratorio vacío.');
    cmd=await command(c,req,'simulation_start',test.id,{account_id:test.body.account_id,contact_name:test.body.contact_name,initial_message:message,flow_test_mode:'ROUTING_SELECTION',...(selectedManifest?{offer_version_id:selectedManifest.offer_version_id,workflow_version_id:selectedManifest.workflow_version_id}:{})},'SIMULATION');
   }else cmd=await command(c,req,'simulation_advance',test.id,{seconds,...(message?{message}:{})},'SIMULATION');
   test=await putRecord(c,{id:test.id,workspaceId:test.workspace_id,environment:'SIMULATION',kind:'simulation',version:test.version,body:{...test.body,last_command_id:cmd.id}});
   await audit(c,req,'number.flow_test_action',test.id,{type:input.type,seconds,external_effects:false},'SIMULATION');
   return{data:{test_id:test.id,command_id:cmd.id,external_effects:false},status:202};
  });reply.code(result.status??202);return{data:result.data};
 });
 app.post('/v1/number-flow-tests/:id/reset',async(req,reply)=>{
  authorize(req);const input=numberFlowTestResetSchema.parse(parseBody(req)),createdFiles:string[]=[];
  try{const result=await mutate(req,'number.flow-test.reset:'+(req.params as Body).id,async c=>{const old=await testRecord(req,c),relations=await related(c,old);await ensureIdle(c,old,relations.conversations);const sourceId=id.parse(old.body.source?.account?.id),startMode=input.start_mode??'EMPTY',created=await createTest(req,c,sourceId,input.contact_name??old.body.contact_name??'Contacto de prueba',createdFiles,startMode,input.initial_message,old.id);await putRecord(c,{id:old.id,workspaceId:old.workspace_id,environment:'SIMULATION',kind:'simulation',version:old.version,body:{...old.body,status:'RESET',reset_to:created.test.id}});await audit(c,req,'number.flow_test_reset',old.id,{replacement_id:created.test.id,start_mode:startMode,external_effects:false},'SIMULATION');return{data:{...await view(c,created.test),command_id:created.command?.id??null},status:201};});reply.code(result.status??201);return{data:result.data};}catch(error){await Promise.allSettled(createdFiles.map(path=>unlink(path)));throw error;}
 });
}
