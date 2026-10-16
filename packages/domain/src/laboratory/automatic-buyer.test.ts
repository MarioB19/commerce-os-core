import {describe,expect,it} from 'vitest';
import {nextSuiteStep,variantVerdict,type SuiteCase,type SuiteEntry,type SuiteLastStep} from './automatic-buyer.js';
import {syntheticReceiptPdf,syntheticReceiptLines} from './synthetic-receipt.js';

const V='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',R='33333333-3333-4333-8333-333333333333';
const base=(journey:'PURCHASE'|'FOLLOWUP',expect_followup=true):SuiteCase=>({journey,variant_id:V,phase:'GREET',steps:0,checks:[],expect_followup,attachment_id:journey==='PURCHASE'?A:null});
const step=(transcript:SuiteEntry[],waiting:string|null,variant=V):SuiteLastStep=>({state:'APPLIED',result:{state:'WORKFLOWS_APPLIED',reason:null,variant_id:variant,transcript,flow:{waiting_for:waiting}}});
function play(c:SuiteCase,steps:SuiteLastStep[]){
 const actions:unknown[]=[];let current=c,decision=nextSuiteStep(current,null);
 for(const last of [null,...steps]){
  if(last)decision=nextSuiteStep(current,last);
  if(!('action' in decision))return{actions,decision};
  actions.push(decision.action);current={...current,phase:decision.phase,steps:current.steps+1,checks:decision.checks};
 }
 return{actions,decision};
}
const hi:SuiteEntry={from:'customer',text:'Hola'},offer:SuiteEntry={from:'business',purpose:'commercial',text:'El curso cuesta 97'},pay:SuiteEntry={from:'business',purpose:'collection',text:'Datos de pago'};

