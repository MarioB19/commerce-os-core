import {createHash} from 'node:crypto';
import {z} from 'zod';
import {profileIdSchema} from '../../../contracts/src/profiles.js';

const uuid=z.uuid(),money=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const currency=z.string().regex(/^[A-Z]{3}$/),instant=z.iso.datetime({offset:true});
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const common={conversation_id:uuid,product_id:uuid.nullable().optional()};
const decision=z.object({previous:z.enum(['COMMERCIAL','GENUINE','FALSE','TEST']).optional(),command_id:uuid.optional(),at:instant.optional()});
const offer=z.object({
 base_amount_minor:money.optional(),currency:currency.optional(),
 payment_method:z.enum(['bank_transfer_receipt','payment_link']).optional(),
 positive_payment_unlocks_all:z.boolean().optional(),
 fulfillment:z.array(z.object({asset_id:uuid,release_on:z.enum(['commitment_accepted','receipt_approved','reconciled']),min_amount_minor:money.optional()})).max(1000).optional(),
});
const orderBody=z.object({
 ...common,amount_minor:money,currency,
 commercial_classification:z.enum(['COMMERCIAL','TEST']).optional(),is_test:z.boolean().optional(),
 committed_at:instant.nullable().optional(),offer_snapshot:offer,
 reconciled_amount_minor:money.optional(),reconciled_currency:currency.optional(),reconciled_at:instant.optional(),
 reconciliation_status:z.enum(['UNRECONCILED','RECONCILED']).optional(),
 reconciliation:z.object({command_id:uuid,evidence_asset_id:uuid}).optional(),
 classification_decision:decision.optional(),
});
const receiptBody=z.object({
 ...common,order_id:uuid,status:z.enum(['APPROVED','REJECTED','HUMAN_REVIEW']),
 commercial_classification:z.enum(['COMMERCIAL','GENUINE','FALSE','TEST']).optional(),is_test:z.boolean().optional(),
 duplicate_of:uuid.nullable().optional(),asset_id:uuid.optional(),evidence_sha256:sha.optional(),
 extraction:z.object({amount_minor:money.nullable().optional(),currency:currency.nullable().optional()}).nullable().optional(),
 received_at:instant.optional(),review:z.object({command_id:uuid.optional(),at:instant.optional()}).optional(),
 classification_decision:decision.optional(),
});
const fulfillmentBody=z.object({conversation_id:uuid,order_id:uuid,asset_id:uuid,
 release_on:z.enum(['commitment_accepted','receipt_approved','reconciled']),
 status:z.enum(['PROPOSED','READY','BLOCKED','SENDING','SENT','DELIVERED','READ','FAILED','CANCELLED','UNKNOWN']),
 effect_id:uuid.optional(),grant_effect_id:uuid.optional(),delivered_at:instant.optional(),read_at:instant.optional(),is_test:z.boolean().optional(),
});
const image=z.object({
 workspace_id:profileIdSchema,environment:z.literal('REAL'),record_id:uuid,
 kind:z.enum(['order','receipt','fulfillment']),version:z.number().int().positive().max(10000),
 body:z.record(z.string(),z.unknown()),
}).strict();
const inputSchema=z.object({current:image,versions:z.array(image).min(1).max(10000)}).strict();
type Image=z.infer<typeof image>;
export type MinimalFinancialBody=z.infer<typeof orderBody>|z.infer<typeof receiptBody>|(z.infer<typeof fulfillmentBody>&{commercial_classification?:never});
export const financialMinimizationVersion='v7-financial-minimization-2' as const;
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}

