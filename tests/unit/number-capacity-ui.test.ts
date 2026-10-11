import {describe,expect,it} from 'vitest';
import {capacityMinimum} from '../../apps/web/src/lib/number-capacity.js';

describe('capacityMinimum',()=>{
 it('ignores the logical ceiling and uses the current inventory floor',()=>{
  expect(capacityMinimum({configured_limit:20,metrics:{logical_limit:20,provisioned_verified:3,reserved:2},slots:[{slot:1},{slot:2},{slot:4}],legacy_reservations:[]})).toBe(4);
 });

 it('never proposes fewer places than existing reservations',()=>{
  expect(capacityMinimum({metrics:{logical_limit:20,reserved:6},slots:[{slot:1},{slot:2}],legacy_reservations:[{slot:3}]})).toBe(6);
 });

 it('includes an explicit or legacy slot floor and keeps one as the empty minimum',()=>{
  expect(capacityMinimum({inventory_floor:5,metrics:{logical_limit:20,reserved:1},slots:[],legacy_reservations:[]})).toBe(5);
  expect(capacityMinimum({metrics:{logical_limit:20,reserved:1},slots:[],legacy_reservations:[{slot:7}]})).toBe(7);
  expect(capacityMinimum({configured_limit:20,metrics:{logical_limit:20},slots:[]})).toBe(1);
 });
});
