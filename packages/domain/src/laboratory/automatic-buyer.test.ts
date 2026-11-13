import {describe,expect,it} from 'vitest';
import {nextSuiteStep,variantVerdict,finishSuiteCase,type SuiteCase,type SuiteEntry,type SuiteInventory,type SuiteLastStep} from './automatic-buyer.js';
import {syntheticReceiptPdf,syntheticReceiptLines} from './synthetic-receipt.js';

const V='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',R='33333333-3333-4333-8333-333333333333';
const base=(journey:'PURCHASE'|'FOLLOWUP',expect_followup=true):SuiteCase=>({journey,variant_id:V,phase:'GREET',steps:0,checks:[],expect_followup,attachment_id:journey==='PURCHASE'?A:null});
const M1='aaaaaaaa-0000-4000-8000-000000000001',M2='aaaaaaaa-0000-4000-8000-000000000002',CAL='aaaaaaaa-0000-4000-8000-000000000003',EXTRA='aaaaaaaa-0000-4000-8000-000000000004';
/** Inventory as the engine reports it: initial bundle, then what the approved amount unlocks. */
const inventory=(stage:'none'|'committed'|'approved',over:Partial<SuiteInventory>={}):SuiteInventory=>({
 expected:{commitment:[M1,M2],receipt:stage==='approved'?[CAL]:[]},committed:stage!=='none',approved_amount_minor:stage==='approved'?9700:null,extracted_amount_minor:stage==='approved'?9700:null,
 delivered:[...(stage!=='none'?[{asset_id:M1,stage:'commitment' as const,effects:1,confirmed:1},{asset_id:M2,stage:'commitment' as const,effects:1,confirmed:1}]:[]),...(stage==='approved'?[{asset_id:CAL,stage:'receipt' as const,effects:1,confirmed:1}]:[])],...over});