/** Canonical JSON only; never calls toJSON/getters. No source text is returned. */
function canonical(value:unknown):string{
 const seen=new Set<object>();let remaining=16*1024*1024;
 function take(text:string){remaining-=Buffer.byteLength(text,'utf8');need(remaining>=0,'FINANCIAL_MINIMIZATION_INPUT_BOUND');return text;}
 function visit(value:unknown,depth:number):string{
  need(depth<=32,'FINANCIAL_MINIMIZATION_JSON_DEPTH');
  if(value===null)return take('null');
  if(typeof value==='string'||typeof value==='boolean')return take(JSON.stringify(value));
  if(typeof value==='number'){need(Number.isFinite(value),'FINANCIAL_MINIMIZATION_JSON_INVALID');return take(JSON.stringify(value));}
  need(typeof value==='object'&&value!==null&&!seen.has(value),'FINANCIAL_MINIMIZATION_JSON_INVALID');
  need(Array.isArray(value)||Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null,'FINANCIAL_MINIMIZATION_JSON_INVALID');
  seen.add(value);
  try{
   const keys=Object.keys(value),descriptors=Object.getOwnPropertyDescriptors(value);
   need(keys.every(k=>'value' in descriptors[k]),'FINANCIAL_MINIMIZATION_JSON_INVALID');
   if(Array.isArray(value)){
    need(keys.length===value.length&&keys.every((k,i)=>k===String(i)),'FINANCIAL_MINIMIZATION_JSON_INVALID');
    return take('[')+keys.map((k,i)=>(i?take(','):'')+visit(descriptors[k].value,depth+1)).join('')+take(']');
   }
   return take('{')+keys.sort().map((k,i)=>(i?take(','):'')+take(JSON.stringify(k)+':')+visit(descriptors[k].value,depth+1)).join('')+take('}');
  }finally{seen.delete(value);}
 }
 return visit(value,0);
}
function hash(text:string){return createHash('sha256').update(text,'utf8').digest('hex');}
function fingerprint(value:unknown){return hash(canonical(value));}
function sameScope(a:Image,b:Image){return a.record_id===b.record_id&&a.workspace_id===b.workspace_id&&a.environment===b.environment&&a.kind===b.kind;}
function minimizeBody(kind:Image['kind'],raw:Image['body']):MinimalFinancialBody{
 const test=raw.is_test===true||raw.commercial_classification==='TEST'||['simulation_id','number_flow_test_id','launch_test_scope_id','launch_test_id'].some(k=>Object.hasOwn(raw,k));
 if(kind==='fulfillment')return fulfillmentBody.parse(raw);
 const body=kind==='order'?orderBody.parse(raw):receiptBody.parse(raw);
 if(test){body.is_test=true;if(body.commercial_classification!=='FALSE')body.commercial_classification='TEST';}
 return body;
}

/** Prepared projection, NOT authorization to erase. The caller must authenticate
 * the complete input under DB locks and bind source_manifest_sha256 to its job.
 * Hashes are local canonical JSON, not PostgreSQL jsonb::text hashes or signatures.
 * No clock/expiry is accepted or generated, so this cannot renew financial life. */
export function minimizeFinancialHistory(input:unknown){
 // Validate/canonicalize before Zod can access a getter on an arbitrary object.
 const serialized=canonical(input);
 const v=inputSchema.parse(JSON.parse(serialized));
 need(v.versions.length===v.current.version,'FINANCIAL_MINIMIZATION_HISTORY_INCOMPLETE');
 const versions=[...v.versions].sort((a,b)=>a.version-b.version);
 for(let i=0;i<versions.length;i++){
  need(sameScope(v.current,versions[i]),'FINANCIAL_MINIMIZATION_SCOPE_MISMATCH');
  need(versions[i].version===i+1,'FINANCIAL_MINIMIZATION_HISTORY_INCOMPLETE');
 }
 need(fingerprint(versions.at(-1)!.body)===fingerprint(v.current.body),'FINANCIAL_MINIMIZATION_CURRENT_MISMATCH');
 const projected=versions.map(row=>({...row,body:minimizeBody(row.kind,row.body)}));
 for(const row of projected){
  need(row.body.conversation_id===v.current.body.conversation_id,'FINANCIAL_MINIMIZATION_RELATION_CHANGED');
  if(row.kind==='receipt'||row.kind==='fulfillment')need((row.body as z.infer<typeof receiptBody>).order_id===v.current.body.order_id,'FINANCIAL_MINIMIZATION_RELATION_CHANGED');
 }
 const sources=versions.map(row=>({version:row.version,sha256:fingerprint(row.body)}));
 const projections=projected.map(row=>({version:row.version,sha256:fingerprint(row.body)}));
 const scope={workspace_id:v.current.workspace_id,environment:v.current.environment,record_id:v.current.record_id,kind:v.current.kind,version:v.current.version};
 return {
  schema_version:1 as const,policy:financialMinimizationVersion,state:'PREPARED_NOT_ERASURE_AUTHORITY' as const,
  ...scope,current:projected.at(-1)!,versions:projected,
  source_manifest_sha256:fingerprint({...scope,versions:sources}),
  minimized_manifest_sha256:fingerprint({...scope,versions:projections}),
  manifest:sources.map((source,i)=>({version:source.version,source_sha256:source.sha256,minimized_sha256:projections[i].sha256})),
 };
}
