import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {decrypt} from './index.js';
import type {ProfileExecutor} from './profile-context.js';

/** V7 F5 (RF-09.g/h/l, RF-17.g, RF-04.b): the receipt queue a person works
 * from. Pending receipts first (oldest first), each with one readable result
 * of five, the rule that decided it and the money expected and observed. A
 * decision is one command to the same worker path as before (one receipt, one
 * recognized payment at most). Full accounts, holders and phones never leave. */
type Environment='REAL'|'SIMULATION';
export class ReceiptQueueError extends Error{constructor(readonly code:string,readonly statusCode=409){super(code);}}
function need(v:unknown,code:string,status=409):asserts v{if(!v)throw new ReceiptQueueError(code,status);}

export const receiptResults=['REVIEW','APPROVED','REJECTED','TEST','FALSE'] as const;
export type ReceiptResult=typeof receiptResults[number];
export const receiptResultLabels:Record<ReceiptResult,string>={REVIEW:'Por revisar',APPROVED:'Aprobado',REJECTED:'Rechazado',TEST:'Prueba',FALSE:'Falso'};
const ruleLabels:Record<string,string>={DOCUMENT:'Es un comprobante',DUPLICATE:'No está repetido',CONFIDENCE:'Lectura confiable',CONTRADICTIONS:'Datos consistentes',
 AMOUNT:'Monto',CURRENCY:'Moneda',DESTINATION:'Cuenta destino',BENEFICIARY:'Beneficiario',DATE:'Fecha',REFERENCE:'Referencia',CONCEPT:'Concepto',
 DOCUMENT_STATUS:'Pago completado',HUMAN_APPROVAL:'Aprobación'};
const codeLabels:Record<string,string>={
 NOT_A_RECEIPT:'La imagen no parece un comprobante',DUPLICATE_EVIDENCE:'Este comprobante ya se recibió en otra venta',LOW_CONFIDENCE:'La lectura no es confiable',
 CONTRADICTORY_FIELDS:'El comprobante tiene datos contradictorios',AMOUNT_MISSING:'No se pudo leer el monto',AMOUNT_MISMATCH:'El monto no coincide con el precio',
 CURRENCY_MISSING:'No se pudo leer la moneda',CURRENCY_MISMATCH:'La moneda no coincide',DESTINATION_UNVERIFIED:'No se pudo confirmar la cuenta destino',
 DESTINATION_MISMATCH:'La cuenta destino no es la configurada',BENEFICIARY_UNVERIFIED:'No se pudo confirmar el beneficiario',BENEFICIARY_MISMATCH:'El beneficiario no coincide',
 DATE_MISSING:'No se pudo leer la fecha',DATE_OUTSIDE_WINDOW:'La fecha está fuera del periodo permitido',REFERENCE_UNVERIFIED:'Falta la referencia',REFERENCE_MISMATCH:'La referencia no coincide',
 CONCEPT_UNVERIFIED:'Falta el concepto',CONCEPT_MISMATCH:'El concepto no coincide',DOCUMENT_REPORTS_FAILURE:'El comprobante indica un pago fallido',
 DOCUMENT_STATUS_UNVERIFIED:'No se pudo confirmar que el pago se completó',HUMAN_APPROVAL_REQUIRED:'Tus reglas piden que una persona lo apruebe',
 RECEIPT_AI_GRANT_REQUIRED:'La lectura con IA no está autorizada para esta variante',RECEIPT_AI_019_REQUIRED:'La lectura con IA no está disponible',
 CONTROLS_CHANGED:'La conversación está pausada o en atención manual'};
const stateLabels:Record<string,string>={PASSED:'Cumple',FAILED:'No cumple',UNKNOWN:'Por confirmar',SKIPPED:'No aplica'};
export const receiptReasonLabel=(code:string|null|undefined)=>code?codeLabels[code]??'Revisa el comprobante':null;

/** Same five-way result as the payments register (one source of truth). */
const resultSql=`CASE WHEN r.body->>'commercial_classification'='FALSE' THEN 'FALSE'
  WHEN r.body->>'commercial_classification'='TEST' OR o.body->>'commercial_classification'='TEST' OR c.body->>'commercial_classification'='TEST'
    OR c.body->>'is_test'='true' OR c.body ? 'number_flow_test_id' OR c.body ? 'launch_test_id' THEN 'TEST'
  WHEN r.body->>'status'='REJECTED' THEN 'REJECTED'
  WHEN r.body->>'status'='APPROVED' AND r.body->>'duplicate_of' IS NULL THEN 'APPROVED' ELSE 'REVIEW' END`;
