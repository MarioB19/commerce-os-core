import {describe,expect,it} from 'vitest';
import {pricedResultFacts} from './result-projection-worker.js';
const fact=(currency:string|null)=>({grain:{day:'2026-10-10',currency,timezone:'UTC',dimensions:{}},counters:{}});
describe('pricedResultFacts (V7.1.1)',()=>{
 it('keeps priced contributions and leaves out only those whose currency is null',()=>{
  expect(pricedResultFacts([fact('MXN'),fact(null)])).toEqual([fact('MXN')]);
  expect(pricedResultFacts([fact(null)])).toEqual([]);
 });
 it('does not hide any other invalid shape: the contract still rejects it later',()=>{
  const odd=[{grain:{day:'2026-10-10'}},{grain:null},'x',{grain:{currency:''}}];
  expect(pricedResultFacts(odd)).toEqual(odd);
  expect(()=>pricedResultFacts({} as unknown)).toThrow('RESULT_SOURCE_FACTS_INVALID');
 });
});
