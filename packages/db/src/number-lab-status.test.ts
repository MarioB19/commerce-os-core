import {describe,expect,it} from 'vitest';
import {classifyNumberTest,numberTestStateLabels} from './number-lab-status.js';

// V7.5.2 T01: pending is never success nor failure; success needs a finished,
// fully covered suite.
const ops=(o:Partial<{total:number;queued:number;executing:number;uncertain:number;failed:number;applied:number}>={})=>({total:2,queued:0,executing:0,uncertain:0,failed:0,applied:2,...o});
const suite=(state:string,...cases:string[])=>({state,cases:cases.map(state=>({state}))});
describe('number test status',()=>{
 it('the V7.5.1 false success: a RUNNING suite with INTENT steps is pending or uncertain, never passed',()=>{
  expect(classifyNumberTest({suite:suite('RUNNING','RUNNING','RUNNING'),runExpired:false,operations:ops({executing:2,applied:0})})).toBe('IN_PROGRESS');
  expect(classifyNumberTest({suite:suite('RUNNING','RUNNING','RUNNING'),runExpired:false,operations:ops({uncertain:2,applied:0})})).toBe('UNCERTAIN');
 });
 it('passes only when every case passed and nothing is pending',()=>{
  expect(classifyNumberTest({suite:suite('COMPLETED','PASSED','PASSED'),runExpired:false,operations:ops()})).toBe('PASSED');
  expect(classifyNumberTest({suite:suite('COMPLETED','PASSED','PARTIAL'),runExpired:false,operations:ops()})).toBe('INCOMPLETE');
  expect(classifyNumberTest({suite:suite('COMPLETED','PASSED','PASSED'),runExpired:false,operations:ops({uncertain:1})})).toBe('INCOMPLETE');
  expect(classifyNumberTest({suite:suite('COMPLETED'),runExpired:false,operations:ops({total:0,applied:0})})).toBe('INCOMPLETE');
 });
 it('a failed case is a failure; steps closed before the engine leave the case incomplete, not failed',()=>{
  expect(classifyNumberTest({suite:suite('COMPLETED','FAILED','PASSED'),runExpired:false,operations:ops()})).toBe('FAILED');
  expect(classifyNumberTest({suite:suite('COMPLETED','PARTIAL','PARTIAL'),runExpired:false,operations:ops({failed:2,applied:0})})).toBe('INCOMPLETE');
 });
 it('an expired suite that never finished is incomplete',()=>{
  expect(classifyNumberTest({suite:suite('RUNNING','RUNNING','PASSED'),runExpired:true,operations:ops({executing:1})})).toBe('INCOMPLETE');
 });
 it('a conversed (manual) test never claims a verdict',()=>{
  expect(classifyNumberTest({suite:null,runExpired:false,operations:ops()})).toBe('MANUAL');
  expect(classifyNumberTest({suite:null,runExpired:false,operations:ops({failed:1})})).toBe('MANUAL');
  expect(classifyNumberTest({suite:null,runExpired:false,operations:ops({queued:1})})).toBe('IN_PROGRESS');
  expect(classifyNumberTest({suite:null,runExpired:false,operations:ops({uncertain:1})})).toBe('UNCERTAIN');
  expect(Object.keys(numberTestStateLabels).sort()).toEqual(['FAILED','INCOMPLETE','IN_PROGRESS','MANUAL','PASSED','UNCERTAIN']);
 });
});