const rowsSql=`SELECT r.id,r.version,r.created_at,r.body rb,o.id order_id,o.body ob,c.id conversation_id,
 ${resultSql} AS result,
 left(family.body->>'name',200) product,left(v.document->>'name',120) variant,left(s.body->'release'->'locale'->>'market',120) market,
 left(account.body->>'name',120) number_name,CASE WHEN account.body->>'masked_number' ~ '^•••• ?[0-9]{4}$' THEN '••••'||right(account.body->>'masked_number',4) END number_masked,
 CASE WHEN contact.body->>'identity' ~ '^\\+?[0-9]{7,16}(@c\\.us|@s\\.whatsapp\\.net)?$' THEN '••••'||right(regexp_replace(split_part(contact.body->>'identity','@',1),'[^0-9]','','g'),4) END contact_masked,
 asset.body->>'mime_type' mime_type,asset.body->>'status'='READY' AND asset.body ? 'storage_key' AS has_document,
 EXISTS(SELECT 1 FROM commands k WHERE k.workspace_id=r.workspace_id AND k.environment=r.environment AND k.kind='receipt_review' AND k.resource_id=r.id::text AND k.status='PENDING') AS decision_pending,
 p.body->'policy'->>'automaticApproval' automatic
 FROM records r
 LEFT JOIN records o ON o.id::text=r.body->>'order_id' AND o.workspace_id=r.workspace_id AND o.environment=r.environment AND o.kind='order'
 LEFT JOIN records c ON c.id::text=r.body->>'conversation_id' AND c.workspace_id=r.workspace_id AND c.environment=r.environment AND c.kind='conversation'
 LEFT JOIN market_journey_snapshots s ON s.journey_id=c.id AND s.workspace_id=r.workspace_id AND s.environment=r.environment
 LEFT JOIN market_variants v ON v.id::text=s.body->'release'->>'variant_id' AND v.workspace_id=r.workspace_id AND v.environment=r.environment
 LEFT JOIN records family ON family.id::text=coalesce(s.body->'release'->>'family_id',o.body->>'product_id') AND family.workspace_id=r.workspace_id AND family.environment=r.environment AND family.kind='product'
 LEFT JOIN records account ON account.id::text=c.body->>'account_id' AND account.workspace_id=r.workspace_id AND account.environment=r.environment AND account.kind='channel_account'
 LEFT JOIN records contact ON contact.id::text=c.body->>'contact_id' AND contact.workspace_id=r.workspace_id AND contact.environment=r.environment AND contact.kind='contact'
 LEFT JOIN records asset ON asset.id::text=r.body->>'asset_id' AND asset.workspace_id=r.workspace_id AND asset.environment=r.environment AND asset.kind='asset'
 LEFT JOIN receipt_order_policy_snapshots p ON p.order_id=o.id AND p.workspace_id=r.workspace_id AND p.environment=r.environment
 WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='receipt' AND coalesce(r.body->>'deleted_at','')='' AND c.body->>'privacy_erased' IS DISTINCT FROM 'true'`;

