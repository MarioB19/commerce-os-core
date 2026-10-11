import type {Body,DomainRecord} from '../../contracts/src/index.js';
import type {QueryExecutor} from './index.js';

/** A workspace pause is a REAL barrier; only the explicit, persisted number lab
 * can progress through that pause. Never infer this permission from one marker
 * or from SIMULATION alone. The API's immutable start event binds its origin. */
export async function isIsolatedNumberFlowTest(client:QueryExecutor,conversation:DomainRecord):Promise<boolean>{
 if(conversation.environment!=='SIMULATION'||conversation.kind!=='conversation'||typeof conversation.body.simulation_id!=='string')return false;
 return !!(await client.query(`SELECT 1 FROM records c
  JOIN records a ON a.id::text=c.body->>'account_id' AND a.workspace_id=c.workspace_id AND a.environment=c.environment AND a.kind='channel_account'
  JOIN records contact ON contact.id::text=c.body->>'contact_id' AND contact.workspace_id=c.workspace_id AND contact.environment=c.environment AND contact.kind='contact'
  JOIN records s ON s.id::text=c.body->>'simulation_id' AND s.workspace_id=c.workspace_id AND s.environment=c.environment AND s.kind='simulation'
  WHERE c.id=$1 AND c.workspace_id=$2 AND c.environment='SIMULATION' AND c.kind='conversation'
   AND c.body->>'simulation_id'=$3 AND c.body->>'account_id'=$4 AND c.body->>'contact_id'=$5
   AND contact.body->>'identity'='opaque:sim-'||s.id::text
   AND a.body->>'provider'='simulator' AND a.body->'lab_snapshot'='true'::jsonb
   AND a.body->>'flow_test_transport'='ISOLATED_SIMULATOR' AND a.body->'sending_enabled'='false'::jsonb AND NOT(a.body?'deleted_at')
   AND s.body->>'account_id'=a.id::text AND s.body->>'mode'='NUMBER_FLOW_TEST_V1' AND s.body->>'status' IN('RUNNING','COMPLETED')
   AND s.body->'external_effects'='false'::jsonb
   AND s.body->'isolation' @> '{"transport":"simulator","external_network":false,"real_mutation":false,"bank":"LAB_PLACEHOLDER","access":"LAB_ONLY"}'::jsonb
   AND EXISTS(SELECT 1 FROM domain_events e WHERE e.workspace_id=s.workspace_id AND e.environment='SIMULATION'
    AND e.aggregate_id=s.id::text AND e.event_type='number.flow_test_started'
    AND e.payload->'external_effects'='false'::jsonb AND e.payload->>'source_account_id'=s.body->'source'->'account'->>'id')`,
 [conversation.id,conversation.workspace_id,conversation.body.simulation_id,conversation.body.account_id,conversation.body.contact_id])).rowCount;
}

/** Effective read projection only. Other pauses, suppression and takeover keep
 * their semantics, including the workspace's own suppression/takeover. */
export async function effectiveNumberFlowControls<T extends Body>(client:QueryExecutor,conversation:DomainRecord,controls:T[]):Promise<T[]>{
 if(!controls.some(control=>control.scope_type==='workspace'&&control.scope_id===conversation.workspace_id&&control.paused)||!await isIsolatedNumberFlowTest(client,conversation))return controls;
 return controls.map(control=>control.scope_type==='workspace'&&control.scope_id===conversation.workspace_id?{...control,paused:false}:control);
}
