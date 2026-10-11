import {appendEvent,getRecord,putRecord,type QueryExecutor} from './index.js';
import type {DomainRecord} from '../../contracts/src/index.js';
import {isIsolatedNumberFlowTest} from './number-flow-controls.js';

async function numberFlowSimulation(c:QueryExecutor,conversation:DomainRecord){
 if(conversation.environment!=='SIMULATION'||typeof conversation.body.simulation_id!=='string')return;
 const simulation=await getRecord(c,conversation.workspace_id,'simulation',conversation.body.simulation_id);
 if(simulation?.environment!=='SIMULATION')return;
 // The immutable API origin also prevents a modified mode from falling back
 // to the older, unrelated single-offer simulation contract.
 return simulation.body.mode==='NUMBER_FLOW_TEST_V1'||(await c.query("SELECT 1 FROM domain_events WHERE workspace_id=$1 AND environment='SIMULATION' AND aggregate_id=$2 AND event_type='number.flow_test_started' LIMIT 1",[simulation.workspace_id,simulation.id])).rowCount?simulation:undefined;
}
async function validNumberFlowConversation(c:QueryExecutor,conversation:DomainRecord){
 if(!await isIsolatedNumberFlowTest(c,conversation))return false;
 return !!(await c.query(`SELECT 1 FROM records r JOIN records s ON s.id::text=r.body->>'simulation_id' AND s.workspace_id=r.workspace_id AND s.environment=r.environment AND s.kind='simulation'
  WHERE r.id=$1 AND r.workspace_id=$2 AND r.environment='SIMULATION' AND r.kind='conversation'
   AND r.body->>'assignment_id'=$3 AND r.body->>'product_id'=$4 AND r.body->>'offer_version_id'=$5 AND r.body->>'workflow_version_id'=$6
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.body->'assignments')='array' THEN s.body->'assignments' ELSE '[]'::jsonb END) a
    WHERE a->>'assignment_id'=r.body->>'assignment_id' AND a->>'product_id'=r.body->>'product_id' AND a->>'offer_version_id'=r.body->>'offer_version_id' AND a->>'workflow_version_id'=r.body->>'workflow_version_id')`,
 [conversation.id,conversation.workspace_id,conversation.body.assignment_id,conversation.body.product_id,conversation.body.offer_version_id,conversation.body.workflow_version_id])).rowCount;
}
function numberFlowOrderMatches(order:DomainRecord,conversation:DomainRecord,allowMissingSimulation=false){
 return order.environment==='SIMULATION'&&order.workspace_id===conversation.workspace_id&&order.body.conversation_id===conversation.id
  && ['account_id','contact_id','assignment_id','product_id','offer_version_id','workflow_version_id'].every(key=>order.body[key]===conversation.body[key])
  && (order.body.simulation_id===conversation.body.simulation_id||allowMissingSimulation&&order.body.simulation_id===undefined);
}
export async function assertNumberFlowTestOrder(c:QueryExecutor,conversation:DomainRecord,order:DomainRecord){
 if(!await numberFlowSimulation(c,conversation))return;
 if(!await validNumberFlowConversation(c,conversation)||!numberFlowOrderMatches(order,conversation)||order.body.commercial_classification!=='TEST')throw new Error('NUMBER_FLOW_TEST_CLASSIFICATION_REQUIRED');
}

/** Canonical worker transition only: preserve the legacy graph and cursor.
 * Caller holds the conversation lock in a transaction. Never relabel financial history. */