const money=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?v:typeof v==='string'&&/^\d{1,16}$/.test(v)?Number(v):null;
function primaryReason(rb:Record<string,any>):string|null{
 if(rb.analysis_status==='HUMAN_REQUIRED'||rb.analysis_dependency)return rb.analysis_dependency??'RECEIPT_AI_019_REQUIRED';
 const checks=Array.isArray(rb.assessment?.checks)?rb.assessment.checks:[];
 const failed=checks.find((c:any)=>c.state==='FAILED')??checks.find((c:any)=>c.state==='UNKNOWN');
 return failed?.code??null;
}
function view(r:any){
 const rb=r.rb??{},ob=r.ob??{},result=r.result as ReceiptResult,reason=result==='REVIEW'?primaryReason(rb):null;
 return{id:r.id as string,version:Number(r.version),received_at:new Date(r.created_at).toISOString(),result,result_label:receiptResultLabels[result],
  reason:reason,reason_label:receiptReasonLabel(reason),analysis:String(rb.analysis_status??'PENDING'),
  product:r.product??null,variant:r.variant??null,market:r.market??null,
  expected_minor:money(ob.amount_minor),currency:typeof ob.currency==='string'?ob.currency:null,
  observed_minor:money(rb.extraction?.amount_minor),observed_currency:typeof rb.extraction?.currency==='string'?rb.extraction.currency:null,
  number:r.number_name??null,number_masked:r.number_masked??null,contact_masked:r.contact_masked??null,conversation_id:r.conversation_id??null,order_id:r.order_id??null,
  has_document:r.has_document===true&&['image/png','image/jpeg','image/webp','application/pdf'].includes(r.mime_type),mime_type:r.mime_type??null,
  decision_pending:r.decision_pending===true,decided_by_person:!!rb.review,automatic_policy:r.automatic==='true'};
}
const pageSchema=z.object({view:z.enum(['pending','all']).default('pending'),limit:z.coerce.number().int().min(1).max(100).default(30),offset:z.coerce.number().int().min(0).max(100000).default(0)}).strict();
async function context(db:ProfileExecutor,environment:Environment){
 const r=(await db.query("SELECT current_setting('app.workspace_id',true) w,current_setting('app.environment',true) e")).rows[0];
 need(r?.w===db.workspaceId&&r?.e===environment,'RECEIPT_QUEUE_CONTEXT',403);
}
/** Receipts waiting for a decision, counted exactly as the queue shows them (Inicio). */
export async function pendingReceiptCount(db:ProfileExecutor,environment:Environment){
 return Number((await db.query(`WITH q AS (${rowsSql}) SELECT count(*) n FROM q WHERE result='REVIEW'`,[db.workspaceId,environment])).rows[0]?.n??0);
}
export async function receiptQueue(db:ProfileExecutor,environment:Environment,input:unknown){
 await context(db,environment);const q=pageSchema.parse(input??{});
 const rows=(await db.query(`WITH q AS (${rowsSql}) SELECT *,count(*) OVER() total FROM q WHERE ($3::text='all' OR result='REVIEW')
  ORDER BY (result='REVIEW') DESC,CASE WHEN result='REVIEW' THEN created_at END ASC,created_at DESC,id LIMIT $4 OFFSET $5`,[db.workspaceId,environment,q.view,q.limit,q.offset])).rows;
 const pending=await pendingReceiptCount(db,environment);
 return{rows:rows.map(view),total:Number(rows[0]?.total??0),pending,view:q.view,limit:q.limit,offset:q.offset};
}
export async function receiptDetail(db:ProfileExecutor,environment:Environment,id:string){
 await context(db,environment);id=z.string().uuid().parse(id);
 const r=(await db.query(`${rowsSql} AND r.id=$3`,[db.workspaceId,environment,id])).rows[0];need(r,'RECEIPT_NOT_FOUND',404);
 const rb=r.rb??{},extraction=rb.extraction??{};
 const checks=(Array.isArray(rb.assessment?.checks)?rb.assessment.checks:[]).map((c:any)=>({rule:String(c.rule),label:ruleLabels[c.rule]??String(c.rule),state:String(c.state),state_label:stateLabels[c.state]??String(c.state),
  reason:c.state==='FAILED'||c.state==='UNKNOWN'?receiptReasonLabel(c.code):null}));
 const last=(await db.query("SELECT status,result FROM commands WHERE workspace_id=$1 AND environment=$2 AND kind='receipt_review' AND resource_id=$3 ORDER BY created_at DESC LIMIT 1",[db.workspaceId,environment,id])).rows[0];
 const failure=last?.status==='FAILED'&&typeof last.result?.error==='string'?String(last.result.error):null;
 return{...view(r),checks,last_decision:last?{status:String(last.status),failure,failure_label:failure?decisionFailureLabels[failure]??'No se pudo aplicar la decisión. Vuelve a intentarlo.':null}:null,
  extraction:{bank:typeof extraction.bank==='string'?extraction.bank.slice(0,120):null,destination_suffix:typeof extraction.destination_suffix==='string'?extraction.destination_suffix.replace(/\D/g,'').slice(-4)||null:null,
   reference:typeof extraction.reference==='string'?extraction.reference.slice(0,120):null,status:typeof extraction.status==='string'?extraction.status:null},
  review:rb.review?{at:rb.review.at??null,reason:typeof rb.review.reason==='string'?rb.review.reason.slice(0,300):null,by_person:true}:null,
  duplicate:!!rb.duplicate_of};
}
const decisionFailureLabels:Record<string,string>={RECEIPT_AMOUNT_REQUIRED:'Indica el monto pagado para aprobarlo.',RECEIPT_CURRENCY_MISMATCH:'La moneda del comprobante no es la de la venta.',
 VERSION_CONFLICT:'El comprobante cambió. Vuelve a abrirlo.',FALSE_RECEIPT_REQUIRES_RESTORATION:'Está marcado como falso.'};
