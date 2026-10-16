import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),version=z.number().int().min(1).max(10000);
const history=z.object({version,source_sha256:sha,minimum_sha256:sha}).strict();
const coverage=z.object({record_id:uuid,kind:z.enum(['order','receipt','fulfillment']),version,
 classification:z.enum(['COMMERCIAL','GENUINE','FALSE','TEST']).nullable(),history:z.array(history).min(1).max(10000),
}).strict().superRefine((v,c)=>{if(v.history.length!==v.version||v.history.some((h,i)=>h.version!==i+1)||v.kind==='fulfillment'&&v.classification!==null||v.kind!=='fulfillment'&&v.classification===null)c.addIssue({code:'custom',message:'FINANCIAL_RETENTION_COVERAGE_INVALID'});});
const receipt=z.object({schema_version:z.literal(1),receipt_uuid:uuid,receipt_sha256:sha,workspace_id:z.string().min(1),environment:z.literal('REAL'),journey_id:uuid,
 source_version:version,source_sha256:sha,coverage:z.array(coverage).max(10000),ledger_sha256:sha,expires_at:z.iso.datetime({offset:true}),
}).strict().superRefine((v,c)=>{if(new Set(v.coverage.map(x=>x.record_id)).size!==v.coverage.length)c.addIssue({code:'custom',message:'FINANCIAL_RETENTION_COVERAGE_INVALID'});});
const capture=receipt.extend({status:z.enum(['CAPTURED','NO_EFFECT'])});
const verify=receipt.extend({status:z.enum(['RESOLUTION_PRESERVED','CORRECTED_REQUIRES_RECONCILIATION']),installed:z.boolean()});
const confirmation=receipt.extend({status:z.enum(['MINIMUM_CONFIRMED','NO_EFFECT']),resolution:z.enum(['RESOLUTION_PRESERVED','CORRECTED_REQUIRES_RECONCILIATION'])});
function scope(db:ProfileExecutor,raw:unknown,journeyId?:string,receiptId?:string){const v=receipt.parse(raw);if(v.workspace_id!==db.workspaceId||journeyId&&v.journey_id!==journeyId||receiptId&&v.receipt_uuid!==receiptId)throw Error('FINANCIAL_RETENTION_SCOPE_CHANGED');return v;}
async function value(db:ProfileExecutor,sql:string,args:unknown[]){const result=await db.query(sql,args);if(result.rows.length!==1||!Object.hasOwn(result.rows[0],'receipt'))throw Error('FINANCIAL_RETENTION_RESPONSE_INVALID');return result.rows[0].receipt;}
/** Prepared ports, not erasure permission. Caller supplies an authenticated RR
 * executor under031's writer/session fence; SQL functions have no runtime grants. */
export async function captureFinancialRetention(db:ProfileExecutor,journeyId:string,expectedVersion:number){
 const id=uuid.parse(journeyId),n=version.parse(expectedVersion),v=capture.parse(await value(db,'SELECT capture_financial_retention($1,$2) receipt',[id,n]));
 scope(db,receipt.parse(Object.fromEntries(Object.entries(v).filter(([k])=>k!=='status'))),id);if(v.source_version!==n)throw Error('FINANCIAL_RETENTION_SOURCE_CHANGED');return v;
}
export async function verifyFinancialRetention(db:ProfileExecutor,journeyId:string){
 const id=uuid.parse(journeyId),v=verify.parse(await value(db,'SELECT verify_financial_retention($1) receipt',[id]));scope(db,Object.fromEntries(Object.entries(v).filter(([k])=>!['status','installed'].includes(k))),id);return v;
}
export async function confirmFinancialMinimization(db:ProfileExecutor,receiptId:string){
 const id=uuid.parse(receiptId),v=confirmation.parse(await value(db,'SELECT confirm_financial_minimization($1) receipt',[id]));scope(db,Object.fromEntries(Object.entries(v).filter(([k])=>!['status','resolution'].includes(k))),undefined,id);return v;
}
export async function correctRetainedFinancialClassification(db:ProfileExecutor,commandId:string){
 const id=uuid.parse(commandId);return z.object({resource_id:uuid,classification:z.enum(['COMMERCIAL','TEST','FALSE','GENUINE']),version,retention_receipt_uuid:uuid,external_effects:z.literal(0)}).strict().parse(await value(db,'SELECT correct_retained_financial_classification($1) receipt',[id]));
}
