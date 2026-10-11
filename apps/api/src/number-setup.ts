import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,getRecord,readNumberOperationalState,type QueryExecutor} from '@commerce/db';
import {readEffectiveHealth,currentProviderHealthReady,effectiveHealthBlockers} from '../../../packages/db/src/effective-health.js';
import type {Body,DomainRecord} from '@commerce/contracts';
import {numberSetupCommandSchema} from '../../../packages/contracts/src/numbers.js';
import {commercialAssignmentResourceIds,commercialAssignmentSnapshot} from '../../../packages/db/src/commercial-assignments.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,parseBody,mutate,fail,scopedRecord,resourcePermitted,command,audit,sanitize} from './context.js';
import {lifecycleSafety,reconciliationObservation,restartAvailability,channelCommandProgress,cancelPendingChannelCommand} from './channel-command-safety.js';
import {assignmentAuthorizationEligibility} from './channel-setup.js';
import {numberFlowSourceState} from './number-flow-state.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';

const id=z.string().uuid();
type StepStatus='READY'|'REQUIRES_ATTENTION'|'BLOCKED'|'IN_PROGRESS'|'UNKNOWN'|'UNAVAILABLE'|'NO_DATA'|'HISTORICAL';
const positions=['CREATE','CONNECT','QR','IDENTITY','HEALTH','PRODUCT','SIMULATION','AUTHORIZATION'] as const;

function access(req:FastifyRequest,write=false){const p=principal(req);assertPermission(p,p.service?write?'channels:manage':'channels:read':write?'channels:manage':'sales:read');return p;}
function step(key:typeof positions[number],status:StepStatus,cause:string,source:string,evidence:Body={},next_action:Body|null=null,observed_at:string|null=null,expires_at:string|null=null){
 return{key,position:positions.indexOf(key)+1,status,cause,observed_at,expires_at,source,next_action,evidence};
}

type SimulationProofInput={
 test_id?:unknown;account_id?:unknown;status?:unknown;start_mode?:unknown;conversation_id?:unknown;external_effects?:unknown;isolation?:Body;
 manifest?:Body[];source_state?:Body;conversation?:DomainRecord;
 pending_commands:number;unknown_commands?:number;failed_commands:number;pending_effects:number;unknown_effects:number;failed_effects:number;pending_timers:number;
};
type SimulationProofResult={status:StepStatus;cause:string;blockers:string[];complete:boolean};
type SimulationGraphCounts={conversation_count:number;resource_count:number;command_count:number;effect_count:number;timer_count:number;pending_commands:number;unknown_commands:number;failed_commands:number;pending_effects:number;unknown_effects:number;failed_effects:number;pending_timers:number};

export function projectProvisionStep(slotState:unknown,operationState:unknown):{status:StepStatus;cause:string}{
 if(!slotState)return{status:'REQUIRES_ATTENTION',cause:'CAPACITY_SLOT_REQUIRED'};
 if(slotState==='UNKNOWN')return{status:'UNKNOWN',cause:'CAPACITY_SLOT_UNKNOWN'};
 if(slotState==='DRAINING'||slotState==='ERROR')return{status:'BLOCKED',cause:`CAPACITY_SLOT_${slotState}`};
 if(operationState==='UNKNOWN')return{status:'UNKNOWN',cause:'PROVISION_UNKNOWN'};
 if(operationState==='FAILED'||operationState==='CANCELLED')return{status:'BLOCKED',cause:`PROVISION_${operationState}`};
 if(['REQUESTED','RESERVED','PREPARING','HUMAN_ACTION_REQUIRED'].includes(String(operationState)))return{status:'IN_PROGRESS',cause:`PROVISION_${operationState}`};
 return{status:'READY',cause:'CAPACITY_SLOT_RESERVED'};
}