const decisionSchema=z.object({decision:z.enum(['APPROVED','REJECTED']),expected_version:z.number().int().positive(),reason:z.string().trim().max(300).optional(),
 amount_minor:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict();
/** One person's decision on one receipt: the worker applies it under the
 * conversation lock (recognition at most once). Replays of the same request
 * return the same command; a second, different decision is refused. */
export async function decideReceipt(db:ProfileExecutor,environment:Environment,id:string,input:unknown,actor:{id:string},operationId:string){
 await context(db,environment);id=z.string().uuid().parse(id);operationId=z.string().uuid().parse(operationId);const q=decisionSchema.parse(input);
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['receipt-decision:'+db.workspaceId+':'+id]);
 const prior=(await db.query("SELECT id,status,payload FROM commands WHERE workspace_id=$1 AND environment=$2 AND kind='receipt_review' AND resource_id=$3 AND actor_id=$4 AND idempotency_key=$5",[db.workspaceId,environment,id,actor.id,operationId])).rows[0];
 if(prior){need(prior.payload?.decision===q.decision&&prior.payload?.expected_version===q.expected_version&&(prior.payload?.amount_minor??null)===(q.decision==='APPROVED'?q.amount_minor??null:null),'RECEIPT_DECISION_OPERATION_CONFLICT');return{command_id:prior.id as string,status:String(prior.status),decision:q.decision};}
 const r=(await db.query(`${rowsSql} AND r.id=$3`,[db.workspaceId,environment,id])).rows[0];need(r,'RECEIPT_NOT_FOUND',404);
 const current=view(r);
 need(Number(r.version)===q.expected_version,'VERSION_CONFLICT');
 need(!current.decision_pending,'RECEIPT_DECISION_PENDING');
 need(!current.decided_by_person,'RECEIPT_ALREADY_DECIDED');
 need(current.result==='REVIEW','RECEIPT_ALREADY_DECIDED');
 // Approving records what was paid: the amount read from the document, or the
 // one the person states when it could not be read (never a silent price).
 need(q.decision!=='APPROVED'||current.observed_minor!==null||q.amount_minor!==undefined,'RECEIPT_AMOUNT_REQUIRED',422);
 need(q.decision!=='APPROVED'||current.observed_currency===null||current.observed_currency===current.currency,'RECEIPT_CURRENCY_MISMATCH',422);
 const reason=q.reason||(q.decision==='APPROVED'?'Aprobado en la revisión de comprobantes':'Rechazado en la revisión de comprobantes');
 const command=(await db.query(`INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,$3,'receipt_review',$4,$5,$6,$7) RETURNING id,status`,
  [randomUUID(),db.workspaceId,environment,id,actor.id,{decision:q.decision,reason,expected_version:q.expected_version,...(q.decision==='APPROVED'&&q.amount_minor!==undefined?{amount_minor:q.amount_minor,currency:current.currency}:{}),journey_id:current.conversation_id,order_id:current.order_id,source:'receipt_queue_v2'},operationId])).rows[0];
 return{command_id:command.id as string,status:String(command.status),decision:q.decision};
}
/** The receipt image/PDF for a person reviewing it: read from the encrypted
 * private store, checked against its captured hash, never cached. */
export async function receiptDocument(db:ProfileExecutor,environment:Environment,id:string){
 await context(db,environment);id=z.string().uuid().parse(id);
 const row=(await db.query(`SELECT a.body FROM records r JOIN records a ON a.id::text=r.body->>'asset_id' AND a.workspace_id=r.workspace_id AND a.environment=r.environment AND a.kind='asset'
  LEFT JOIN records c ON c.id::text=r.body->>'conversation_id' AND c.workspace_id=r.workspace_id AND c.environment=r.environment AND c.kind='conversation'
  WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='receipt' AND r.id=$3 AND coalesce(r.body->>'deleted_at','')='' AND c.body->>'privacy_erased' IS DISTINCT FROM 'true'`,[db.workspaceId,environment,id])).rows[0];
 need(row,'RECEIPT_NOT_FOUND',404);const a=row.body;
 need(a.status==='READY'&&typeof a.storage_key==='string'&&/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(a.storage_key)&&/^[a-f0-9]{64}$/.test(a.sha256)&&['image/png','image/jpeg','image/webp','application/pdf'].includes(a.mime_type),'RECEIPT_DOCUMENT_UNAVAILABLE',404);
 const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;need(root,'RECEIPT_DOCUMENT_UNAVAILABLE',503);
 const bytes=Buffer.from(decrypt(await readFile(join(root,'assets',`${a.storage_key}.enc`),'utf8')),'base64');
 need(bytes.length>0&&bytes.length<=20*1024*1024&&createHash('sha256').update(bytes).digest('hex')===a.sha256,'RECEIPT_DOCUMENT_CHANGED',409);
 return{mimeType:String(a.mime_type),bytes};
}
