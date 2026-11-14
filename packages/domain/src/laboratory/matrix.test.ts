import {describe,expect,it} from 'vitest';
import {matrixReservation} from './matrix.js';

// V7.5.4: the matrix 9aca909f of production (14-nov): two suites of 16 calls /
// US$3.20 each, four steps stopped before any AI call. Closed, they free their
// unconsumed part; open, or with uncertain consumption, they keep it.
const suite=(o:Partial<Parameters<typeof matrixReservation>[0][number]>={})=>({terminal:false,maximum_microusd:3_200_000,maximum_ai_calls:16,confirmed_microusd:0,uncertain_microusd:0,calls:0,...o});
describe('matrixReservation',()=>{
 it('keeps the whole maximum of suites still open (the 409 of V7.5.3)',()=>{
  expect(matrixReservation([suite(),suite()])).toMatchObject({reserved_microusd:6_400_000,reserved_ai_calls:32});
 });
 it('frees what terminal suites never consumed',()=>{
  expect(matrixReservation([suite({terminal:true}),suite({terminal:true})])).toEqual({reserved_microusd:0,reserved_ai_calls:0,consumed_microusd:0,uncertain_microusd:0,calls:0});
 });
 it('counts confirmed and uncertain consumption across both numbers and every attempt',()=>{
  const r=matrixReservation([suite({terminal:true,confirmed_microusd:41_000,calls:3}),suite({terminal:true,uncertain_microusd:200_000,calls:1}),suite({confirmed_microusd:10_000,calls:1})]);
  expect(r).toEqual({reserved_microusd:41_000+200_000+3_200_000,reserved_ai_calls:3+1+16,consumed_microusd:51_000,uncertain_microusd:200_000,calls:5});
 });
 it('never reserves less than consumed, even above the maximum',()=>{
  expect(matrixReservation([suite({confirmed_microusd:3_300_000,calls:17})])).toMatchObject({reserved_microusd:3_300_000,reserved_ai_calls:17});
 });
 it('rejects malformed usage',()=>{
  expect(()=>matrixReservation([suite({calls:-1})])).toThrow('LAB_MATRIX_USAGE_INVALID');
  expect(()=>matrixReservation([suite({confirmed_microusd:0.5})])).toThrow('LAB_MATRIX_USAGE_INVALID');
 });
});