export function projectIdentityStep(input:{conflict:boolean;verified:boolean;authState:unknown;observed:boolean;operationState:unknown}):{status:StepStatus;cause:string;recovery:boolean;pending:boolean}{
 if(input.conflict)return{status:'BLOCKED',cause:'IDENTITY_CONFLICT',recovery:false,pending:false};
 if(input.verified&&input.authState==='VERIFIED')return{status:'READY',cause:'IDENTITY_VERIFIED',recovery:false,pending:false};
 if(input.observed)return{status:'REQUIRES_ATTENTION',cause:'IDENTITY_CONFIRMATION_REQUIRED',recovery:false,pending:false};
 if(input.operationState==='UNKNOWN')return{status:'UNKNOWN',cause:'IDENTITY_OBSERVATION_UNKNOWN',recovery:true,pending:false};
 if(input.operationState==='FAILED')return{status:'BLOCKED',cause:'IDENTITY_OBSERVATION_FAILED',recovery:true,pending:false};
 if(['REQUESTED','RESERVED','PREPARING'].includes(String(input.operationState)))return{status:'IN_PROGRESS',cause:'IDENTITY_OBSERVATION_IN_PROGRESS',recovery:false,pending:true};
 return{status:'NO_DATA',cause:'IDENTITY_OBSERVATION_REQUIRED',recovery:false,pending:false};
}

export function projectSimulationProof(input:SimulationProofInput):SimulationProofResult{
 const staleReasons=input.source_state?.stale_reasons;
 const stale:string[]=Array.isArray(staleReasons)?[...new Set(staleReasons.map(value=>String(value)))]:[];
 if(stale.length)return{status:'REQUIRES_ATTENTION' as StepStatus,cause:stale[0]!,blockers:stale,complete:false};
 if(input.status==='RESET')return{status:'HISTORICAL' as StepStatus,cause:'SIMULATION_RESET',blockers:['SIMULATION_RESET'],complete:false};
 if(input.status==='PENDING')return{status:'IN_PROGRESS' as StepStatus,cause:'SIMULATION_PENDING',blockers:['SIMULATION_STATUS_NOT_COMPLETED'],complete:false};
 if(input.status==='READY'&&!input.conversation_id)return{status:'REQUIRES_ATTENTION' as StepStatus,cause:input.start_mode==='EMPTY'?'SIMULATION_EMPTY':'SIMULATION_REQUIRED',blockers:['SIMULATION_STATUS_NOT_COMPLETED'],complete:false};
 if(input.status==='RUNNING')return{status:'IN_PROGRESS' as StepStatus,cause:'SIMULATION_IN_PROGRESS',blockers:['SIMULATION_STATUS_NOT_COMPLETED'],complete:false};
 if(input.status!=='COMPLETED')return{status:'BLOCKED' as StepStatus,cause:'SIMULATION_NOT_COMPLETED',blockers:['SIMULATION_STATUS_NOT_COMPLETED'],complete:false};
 const blockers:string[]=[];
 const isolation=input.isolation??{};
 if(input.external_effects!==false||isolation.transport!=='simulator'||isolation.external_network!==false||isolation.real_mutation!==false)blockers.push('SIMULATION_ISOLATION_UNVERIFIED');
 const manifest=input.manifest??[],sourceCount=Number(input.source_state?.current_assignment_count);
 const completeManifest=Number.isSafeInteger(sourceCount)&&sourceCount>0&&manifest.length===sourceCount&&new Set(manifest.map(item=>item.source?.assignment_id)).size===manifest.length&&manifest.every(item=>item.assignment_id&&item.product_id&&item.offer_version_id&&item.workflow_version_id&&item.source?.assignment_id&&Number.isInteger(item.source?.revision)&&item.source?.binding_id);
 if(!completeManifest)blockers.push('SIMULATION_SNAPSHOT_PARTIAL');
 const conversation=input.conversation,canonical=conversation?.environment==='SIMULATION'&&conversation.id===input.conversation_id&&conversation.body.simulation_id===input.test_id&&conversation.body.account_id===input.account_id&&conversation.body.routing_state==='RESOLVED'&&conversation.body.flow_state?.status==='FINISHED'&&manifest.some(item=>item.assignment_id===conversation.body.assignment_id);
 if(!canonical)blockers.push('SIMULATION_CANONICAL_PROOF_MISSING');
 if(input.pending_commands)blockers.push('SIMULATION_COMMANDS_PENDING');
 if(input.unknown_commands)blockers.push('SIMULATION_COMMANDS_UNKNOWN');
 if(input.failed_commands)blockers.push('SIMULATION_COMMANDS_FAILED');
 if(input.pending_effects)blockers.push('SIMULATION_EFFECTS_PENDING');
 if(input.unknown_effects)blockers.push('SIMULATION_EFFECTS_UNKNOWN');
 if(input.failed_effects)blockers.push('SIMULATION_EFFECTS_FAILED');
 if(input.pending_timers)blockers.push('SIMULATION_TIMERS_PENDING');
 const unknown=blockers.find(value=>value.endsWith('_UNKNOWN'));
 if(unknown)return{status:'UNKNOWN' as StepStatus,cause:unknown,blockers,complete:false};
 if(blockers.some(value=>value.endsWith('_PENDING')))return{status:'IN_PROGRESS' as StepStatus,cause:blockers.find(value=>value.endsWith('_PENDING'))!,blockers,complete:false};
 if(blockers.length)return{status:'BLOCKED' as StepStatus,cause:blockers[0]!,blockers,complete:false};
 return{status:'READY' as StepStatus,cause:'SIMULATION_COMPLETED_CURRENT',blockers:[],complete:true};
}

