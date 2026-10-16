import {createHash} from 'node:crypto';
import {z} from 'zod';
import {encrypt,decrypt,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import type {DomainRecord} from '@commerce/contracts';
import {currentWorkerProfile,withWorkerProfilePhase} from '../../../packages/db/src/profile-worker-scope.js';
import {currentProfileExecutor} from '../../../packages/db/src/profile-query-routing.js';
import {readOrderReceiptPolicy} from '../../../packages/db/src/receipt-policies.js';
import {PostgresReceiptDocumentAi,receiptAiDocumentSchema,receiptDocumentScope,parseReceiptDocument,type ReceiptAiDocument} from '../../../packages/ai-providers/src/receipt-document.js';
import type {Outcome} from '../../../packages/ai-providers/src/contracts.js';
import {applyReceiptAnalysis} from './commands.js';
import {save,gated,receiptReviewPending} from './shared.js';

function need(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
const canonical=(v:unknown):string=>JSON.stringify(v,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,value[k]])):value);
const digest=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const frameSchema=z.object({document:receiptAiDocumentSchema,assetVersion:z.number().int().positive(),operationalRevision:z.number().int().nonnegative()}).strict();
type Frame=z.infer<typeof frameSchema>;
/** Broker is installed by the worker host. It resolves only this authenticated
 * asset to bounded private bytes; it must never accept a URL from a receipt. */
