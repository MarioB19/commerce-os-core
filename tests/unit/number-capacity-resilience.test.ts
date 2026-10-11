import {describe,expect,it} from 'vitest';
import {projectCapacityMetrics} from '../../apps/api/src/number-capacity.js';
import {capacityReadbackIsFresh,projectGatewayMapping} from '../../apps/api/src/number-capacity-state.js';
import {capacityLegacyAdoptionSchema} from '../../packages/contracts/src/numbers.js';
import {CAPACITY_READBACK_TTL_MS} from '../../packages/contracts/src/numbers.js';
import {numberRequest,numberTools} from '../../apps/commerce-mcp/src/numbers.js';

describe('number capacity reconciliation',()=>{
 const now=new Date('2026-09-22T12:00:00.000Z');

 it('does not count expired verified readback as provisioned or available',()=>{
  const slots=[{slot:1,state:'PREPARED',account_id:null,readback:{verified:true,observed_at:'2026-09-22T11:58:59.000Z'}}];
  expect(capacityReadbackIsFresh(slots[0]!.readback,now)).toBe(false);
  expect(projectCapacityMetrics({slots,legacy:[],sessions:[],globallyOccupied:[1],physicalSessionsObserved:null,workspace:'fixture',now})).toMatchObject({slot_records:1,provisioned_verified:null,readback_unverified:1,verification_status:'STALE',available:null,headroom:19});
 });

 it('accepts only the bounded readback window around the supplied clock',()=>{
  const fresh={verified:true,observed_at:'2026-09-22T11:59:30.000Z',expires_at:'2026-09-22T12:00:30.000Z'};
  expect(capacityReadbackIsFresh(fresh,now)).toBe(true);
  expect(Date.parse(fresh.expires_at)-Date.parse(fresh.observed_at)).toBe(CAPACITY_READBACK_TTL_MS);
  expect(capacityReadbackIsFresh({...fresh,expires_at:'2026-09-22T11:59:59.999Z'},now)).toBe(false);
 });

 it('treats physical_sessions_verified as observed occupancy, never as a ceiling',()=>{
  const sessions=[1,2,3].map(account_id=>({account_id,observed_state:'CONNECTED',health_expires_at:'2026-09-22T12:05:00.000Z'}));
  expect(projectCapacityMetrics({slots:[],legacy:[],sessions,globallyOccupied:[1,2,3],physicalSessionsObserved:3,workspace:'fixture',now})).toMatchObject({connected_sessions:3,physical_sessions_observed:3,physical_capacity_measured:null,headroom:17,logical_headroom:17,physical_headroom:null,headroom_basis:'LOGICAL_LIMIT_MINUS_OCCUPIED_SLOTS'});
 });

 it('detects account/session/canonical gateway mismatch',()=>{
  expect(projectGatewayMapping({canonical_slot:2,account_gateway_ref:'waha-02',session_gateway_ref:'http://waha-01:3000'})).toMatchObject({canonical_slot:2,account_slot:2,session_slot:1,physical_slots:[1,2],physical_slot:null,gateway_slot_mismatch:true});
 });

 it('requires unique accounts and slots in an adoption command',()=>{
  const item={account_id:'00000000-0000-4000-8000-000000000001',slot:1,expected_account_version:1,expected_session_version:1};
  expect(capacityLegacyAdoptionSchema.safeParse({items:[item,{...item,slot:2}],confirmation:'ADOPT_RECONCILED_LEGACY_SLOTS',reason:'Conciliar inventario observado'}).success).toBe(false);
 });

 it('publishes the same legacy-adoption contract through MCP',()=>{
  expect(numberTools.number_capacity_adopt_legacy.schema.body).toBe(capacityLegacyAdoptionSchema);
  expect(numberRequest('number_capacity_adopt_legacy',{body:{items:[],confirmation:'ADOPT_RECONCILED_LEGACY_SLOTS',reason:'Fixture'},idempotency_key:'capacity-fixture',environment:'REAL'})).toMatchObject({route:'/v1/number-capacity/reconciliation/adopt-legacy',method:'POST',key:'capacity-fixture'});
 });
});