async function simulationGraphCounts(c:QueryExecutor,simulation:DomainRecord):Promise<SimulationGraphCounts>{
 const accountId=typeof simulation.body.account_id==='string'?simulation.body.account_id:'',conversationId=typeof simulation.body.conversation_id==='string'?simulation.body.conversation_id:'',lastCommandId=typeof simulation.body.last_command_id==='string'?simulation.body.last_command_id:'';
 const row=(await c.query(`WITH graph_conversations AS (
   SELECT id::text id,NULLIF(body->>'contact_id','') contact_id
   FROM records
   WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='conversation'
     AND (body->>'simulation_id'=$2 OR body->>'account_id'=$3 OR id::text=$4)
  ), graph_records AS (
   SELECT r.id::text id
   FROM records r
   WHERE r.workspace_id=$1 AND r.environment='SIMULATION'
     AND (r.id::text IN ($2,$3) OR r.id::text IN (SELECT id FROM graph_conversations)
       OR r.id::text IN (SELECT contact_id FROM graph_conversations WHERE contact_id IS NOT NULL)
       OR r.body->>'simulation_id'=$2 OR r.body->>'conversation_id' IN (SELECT id FROM graph_conversations))
  ), graph_effects AS (
   SELECT id::text id,status FROM outbox
   WHERE workspace_id=$1 AND environment='SIMULATION'
     AND (account_id=$3 OR conversation_id IN (SELECT id FROM graph_conversations))
  ), graph_timers AS (
   SELECT id::text id,status FROM timers
   WHERE workspace_id=$1 AND environment='SIMULATION'
     AND conversation_id IN (SELECT id FROM graph_conversations)
  ), graph_resources AS (
   SELECT id FROM graph_records UNION SELECT id FROM graph_effects UNION SELECT id FROM graph_timers
  ), graph_commands AS (
   SELECT status,result FROM commands
   WHERE workspace_id=$1 AND environment='SIMULATION'
     AND (resource_id IN (SELECT id FROM graph_resources) OR id::text=$5
       OR payload->>'simulation_id'=$2 OR payload->>'account_id'=$3)
  ) SELECT
   (SELECT count(*)::int FROM graph_conversations) conversation_count,
   (SELECT count(*)::int FROM graph_resources) resource_count,
   (SELECT count(*)::int FROM graph_commands) command_count,
   (SELECT count(*)::int FROM graph_effects) effect_count,
   (SELECT count(*)::int FROM graph_timers) timer_count,
   (SELECT count(*) FILTER(WHERE status='PENDING')::int FROM graph_commands) pending_commands,
   (SELECT count(*) FILTER(WHERE status='FAILED' AND COALESCE(result->>'remote_outcome','')='UNKNOWN')::int FROM graph_commands) unknown_commands,
   (SELECT count(*) FILTER(WHERE status='FAILED')::int FROM graph_commands) failed_commands,
   (SELECT count(*) FILTER(WHERE status IN('READY','BLOCKED','SENDING'))::int FROM graph_effects) pending_effects,
   (SELECT count(*) FILTER(WHERE status='UNKNOWN')::int FROM graph_effects) unknown_effects,
   (SELECT count(*) FILTER(WHERE status='FAILED')::int FROM graph_effects) failed_effects,
   (SELECT count(*) FILTER(WHERE status='PENDING')::int FROM graph_timers) pending_timers`,[simulation.workspace_id,simulation.id,accountId,conversationId,lastCommandId])).rows[0]??{};
 return Object.fromEntries(Object.entries(row).map(([key,value])=>[key,Number(value??0)])) as SimulationGraphCounts;
}

