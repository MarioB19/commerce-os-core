import {randomUUID} from 'node:crypto';
import type {ProfileExecutor} from './profile-context.js';
import {receiptPolicySchema,receiptPolicyOverrideSchema,resolvedReceiptPolicySchema} from '../../contracts/src/receipt-policy.js';
import {receiptPolicyId,receiptPolicyQuery,receiptPolicyStored,receiptProfilePolicyWrite,receiptVariantPolicyWrite} from '../../contracts/src/receipt-policy-store.js';
import {createHash} from 'node:crypto';
import {defaultReceiptPolicy,receiptPolicyHash,resolveReceiptPolicy,type ResolvedReceiptPolicy} from '../../domain/src/sales/receipt-policy.js';

type Environment='REAL'|'SIMULATION';
export class ReceiptPolicyStoreError extends Error{constructor(readonly code:string,readonly statusCode=409){super(code);}}
function need(v:unknown,code:string,status=409):asserts v{if(!v)throw new ReceiptPolicyStoreError(code,status);}
async function context(db:ProfileExecutor,environment:Environment,mutation=false,owner=false){
 // `owner`: the API role or the schema owner (the reviewed migration); only the
 // default-policy bootstrap asks for it.
 receiptPolicyQuery.parse({environment});
 const r=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) w,current_setting('app.environment',true) e,current_user=pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid='public.receipt_policy_heads'::regclass")).rows[0];
 need(r&&r.w===db.workspaceId&&r.e===environment&&(owner?(r.owner===true||r.role==='commerce_api'):mutation?r.role==='commerce_api':['commerce_api','commerce_automation'].includes(r.role)),'RECEIPT_POLICY_CONTEXT',403);
}
async function lock(db:ProfileExecutor,environment:Environment){
 need((await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',['receipt-policy:'+db.workspaceId+':'+environment])).rows[0]?.acquired===true,'RECEIPT_POLICY_BUSY');
}
interface PolicyRow{variant_id:string|null;id:string;revision:number;sha256:string;body:unknown}
function present(db:ProfileExecutor,environment:Environment,row:PolicyRow){
 const body=(row.variant_id===null?receiptPolicySchema:receiptPolicyOverrideSchema).parse(row.body);
 need(receiptPolicyHash(body)===row.sha256,'RECEIPT_POLICY_CORRUPT');
 return receiptPolicyStored.parse({workspaceId:db.workspaceId,environment,variantId:row.variant_id,ref:{id:row.id,revision:row.revision,sha256:row.sha256},body});
}
async function current(db:ProfileExecutor,environment:Environment,variantId:string|null){
 const row=(await db.query<PolicyRow>(`SELECT h.variant_id,v.id,v.revision,v.sha256,v.body FROM receipt_policy_heads h
 JOIN receipt_policy_versions v ON v.workspace_id=h.workspace_id AND v.environment=h.environment AND v.id=h.current_version_id
 WHERE h.workspace_id=$1 AND h.environment=$2 AND h.variant_id IS NOT DISTINCT FROM $3::uuid`,[db.workspaceId,environment,variantId])).rows[0];
 return row?present(db,environment,row):null;
}
export async function readReceiptPolicy(db:ProfileExecutor,environment:Environment,variantId:string|null){
 await context(db,environment);if(variantId!==null)variantId=receiptPolicyId.parse(variantId);return current(db,environment,variantId);
}
/** Caller owns the F2 transaction and its final authority check. No config,
 * snapshot or operation becomes durable before that transaction commits. */
export async function writeReceiptPolicy(db:ProfileExecutor,environment:Environment,variantId:string|null,input:unknown,actorId:string,operationId:string,options:{bootstrap?:boolean}={}){
 await context(db,environment,true,options.bootstrap===true);if(variantId!==null)variantId=receiptPolicyId.parse(variantId);operationId=receiptPolicyId.parse(operationId);
 need(typeof actorId==='string'&&actorId.length>0&&actorId.length<=256,'RECEIPT_POLICY_ACTOR',400);
 const parsed=variantId===null?receiptProfilePolicyWrite.parse(input):receiptVariantPolicyWrite.parse(input);
 const body='policy'in parsed?parsed.policy:parsed.override,request={variantId,...parsed},requestHash=receiptPolicyHash(request);
 await lock(db,environment);
 const prior=(await db.query('SELECT request_hash,result FROM receipt_policy_operations WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND operation_id=$4',[db.workspaceId,environment,actorId,operationId])).rows[0];
 if(prior){need(prior.request_hash===requestHash,'RECEIPT_POLICY_OPERATION_CONFLICT');const result=receiptPolicyStored.parse(prior.result);need(result.workspaceId===db.workspaceId&&result.environment===environment&&result.variantId===variantId&&receiptPolicyHash(result.body)===result.ref.sha256,'RECEIPT_POLICY_CORRUPT');return result;}
 if(variantId!==null)need((await db.query('SELECT id FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,environment,variantId])).rows.length===1,'RECEIPT_POLICY_VARIANT_NOT_FOUND',404);
 const head=(await db.query('SELECT id,revision FROM receipt_policy_heads WHERE workspace_id=$1 AND environment=$2 AND variant_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE',[db.workspaceId,environment,variantId])).rows[0];
 need((head?.revision??0)===parsed.expectedRevision,'RECEIPT_POLICY_REVISION');
 const versionId=randomUUID(),headId=head?.id??randomUUID(),revision=parsed.expectedRevision+1,sha256=receiptPolicyHash(body);
 if(head){need((await db.query(`UPDATE receipt_policy_heads SET revision=$4,current_version_id=$5,updated_at=clock_timestamp()
 WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND revision=$6`,[db.workspaceId,environment,headId,revision,versionId,parsed.expectedRevision])).rowCount===1,'RECEIPT_POLICY_REVISION');}
 else await db.query(`INSERT INTO receipt_policy_heads(workspace_id,environment,id,variant_id,revision,current_version_id) VALUES($1,$2,$3,$4,1,$5)`,[db.workspaceId,environment,headId,variantId,versionId]);
 await db.query(`INSERT INTO receipt_policy_versions(workspace_id,environment,id,head_id,revision,is_override,body,sha256,actor_id)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[db.workspaceId,environment,versionId,headId,revision,variantId!==null,body,sha256,actorId]);
 const result=present(db,environment,{variant_id:variantId,id:versionId,revision,sha256,body});
 await db.query('INSERT INTO receipt_policy_operations(workspace_id,environment,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6)',[db.workspaceId,environment,actorId,operationId,requestHash,result]);return result;
}
/** V7 (RF-09.a): a profile that sells variants always has an explicit profile
 * policy, so a new order can capture its rules. The default keeps human
 * approval. It is an ordinary versioned write (revision 1, CAS, history) with
 * one deterministic operation per profile and environment, so concurrent or
 * repeated calls converge and an owner's later edit is never overwritten. The
 * API role or the schema owner (inside the reviewed variant migration) runs it. */
export async function ensureDefaultReceiptPolicy(db:ProfileExecutor,environment:Environment,actorId:string){
 await context(db,environment,true,true);
 const existing=await current(db,environment,null);if(existing)return existing;
 const h=createHash('sha256').update('receipt-policy-default:'+db.workspaceId+':'+environment).digest('hex');
 const operationId=`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-${(8+parseInt(h[16]!,16)%4).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
 const prior=(await db.query('SELECT result FROM receipt_policy_operations WHERE workspace_id=$1 AND environment=$2 AND operation_id=$3',[db.workspaceId,environment,operationId])).rows[0];
 if(prior)return receiptPolicyStored.parse(prior.result);
 return writeReceiptPolicy(db,environment,null,{expectedRevision:0,policy:defaultReceiptPolicy()},actorId,operationId,{bootstrap:true});
}
export async function readReceiptPolicyOperation(db:ProfileExecutor,environment:Environment,actorId:string,operationId:string){
 await context(db,environment);operationId=receiptPolicyId.parse(operationId);
 const row=(await db.query('SELECT result FROM receipt_policy_operations WHERE workspace_id=$1 AND environment=$2 AND actor_id=$3 AND operation_id=$4',[db.workspaceId,environment,actorId,operationId])).rows[0];
 need(row,'RECEIPT_POLICY_OPERATION_NOT_FOUND',404);return receiptPolicyStored.parse(row.result);
}
export async function effectiveReceiptPolicy(db:ProfileExecutor,environment:Environment,variantId:string):Promise<ResolvedReceiptPolicy>{
 await context(db,environment);variantId=receiptPolicyId.parse(variantId);await lock(db,environment);
 need((await db.query('SELECT id FROM market_variants WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,environment,variantId])).rows.length===1,'RECEIPT_POLICY_VARIANT_NOT_FOUND',404);
 const profile=await current(db,environment,null),variant=await current(db,environment,variantId);need(profile,'RECEIPT_POLICY_PROFILE_REQUIRED');
 const scope={workspace_id:db.workspaceId,environment};
 return resolveReceiptPolicy({scope,variantId,profile:{scope,ref:profile.ref,policy:profile.body},variant:variant?{scope,variantId,ref:variant.ref,override:variant.body}:null});
}
function validateSnapshot(db:ProfileExecutor,environment:Environment,variantId:string,raw:unknown):ResolvedReceiptPolicy{
 const value=resolvedReceiptPolicySchema.parse(raw);
 need(value&&value.scope?.workspace_id===db.workspaceId&&value.scope?.environment===environment&&value.variantId===variantId,'RECEIPT_POLICY_SNAPSHOT_CORRUPT');
 const {sha256,...body}=value;need(receiptPolicyHash(body)===sha256,'RECEIPT_POLICY_SNAPSHOT_CORRUPT');return value;
}
export async function readOrderReceiptPolicy(db:ProfileExecutor,environment:Environment,orderId:string){
 await context(db,environment);orderId=receiptPolicyId.parse(orderId);
 const row=(await db.query('SELECT variant_id,body,sha256 FROM receipt_order_policy_snapshots WHERE workspace_id=$1 AND environment=$2 AND order_id=$3',[db.workspaceId,environment,orderId])).rows[0];
 if(!row)return null;need(row.sha256===row.body.sha256,'RECEIPT_POLICY_SNAPSHOT_CORRUPT');return validateSnapshot(db,environment,row.variant_id,row.body);
}
/** Only a newly created canonical order/journey can capture current policy.
 * Replays return its historical snapshot, never today's replacement policy. */
export async function captureOrderReceiptPolicy(db:ProfileExecutor,environment:Environment,orderId:string){
 await context(db,environment);orderId=receiptPolicyId.parse(orderId);await lock(db,environment);
 const prior=await readOrderReceiptPolicy(db,environment,orderId);if(prior)return prior;
 const row=(await db.query(`SELECT j.body->'release'->>'variant_id' variant_id FROM records o JOIN market_journey_snapshots j
 ON j.workspace_id=o.workspace_id AND j.environment=o.environment AND j.journey_id::text=o.body->>'conversation_id'
 WHERE o.workspace_id=$1 AND o.environment=$2 AND o.id=$3 AND o.kind='order' AND o.version=1 AND o.xmin=((pg_current_xact_id()::text::numeric % 4294967296)::text)::xid FOR SHARE OF o`,[db.workspaceId,environment,orderId])).rows[0];
 need(row,'RECEIPT_POLICY_ORDER_SCOPE');const resolved=await effectiveReceiptPolicy(db,environment,row.variant_id);
 await db.query(`INSERT INTO receipt_order_policy_snapshots(workspace_id,environment,order_id,variant_id,profile_version_id,variant_version_id,body,sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[db.workspaceId,environment,orderId,resolved.variantId,resolved.profile.id,resolved.variant?.id??null,resolved,resolved.sha256]);return resolved;
}
