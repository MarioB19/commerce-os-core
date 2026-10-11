import {withTransaction,type QueryExecutor} from '../../../packages/db/src/index.js';
import type {CommercialAssignment} from '../../../packages/db/src/commercial-assignments.js';
import {fail} from './context.js';

/** Read-only impact of the existing replacement contract, not a permission to apply it. */
export async function assignmentChangePreview(loadAssignment:(c:QueryExecutor)=>Promise<CommercialAssignment>,expectedVersion?:number){
  return withTransaction(async c=>{
    await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const a=await loadAssignment(c);
    if(expectedVersion!==undefined&&a.revision!==expectedVersion)throw fail(409,'VERSION_CONFLICT');
    const conversations=(await c.query(`SELECT id,version,body->>'status' status,body->>'stage' stage,
      body->>'assignment_revision' assignment_revision,body->>'offer_version_id' offer_version_id,
      body->>'workflow_version_id' workflow_version_id,body->'flow_state'->>'status' flow_status
      FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'assignment_id'=$3 ORDER BY created_at,id`,[a.workspace_id,a.environment,a.id])).rows;
    const timers=(await c.query(`SELECT id,conversation_id,kind,status,due_at FROM timers
      WHERE workspace_id=$1 AND environment=$2 AND status='PENDING' AND conversation_id IN
      (SELECT id::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'assignment_id'=$3) ORDER BY due_at,id`,[a.workspace_id,a.environment,a.id])).rows;
    const effects=(await c.query(`SELECT id,conversation_id,status,attempts,
      (status IN('READY','BLOCKED') AND attempts=0 AND NOT payload ? 'fulfillment_id' AND payload->>'kind' IS DISTINCT FROM 'grant') would_cancel,
      status IN('SENDING','UNKNOWN') requires_reconciliation,
      payload ? 'fulfillment_id' OR payload->>'kind'='grant' delivery_effect
      FROM outbox WHERE workspace_id=$1 AND environment=$2 AND payload->>'assignment_id'=$3 ORDER BY created_at,id`,[a.workspace_id,a.environment,a.id])).rows;
    const open=conversations.filter(row=>row.status!=='CLOSED');
    const uncertain=effects.filter(row=>row.requires_reconciliation);
    return {
      observed_at:new Date().toISOString(),environment:a.environment,
      assignment:{id:a.id,revision:a.revision,state:a.state,account_id:a.account_id,product_id:a.product_id,binding_id:a.binding_id,authorization_id:a.authorization_id,offer_version_id:a.body.offer_version_id,workflow_version_id:a.body.workflow_version_id,agent_version_id:a.body.agent_version_id},
      proposed_revision:a.revision+1,read_only:true,external_effects:false,apply_allowed:false,
      history_preserved:true,historical_automation_preserved:false,
      consequences:{authorization_revoked:!!a.authorization_id,pending_timers_cancelled:timers.length,
        unsent_messages_cancelled:effects.filter(row=>row.would_cancel).length,
        historical_assignment_gate:'ASSIGNMENT_CHANGED',unknown_resent:false},
      blockers:[...(open.length?['OPEN_CONVERSATION_CONTINUITY_REQUIRED']:[]),
        ...(timers.length?['PENDING_TIMERS_WOULD_CANCEL']:[]),
        ...(effects.some(row=>row.would_cancel)?['UNSENT_MESSAGES_WOULD_CANCEL']:[]),
        ...(uncertain.length?['IN_FLIGHT_OR_UNKNOWN_REQUIRES_RECONCILIATION']:[]),
        'CUTOVER_DECISION_REQUIRED'],
      conversations,timers,effects,
      next_action:'Decidir explícitamente la continuidad de los recorridos anteriores antes de sustituir la asignación. La vista previa no cierra chats, no conserva permisos ni habilita envíos.',
    };
  });
}