const step=(transcript:SuiteEntry[],waiting:string|null,variant=V,inv?:SuiteInventory):SuiteLastStep=>({state:'APPLIED',result:{state:'WORKFLOWS_APPLIED',reason:null,variant_id:variant,transcript,flow:{waiting_for:waiting},...(inv?{inventory:inv}:{})}});
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
   step([hi,offer],'simulation_continue'),step([hi,offer],'commitment'),step([hi,offer,pay],'simulation_continue',V,inventory('committed')),step([hi,offer,pay],'receipt_approved',V,inventory('committed')),
   step([hi,offer,pay,approved],'simulation_continue',V,inventory('approved')),step([hi,offer,pay,approved,{from:'business',material:'Acceso',explanation:'Entrega de la variante'}],null,V,inventory('approved')),
   step([hi,offer,pay,approved,{from:'business',material:'Acceso'}],null,V,inventory('approved'))]);
  expect(actions).toEqual([{type:'message',text:'Hola, quiero información'},{type:'continue'},{type:'message',text:'Sí, acepto'},{type:'continue'},{type:'receipt',attachment_id:A},{type:'continue'},{type:'advance',hours:24}]);
  expect(decision).toMatchObject({done:'PASSED'});
  expect('checks' in decision&&decision.checks.map(c=>[c.name,c.state])).toEqual(expect.arrayContaining([['route','PASSED'],['offer','PASSED'],['agreement','PASSED'],['initial_delivery','PASSED'],['collection','PASSED'],['receipt','PASSED'],['delivery','PASSED'],['exclusion','PASSED']]));
 });
 it('approves as a person when the rules leave the receipt in review, and fails if follow-ups continue after buying',()=>{
  const review:SuiteEntry={from:'customer',kind:'receipt',status:'HUMAN_REVIEW',receipt_id:R,explanation:'Tus reglas piden que una persona lo apruebe'};
  const approved:SuiteEntry={...review,status:'APPROVED'};
  const {actions,decision}=play(base('PURCHASE'),[step([hi,offer],'commitment'),step([hi,offer,pay],'receipt_approved',V,inventory('committed')),step([hi,offer,pay,review],null,V,inventory('committed')),
   step([hi,offer,pay,approved,{from:'business',material:'Acceso'}],null,V,inventory('approved')),step([hi,offer,pay,approved,{from:'business',material:'Acceso'},{from:'business',purpose:'remarketing'}],null,V,inventory('approved'))]);
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
  const silent=(extra:SuiteEntry[]=[],at=99)=>[step([hi,offer],'commitment'),...Array.from({length:18},(_,i)=>step([hi,offer,...(i+1>=at?extra:[])],'commitment'))];
  const reminder:SuiteEntry={from:'business',purpose:'remarketing'};
  // V7.5.3: bounded 2 h steps up to 34 h; one reminder at 12 h (deferred to the window) passes only after the whole wait shows no second one.
  const nudged=play(base('FOLLOWUP'),silent([reminder],6));
  expect(nudged.actions[0]).toEqual({type:'message',text:'Hola, quiero información'});
  expect(nudged.actions.slice(1)).toEqual(Array.from({length:17},()=>({type:'advance',hours:2})));
  expect(nudged.decision).toMatchObject({done:'PASSED',phase:'FOLLOWUP_34'});
  const twice=play(base('FOLLOWUP'),silent([reminder,{...reminder}],6));
  expect(twice.decision).toMatchObject({done:'FAILED'});expect('checks' in twice.decision&&twice.decision.checks.find(c=>c.name==='followup')?.detail).toContain('uno por ciclo');
  // A disabled policy is recorded as SKIPPED and never proves follow-up.
  const none=play(base('FOLLOWUP',false),silent());
  expect(none.decision).toMatchObject({done:'PARTIAL'});expect('checks' in none.decision&&none.decision.checks.find(c=>c.name==='followup')).toMatchObject({state:'SKIPPED'});
  const missing=play(base('FOLLOWUP',true),silent());
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
 // V7.5.3 regressions of the baseline reproductions (evidencia/2026-11-13-v753-analisis).
 it('A01/F2: the natural acceptance is sent to a contextual agreement and the literal phrase to a strict one',()=>{
  const offered=(agreement:{classifier:string|null;literal:string|null})=>nextSuiteStep({...base('PURCHASE'),phase:'OFFER',steps:2,checks:[{name:'route',state:'PASSED',detail:''}]},{state:'APPLIED',result:{variant_id:V,transcript:[hi,offer],flow:{waiting_for:'commitment'},agreement}});
  expect(offered({classifier:'contextual_agreement',literal:'sí'})).toMatchObject({action:{type:'message',text:'Sí, acepto'}});
  expect(offered({classifier:null,literal:'SÍ, QUIERO MI CICLO LISTO'})).toMatchObject({action:{type:'message',text:'SÍ, QUIERO MI CICLO LISTO'}});
 });
 it('A01/F1: an acceptance that leaves the flow waiting for the agreement fails, whatever the seller said',()=>{
  const said:SuiteEntry={from:'business',purpose:'seller_reply',text:'Ya queda registrado tu acuerdo y te envío ahorita tu material'};
  const d=nextSuiteStep({...base('PURCHASE'),phase:'COLLECTION',steps:4},step([hi,offer,said],'commitment',V,inventory('none')));
  expect(d).toMatchObject({done:'FAILED'});expect('checks' in d&&d.checks.find(c=>c.name==='agreement')).toMatchObject({state:'FAILED'});
 });
 it('A02: a valid wait for time or transport is waited for, boundedly, and a timeout is incomplete, not a collection failure',()=>{
  const waiting=(phase:string)=>nextSuiteStep({...base('PURCHASE'),phase,steps:5},step([hi,offer],'timer',V,inventory('committed')));
  expect(waiting('COLLECTION')).toMatchObject({action:{type:'advance',hours:2},phase:'COLLECTION_WAIT_1'});
  expect(waiting('COLLECTION_WAIT_2')).toMatchObject({action:{type:'advance',hours:2},phase:'COLLECTION_WAIT_3'});
  const timeout=waiting('COLLECTION_WAIT_3');expect(timeout).toMatchObject({done:'PARTIAL'});
  expect('checks' in timeout&&timeout.checks.find(c=>c.name==='collection')).toMatchObject({state:'UNKNOWN'});
  expect(nextSuiteStep({...base('PURCHASE'),phase:'COLLECTION',steps:5},step([hi,offer],'prepayment_delivery_confirmed',V,inventory('committed')))).toMatchObject({action:{type:'advance',hours:2}});
 });
 it('A03: delivery passes only with the complete expected inventory, once each, at the right stage and amount',()=>{
  const at=(inv:SuiteInventory,plan?:{receipt_amount_minor:number})=>nextSuiteStep({...base('PURCHASE'),phase:'DELIVERY',steps:9,...(plan?{plan}:{})},step([hi,offer,pay,{from:'customer',kind:'receipt',status:'APPROVED',receipt_id:R}],null,V,inv));
  const detail=(d:ReturnType<typeof at>)=>'checks' in d?d.checks.find(c=>c.name==='delivery'):undefined;
  expect(at(inventory('approved'))).toMatchObject({action:{type:'advance',hours:24}});
  // One material of several (the installed rule accepted this).
  const partial=at(inventory('approved',{expected:{commitment:[M1,M2],receipt:[CAL,EXTRA]}}));expect(partial).toMatchObject({done:'FAILED'});expect(detail(partial)?.detail).toContain('Faltan 1 de 2');
  const duplicated=at(inventory('approved',{delivered:[...inventory('approved').delivered,{asset_id:CAL,stage:'receipt',effects:2,confirmed:2}]}));expect(duplicated).toMatchObject({done:'FAILED'});expect(detail(duplicated)?.detail).toContain('duplicados');
  expect(detail(at(inventory('approved',{delivered:[]})))).toMatchObject({state:'FAILED'});
  // Without an inventory nothing is credited by a text that says «entregado».
  expect(detail(nextSuiteStep({...base('PURCHASE'),phase:'DELIVERY',steps:9},step([{from:'business',material:'Acceso',explanation:'Entrega de la variante'}],null)))).toMatchObject({state:'UNKNOWN'});
  // 107 must be approved as 107: an approval of 97 is a failure, not a silent downgrade.
  expect(detail(at(inventory('approved'),{receipt_amount_minor:10700}))).toMatchObject({state:'FAILED'});
  expect(at(inventory('approved',{approved_amount_minor:10700,expected:{commitment:[M1,M2],receipt:[CAL,EXTRA]},delivered:[...inventory('approved').delivered,{asset_id:EXTRA,stage:'receipt',effects:1,confirmed:1}]}),{receipt_amount_minor:10700})).toMatchObject({action:{type:'advance',hours:24}});
  // The initial bundle: a benefit released before payment approval is a failure.
  const early=nextSuiteStep({...base('PURCHASE'),phase:'COLLECTION',steps:5},step([hi,offer,pay],'receipt_approved',V,inventory('committed',{delivered:[...inventory('committed').delivered,{asset_id:EXTRA,stage:'receipt',effects:1,confirmed:1}]})));
  expect(early).toMatchObject({done:'FAILED'});expect('checks' in early&&early.checks.find(c=>c.name==='initial_delivery')?.detail).toContain('antes de aprobar');
 });
 it('A03: a receipt read with another amount than the one sent fails before approval',()=>{
  const review:SuiteEntry={from:'customer',kind:'receipt',status:'HUMAN_REVIEW',receipt_id:R};
  expect(nextSuiteStep({...base('PURCHASE'),phase:'RECEIPT',steps:7,plan:{receipt_amount_minor:10700}},step([hi,offer,pay,review],null,V,inventory('committed',{extracted_amount_minor:9700})))).toMatchObject({done:'FAILED'});
  expect(nextSuiteStep({...base('PURCHASE'),phase:'RECEIPT',steps:7,plan:{receipt_amount_minor:10700}},step([hi,offer,pay,review],null,V,inventory('committed',{extracted_amount_minor:10700})))).toMatchObject({action:{type:'review_receipt',decision:'APPROVED'}});
 });
 it('SKIPPED never completes a case',()=>{
  expect(finishSuiteCase('FOLLOWUP',[{name:'route',state:'PASSED',detail:''},{name:'offer',state:'PASSED',detail:''},{name:'followup',state:'SKIPPED',detail:''}])).toBe('PARTIAL');
 });
});