export interface ReceiptMediaBroker {read(document:ReceiptAiDocument,assetVersion:number):Promise<Uint8Array>}
export interface ReceiptAnalysisRuntime {
 /** Synchronous trusted composition from authenticated frame only. No key or
  * model selector enters from receipt text; native019 revalidates this grant. */
 bind(document:ReceiptAiDocument):PostgresReceiptDocumentAi|null;
 media:ReceiptMediaBroker;
}
const row=async(c:QueryExecutor,workspace:string,environment:string,kind:string,id:string,lock='')=>
 (await c.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind=$3 AND id=$4 AND coalesce(body->>'deleted_at','')='' ${lock}`,[workspace,environment,kind,id])).rows[0] as DomainRecord|undefined;
function identity(){const scope=currentWorkerProfile();need(scope&&!currentProfileExecutor(),'RECEIPT_AI_WORKER_SCOPE_REQUIRED');return scope;}
async function owned(c:QueryExecutor,receiptId:string){const s=currentWorkerProfile();need(s,'RECEIPT_AI_WORKER_SCOPE_REQUIRED');const r=await row(c,s.workspaceId,s.environment,'receipt',receiptId);need(r,'RECEIPT_AI_RECEIPT_REQUIRED');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[r.body.conversation_id]);const current=await row(c,s.workspaceId,s.environment,'receipt',receiptId,'FOR UPDATE');need(current&&current.body.conversation_id===r.body.conversation_id,'RECEIPT_AI_RECEIPT_CHANGED');return current;}
async function frame(c:QueryExecutor,r:DomainRecord):Promise<Frame>{
 const scope=currentWorkerProfile(r.workspace_id);need(scope&&r.environment===scope.environment,'RECEIPT_AI_SCOPE_CHANGED');
 const order=await row(c,r.workspace_id,r.environment,'order',r.body.order_id,'FOR SHARE');need(order&&order.body.conversation_id===r.body.conversation_id,'RECEIPT_AI_ORDER_CHANGED');
 const db=currentProfileExecutor(r.workspace_id);need(db,'RECEIPT_AI_PHASE_REQUIRED');const policy=await readOrderReceiptPolicy(db,r.environment,order.id);need(policy&&order.body.receipt_policy_snapshot_sha256===policy.sha256,'RECEIPT_POLICY_SNAPSHOT_REQUIRED');
 const asset=await row(c,r.workspace_id,r.environment,'asset',r.body.asset_id,'FOR SHARE');need(asset?.body.status==='READY'&&asset.body.storage_key,'PROTECTED_RECEIPT_ASSET_REQUIRED');
 const settings=await readOperationalSettings(c,r.workspace_id,r.environment,{lock:'share'});
 return frameSchema.parse({document:{workspaceId:r.workspace_id,environment:r.environment,variantId:policy.variantId,conversationId:r.body.conversation_id,receiptId:r.id,orderId:order.id,policySha256:policy.sha256,asset:{id:asset.id,sha256:asset.body.sha256,mimeType:asset.body.mime_type}},assetVersion:asset.version,operationalRevision:settings.version});
}
async function controls(c:QueryExecutor,r:DomainRecord){const conversation=await row(c,r.workspace_id,r.environment,'conversation',r.body.conversation_id,'FOR SHARE');return !conversation||conversation.body.privacy_erased===true||!!conversation.body.closed_at||r.body.review||await receiptReviewPending(c,r)||await gated(c,conversation);}
async function recheck(c:QueryExecutor,r:DomainRecord,expected:Frame,status:string){need(r.body.analysis_status===status&&r.body.receipt_ai?.frameSha256===digest(expected)&&r.body.receipt_ai?.attemptId===receiptDocumentScope(expected.document).attemptId,'RECEIPT_AI_CLAIM_CHANGED');need(canonical(await frame(c,r))===canonical(expected),'RECEIPT_AI_SOURCE_CHANGED');}

/** New policy023 path only. Runtime is explicit; absence cannot route to legacy
 * SalesAiProvider. Every phase exits before media, credential or provider I/O. */
export async function processProfileReceiptAnalyses(runtime:ReceiptAnalysisRuntime|undefined,limit=3){
 const s=identity();need(Number.isInteger(limit)&&limit>=1&&limit<=10,'RECEIPT_AI_LIMIT');
 const ids=await withWorkerProfilePhase(async c=>(await c.query(`SELECT r.id FROM records r JOIN receipt_order_policy_snapshots p ON p.workspace_id=r.workspace_id AND p.environment=r.environment AND p.order_id::text=r.body->>'order_id'
 WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='receipt' AND coalesce(r.body->>'deleted_at','')='' AND r.body->>'analysis_status' IN('PENDING','AWAITING_POLICY') AND r.body->>'review' IS NULL ORDER BY r.updated_at,r.id LIMIT $3`,[s.workspaceId,s.environment,limit])).rows.map(r=>r.id as string));
 for(const id of ids){
  const prepared=await withWorkerProfilePhase(async c=>{
   const r=await owned(c,id);if(!['PENDING','AWAITING_POLICY'].includes(r.body.analysis_status))return;
   if(await controls(c,r)){await save(c,r,{...r.body,analysis_dependency:'CONTROLS_CHANGED'});return;}
   if(!runtime){await save(c,r,{...r.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:'RECEIPT_AI_019_REQUIRED'});return;}
   if(r.body.analysis_status==='AWAITING_POLICY'){const f=frameSchema.parse(r.body.receipt_ai?.frame);await recheck(c,r,f,'AWAITING_POLICY');const ai=runtime.bind(f.document);need(ai&&ai.grantId===r.body.receipt_ai.grantId,'RECEIPT_AI_GRANT_CHANGED');need(typeof r.body.receipt_ai_result==='string'&&r.body.receipt_ai_result.length>0,'RECEIPT_AI_CACHE_REQUIRED');return{frame:f,ai,cached:r.body.receipt_ai_result as string};}
   const f=await frame(c,r),ai=runtime.bind(f.document);
   // No owner grant for this variant's receipts: a person reviews it (RF-09.f).
   if(!ai){await save(c,r,{...r.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:'RECEIPT_AI_GRANT_REQUIRED'});return;}
   const claim={frame:f,frameSha256:digest(f),attemptId:receiptDocumentScope(f.document).attemptId,grantId:ai.grantId};
   need(!r.body.receipt_ai,'RECEIPT_AI_ALREADY_CLAIMED');await save(c,r,{...r.body,analysis_status:'RUNNING',analysis_dependency:null,receipt_ai:claim});return{frame:f,ai,cached:undefined};
  });
  if(!prepared||!runtime)continue;
  const f=prepared.frame,ai=prepared.ai;let cached=prepared.cached;
  if(!cached){
   let bytes:Uint8Array|undefined;
   try{
    bytes=await runtime.media.read(f.document,f.assetVersion);
    const result=await ai.invoke(f.document,bytes,()=>withWorkerProfilePhase(async c=>{const r=await owned(c,id);await recheck(c,r,f,'RUNNING');need(!await controls(c,r),'RECEIPT_AI_CONTROLS_CHANGED');}));
    if(result.state!=='SUCCEEDED'){
     await withWorkerProfilePhase(async c=>{const r=await owned(c,id);await recheck(c,r,f,'RUNNING');await save(c,r,{...r.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:result.code,receipt_ai_outcome:result.state});});continue;
    }
    const binding=await ai.verifySettlement(f.document,result.outcome);
    cached=encrypt({schema_version:1,frame:f,attemptId:receiptDocumentScope(f.document).attemptId,requestSha256:binding.requestSha256,value:result.value,outcome:result.outcome});
    await withWorkerProfilePhase(async c=>{const r=await owned(c,id);await recheck(c,r,f,'RUNNING');need(!r.body.review&&!await receiptReviewPending(c,r),'RECEIPT_AI_HUMAN_REVIEW_PENDING');await save(c,r,{...r.body,analysis_status:'AWAITING_POLICY',receipt_ai_result:cached});});
   }catch{
    // No provider replay, even when COMMIT or media acquisition was uncertain.
    // An acknowledged cache is retained; a claim without one becomes explicit
    // human reconciliation with its019 budget/history unchanged.
    await withWorkerProfilePhase(async c=>{const r=await owned(c,id);if(r.body.analysis_status==='RUNNING'&&r.body.receipt_ai?.frameSha256===digest(f)&&!r.body.review&&!await receiptReviewPending(c,r))await save(c,r,{...r.body,analysis_status:'HUMAN_REQUIRED',analysis_dependency:'RECEIPT_AI_RECONCILE_REQUIRED'});});
    continue;
   }finally{bytes?.fill(0);}
  }
  const raw=JSON.parse(decrypt(cached));need(raw&&Object.keys(raw).sort().join(',')==='attemptId,frame,outcome,requestSha256,schema_version,value'&&raw.schema_version===1&&canonical(raw.frame)===canonical(f)&&raw.attemptId===receiptDocumentScope(f.document).attemptId&&/^[a-f0-9]{64}$/.test(raw.requestSha256),'RECEIPT_AI_CACHE_CHANGED');
  const value=parseReceiptDocument(JSON.stringify(raw.value));await ai.verifySettlement(f.document,raw.outcome as Extract<Outcome,{state:'SUCCEEDED'}>,raw.requestSha256);
  await withWorkerProfilePhase(async c=>{const r=await owned(c,id);await recheck(c,r,f,'AWAITING_POLICY');if(await controls(c,r)){await save(c,r,{...r.body,analysis_dependency:'CONTROLS_CHANGED'});return;}await applyReceiptAnalysis(c,r,value,raw.attemptId);});
 }
 return ids.length;
}
