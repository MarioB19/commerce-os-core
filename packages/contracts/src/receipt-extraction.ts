import {z} from 'zod';
import {receiptEvidenceSchema} from './receipt-policy.js';
const nullableText=z.string().max(500).nullable();
/** Documentary output only. Scope, expected fields and decisions never come
 * from a model response. Legacy extractors may omit enriched fields. */
export const receiptDocumentExtractionSchema=z.object({
 is_receipt:z.boolean(),amount_minor:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),
 destination_suffix:nullableText,bank:nullableText,reference:nullableText,status:z.enum(['completed','pending','failed','unknown']),
 confidence:z.number().min(0).max(1),contradictions:z.array(z.string().min(1).max(200)).max(30),
 destination:nullableText.optional(),beneficiary:nullableText.optional(),paid_at:z.string().datetime({offset:true}).nullable().optional(),
 paid_on:z.string().nullable().optional(),concept:nullableText.optional(),
}).strict();
export function receiptDocumentEvidence(raw:unknown,allowSuffix:boolean){
 const v=receiptDocumentExtractionSchema.parse(raw);
 const evidence=receiptEvidenceSchema.parse({isReceipt:v.is_receipt,amountMinor:v.amount_minor,currency:v.currency,
 destination:v.destination??(allowSuffix?v.destination_suffix:null),beneficiary:v.beneficiary??null,paidAt:v.paid_at??null,paidOn:v.paid_on??null,
 reference:v.reference,concept:v.concept??null,status:v.status.toUpperCase(),confidenceBps:Math.floor(v.confidence*10000),contradictions:v.contradictions});
 // Historical projection deliberately excludes full account, holder and text
 // newly extracted for policy023. Those fields are retained only encrypted.
 const legacy={is_receipt:v.is_receipt,amount_minor:v.amount_minor,currency:v.currency,destination_suffix:v.destination_suffix,bank:v.bank,reference:v.reference,status:v.status,confidence:v.confidence,contradictions:v.contradictions};
 return{evidence,legacy,document:v};
}
