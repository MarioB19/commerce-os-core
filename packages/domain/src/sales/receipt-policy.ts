import {createHash} from 'node:crypto';
import {z} from 'zod';
import {marketScopeSchema} from '../../../contracts/src/market-variants.js';
import {receiptPolicySchema,receiptPolicyVersionSchema,receiptPolicyOverrideVersionSchema,receiptEvidenceSchema,receiptPolicyContextSchema,resolvedReceiptPolicySchema,type ReceiptPolicy} from '../../../contracts/src/receipt-policy.js';

function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
export function receiptPolicyCanonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(receiptPolicyCanonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+receiptPolicyCanonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export const receiptPolicyHash=(value:unknown)=>createHash('sha256').update(receiptPolicyCanonical(value)).digest('hex');
export function defaultReceiptPolicy():ReceiptPolicy{return{automaticApproval:false,failureDisposition:'REVIEW',minimumConfidenceBps:8500,
 amount:{mode:'EXACT'},destination:{mode:'EXACT'},beneficiary:{required:true},date:{required:true,maximumAgeDays:7,maximumFutureDays:0},reference:{required:true,match:'PRESENT'},concept:{required:false,match:'PRESENT'}};}
const resolvedSchema=resolvedReceiptPolicySchema;
/** Repositories authenticate versions; this function only resolves their scope
 * and immutable identity. No HTTP-supplied policy can become authority here. */
export function resolveReceiptPolicy(raw:unknown){
 const r=z.object({scope:marketScopeSchema,variantId:z.string().uuid().toLowerCase(),profile:receiptPolicyVersionSchema,variant:receiptPolicyOverrideVersionSchema.nullable()}).strict().parse(raw);
 need(receiptPolicyCanonical(r.scope)===receiptPolicyCanonical(r.profile.scope)&&(!r.variant||(receiptPolicyCanonical(r.scope)===receiptPolicyCanonical(r.variant.scope)&&r.variant.variantId===r.variantId)),'RECEIPT_POLICY_SCOPE');
 need(receiptPolicyHash(r.profile.policy)===r.profile.ref.sha256&&(!r.variant||receiptPolicyHash(r.variant.override)===r.variant.ref.sha256),'RECEIPT_POLICY_VERSION_CHANGED');
 const policy=receiptPolicySchema.parse({...r.profile.policy,...r.variant?.override});
 const body={schemaVersion:1 as const,scope:r.scope,variantId:r.variantId,profile:r.profile.ref,variant:r.variant?.ref??null,policy};
 return resolvedSchema.parse({...body,sha256:receiptPolicyHash(body)});
}
export type ResolvedReceiptPolicy=ReturnType<typeof resolveReceiptPolicy>;
export type ReceiptRule='DOCUMENT'|'DUPLICATE'|'CONFIDENCE'|'CONTRADICTIONS'|'AMOUNT'|'CURRENCY'|'DESTINATION'|'BENEFICIARY'|'DATE'|'REFERENCE'|'CONCEPT'|'DOCUMENT_STATUS'|'HUMAN_APPROVAL';
export interface ReceiptRuleCheck {rule:ReceiptRule;state:'PASSED'|'FAILED'|'UNKNOWN'|'SKIPPED';code:string}
const normalized=(v:string|null)=>v?.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleUpperCase('en-US')??'';
const digits=(v:string|null)=>{if(v===null||!/^[0-9 -]+$/.test(v))return'';return v.replace(/[ -]/g,'');};
function civilDay(instant:string,timezone:string){const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(instant));return ['year','month','day'].map(k=>parts.find(p=>p.type===k)!.value).join('-');}
const ordinal=(day:string)=>Date.parse(day+'T00:00:00Z')/86400000;

/** Documentary assessment only. No bank reconciliation, durable decision,
 * contribution or external effect is performed by this pure function. */
