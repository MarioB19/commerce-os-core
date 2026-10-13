import type {DomainRecord} from '@commerce/contracts';
import {encrypt} from '@commerce/db';
import {evaluateReceiptPolicy,receiptPolicyHash} from '../../../packages/domain/src/sales/receipt-policy.js';
import {receiptDocumentEvidence} from '../../../packages/contracts/src/receipt-extraction.js';
import {resolvedReceiptPolicySchema} from '../../../packages/contracts/src/receipt-policy.js';
import {marketRecordVersionHash} from '../../../packages/db/src/market-variants.js';
import type {MarketRelease} from '../../../packages/contracts/src/market-variants.js';

/** V7 RF-19.d: the documentary assessment of an example receipt in «Probar
 * número». Same evaluator (evaluateReceiptPolicy) and evidence parser as the
 * production policy path, over the variant's receipt policy captured when the
 * test started (RF-19.b/m), as a customer's receipt (COMMERCIAL), never as a
 * TEST conversation, so the person sees what would happen with a real sale.
 *
 * A test never uses the business's real account (the chat shows LAB_ONLY
 * payment details). The destination and holder checks are therefore evaluated
 * twice: strictly (unverified, as a test cannot know) and assuming they match
 * the account. The laboratory applies the second one and records both, with
 * the assumption named, so the result is never presented as a bank check. */
export const LAB_RECEIPT_ASSUMPTIONS=['DESTINATION','BENEFICIARY'] as const;
export function prepareLabReceiptAssessment(input:{policy:unknown;receipt:DomainRecord;asset:DomainRecord;order:DomainRecord;release:MarketRelease;observedAt:string;duplicate:boolean;document:unknown;cause:string;expected?:{reference?:unknown;concept?:unknown}}){
 const text=(v:unknown)=>typeof v==='string'&&v.trim()?v:null;
 const policy=resolvedReceiptPolicySchema.parse(input.policy),r=input.receipt;
 const {document,evidence,legacy}=receiptDocumentEvidence(input.document,policy.policy.destination.mode==='SUFFIX');
 const context=(destination:string|null,beneficiary:string|null)=>({scope:policy.scope,variantId:policy.variantId,
  receipt:{id:r.id,revision:r.version,sha256:marketRecordVersionHash({record_id:r.id,workspace_id:r.workspace_id,environment:r.environment,kind:r.kind,version:r.version,body:r.body})},
  evidenceSha256:String(input.asset.body.sha256),collection:input.release.configuration.collection,amountMinor:Number(input.order.body.amount_minor),
  currency:input.release.locale.currency,timezone:input.release.locale.timezone,observedAt:input.observedAt,
  expectedDestination:destination,expectedBeneficiary:beneficiary,expectedReference:text(input.expected?.reference),expectedConcept:text(input.expected?.concept),duplicate:input.duplicate,classification:'COMMERCIAL' as const});
 const strict=evaluateReceiptPolicy(policy,context(null,null),evidence);
 const assumed=evaluateReceiptPolicy(policy,context(evidence.destination,evidence.beneficiary),evidence);
 return{state:'PREPARED' as const,assessment:assumed,extraction:legacy,evidenceCiphertext:encrypt(document),observedAt:input.observedAt,
  policyAnalysis:{cause:input.cause,document_sha256:receiptPolicyHash(document),policy_sha256:policy.sha256},
  laboratory:{assumed:[...LAB_RECEIPT_ASSUMPTIONS],decision:assumed.decision,reasons:assumed.reasons,strict_decision:strict.decision,strict_reasons:strict.reasons}};
}