export async function simulationProof(c:QueryExecutor,simulation:DomainRecord):Promise<SimulationProofResult&{graph:SimulationGraphCounts}>{
 const sourceState=await numberFlowSourceState(c,simulation),conversationId=typeof simulation.body.conversation_id==='string'?simulation.body.conversation_id:'';
 const conversation=conversationId?await getRecord(c,simulation.workspace_id,'conversation',conversationId):undefined;
 const graph=await simulationGraphCounts(c,simulation);
 return{...projectSimulationProof({test_id:simulation.id,account_id:simulation.body.account_id,status:simulation.body.status,start_mode:simulation.body.start_mode,conversation_id:conversationId,external_effects:simulation.body.external_effects,isolation:simulation.body.isolation,manifest:simulation.body.assignments??[],source_state:sourceState,conversation,...graph}),graph};
}

export async function numberSetupProjection(req:FastifyRequest,c:QueryExecutor=pool,provided?:DomainRecord){
 const p=access(req),account=provided??await scopedRecord(req,'channel_account',id.parse((req.params as Body).id),c),now=await numberNow(c,p.workspace_id,account.environment),assignmentSnapshot=await commercialAssignmentSnapshot(c,p.workspace_id,account.environment,[account.id],now);
 const operational=await readNumberOperationalState(c,account,now),session=operational.session;
 const slot=(await c.query('SELECT * FROM number_capacity_slots WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 ORDER BY updated_at DESC LIMIT 1',[p.workspace_id,account.environment,account.id])).rows[0];
 const provision=(await c.query("SELECT * FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND input->>'account_id'=$3 AND action='PROVISION' ORDER BY created_at DESC LIMIT 1",[p.workspace_id,account.environment,account.id])).rows[0];
 const identityOperation=(await c.query("SELECT id,state,version,result,created_at,updated_at FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND input->>'account_id'=$3 AND action='IDENTITY_OBSERVE' ORDER BY created_at DESC,id DESC LIMIT 1",[p.workspace_id,account.environment,account.id])).rows[0];
 const assignments=assignmentSnapshot.current.filter(item=>commercialAssignmentResourceIds(item).every(resourceId=>resourcePermitted(p,resourceId)));
 let validAssignments=0;for(const assignment of assignments){const product=await getRecord(c,p.workspace_id,'product',assignment.product_id),offer=assignment.body.offer_version_id?await getRecord(c,p.workspace_id,'offer',assignment.body.offer_version_id):undefined,workflow=assignment.body.workflow_version_id?await getRecord(c,p.workspace_id,'workflow',assignment.body.workflow_version_id):undefined;if(product&&!product.body.archived_at&&offer?.body.status==='PUBLISHED'&&!offer.body.archived_at&&workflow?.body.status==='PUBLISHED'&&!workflow.body.archived_at)validAssignments++;}
 const simulation=(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='simulation' AND body->>'mode'='NUMBER_FLOW_TEST_V1' AND body->'source'->'account'->>'id'=$2 ORDER BY created_at DESC LIMIT 1",[p.workspace_id,account.id])).rows[0] as DomainRecord|undefined;
 const health=await readEffectiveHealth(c,{workspaceId:p.workspace_id,environment:account.environment,accountId:account.id,now}),healthReasons=effectiveHealthBlockers(health);
 const healthBlocked=healthReasons.length>0;
 const healthOk=operational.fresh&&operational.connection==='CONNECTED'&&currentProviderHealthReady(health,String(account.body.provider));
 const eligibility:Body[]=[];for(const assignment of assignments)try{eligibility.push({assignment_id:assignment.id,...await assignmentAuthorizationEligibility(req,c,account,assignment,now)});}catch{eligibility.push({assignment_id:assignment.id,ready:false,blockers:['ASSIGNMENT_SETUP_UNAVAILABLE'],authorization:null});}
 const authorized=eligibility.find(item=>item.ready),observed=authorized??eligibility.find(item=>item.authorization),authorization=observed?.authorization??null,authorizationBlockers=[...new Set(eligibility.flatMap(item=>item.blockers??[]))];
 const restart=await restartAvailability(c,account),steps:Body[]=[];

 const provisionStep=projectProvisionStep(slot?.state,provision?.state);
 steps.push(step('CREATE',provisionStep.status,provisionStep.cause,'number_capacity_slots',{slot:slot?.slot??null,slot_state:slot?.state??null,operation_id:provision?.id??null,operation_state:provision?.state??null},slot?null:{type:'CREATE_NUMBER',label:'Crear y reservar número',href:'/sales/channels/whatsapp'},provision?.updated_at??slot?.updated_at??account.created_at,null));
 const pendingProgress=operational.pending_commands.length?await channelCommandProgress(c,account,now):null;
 const cancellable=operational.pending_commands.filter((item:Body)=>item.cancellable===true).map((item:Body)=>item.id);
 const serviceBlocked=!!pendingProgress&&!pendingProgress.ready&&!operational.uncertain_commands.length;
 const connectStatus:StepStatus=serviceBlocked?'BLOCKED':operational.connection==='QR_REQUIRED'?'READY':operational.status;
 const connectCause=serviceBlocked?pendingProgress!.code:operational.connection==='QR_REQUIRED'?'CONNECTION_READY_FOR_QR':operational.cause;
 const connectNext=operational.uncertain_commands.length?{type:'RECONCILE_UNKNOWN',label:'Conciliar resultado',href:'/sales/channels/whatsapp'}:cancellable.length?{type:'CANCEL_PENDING',label:'Cancelar orden sin iniciar',command_id:cancellable[0],href:'/sales/channels/whatsapp'}:serviceBlocked?{type:'REVIEW_CONNECTION_SERVICE',label:'Revisar servicio de conexión',href:'/settings?section=audit'}:operational.connection==='QR_REQUIRED'||connectStatus==='READY'||connectStatus==='IN_PROGRESS'?null:connectStatus==='UNKNOWN'?{type:'RECONCILE_UNKNOWN',label:'Conciliar resultado',href:'/sales/channels/whatsapp'}:{type:restart.failed&&restart.restart_remaining?'RESTART':'CONNECT',label:restart.failed?'Reiniciar una vez':'Conectar',href:'/sales/channels/whatsapp'};
 steps.push(step('CONNECT',connectStatus,connectCause,'channel_sessions',{connection:operational.connection,raw_state:session?.raw_state??null,session_id:session?.id??null,pending_command_ids:operational.pending_commands.map((item:Body)=>item.id),cancellable_command_ids:cancellable,worker:pendingProgress,uncertain_command_ids:operational.uncertain_commands.map((item:Body)=>item.id)},connectNext,operational.observed_at,operational.expires_at));
 const qrStatus:StepStatus=operational.connection==='CONNECTED'?'READY':operational.connection==='QR_REQUIRED'?'REQUIRES_ATTENTION':restart.failed&&restart.restart_remaining===0?'BLOCKED':operational.status==='UNKNOWN'?'UNKNOWN':'NO_DATA';
 steps.push(step('QR',qrStatus,operational.connection==='CONNECTED'?'QR_COMPLETED':operational.connection==='QR_REQUIRED'?'QR_SCAN_REQUIRED':restart.failed&&restart.restart_remaining===0?'WAITING_FOR_SCAN_QR_CODE':'QR_NOT_AVAILABLE','channel_sessions',{auth_state:session?.auth_state??null,raw_state:session?.raw_state??null,restart_remaining:restart.restart_remaining},operational.connection==='QR_REQUIRED'?{type:'OPEN_QR',label:'Abrir QR fresco',href:`/sales/channels/whatsapp?number=${account.id}`}:{type:'CHECK_HEALTH',label:'Releer estado',href:'/sales/channels/whatsapp'},operational.observed_at,operational.expires_at));
 const identity=projectIdentityStep({conflict:account.body.identity_conflict===true,verified:account.body.identity_verified===true,authState:session?.auth_state,observed:!!session?.observed_identity_ciphertext,operationState:identityOperation?.state});
 const identityNext=identity.status==='READY'?null:session?.observed_identity_ciphertext?{type:'CONFIRM_IDENTITY',label:'Confirmar propiedad',href:`/sales/channels/whatsapp?number=${account.id}`}:identity.recovery?{type:'RESUME_IDENTITY_READ',label:'Reanudar la misma lectura',href:`/v1/number-operations/${identityOperation.id}/commands`,operation_id:identityOperation.id,expected_version:identityOperation.version,command:{action:'resume_read'}}:identity.pending?null:{type:'OBSERVE_IDENTITY',label:'Leer identidad',href:'/sales/channels/whatsapp'};
 steps.push(step('IDENTITY',identity.status,identity.cause,identityOperation?'channel_sessions+number_operations':'channel_sessions',{identity_verified:account.body.identity_verified===true,auth_state:session?.auth_state??null,operation_id:identityOperation?.id??null,operation_state:identityOperation?.state??null,operation_version:identityOperation?.version??null,operation_reason:identityOperation?.result?.reason??null},identityNext,identityOperation?.updated_at??session?.last_health_at??null,identityOperation?null:session?.health_expires_at??null));
 steps.push(step('HEALTH',healthOk?'READY':healthBlocked?'BLOCKED':operational.fresh?'REQUIRES_ATTENTION':'NO_DATA',healthOk?'HEALTH_CURRENT':healthBlocked?'HEALTH_BLOCKED':operational.fresh?'HEALTH_INCOMPLETE':'HEALTH_STALE','channel_sessions+health_signals',{signal_count:health.signals.length,invalid_signal_count:health.invalid.length,blocked:healthBlocked,blockers:healthReasons},healthOk?null:{type:'CHECK_HEALTH',label:'Actualizar salud',href:'/sales/channels/whatsapp'},operational.observed_at,operational.expires_at));
 steps.push(step('PRODUCT',validAssignments>0?'READY':assignments.length?'BLOCKED':'REQUIRES_ATTENTION',validAssignments>0?'ASSIGNMENT_CURRENT':assignments.length?'ASSIGNMENT_INVALID':'ASSIGNMENT_REQUIRED','commercial_assignments',{assignment_count:assignments.length,valid_assignment_count:validAssignments},validAssignments?null:{type:'ASSIGN_PRODUCT',label:'Asignar producto',href:`/sales/channels/whatsapp?number=${account.id}`},null,null));
 const simulationResult=simulation?await simulationProof(c,simulation):{status:'NO_DATA' as StepStatus,cause:'SIMULATION_REQUIRED',blockers:['SIMULATION_REQUIRED'],complete:false,graph:null};
 const simulationStep=step('SIMULATION',simulationResult.status,simulationResult.cause,'records.simulation+canonical_flow_proof',{test_id:simulation?.id??null,test_status:simulation?.body.status??null,start_mode:simulation?.body.start_mode??null,external_effects:false,complete:simulationResult.complete,blockers:simulationResult.blockers,graph:simulationResult.graph},simulationResult.complete?null:{type:'RUN_SIMULATION',label:simulationResult.blockers.some(value=>['SOURCE_ACCOUNT_CHANGED','ASSIGNMENTS_CHANGED'].includes(value))?'Actualizar copia de prueba':'Probar flujo',href:`/sales/channels/whatsapp?number=${account.id}`},simulation?.body.completed_at??simulation?.updated_at??null,null);
 steps.push({...simulationStep,blockers:simulationResult.blockers});
 const authorizationReady=!!authorized;
 steps.push(step('AUTHORIZATION',authorizationReady?'READY':authorization?'BLOCKED':'REQUIRES_ATTENTION',authorizationReady?'AUTHORIZATION_CURRENT':authorization?'AUTHORIZATION_BLOCKED':'EXPLICIT_AUTHORIZATION_REQUIRED','channel_setup+operation_authorizations',{authorization_id:authorization?.id??null,assignment_id:observed?.assignment_id??null,expires_at:authorization?.expires_at??null,sending_enabled:account.body.sending_enabled===true,configuration_version:observed?.setup?.configuration_version??null,blockers:authorizationBlockers},authorizationReady?null:{type:'REVIEW_AUTHORIZATION',label:'Revisar autorización',href:`/sales/channels/whatsapp?number=${account.id}`},authorization?.created_at??null,authorization?.expires_at??null));

 const current=steps.find(candidate=>candidate.status!=='READY'&&candidate.status!=='HISTORICAL')??steps.at(-1)!;
 const overall:StepStatus=steps.some(candidate=>candidate.status==='UNKNOWN')?'UNKNOWN':steps.some(candidate=>candidate.status==='BLOCKED')?'BLOCKED':steps.some(candidate=>candidate.status==='IN_PROGRESS')?'IN_PROGRESS':steps.every(candidate=>candidate.status==='READY')?'READY':'REQUIRES_ATTENTION';
 const identityCommand=identity.recovery?'resume_read':identity.pending||identity.status==='READY'||!!session?.observed_identity_ciphertext?null:'observe_identity';
 const availableCommands=operational.uncertain_commands.length?['reconcile_unknown']:operational.pending_commands.length?(cancellable.length?['cancel_pending']:[]):restart.failed?(restart.restart_remaining?['restart','check_health']:['check_health']):['QR_REQUIRED','CONNECTING'].includes(operational.connection)?['check_health']:operational.connection==='CONNECTED'?['check_health',...(identityCommand?[identityCommand]:[])]:['connect','check_health'];
 return sanitize({account_id:account.id,account_version:account.version,session_version:operational.session_version,status:overall,current_step:current.key,steps,available_commands:availableCommands,restart:{remaining:restart.restart_remaining,last_command_id:restart.last_restart_command_id},computed_at:now.toISOString(),environment:account.environment});
}

export async function numberSetupRoutes(app:FastifyInstance){
 app.get('/v1/numbers/:id/setup',async req=>({data:await numberSetupProjection(req)}));
 app.post('/v1/numbers/:id/setup/commands',async(req,reply)=>{
  access(req,true);const input=numberSetupCommandSchema.parse(parseBody(req)),accountId=id.parse((req.params as Body).id);
  const result=await mutate(req,'number.setup.command:'+accountId,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+accountId]);
   const account=await scopedRecord(req,'channel_account',accountId,c);if(account.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   const operational=await readNumberOperationalState(c,account),session=operational.session;if(!session)throw fail(409,'SESSION_NOT_FOUND');
   if(input.expected_session_version===undefined||session.revision!==input.expected_session_version)throw fail(409,'SESSION_VERSION_CONFLICT','La sesión cambió. Relee el asistente antes de continuar.');
   if(input.action==='cancel_pending'){
    const cancelled=await cancelPendingChannelCommand(c,account,input.command_id!,principal(req).user.id,input.reason,session.revision);
    await audit(c,req,'number.setup.pending_cancelled',account.id,{command_id:cancelled.id,type:cancelled.type,remote_outcome:'NOT_ATTEMPTED',reason:input.reason});
    return{data:{account_id:account.id,command_id:cancelled.id,status:'CANCELLED_BEFORE_EXECUTION',remote_outcome:'NOT_ATTEMPTED',next_action:'READ_SETUP'},status:200};
   }
   if(input.action==='reconcile_unknown'){
    const candidate=operational.uncertain_commands.find((item:Body)=>item.id===input.command_id);if(!candidate)throw fail(409,'UNKNOWN_COMMAND_NOT_CURRENT');
    const target=(await c.query("SELECT * FROM commands WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND resource_id=$4 AND kind='channel_command' AND status='FAILED' AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at') FOR UPDATE",[input.command_id,account.workspace_id,account.environment,account.id])).rows[0];if(!target)throw fail(409,'FAILED_COMMAND_NOT_FOUND');
    if(String(candidate.type)!==String(target.payload?.type))throw fail(409,'RECONCILIATION_COMMAND_MISMATCH');
    if(input.outcome!=='keep_unknown'){if(!session.last_health_at||new Date(session.last_health_at)<=new Date(target.updated_at)||!session.health_expires_at||new Date(session.health_expires_at)<=new Date())throw fail(409,'FRESH_HEALTH_REQUIRED');const observation=reconciliationObservation(target,session,input.outcome!);await c.query("UPDATE commands SET result=result||$2::jsonb,updated_at=now() WHERE id=$1",[target.id,JSON.stringify({reconciled_at:new Date().toISOString(),reconciled_by:principal(req).user.id,reconciliation:input.outcome,evidence:input.reason,reconciliation_observation:observation})]);await c.query('UPDATE channel_sessions SET recovery_blocker=NULL,revision=revision+1,updated_at=now() WHERE id=$1',[session.id]);}
    await audit(c,req,'number.setup.unknown_reconciled',account.id,{command_id:target.id,outcome:input.outcome,reason:input.reason});return{data:{account_id:account.id,command_id:target.id,outcome:input.outcome,next_action:'READ_SETUP'}};
   }
   if(input.action==='observe_identity'){
    const latest=(await c.query("SELECT id,state,version FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND input->>'account_id'=$3 AND action='IDENTITY_OBSERVE' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE",[account.workspace_id,account.environment,account.id])).rows[0];
    if(['UNKNOWN','FAILED'].includes(String(latest?.state)))throw fail(409,'IDENTITY_READ_RESUME_REQUIRED','Reanuda la misma lectura con su versión vigente.',{operation_id:latest.id,expected_version:latest.version,command_path:`/v1/number-operations/${latest.id}/commands`,action:'resume_read'});
    const operation=['REQUESTED','RESERVED','PREPARING'].includes(String(latest?.state))?latest:(await c.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,input) VALUES($1,$2,$3,'IDENTITY_OBSERVE',$4) RETURNING id,state,version",[account.workspace_id,account.environment,principal(req).user.id,{account_id:account.id}])).rows[0];await audit(c,req,'number.identity_observation_requested',account.id,{operation_id:operation.id,source:'resumable_setup'});return{data:{account_id:account.id,operation_id:operation.id,state:operation.state,version:operation.version,next_action:'READ_OPERATION'},status:202};
   }
   const type=input.action==='check_health'?'check_health':input.action;await lifecycleSafety(c,account,type);
   if(input.action==='restart')await c.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,$3,$4) ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=true,version=manual_controls.version+1,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id,updated_at=now()",[account.workspace_id,account.id,input.reason,principal(req).user.id]);
   if(['connect','restart'].includes(input.action))await c.query("UPDATE channel_sessions SET desired_state='RUNNING',revision=revision+1,updated_at=now() WHERE id=$1",[session.id]);
   const created=await command(c,req,'channel_command',account.id,{type,expected_version:account.version,reason:input.reason},account.environment);await audit(c,req,'number.setup.command_requested',account.id,{type,command_id:created.id,expected_session_version:input.expected_session_version});return{data:{account_id:account.id,command_id:created.id,status:'IN_PROGRESS',next_action:'READ_SETUP'},status:202};
  });reply.code(result.status??202);return{data:result.data};
 });
}
