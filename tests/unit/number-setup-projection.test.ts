import {describe,expect,it} from 'vitest';
import {projectIdentityStep,projectProvisionStep,projectSimulationProof} from '../../apps/api/src/number-setup.js';

const manifest=[{assignment_id:'simulation-assignment',product_id:'product',offer_version_id:'offer',workflow_version_id:'workflow',source:{assignment_id:'real-assignment',revision:1,binding_id:'real-binding'}}];
const conversation={id:'conversation',workspace_id:'workspace',environment:'SIMULATION',kind:'conversation',version:1,created_at:'2026-09-22T00:00:00.000Z',updated_at:'2026-09-22T00:00:00.000Z',body:{simulation_id:'test',account_id:'simulation-account',assignment_id:'simulation-assignment',routing_state:'RESOLVED',flow_state:{status:'FINISHED'}}} as any;
const complete={test_id:'test',account_id:'simulation-account',status:'COMPLETED',start_mode:'EMPTY',conversation_id:'conversation',external_effects:false,isolation:{transport:'simulator',external_network:false,real_mutation:false},manifest,source_state:{freshness:'CURRENT',stale_reasons:[],current_assignment_count:1},conversation,pending_commands:0,failed_commands:0,pending_effects:0,unknown_effects:0,failed_effects:0,pending_timers:0};

describe('number setup simulation proof',()=>{
 it('does not treat the first running turn as a completed flow',()=>{
  expect(projectSimulationProof({...complete,status:'RUNNING'})).toMatchObject({status:'IN_PROGRESS',cause:'SIMULATION_IN_PROGRESS',complete:false,blockers:['SIMULATION_STATUS_NOT_COMPLETED']});
 });

 it('requires a complete canonical isolated proof',()=>{
  expect(projectSimulationProof(complete)).toEqual({status:'READY',cause:'SIMULATION_COMPLETED_CURRENT',blockers:[],complete:true});
  expect(projectSimulationProof({...complete,isolation:{transport:'simulator',external_network:true,real_mutation:false}})).toMatchObject({status:'BLOCKED',complete:false,blockers:expect.arrayContaining(['SIMULATION_ISOLATION_UNVERIFIED'])});
  expect(projectSimulationProof({...complete,manifest:[]})).toMatchObject({status:'BLOCKED',complete:false,blockers:expect.arrayContaining(['SIMULATION_SNAPSHOT_PARTIAL','SIMULATION_CANONICAL_PROOF_MISSING'])});
  expect(projectSimulationProof({...complete,pending_effects:1})).toMatchObject({status:'IN_PROGRESS',cause:'SIMULATION_EFFECTS_PENDING',complete:false});
  expect(projectSimulationProof({...complete,unknown_commands:1,failed_commands:1})).toMatchObject({status:'UNKNOWN',cause:'SIMULATION_COMMANDS_UNKNOWN',complete:false,blockers:expect.arrayContaining(['SIMULATION_COMMANDS_UNKNOWN','SIMULATION_COMMANDS_FAILED'])});
  expect(projectSimulationProof({...complete,unknown_effects:1})).toMatchObject({status:'UNKNOWN',cause:'SIMULATION_EFFECTS_UNKNOWN',complete:false});
 });

 it('propagates exact source and assignment freshness blockers',()=>{
  const result=projectSimulationProof({...complete,source_state:{freshness:'STALE',stale_reasons:['SOURCE_ACCOUNT_CHANGED','ASSIGNMENTS_CHANGED'],current_assignment_count:1}});
  expect(result).toEqual({status:'REQUIRES_ATTENTION',cause:'SOURCE_ACCOUNT_CHANGED',blockers:['SOURCE_ACCOUNT_CHANGED','ASSIGNMENTS_CHANGED'],complete:false});
 });
});

describe('number setup canonical step projection',()=>{
 it.each([
  ['DRAINING','BLOCKED','CAPACITY_SLOT_DRAINING'],
  ['ERROR','BLOCKED','CAPACITY_SLOT_ERROR'],
  ['UNKNOWN','UNKNOWN','CAPACITY_SLOT_UNKNOWN'],
 ] as const)('never marks a %s capacity slot ready', (slot,status,cause)=>{
  expect(projectProvisionStep(slot,'SUCCEEDED')).toEqual({status,cause});
 });

 it('exposes same-operation identity recovery without treating it as a new observation',()=>{
  expect(projectIdentityStep({conflict:false,verified:false,authState:'UNKNOWN',observed:false,operationState:'UNKNOWN'})).toEqual({status:'UNKNOWN',cause:'IDENTITY_OBSERVATION_UNKNOWN',recovery:true,pending:false});
  expect(projectIdentityStep({conflict:false,verified:false,authState:'UNKNOWN',observed:false,operationState:'PREPARING'})).toEqual({status:'IN_PROGRESS',cause:'IDENTITY_OBSERVATION_IN_PROGRESS',recovery:false,pending:true});
 });
});
