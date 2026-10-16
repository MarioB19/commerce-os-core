import {describe,expect,it} from 'vitest';
import {hostMetricsSchema,numberFlowTestResetSchema,numberFlowTestStartSchema} from '../../packages/contracts/src/numbers.js';
import {projectCapacityMetrics} from '../../apps/api/src/number-capacity.js';
import {projectAssignmentAuthorization} from '../../apps/api/src/assignment-authorization.js';
import {lifecycleSafety} from '../../apps/api/src/channel-command-safety.js';
import {channelIdentityHash} from '../../packages/db/src/commercial-assignments.js';

describe('resilience contracts',()=>{
 it('starts and resets flow tests empty unless seeding is explicit',()=>{
  expect(numberFlowTestStartSchema.parse({contact_name:'Prueba'})).toEqual({contact_name:'Prueba',start_mode:'EMPTY'});
  expect(numberFlowTestResetSchema.parse({})).toEqual({start_mode:'EMPTY'});
  expect(numberFlowTestStartSchema.safeParse({contact_name:'Prueba',initial_message:'Hola'}).success).toBe(false);
  expect(numberFlowTestStartSchema.safeParse({contact_name:'Prueba',start_mode:'SEEDED',initial_message:'Hola'}).success).toBe(true);
 });

 it('does not claim legacy reservations are provisioned, connected, measured or available',()=>{
  const legacy=[1,2,3].map(slot=>({slot,workspace_id:'fixture',account_id:`account-${slot}`}));
  const sessions=legacy.map(item=>({account_id:item.account_id,observed_state:'STOPPED',health_expires_at:null}));
  expect(projectCapacityMetrics({slots:[],legacy,sessions,globallyOccupied:[1,2,3],physicalSessionsObserved:null,workspace:'fixture'})).toEqual({
   logical_limit:20,slot_records:0,provisioned_verified:null,readback_unverified:0,verification_status:'NO_DATA',reserved:3,connected_sessions:0,physical_sessions_observed:null,physical_capacity_measured:null,available:null,headroom:17,logical_headroom:17,physical_headroom:null,headroom_basis:'LOGICAL_LIMIT_MINUS_OCCUPIED_SLOTS',
  });
 });

 it('treats invalid or legacy physical measurements as unknown',()=>{
  expect(projectCapacityMetrics({slots:[],legacy:[],sessions:[],globallyOccupied:[],physicalSessionsObserved:Number.NaN,workspace:'fixture'})).toMatchObject({physical_capacity_measured:null,physical_headroom:null,headroom:20});
  expect(hostMetricsSchema.safeParse({physical_sessions_verified:3}).success).toBe(false);
 });

 it('never projects a stale authorization as ready while canonical REAL gates are frozen',()=>{
  const now=new Date('2026-09-22T12:00:00.000Z');
  const account={id:'00000000-0000-4000-8000-000000000001',workspace_id:'workspace',environment:'REAL',kind:'channel_account',version:2,body:{provider:'waha',gateway_ref:'waha-01',identity_fingerprint:'fixture',sending_enabled:true}} as any;
  const assignment={id:'00000000-0000-4000-8000-000000000002',workspace_id:'workspace',environment:'REAL',account_id:account.id,product_id:'00000000-0000-4000-8000-000000000003',binding_id:'00000000-0000-4000-8000-000000000004',revision:3,state:'ACTIVE',authorization_id:'00000000-0000-4000-8000-000000000005',body:{valid_from:'2026-09-21T00:00:00.000Z'}} as any;
  const scope={mode:'product_assignment',assignment_id:assignment.id,assignment_revision:assignment.revision,binding_id:assignment.binding_id,product_id:assignment.product_id,account_ids:[account.id],channel_identity_hash:channelIdentityHash(account),max_messages:5};
  const authorization={id:assignment.authorization_id,expires_at:'2026-09-23T00:00:00.000Z',revoked_at:null,configuration_version:7,scope};
  const readySetup={ready:true,sending_enabled:true,configuration_version:7,checks:[{key:'operations',ok:true}]};
  expect(projectAssignmentAuthorization({setup:readySetup,assignment,account,authorization,usage:0,now})).toEqual({ready:true,blockers:[]});
  expect(projectAssignmentAuthorization({setup:{...readySetup,ready:false,checks:[{key:'operations',ok:false}]},assignment,account,authorization,usage:0,now})).toEqual({ready:false,blockers:['SETUP_OPERATIONS']});
  expect(projectAssignmentAuthorization({setup:readySetup,assignment:{...assignment,revision:4},account,authorization,usage:0,now})).toMatchObject({ready:false,blockers:['AUTHORIZATION_SCOPE_CHANGED']});
 });

 it('does not let connect bypass the single restart path after a failed session',async()=>{
  const replies=[{rows:[{id:'session',raw_state:'FAILED',observed_state:'AUTH_FAILURE',disconnect_reason:null}]},{rows:[]},{rows:[]}];
  const client={query:async()=>replies.shift()!} as any;
  await expect(lifecycleSafety(client,{id:'account',workspace_id:'workspace',environment:'REAL'} as any,'connect')).rejects.toMatchObject({code:'CONNECT_REQUIRES_RESTART_PATH',statusCode:409});
 });
});