describe('automatic buyer (RF-19.p)',()=>{
 it('buys: greeting, offer, collection, receipt, delivery and no follow-up afterwards',()=>{
  const approved:SuiteEntry={from:'customer',kind:'receipt',status:'APPROVED',receipt_id:R,explanation:'Aprobado'};
  const {actions,decision}=play(base('PURCHASE'),[
   step([hi,offer],'simulation_continue'),step([hi,offer],'commitment'),step([hi,offer,pay],'simulation_continue'),step([hi,offer,pay],'receipt_approved'),
   step([hi,offer,pay,approved],'simulation_continue'),step([hi,offer,pay,approved,{from:'business',material:'Acceso',explanation:'Entrega de la variante'}],null),
   step([hi,offer,pay,approved,{from:'business',material:'Acceso'}],null)]);
  expect(actions).toEqual([{type:'message',text:'Hola, quiero información'},{type:'continue'},{type:'message',text:'Sí, acepto'},{type:'continue'},{type:'receipt',attachment_id:A},{type:'continue'},{type:'advance',hours:24}]);
  expect(decision).toMatchObject({done:'PASSED'});
  expect('checks' in decision&&decision.checks.map(c=>[c.name,c.state])).toEqual(expect.arrayContaining([['route','PASSED'],['offer','PASSED'],['collection','PASSED'],['receipt','PASSED'],['delivery','PASSED'],['exclusion','PASSED']]));
 });
 it('approves as a person when the rules leave the receipt in review, and fails if follow-ups continue after buying',()=>{
  const review:SuiteEntry={from:'customer',kind:'receipt',status:'HUMAN_REVIEW',receipt_id:R,explanation:'Tus reglas piden que una persona lo apruebe'};
  const approved:SuiteEntry={...review,status:'APPROVED'};
  const {actions,decision}=play(base('PURCHASE'),[step([hi,offer],'commitment'),step([hi,offer,pay],'receipt_approved'),step([hi,offer,pay,review],null),
   step([hi,offer,pay,approved,{from:'business',material:'Acceso'}],null),step([hi,offer,pay,approved,{from:'business',material:'Acceso'},{from:'business',purpose:'remarketing'}],null)]);
  expect(actions).toContainEqual({type:'review_receipt',receipt_id:R,decision:'APPROVED',reason:'Aprobado por la prueba automática'});
  expect(decision).toMatchObject({done:'FAILED'});
  expect('checks' in decision&&decision.checks.find(c=>c.name==='exclusion')).toMatchObject({state:'FAILED'});
 });
 it('marks a step that could not run as incomplete, never as passed',()=>{
  const d=nextSuiteStep({...base('PURCHASE'),phase:'OFFER',steps:1},{state:'FAILED',result:{state:'DEPENDENCY_REQUIRED',reason:'LAB_SELLER_GRANT_REQUIRED'}});
  expect(d).toMatchObject({done:'PARTIAL'});
  expect(nextSuiteStep({...base('PURCHASE'),phase:'OFFER',steps:1},step([hi,{from:'business',text:'x'}],'commitment','44444444-4444-4444-8444-444444444444'))).toMatchObject({done:'FAILED'});
 });
 it('waits silently and expects a follow-up only when the variant has one',()=>{
  const nudged=play(base('FOLLOWUP'),[step([hi,offer],'commitment'),step([hi,offer],'commitment'),step([hi,offer,{from:'business',purpose:'remarketing'}],'commitment')]);
  expect(nudged.actions).toEqual([{type:'message',text:'Hola, quiero información'},{type:'advance',hours:2},{type:'advance',hours:8}]);
  expect(nudged.decision).toMatchObject({done:'PASSED'});
  const none=play(base('FOLLOWUP',false),[step([hi,offer],'commitment'),step([hi,offer],'commitment'),step([hi,offer],'commitment'),step([hi,offer],'commitment')]);
  expect(none.decision).toMatchObject({done:'PASSED'});expect('checks' in none.decision&&none.decision.checks.find(c=>c.name==='followup')).toMatchObject({state:'SKIPPED'});
  const missing=play(base('FOLLOWUP',true),[step([hi,offer],'commitment'),step([hi,offer],'commitment'),step([hi,offer],'commitment'),step([hi,offer],'commitment')]);
  expect(missing.decision).toMatchObject({done:'FAILED'});
 });
 it('gives one verdict per variant (RF-19.h)',()=>{
  expect(variantVerdict([])).toBe('SIN_PROBAR');
  expect(variantVerdict([{journey:'PURCHASE',state:'PASSED'},{journey:'FOLLOWUP',state:'PASSED'}])).toBe('RESPONDE_BIEN');
  expect(variantVerdict([{journey:'PURCHASE',state:'PASSED'},{journey:'FOLLOWUP',state:'PARTIAL'}])).toBe('INCOMPLETO');
  expect(variantVerdict([{journey:'PURCHASE',state:'FAILED'},{journey:'FOLLOWUP',state:'RUNNING'}])).toBe('FALLO');
  expect(variantVerdict([{journey:'PURCHASE',state:'RUNNING'},{journey:'FOLLOWUP',state:'PASSED'}])).toBe('EN_CURSO');
 });
 it('writes a valid one-page test receipt for the variant price',()=>{
  const pdf=syntheticReceiptPdf({amountMinor:9700,currency:'MXN',minorDigits:2,paidOn:'2026-10-13',reference:'LAB-ABCD1234'});
  const text=pdf.toString('latin1');expect(text.startsWith('%PDF-1.4')).toBe(true);expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  const xref=Number(/startxref\n(\d+)/.exec(text)![1]);expect(text.slice(xref,xref+4)).toBe('xref');
  for(const [i,offset] of [...text.matchAll(/^(\d{10}) 00000 n $/gm)].map((m,i)=>[i+1,Number(m[1])] as const))expect(text.slice(offset,offset+String(i).length+6)).toBe(`${i} 0 obj`);
  expect(syntheticReceiptLines({amountMinor:9700,currency:'MXN',minorDigits:2,paidOn:'2026-10-13',reference:'LAB-ABCD1234'})).toContain('Monto: 97.00 MXN');
  expect(()=>syntheticReceiptPdf({amountMinor:0,currency:'MXN',minorDigits:2,paidOn:'2026-10-13',reference:'LAB-1'})).toThrow('LAB_SYNTHETIC_RECEIPT');
 });
});