export function evaluateReceiptPolicy(rawPolicy:unknown,rawContext:unknown,rawEvidence:unknown){
 const resolved=resolvedSchema.parse(rawPolicy),context=receiptPolicyContextSchema.parse(rawContext),e=receiptEvidenceSchema.parse(rawEvidence),p=resolved.policy;
 const {sha256,...body}=resolved;need(receiptPolicyHash(body)===sha256,'RECEIPT_POLICY_CHANGED');
 need(receiptPolicyCanonical(resolved.scope)===receiptPolicyCanonical(context.scope)&&resolved.variantId===context.variantId,'RECEIPT_POLICY_SCOPE');
 const checks:ReceiptRuleCheck[]=[];
 const check=(rule:ReceiptRule,state:ReceiptRuleCheck['state'],code:string)=>checks.push({rule,state,code});
 check('DOCUMENT',e.isReceipt?'PASSED':'FAILED',e.isReceipt?'DOCUMENT_PRESENT':'NOT_A_RECEIPT');
 check('DUPLICATE',context.duplicate?'UNKNOWN':'PASSED',context.duplicate?'DUPLICATE_EVIDENCE':'NO_DUPLICATE_OBSERVED');
 check('CONFIDENCE',e.confidenceBps>=p.minimumConfidenceBps?'PASSED':'UNKNOWN',e.confidenceBps>=p.minimumConfidenceBps?'CONFIDENCE_SUFFICIENT':'LOW_CONFIDENCE');
 check('CONTRADICTIONS',e.contradictions.length?'UNKNOWN':'PASSED',e.contradictions.length?'CONTRADICTORY_FIELDS':'FIELDS_CONSISTENT');
 if(e.amountMinor===null)check('AMOUNT','UNKNOWN','AMOUNT_MISSING');
 else{const amount=BigInt(e.amountMinor),expected=BigInt(context.amountMinor),delta=amount>=expected?amount-expected:expected-amount;
  const ok=amount>0n&&(p.amount.mode==='EXACT'?amount===expected:p.amount.mode==='MINIMUM'?amount>=expected:delta<=BigInt(p.amount.toleranceMinor));check('AMOUNT',ok?'PASSED':'FAILED',ok?'AMOUNT_MATCH':'AMOUNT_MISMATCH');}
 check('CURRENCY',e.currency===null?'UNKNOWN':e.currency===context.currency?'PASSED':'FAILED',e.currency===null?'CURRENCY_MISSING':e.currency===context.currency?'CURRENCY_MATCH':'CURRENCY_MISMATCH');
 if(p.destination.mode==='DISABLED')check('DESTINATION','SKIPPED','DESTINATION_DISABLED');
 else{const actual=digits(e.destination),expected=digits(context.expectedDestination),minimum=p.destination.mode==='SUFFIX'?p.destination.digits:4;
  if(actual.length<minimum||expected.length<minimum)check('DESTINATION','UNKNOWN','DESTINATION_UNVERIFIED');
  else{const ok=p.destination.mode==='EXACT'?actual===expected:actual.slice(-minimum)===expected.slice(-minimum);check('DESTINATION',ok?'PASSED':'FAILED',ok?'DESTINATION_MATCH':'DESTINATION_MISMATCH');}}
 const matching=(rule:'BENEFICIARY'|'REFERENCE'|'CONCEPT',required:boolean,mode:'PRESENT'|'EXACT'|'CONTAINS',value:string|null,expectedValue:string|null)=>{
  const actual=normalized(value),expected=normalized(expectedValue);
  if(!required&&!actual){check(rule,'SKIPPED',rule+'_OPTIONAL_ABSENT');return;}
  if(!actual||(mode!=='PRESENT'&&!expected)){check(rule,'UNKNOWN',rule+'_UNVERIFIED');return;}
  const ok=mode==='PRESENT'||(mode==='EXACT'?actual===expected:actual.includes(expected));check(rule,ok?'PASSED':'FAILED',rule+(ok?'_MATCH':'_MISMATCH'));
 };
 matching('BENEFICIARY',p.beneficiary.required,'EXACT',e.beneficiary,context.expectedBeneficiary);
 if(!e.paidAt&&!e.paidOn)check('DATE',p.date.required?'UNKNOWN':'SKIPPED',p.date.required?'DATE_MISSING':'DATE_OPTIONAL_ABSENT');
 else{const age=ordinal(civilDay(context.observedAt,context.timezone))-ordinal(e.paidOn??civilDay(e.paidAt!,context.timezone));const ok=age>=-p.date.maximumFutureDays&&age<=p.date.maximumAgeDays;check('DATE',ok?'PASSED':'FAILED',ok?'DATE_IN_WINDOW':'DATE_OUTSIDE_WINDOW');}
 matching('REFERENCE',p.reference.required,p.reference.match,e.reference,context.expectedReference);
 matching('CONCEPT',p.concept.required,p.concept.match,e.concept,context.expectedConcept);
 check('DOCUMENT_STATUS',e.status==='COMPLETED'?'PASSED':e.status==='FAILED'?'FAILED':'UNKNOWN',e.status==='COMPLETED'?'DOCUMENT_COMPLETED':e.status==='FAILED'?'DOCUMENT_REPORTS_FAILURE':'DOCUMENT_STATUS_UNVERIFIED');
 check('HUMAN_APPROVAL',p.automaticApproval?'SKIPPED':'UNKNOWN',p.automaticApproval?'AUTOMATIC_POLICY':'HUMAN_APPROVAL_REQUIRED');
 const failed=checks.some(c=>c.state==='FAILED'),uncertain=checks.some(c=>c.state==='UNKNOWN'&&c.rule!=='HUMAN_APPROVAL');
 const decision=context.classification==='FALSE'?'FALSE':context.classification==='TEST'?'TEST':!e.isReceipt?'REJECTED':uncertain?'REVIEW':failed?(p.failureDisposition==='REJECT'?'REJECTED':'REVIEW'):p.automaticApproval?'APPROVED':'REVIEW';
 return{schemaVersion:1 as const,decision,policySha256:sha256,profilePolicy:resolved.profile,variantPolicy:resolved.variant,
  receipt:context.receipt,evidenceSha256:context.evidenceSha256,collection:context.collection,observedAt:context.observedAt,
  checks,reasons:checks.filter(c=>c.state==='FAILED'||c.state==='UNKNOWN').map(c=>c.code),bankReconciled:false as const,effectsAuthorized:false as const};
}
