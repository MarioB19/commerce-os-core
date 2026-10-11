export interface ReceiptExtraction {is_receipt:boolean;amount_minor:number|null;currency:string|null;destination_suffix:string|null;bank:string|null;reference:string|null;status:'completed'|'pending'|'failed'|'unknown';confidence:number;contradictions:string[]}
export interface ReceiptRuleContext {amount_minor:number;currency:string;destination_suffix?:string;duplicate:boolean;policy:{allow_amount_mismatch?:boolean;allow_pending?:boolean;require_currency?:boolean;require_destination?:boolean;min_amount_minor?:number;auto_approve?:boolean}}
export function parseReceiptExtraction(raw:unknown):ReceiptExtraction {
  const r=raw as ReceiptExtraction;if(!r||typeof r!=='object'||typeof r.is_receipt!=='boolean'||(r.amount_minor!==null&&(!Number.isSafeInteger(r.amount_minor)||r.amount_minor<0))||!['completed','pending','failed','unknown'].includes(r.status)||typeof r.confidence!=='number'||r.confidence<0||r.confidence>1||!Array.isArray(r.contradictions)||r.contradictions.some(x=>typeof x!=='string'))throw new Error('RECEIPT_OUTPUT_INVALID');
  for(const key of ['currency','destination_suffix','bank','reference']as const)if(r[key]!==null&&typeof r[key]!=='string')throw new Error('RECEIPT_OUTPUT_INVALID');
  return r;
}
export function assessReceipt(extraction:ReceiptExtraction,context:ReceiptRuleContext):{decision:'APPROVED'|'REJECTED'|'HUMAN_REVIEW';reasons:string[]} {
  const reasons:string[]=[];if(!extraction.is_receipt)return{decision:'REJECTED',reasons:['NOT_A_RECEIPT']};
  if(context.duplicate)reasons.push('DUPLICATE_EVIDENCE');if(extraction.contradictions.length)reasons.push('CONTRADICTORY_FIELDS');if(extraction.confidence<0.85)reasons.push('LOW_CONFIDENCE');
  if(extraction.amount_minor===null)reasons.push('AMOUNT_MISSING');else{if(extraction.amount_minor<Math.max(1,context.policy.min_amount_minor??1))reasons.push('AMOUNT_BELOW_MINIMUM');if(!context.policy.allow_amount_mismatch&&extraction.amount_minor!==context.amount_minor)reasons.push('AMOUNT_MISMATCH');}
  if(extraction.currency&&extraction.currency!==context.currency)reasons.push('CURRENCY_MISMATCH');if(context.policy.require_currency&&!extraction.currency)reasons.push('CURRENCY_MISSING');
  if(extraction.destination_suffix&&context.destination_suffix&&extraction.destination_suffix!==context.destination_suffix)reasons.push('DESTINATION_MISMATCH');if(context.policy.require_destination&&(!extraction.destination_suffix||!context.destination_suffix))reasons.push('DESTINATION_UNVERIFIED');
  if(extraction.status==='failed')reasons.push('DOCUMENT_REPORTS_FAILURE');if(extraction.status==='unknown'||(extraction.status==='pending'&&!context.policy.allow_pending))reasons.push('DOCUMENT_STATUS_UNVERIFIED');
  if(!context.policy.auto_approve)reasons.push('HUMAN_APPROVAL_REQUIRED');return{decision:reasons.length?'HUMAN_REVIEW':'APPROVED',reasons};
}