export async function reconcileNumberFlowTestClassification(c:QueryExecutor,conversation:DomainRecord):Promise<DomainRecord>{
 if(!await numberFlowSimulation(c,conversation))return conversation;
 if(!await validNumberFlowConversation(c,conversation))throw new Error('NUMBER_FLOW_TEST_SCOPE_INVALID');
 if(conversation.body.commercial_classification!=null&&conversation.body.commercial_classification!=='TEST')throw new Error('NUMBER_FLOW_TEST_CLASSIFICATION_CONFLICT');
 const orders=(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='order' AND body->>'conversation_id'=$2 FOR UPDATE",[conversation.workspace_id,conversation.id])).rows as DomainRecord[];
 if(orders.length>1)throw new Error('NUMBER_FLOW_TEST_ORDER_AMBIGUOUS');
 const order=orders[0],needsOrder=order&&(order.body.commercial_classification!=='TEST'||order.body.simulation_id!==conversation.body.simulation_id);
 if(order&&!numberFlowOrderMatches(order,conversation,true))throw new Error('NUMBER_FLOW_TEST_ORDER_BINDING_CHANGED');
 if(needsOrder){
  if(order.body.commercial_classification!=null&&order.body.commercial_classification!=='TEST')throw new Error('NUMBER_FLOW_TEST_CLASSIFICATION_CONFLICT');
  if(order.body.receipt_id||order.body.sale_id||order.body.sale_definition||order.body.sale_status||order.body.sale_effective_at||order.body.sale_effects_applied_at||order.body.sale_effects_suppressed_by_migration
   ||['sale_amount_minor','test_approved_amount_minor','observed_amount_minor','reconciled_amount_minor'].some(key=>Number(order.body[key]??0)!==0)
   ||!['NONE',undefined].includes(order.body.receipt_status)||!['UNRECONCILED',undefined].includes(order.body.reconciliation_status)
   ||(await c.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='receipt' AND (body->>'order_id'=$2 OR body->>'conversation_id'=$3))
    OR EXISTS(SELECT 1 FROM payment_contributions WHERE workspace_id=$1 AND environment='SIMULATION' AND order_id::text=$2)
    OR EXISTS(SELECT 1 FROM domain_events WHERE workspace_id=$1 AND environment='SIMULATION' AND aggregate_id=$2 AND event_type LIKE 'sale.%')`,[order.workspace_id,order.id,conversation.id])).rowCount)throw new Error('NUMBER_FLOW_TEST_FINANCIAL_HISTORY_REQUIRES_REVIEW');
 }
 const changed:string[]=[];
 if(needsOrder){await putRecord(c,{id:order.id,workspaceId:order.workspace_id,environment:'SIMULATION',kind:'order',version:order.version,body:{...order.body,commercial_classification:'TEST',simulation_id:conversation.body.simulation_id,analytics_excluded_from_creation:false,classification_source:'NUMBER_FLOW_TEST_RECONCILIATION'}});changed.push(order.id);}
 if(conversation.body.commercial_classification!=='TEST'){
  conversation=await putRecord(c,{id:conversation.id,workspaceId:conversation.workspace_id,environment:'SIMULATION',kind:'conversation',version:conversation.version,body:{...conversation.body,commercial_classification:'TEST',analytics_excluded_from_creation:!order,classification_source:'NUMBER_FLOW_TEST_RECONCILIATION'}});changed.push(conversation.id);
 }
 if(changed.length)await appendEvent(c,{workspace_id:conversation.workspace_id,environment:'SIMULATION',event_type:'number.flow_test_classification_reconciled',aggregate_id:conversation.body.simulation_id,correlation_id:conversation.id,actor:{type:'automation'},payload:{conversation_id:conversation.id,order_id:order?.id??null,record_ids:changed,classification:'TEST',financial_history_changed:false,external_effects:false}});
 return conversation;
}

/**
 * Serializes scope declaration with new orders on that account. Callers that
 * own a conversation lock acquire it first; declaration never locks a
 * conversation, so it cannot invert the worker's conversation -> account order.
 */
export async function lockLaunchTestOrderCreation(c:QueryExecutor,workspace:string,accountId:string){
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`launch-test:${workspace}:${accountId}`]);
}

/** Match only an owner-declared scope. This does not authorize transport.
 * A conversation classified at its first persistence keeps its TEST history;
 * expiry/revocation still blocks effects through activeLaunchTest.
 */
export async function launchTestOrderFields(c:QueryExecutor,conversation:DomainRecord){
 if(await numberFlowSimulation(c,conversation)){
  if(!await validNumberFlowConversation(c,conversation))throw new Error('NUMBER_FLOW_TEST_SCOPE_INVALID');
  return{commercial_classification:'TEST',simulation_id:conversation.body.simulation_id,analytics_excluded_from_creation:true};
 }
 if(conversation.environment==='SIMULATION'&&conversation.body.simulation_id&&(await c.query("SELECT 1 FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION' AND kind='simulation' AND body->>'account_id'=$3 AND body->>'offer_version_id'=$4",[conversation.body.simulation_id,conversation.workspace_id,conversation.body.account_id,conversation.body.offer_version_id])).rowCount)return{commercial_classification:'TEST',simulation_id:conversation.body.simulation_id,analytics_excluded_from_creation:true};
 if(conversation.body.commercial_classification==='TEST'&&conversation.body.launch_test_scope_id){
  const scope=(await c.query(`SELECT * FROM mcl_test_scopes WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND account_id::text=$4 AND offer_version_id::text=$5 AND participants @> $6::jsonb`,[conversation.body.launch_test_scope_id,conversation.workspace_id,conversation.environment,conversation.body.account_id,conversation.body.offer_version_id,JSON.stringify([{contact_id:conversation.body.contact_id}])])).rows[0];
  const participant=scope?.participants.find((p:{contact_id:string})=>p.contact_id===conversation.body.contact_id);
  if(!participant||conversation.body.analytics_excluded_from_creation!==true||conversation.body.launch_test_role!==participant.role)throw new Error('LAUNCH_TEST_CONVERSATION_BINDING_CHANGED');
  return {commercial_classification:'TEST',launch_test_scope_id:scope.id,launch_test_role:participant.role,analytics_excluded_from_creation:true};
 }
 const scopes=(await c.query(`SELECT * FROM mcl_test_scopes WHERE workspace_id=$1 AND environment=$2 AND account_id::text=$3 AND offer_version_id::text=$4 AND revoked_at IS NULL AND expires_at>now() AND participants @> $5::jsonb AND created_at<=COALESCE((SELECT r.created_at FROM records r WHERE r.id=$6 AND r.workspace_id=$1 AND r.environment=$2 AND r.kind='conversation'),clock_timestamp()) ORDER BY created_at`,[conversation.workspace_id,conversation.environment,conversation.body.account_id,conversation.body.offer_version_id,JSON.stringify([{contact_id:conversation.body.contact_id}]),conversation.id])).rows;
 if(scopes.length>1)throw new Error('AMBIGUOUS_LAUNCH_TEST_SCOPE');
 const scope=scopes[0];if(!scope)return {};
 const participant=scope.participants.find((p:{contact_id:string})=>p.contact_id===conversation.body.contact_id);
 return {commercial_classification:'TEST',launch_test_scope_id:scope.id,launch_test_role:participant.role,analytics_excluded_from_creation:true};
}
export async function activeLaunchTest(c:QueryExecutor,order:DomainRecord){
 if(order.environment==='SIMULATION'&&order.body.commercial_classification==='TEST'&&order.body.simulation_id){
  const conversation=await getRecord(c,order.workspace_id,'conversation',order.body.conversation_id??'');
  if(conversation&&await numberFlowSimulation(c,conversation))return numberFlowOrderMatches(order,conversation)&&await validNumberFlowConversation(c,conversation);
  // A number lab may never fall through to the older single-offer contract.
  const simulation=await getRecord(c,order.workspace_id,'simulation',order.body.simulation_id);
  if(simulation?.body.mode==='NUMBER_FLOW_TEST_V1')return false;
 }
 if(order.environment==='SIMULATION'&&order.body.commercial_classification==='TEST'&&order.body.simulation_id)return !!(await c.query("SELECT 1 FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION' AND kind='simulation' AND body->>'account_id'=$3 AND body->>'offer_version_id'=$4",[order.body.simulation_id,order.workspace_id,order.body.account_id,order.body.offer_version_id])).rowCount;
 if(order.body.commercial_classification!=='TEST'||!order.body.launch_test_scope_id)return false;
 return !!(await c.query(`SELECT 1 FROM mcl_test_scopes WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND account_id::text=$4 AND offer_version_id::text=$5 AND revoked_at IS NULL AND expires_at>now() AND participants @> $6::jsonb`,[order.body.launch_test_scope_id,order.workspace_id,order.environment,order.body.account_id,order.body.offer_version_id,JSON.stringify([{contact_id:order.body.contact_id}])])).rowCount;
}
/** TEST remains zero in analytics; this separate total is only for rehearsal benefits. */
export async function approvedBenefitTotal(c:QueryExecutor,order:DomainRecord):Promise<number>{
 if(order.body.commercial_classification!=='TEST')return Number(order.body.sale_amount_minor??0);
 if(!await activeLaunchTest(c,order))return 0;
 const simulation=order.body.simulation_id?await getRecord(c,order.workspace_id,'simulation',order.body.simulation_id):undefined;
 const numberLab=order.environment==='SIMULATION'&&simulation?.body.mode==='NUMBER_FLOW_TEST_V1';
 const row=(await c.query(`SELECT COALESCE(sum(p.amount_minor),0)::text amount FROM payment_contributions p JOIN records r ON r.id=p.receipt_id
  WHERE p.workspace_id=$1 AND p.environment=$2 AND p.order_id=$3 AND r.body->>'status'='APPROVED' AND r.body->>'commercial_classification' IS DISTINCT FROM 'FALSE'
   AND ($4::boolean=false OR (r.workspace_id=p.workspace_id AND r.environment=p.environment AND r.kind='receipt' AND r.body->>'order_id'=p.order_id::text AND r.body->>'conversation_id'=$5 AND r.body->>'source'='simulation_fixture'
    AND EXISTS(SELECT 1 FROM records a WHERE a.id::text=r.body->>'asset_id' AND a.workspace_id=r.workspace_id AND a.environment=r.environment AND a.kind='asset' AND a.body->'lab_snapshot'='true'::jsonb AND a.body->'synthetic_receipt'='true'::jsonb AND a.body->>'status'='READY' AND a.body->>'sha256'=p.evidence_sha256)))`,[order.workspace_id,order.environment,order.id,numberLab,order.body.conversation_id])).rows[0];
 const amount=Number(row.amount);if(!Number.isSafeInteger(amount))throw new Error('AMOUNT_OVERFLOW');return amount;
}

/** Separate rehearsal eligibility; never turn TEST totals into commercial income. */
export async function approvedNumberFlowTestPayment(c:QueryExecutor,order:DomainRecord):Promise<boolean>{
 if(order.environment!=='SIMULATION'||order.body.commercial_classification!=='TEST'||order.body.sale_status!=='TEST'||!order.body.simulation_id)return false;
 const simulation=await getRecord(c,order.workspace_id,'simulation',order.body.simulation_id);
 return simulation?.body.mode==='NUMBER_FLOW_TEST_V1'&&await approvedBenefitTotal(c,order)>0;
}

/** Recheck at dispatch; a queued test/sponsorship is never authorization to send later. */
export async function launchEffectBlockReason(c:QueryExecutor,conversation:DomainRecord,payload:Record<string,any>):Promise<string|undefined>{
 const order=(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND body->>'conversation_id'=$3 LIMIT 1",[conversation.workspace_id,conversation.environment,conversation.id])).rows[0] as DomainRecord|undefined;
 if(order?.body.launch_test_scope_id&&!await activeLaunchTest(c,order))return 'LAUNCH_TEST_SCOPE_INACTIVE';
 if(order?.body.launch_test_role==='beneficiary'&&!['sponsorship','sponsorship_notice'].includes(payload.purpose)&&payload.actor_kind!=='human')return 'TEST_BENEFICIARY_NO_COMMERCIAL_SENDS';
 if(conversation.body.sponsorship_id&&!['sponsorship','sponsorship_notice'].includes(payload.purpose)&&payload.actor_kind!=='human')return 'SPONSORED_CONVERSATION_NO_COMMERCIAL_SENDS';
 if(payload.sponsorship_id||['sponsorship','sponsorship_notice'].includes(payload.purpose))return 'SPONSORSHIP_RETIRED';

 return undefined;
}
