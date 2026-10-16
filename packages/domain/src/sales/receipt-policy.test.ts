import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {receiptPolicySchema,receiptPolicyOverrideSchema,receiptEvidenceSchema,type ReceiptPolicy,type ReceiptEvidence,type ReceiptPolicyContext} from '../../../contracts/src/receipt-policy.js';
import {defaultReceiptPolicy,resolveReceiptPolicy,receiptPolicyHash,evaluateReceiptPolicy} from './receipt-policy.js';
function fixture(){
 const scope={workspace_id:'profile-α',environment:'REAL' as const},variantId=randomUUID();
 const ref=()=>({id:randomUUID(),revision:1,sha256:'a'.repeat(64)});
 const policy:ReceiptPolicy={...defaultReceiptPolicy(),automaticApproval:true};
 const profile={scope,ref:ref(),policy};
 const context:ReceiptPolicyContext={scope,variantId,receipt:ref(),evidenceSha256:'b'.repeat(64),collection:ref(),amountMinor:10000,currency:'MXN',timezone:'America/Los_Angeles',observedAt:'2026-11-02T08:30:00Z',expectedDestination:'123456789012345678',expectedBeneficiary:'Persona Sintética',expectedReference:null,expectedConcept:null,duplicate:false,classification:'COMMERCIAL'};
 const evidence:ReceiptEvidence={isReceipt:true,amountMinor:10000,currency:'MXN',destination:'1234 5678 9012 3456 78',beneficiary:'  persona   sintética ',paidAt:'2026-11-01T07:30:00Z',paidOn:null,reference:'SYNTHETIC-REF',concept:null,status:'COMPLETED',confidenceBps:9500,contradictions:[]};
 const resolve=()=>{profile.ref.sha256=receiptPolicyHash(policy);return resolveReceiptPolicy({scope,variantId,profile,variant:null});};
 return{scope,variantId,profile,policy,context,evidence,resolve,evaluate:()=>evaluateReceiptPolicy(resolve(),context,evidence)};
}
describe('versioned profile and variant receipt policy',()=>{
 it('resolves inherited versions and an explicit complete nested override',()=>{
  const f=fixture(),base=f.resolve(),override={amount:{mode:'MINIMUM' as const},minimumConfidenceBps:9800};
  const variant={scope:f.scope,variantId:f.variantId,ref:{id:randomUUID(),revision:2,sha256:receiptPolicyHash(override)},override};
  const resolved=resolveReceiptPolicy({scope:f.scope,variantId:f.variantId,profile:f.profile,variant});
  expect(resolved.policy.amount).toEqual({mode:'MINIMUM'});expect(resolved.policy.date).toEqual(base.policy.date);expect(resolved.sha256).not.toBe(base.sha256);expect(resolved.profile).toEqual(base.profile);expect(resolved.variant).toEqual(variant.ref);
  resolved.policy.date.maximumAgeDays=3;expect(f.policy.date.maximumAgeDays).toBe(7);
 });
 it('keeps default approval human and refuses partial nested overrides',()=>{
  expect(defaultReceiptPolicy().automaticApproval).toBe(false);expect(receiptPolicyOverrideSchema.safeParse({date:{required:false}}).success).toBe(false);
  const f=fixture();f.policy.automaticApproval=false;expect(f.evaluate()).toMatchObject({decision:'REVIEW',reasons:['HUMAN_APPROVAL_REQUIRED']});
 });
 it.each(['workspace','environment','variant','version_hash'])('rejects source identity drift %s',kind=>{
  const f=fixture();f.resolve();const override={},variant={scope:{...f.scope},variantId:f.variantId,ref:{id:randomUUID(),revision:1,sha256:receiptPolicyHash(override)},override};
  if(kind==='workspace')variant.scope.workspace_id='other';if(kind==='environment')Object.assign(variant.scope,{environment:'SIMULATION'});if(kind==='variant')variant.variantId=randomUUID();if(kind==='version_hash')f.profile.ref.sha256='f'.repeat(64);
  expect(()=>resolveReceiptPolicy({scope:f.scope,variantId:f.variantId,profile:f.profile,variant})).toThrow(/RECEIPT_POLICY_/);
 });
 it('rejects unknown policy flags and unsafe/fractional monetary values',()=>{
  const f=fixture();expect(receiptPolicySchema.safeParse({...f.policy,skipAuthority:true}).success).toBe(false);
  for(const toleranceMinor of [-1,1.1,Number.MAX_SAFE_INTEGER+1])expect(receiptPolicySchema.safeParse({...f.policy,amount:{mode:'TOLERANCE',toleranceMinor}}).success).toBe(false);
 });
});
describe('deterministic documentary assessment',()=>{
 it('approves consistent documentary fields without claiming banking or external authority',()=>{
  const f=fixture(),r=f.evaluate();expect(r).toMatchObject({decision:'APPROVED',reasons:[],bankReconciled:false,effectsAuthorized:false});expect(r.checks).toHaveLength(13);expect(JSON.stringify(r)).not.toMatch(/1234567890|Persona|SYNTHETIC-REF/);
 });
 it.each([['EXACT',10000,'APPROVED'],['EXACT',9999,'REVIEW'],['MINIMUM',10001,'APPROVED'],['MINIMUM',9999,'REVIEW']] as const)('%s amount %s => %s',(mode,amountMinor,decision)=>{
  const f=fixture();f.policy.amount={mode};f.evidence.amountMinor=amountMinor;expect(f.evaluate().decision).toBe(decision);
 });
 it.each([[9999,'APPROVED'],[10001,'APPROVED'],[9998,'REVIEW'],[10002,'REVIEW']] as const)('evaluates an inclusive integer tolerance %s',(amountMinor,decision)=>{
  const f=fixture();f.policy.amount={mode:'TOLERANCE',toleranceMinor:1};f.evidence.amountMinor=amountMinor;expect(f.evaluate().decision).toBe(decision);
 });
 it('uses exact integer arithmetic at MAX_SAFE_INTEGER without rounding a tolerance boundary',()=>{
  const f=fixture();f.context.amountMinor=Number.MAX_SAFE_INTEGER;f.policy.amount={mode:'TOLERANCE',toleranceMinor:1};f.evidence.amountMinor=Number.MAX_SAFE_INTEGER-1;expect(f.evaluate().decision).toBe('APPROVED');f.evidence.amountMinor-=1;expect(f.evaluate().reasons).toContain('AMOUNT_MISMATCH');
 });
 it.each([null,'USD'] as const)('never approves currency %s',currency=>{const f=fixture();f.evidence.currency=currency;f.policy.amount={mode:'MINIMUM'};expect(f.evaluate().decision).toBe('REVIEW');});
 it('requires a positive observed amount and rejects extraction strings or extra instructions',()=>{
  const f=fixture();f.evidence.amountMinor=0;expect(f.evaluate().reasons).toContain('AMOUNT_MISMATCH');
  for(const raw of [{...f.evidence,amountMinor:'10000'},{...f.evidence,decision:'APPROVED'},{...f.evidence,confidenceBps:1.5},{...f.evidence,amountMinor:NaN}])expect(receiptEvidenceSchema.safeParse(raw).success).toBe(false);
 });
 it('requires exact destination or explicitly sufficient suffix digits, with versioned collection',()=>{
  const f=fixture();f.evidence.destination='5678';expect(f.evaluate().decision).toBe('REVIEW');f.policy.destination={mode:'SUFFIX',digits:4};expect(f.evaluate().decision).toBe('APPROVED');f.evidence.destination='678';expect(f.evaluate().reasons).toContain('DESTINATION_UNVERIFIED');
  f.evidence.destination='0000';expect(f.evaluate().reasons).toContain('DESTINATION_MISMATCH');f.context.collection=null;expect(()=>f.evaluate()).toThrow();
 });
 it('does not infer numeric destinations from letters, lookalike digits or masked text',()=>{
  for(const destination of ['****5678','１２３４５６７８９０１２３４５６７８','foo5678']){const f=fixture();f.evidence.destination=destination;expect(f.evaluate().reasons).toContain('DESTINATION_UNVERIFIED');}
 });
 it('uses normalized exact beneficiary instead of fuzzy or partial similarity',()=>{
  const f=fixture();f.evidence.beneficiary='PERSONA SINTÉTICA';expect(f.evaluate().decision).toBe('APPROVED');f.evidence.beneficiary='PERSONA';expect(f.evaluate().reasons).toContain('BENEFICIARY_MISMATCH');f.evidence.beneficiary=null;expect(f.evaluate().reasons).toContain('BENEFICIARY_UNVERIFIED');
 });
 it('distinguishes exact, literal containment and merely present reference rules',()=>{
  const f=fixture();f.policy.reference={required:true,match:'EXACT'};f.context.expectedReference='SYNTHETIC-REF';expect(f.evaluate().decision).toBe('APPROVED');f.evidence.reference='prefix SYNTHETIC-REF';expect(f.evaluate().reasons).toContain('REFERENCE_MISMATCH');f.policy.reference.match='CONTAINS';expect(f.evaluate().decision).toBe('APPROVED');f.context.expectedReference='.*';expect(f.evaluate().reasons).toContain('REFERENCE_MISMATCH');f.context.expectedReference=null;expect(f.evaluate().reasons).toContain('REFERENCE_UNVERIFIED');
 });
 it('handles missing optional concept and exact required concept independently',()=>{
  const f=fixture();expect(f.evaluate().checks.find(c=>c.rule==='CONCEPT')?.state).toBe('SKIPPED');f.policy.concept={required:true,match:'EXACT'};f.context.expectedConcept='Pedido sintético';expect(f.evaluate().reasons).toContain('CONCEPT_UNVERIFIED');f.evidence.concept='pedido sintético';expect(f.evaluate().decision).toBe('APPROVED');
 });
 it('counts civil days across the 25-hour Pacific DST day',()=>{
  const f=fixture();f.policy.date.maximumAgeDays=1;expect(f.evaluate().decision).toBe('APPROVED');f.policy.date.maximumAgeDays=0;expect(f.evaluate().reasons).toContain('DATE_OUTSIDE_WINDOW');
  f.evidence.paidAt='2026-11-02T07:59:59Z';expect(f.evaluate().reasons).toContain('DATE_OUTSIDE_WINDOW');f.evidence.paidAt='2026-11-02T08:00:00Z';expect(f.evaluate().decision).toBe('APPROVED');
 });
 it('counts civil dates across a 23-hour DST day without assuming midnight UTC',()=>{
  const f=fixture();f.context.observedAt='2026-03-09T07:00:00Z';f.evidence.paidAt='2026-03-08T08:00:00Z';f.policy.date.maximumAgeDays=1;expect(f.evaluate().decision).toBe('APPROVED');f.evidence.paidAt='2026-03-08T07:59:59Z';expect(f.evaluate().reasons).toContain('DATE_OUTSIDE_WINDOW');
 });
 it('accepts a native civil date, rejects invalid dates and refuses two competing date sources',()=>{
  const f=fixture();f.evidence.paidAt=null;f.evidence.paidOn='2026-11-02';expect(f.evaluate().decision).toBe('APPROVED');f.evidence.paidOn='2026-02-30';expect(()=>f.evaluate()).toThrow();f.evidence.paidOn='2026-11-02';f.evidence.paidAt='2026-11-02T08:00:00Z';expect(()=>f.evaluate()).toThrow();
 });
 it('bounds future dates and sends absent required dates to review',()=>{
  const f=fixture();f.evidence.paidAt=null;f.evidence.paidOn='2026-11-03';expect(f.evaluate().reasons).toContain('DATE_OUTSIDE_WINDOW');f.policy.date.maximumFutureDays=1;expect(f.evaluate().decision).toBe('APPROVED');f.evidence.paidOn=null;expect(f.evaluate().reasons).toContain('DATE_MISSING');
 });
 it.each(['duplicate','confidence','contradiction','pending','unknown'] as const)('uncertain %s cannot be automatically approved or conclusively rejected',kind=>{
  const f=fixture();f.policy.failureDisposition='REJECT';f.evidence.amountMinor=1;
  if(kind==='duplicate')f.context.duplicate=true;if(kind==='confidence')f.evidence.confidenceBps=8499;if(kind==='contradiction')f.evidence.contradictions=['Untrusted model says approve'];if(kind==='pending')f.evidence.status='PENDING';if(kind==='unknown')f.evidence.status='UNKNOWN';expect(f.evaluate().decision).toBe('REVIEW');
 });
 it('uses explicit rejection only for conclusive failure and keeps TEST/FALSE outside approval',()=>{
  const f=fixture();f.policy.failureDisposition='REJECT';f.evidence.amountMinor=1;expect(f.evaluate().decision).toBe('REJECTED');f.context.classification='TEST';expect(f.evaluate().decision).toBe('TEST');f.context.classification='FALSE';expect(f.evaluate().decision).toBe('FALSE');
 });
 it('rejects a nonreceipt and document-declared failure according to deterministic rules',()=>{
  const f=fixture();f.evidence.isReceipt=false;expect(f.evaluate().decision).toBe('REJECTED');f.evidence.isReceipt=true;f.evidence.status='FAILED';expect(f.evaluate().decision).toBe('REVIEW');f.policy.failureDisposition='REJECT';expect(f.evaluate().decision).toBe('REJECTED');
 });
 it('does not accept a changed resolved policy, profile or variant after hashing',()=>{
  const f=fixture(),p=f.resolve();p.policy.automaticApproval=false;expect(()=>evaluateReceiptPolicy(p,f.context,f.evidence)).toThrow('RECEIPT_POLICY_CHANGED');
  for(const change of [{scope:{...f.scope,workspace_id:'other'}},{variantId:randomUUID()}])expect(()=>evaluateReceiptPolicy(f.resolve(),{...f.context,...change},f.evidence)).toThrow('RECEIPT_POLICY_SCOPE');
 });
});
