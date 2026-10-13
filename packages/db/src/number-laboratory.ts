import {createCipheriv,createDecipheriv,createHash,hkdfSync,randomBytes,randomUUID} from 'node:crypto';
import {numberLabStartSchema,numberLabOperationSchema,labCiphertextSchema,type NumberLabOperation,type NumberLabAction} from '../../contracts/src/number-laboratory.js';
import {labHash,labCanonical,validateLabSnapshot,type LabEstimate} from '../../domain/src/laboratory/number-lab.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from './profile-context.js';
import {currentProfileExecutor} from './profile-query-routing.js';
import type {LabCapturedConfiguration} from './number-lab-snapshot.js';
import {compileNumberLabConfiguration} from '../../domain/src/laboratory/configuration-plan.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function need(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
const iso=(v:unknown)=>new Date(v instanceof Date?v.getTime():String(v)).toISOString();
const amount=(v:unknown)=>{const n=Number(v);need(Number.isSafeInteger(n)&&n>=0,'LAB_INVALID_COUNT');return n;};
/** V7 F6: keys of the laboratory, derived from the private data key (no new
 * secret to custody). `control` seals runs/operations/results, `files` the
 * lab copies of materials; `source` is the existing private-store key. */
export function numberLabKeys(secret=process.env.PRIVATE_DATA_KEY??process.env.DATA_ENCRYPTION_KEY??process.env.ENCRYPTION_KEY){
 need(typeof secret==='string'&&secret.length>0,'LAB_KEY_REQUIRED');
 const raw=Buffer.from(secret,/^[a-f0-9]{64}$/i.test(secret)?'hex':'base64');need(raw.length===32,'LAB_KEY_REQUIRED');
 const derive=(info:string)=>new Uint8Array(hkdfSync('sha256',raw,Buffer.from('commerce-os'),Buffer.from(info),32));
 return{control:derive('commerce.number-lab.control.v1'),files:derive('commerce.number-lab.files.v1'),transport:derive('commerce.number-lab.transport.v1'),source:new Uint8Array(raw)};
}
export interface LabCipherBinding {workspaceId:string;runId:string;purpose:'snapshot'|'action'|'result'|'attachment';operationId?:string}
function aad(b:LabCipherBinding){need(typeof b.workspaceId==='string'&&b.workspaceId.length>0&&b.workspaceId.length<=256&&!b.workspaceId.includes('\0')&&uuid.test(b.runId)&&['snapshot','action','result','attachment'].includes(b.purpose)&&(b.purpose==='snapshot'?b.operationId===undefined:typeof b.operationId==='string'&&uuid.test(b.operationId)),'LAB_CIPHER_SCOPE');return Buffer.from(labCanonical({protocol:'commerce.number-lab.v1',...b}));}
export function sealLabValue(binding:LabCipherBinding,value:unknown,key:Uint8Array){
 need(key.length===32,'LAB_CIPHER_KEY');const raw=Buffer.from(labCanonical(value));need(raw.length>0&&raw.length<=8388608,'LAB_CONTENT_LIMIT');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(binding));try{const encrypted=Buffer.concat([cipher.update(raw),cipher.final()]);return{version:1 as const,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:encrypted.toString('base64')};}finally{raw.fill(0);}
}
export function openLabValue(binding:LabCipherBinding,value:unknown,key:Uint8Array):unknown{
 try{need(key.length===32,'LAB_CIPHER_KEY');const v=labCiphertextSchema.parse(value);const decode=(s:string,n?:number)=>{const b=Buffer.from(s,'base64');need(b.toString('base64')===s&&(n===undefined||n===b.length),'LAB_CIPHER_INVALID');return b;};
  const cipher=createDecipheriv('aes-256-gcm',key,decode(v.iv,12));cipher.setAAD(aad(binding));cipher.setAuthTag(decode(v.tag,16));const raw=Buffer.concat([cipher.update(decode(v.ciphertext)),cipher.final()]);try{return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(raw));}finally{raw.fill(0);}
 }catch{throw Error('LAB_CIPHER_INVALID');}
}
async function dbNow(db:ProfileExecutor){return new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);}
async function authorize(db:ProfileExecutor,a:ProfileAuthority,write:boolean){const now=await dbNow(db);authorizeProfileAction(a,{scope:write?'tests:run':'tests:read',workspaceId:db.workspaceId,mutation:write},now);return now;}
export function presentLabRun(r:any){return{run_id:String(r.id),account_id:String(r.source_account_id),snapshot_sha256:String(r.snapshot_sha256),estimate_sha256:String(r.estimate_sha256),engine_sha256:String(r.engine_sha256),mode:r.mode as 'CHAT'|'AUTOMATIC',state:r.state as 'READY'|'RUNNING'|'PARTIAL'|'COMPLETED'|'STOPPED',version:amount(r.version),virtual_now:iso(r.virtual_now),created_at:iso(r.created_at),expires_at:iso(r.expires_at),maximum_ai_calls:amount(r.maximum_ai_calls),maximum_microusd:amount(r.maximum_microusd),execution_environment:'SIMULATION' as const,operation_class:'TEST' as const};}
function settlement(o:any,key:Uint8Array){const v=openLabValue({workspaceId:o.workspace_id,runId:o.run_id,purpose:'result',operationId:o.id},o.result_ciphertext,key) as {schema_version:number;run_state:string;result:unknown};need(v&&Object.keys(v).sort().join(',')==='result,run_state,schema_version'&&v.schema_version===1&&['RUNNING','PARTIAL','COMPLETED','STOPPED'].includes(v.run_state),'LAB_SETTLEMENT_INVALID');return v;}
function presentOperation(o:any,key:Uint8Array){return{operation_id:String(o.id),run_id:String(o.run_id),state:o.state as 'QUEUED'|'INTENT'|'APPLIED'|'FAILED'|'UNKNOWN',expected_version:amount(o.expected_version),created_at:iso(o.created_at),result:o.result_ciphertext?settlement(o,key).result:null};}
/** Execute in the live F2 authority callback; caller never supplies snapshot or
 * price through HTTP. Capture and estimate are server-derived in that callback. */
/** extras.receipt_policies (RF-19.d): each variant's resolved receipt policy at
 * capture time, sealed with the snapshot so a test keeps the rules it started with. */
export async function startNumberLab(db:ProfileExecutor,a:ProfileAuthority,raw:unknown,captured:LabCapturedConfiguration,estimate:LabEstimate,key:Uint8Array,extras:{receipt_policies?:Record<string,unknown>}={}){
 const now=await authorize(db,a,true),input=numberLabStartSchema.parse(raw),snapshot=validateLabSnapshot(captured.snapshot);
 need(Array.isArray(captured.records)&&labHash(captured.records)===snapshot.configuration_sha256&&captured.records.length===snapshot.sources.length&&captured.records.every(r=>snapshot.sources.some(s=>s.kind===r.kind&&labCanonical(s.ref)===labCanonical(r.ref))),'LAB_CAPTURE_BINDING');
 need(snapshot.workspace_id===db.workspaceId&&snapshot.account.id===input.account_id&&labHash(snapshot)===input.snapshot_sha256&&estimate.snapshot_sha256===input.snapshot_sha256&&estimate.sha256===input.estimate_sha256&&estimate.mode===input.mode,'LAB_START_BINDING');
 const {sha256,...estimated}=estimate;need(labHash(estimated)===sha256&&Date.parse(snapshot.captured_at)<=now.getTime()&&now.getTime()-Date.parse(snapshot.captured_at)<=120000&&Date.parse(estimate.valid_until)>now.getTime(),'LAB_ESTIMATE_EXPIRED');
 const request=labHash({input,actor_id:a.membership.userId});
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('commerce.number-lab.start:'||$1||':'||$2,0))",[db.workspaceId,input.operation_id]);
 const existing=(await db.query('SELECT * FROM commerce_number_lab.runs WHERE workspace_id=$1 AND start_operation_id=$2',[db.workspaceId,input.operation_id])).rows[0];
 if(existing){need(existing.start_request_sha256===request&&existing.actor_id===a.membership.userId,'LAB_OPERATION_CONFLICT');await authorize(db,a,true);return{...presentLabRun(existing),created:false};}
 const runId=randomUUID(),ciphertext=sealLabValue({workspaceId:db.workspaceId,runId,purpose:'snapshot'},{snapshot,estimate,records:captured.records,...(extras.receipt_policies&&Object.keys(extras.receipt_policies).length?{receipt_policies:extras.receipt_policies}:{})},key);
 await authorize(db,a,true);need(Date.parse(estimate.valid_until)>(await dbNow(db)).getTime(),'LAB_ESTIMATE_EXPIRED');
 const r=(await db.query(`INSERT INTO commerce_number_lab.runs(workspace_id,id,source_account_id,actor_id,start_operation_id,start_request_sha256,snapshot_sha256,estimate_sha256,engine_sha256,snapshot_ciphertext,mode,virtual_now,maximum_ai_calls,maximum_microusd)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp(),$12,$13) RETURNING *`,[db.workspaceId,runId,input.account_id,a.membership.userId,input.operation_id,request,input.snapshot_sha256,input.estimate_sha256,snapshot.engine_sha256,ciphertext,input.mode,estimate.maximum_ai_calls,estimate.maximum_microusd])).rows[0];await authorize(db,a,true);return{...presentLabRun(r),created:true};
}
export async function enqueueNumberLab(db:ProfileExecutor,a:ProfileAuthority,runId:string,raw:unknown,key:Uint8Array){
 await authorize(db,a,true);need(uuid.test(runId),'LAB_RUN_ID');const input=numberLabOperationSchema.parse(raw),request=labHash({runId,input,actor_id:a.membership.userId});
 // Serialize before the first lookup. A racing duplicate sees the committed
 // operation rather than a unique violation disguised as another admission.
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('commerce.number-lab.operation:'||$1||':'||$2,0))",[db.workspaceId,input.operation_id]);
 const existing=(await db.query('SELECT * FROM commerce_number_lab.operations WHERE workspace_id=$1 AND id=$2',[db.workspaceId,input.operation_id])).rows[0];
 if(existing){need(existing.run_id===runId&&existing.request_sha256===request&&existing.actor_id===a.membership.userId,'LAB_OPERATION_CONFLICT');await authorize(db,a,true);return{...presentOperation(existing,key),created:false};}
 const ciphertext=sealLabValue({workspaceId:db.workspaceId,runId,purpose:'action',operationId:input.operation_id},input.action,key);
 await authorize(db,a,true);const row=(await db.query('INSERT INTO commerce_number_lab.operations(workspace_id,run_id,id,actor_id,request_sha256,expected_version,action_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[db.workspaceId,runId,input.operation_id,a.membership.userId,request,input.expected_version,ciphertext])).rows[0];await authorize(db,a,true);return{...presentOperation(row,key),created:true};
}
export async function readNumberLab(db:ProfileExecutor,a:ProfileAuthority,runId:string){await authorize(db,a,false);need(uuid.test(runId),'LAB_RUN_ID');const r=(await db.query('SELECT * FROM commerce_number_lab.runs WHERE workspace_id=$1 AND id=$2',[db.workspaceId,runId])).rows[0];await authorize(db,a,false);return r?presentLabRun(r):null;}
/** V7 F6 (RF-19.a/o): a run's operations in order, each with its action and
 * settled result (the transcript travels inside the encrypted result). */
export async function listNumberLabOperations(db:ProfileExecutor,a:ProfileAuthority,runId:string,key:Uint8Array){await authorize(db,a,false);need(uuid.test(runId),'LAB_RUN_ID');
 const rows=(await db.query('SELECT * FROM commerce_number_lab.operations WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at,id LIMIT 500',[db.workspaceId,runId])).rows;await authorize(db,a,false);
 return rows.map(o=>({...presentOperation(o,key),action:numberLabOperationSchema.shape.action.parse(openLabValue({workspaceId:String(o.workspace_id),runId:String(o.run_id),purpose:'action',operationId:String(o.id)},o.action_ciphertext,key))}));}
/** The newest run of the profile, optionally of one number (RF-19.n «última prueba»). */
export async function latestNumberLab(db:ProfileExecutor,a:ProfileAuthority,accountId:string|null){await authorize(db,a,false);need(accountId===null||uuid.test(accountId),'LAB_ACCOUNT_ID');
 const r=(await db.query('SELECT * FROM commerce_number_lab.runs WHERE workspace_id=$1 AND ($2::uuid IS NULL OR source_account_id=$2::uuid) ORDER BY created_at DESC,id LIMIT 1',[db.workspaceId,accountId])).rows[0];await authorize(db,a,false);return r?presentLabRun(r):null;}
/** Variants and releases the run was captured with (never the live catalogue). */
export async function numberLabRunScope(db:ProfileExecutor,a:ProfileAuthority,runId:string,key:Uint8Array){await authorize(db,a,false);need(uuid.test(runId),'LAB_RUN_ID');
 const r=(await db.query('SELECT snapshot_ciphertext,snapshot_sha256 FROM commerce_number_lab.runs WHERE workspace_id=$1 AND id=$2',[db.workspaceId,runId])).rows[0];if(!r)return null;
 const value=openLabValue({workspaceId:db.workspaceId,runId,purpose:'snapshot'},r.snapshot_ciphertext,key) as {snapshot:unknown;estimate:LabEstimate};const snapshot=validateLabSnapshot(value.snapshot);need(labHash(snapshot)===r.snapshot_sha256,'LAB_SNAPSHOT_CHANGED');
 return{captured_at:snapshot.captured_at,ai_configuration_version:snapshot.ai_configuration_version,variants:snapshot.candidates.map(c=>({variant_id:c.release.variant_id,release_id:c.release.id,revision:c.release.revision,amount_minor:c.release.amount_minor,currency:c.release.locale.currency})),
  estimate:{maximum_microusd:value.estimate.maximum_microusd,maximum_ai_calls:value.estimate.maximum_ai_calls,mode:value.estimate.mode}};}
/** V7 RF-19.c: a file material this run captured, for the private in-chat
 * preview. The chat names the laboratory copy (its engine id); the sealed plan
 * maps it back to the captured REAL asset. Only assets in the run's capture are
 * eligible; the caller serves bytes only while REAL still holds the captured ones. */
export async function numberLabRunMaterial(db:ProfileExecutor,a:ProfileAuthority,runId:string,labMaterialId:string,key:Uint8Array){await authorize(db,a,false);need(uuid.test(runId)&&uuid.test(labMaterialId),'LAB_RUN_ID');
 const r=(await db.query('SELECT snapshot_ciphertext,snapshot_sha256 FROM commerce_number_lab.runs WHERE workspace_id=$1 AND id=$2',[db.workspaceId,runId])).rows[0];if(!r)return null;
 const value=openLabValue({workspaceId:db.workspaceId,runId,purpose:'snapshot'},r.snapshot_ciphertext,key) as {snapshot:unknown;records:LabCapturedConfiguration['records']};
 need(labHash(validateLabSnapshot(value.snapshot))===r.snapshot_sha256,'LAB_SNAPSHOT_CHANGED');
 const plan=compileNumberLabConfiguration(value,runId);
 const record=plan.variants.flatMap(v=>v.records).find(x=>x.kind==='asset'&&x.id===labMaterialId),body=record?.body as Record<string,unknown>|undefined;
 if(!record||body?.kind!=='file'||typeof body.sha256!=='string'||typeof body.mime_type!=='string')return null;
 return{source_id:record.source.id,revision:record.source.revision,sha256:body.sha256,size_bytes:Number(body.size_bytes),mime_type:body.mime_type,name:String(body.name??'Material').slice(0,160)};
}
export async function readNumberLabOperation(db:ProfileExecutor,a:ProfileAuthority,runId:string,operationId:string,key:Uint8Array){await authorize(db,a,false);need(uuid.test(runId)&&uuid.test(operationId),'LAB_OPERATION_ID');const o=(await db.query('SELECT * FROM commerce_number_lab.operations WHERE workspace_id=$1 AND run_id=$2 AND id=$3',[db.workspaceId,runId,operationId])).rows[0];await authorize(db,a,false);return o?presentOperation(o,key):null;}
/** V7 RF-19.d: an example receipt for one run, as the customer would send it
 * (image or PDF, ≤4 MiB). Sealed with the control key under purpose
 * 'attachment' (its id is the operation binding); the same bytes twice in one
 * run return the first attachment. Never a REAL asset or a public link. */
export const NUMBER_LAB_ATTACHMENT_MAX=4*1024*1024;
const attachmentSignatures:Record<string,(b:Buffer)=>boolean>={'application/pdf':b=>b.subarray(0,5).toString()==='%PDF-',
 'image/png':b=>b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'image/jpeg':b=>b[0]===255&&b[1]===216&&b[2]===255,
 'image/webp':b=>b.subarray(0,4).toString()==='RIFF'&&b.subarray(8,12).toString()==='WEBP'};
export async function attachNumberLabFile(db:ProfileExecutor,a:ProfileAuthority,runId:string,input:{mime_type:string;base64:string},key:Uint8Array){
 await authorize(db,a,true);need(uuid.test(runId),'LAB_RUN_ID');
 const check=attachmentSignatures[input.mime_type];need(check,'LAB_ATTACHMENT_TYPE');
 const bytes=Buffer.from(input.base64,'base64');need(bytes.length>0&&bytes.length<=NUMBER_LAB_ATTACHMENT_MAX&&bytes.toString('base64').replace(/=+$/,'')===input.base64.replace(/=+$/,''),'LAB_ATTACHMENT_SIZE');
 need(check(bytes),'LAB_ATTACHMENT_TYPE');
 const sha256=createHash('sha256').update(bytes).digest('hex');
 const prior=(await db.query('SELECT id,mime_type,size_bytes,sha256,created_at FROM commerce_number_lab.attachments WHERE workspace_id=$1 AND run_id=$2 AND sha256=$3',[db.workspaceId,runId,sha256])).rows[0];
 if(prior)return{attachment_id:String(prior.id),mime_type:String(prior.mime_type),size_bytes:Number(prior.size_bytes),sha256,created_at:iso(prior.created_at),created:false};
 const id=randomUUID(),sealed=sealLabValue({workspaceId:db.workspaceId,runId,purpose:'attachment',operationId:id},{schema_version:1,mime_type:input.mime_type,sha256,base64:bytes.toString('base64')},key);
 const row=(await db.query('INSERT INTO commerce_number_lab.attachments(workspace_id,run_id,id,actor_id,mime_type,size_bytes,sha256,content_ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at',
  [db.workspaceId,runId,id,a.membership.userId,input.mime_type,bytes.length,sha256,sealed])).rows[0];
 return{attachment_id:id,mime_type:input.mime_type,size_bytes:bytes.length,sha256,created_at:iso(row.created_at),created:true};
}
export async function listNumberLabAttachments(db:ProfileExecutor,a:ProfileAuthority,runId:string){await authorize(db,a,false);need(uuid.test(runId),'LAB_RUN_ID');
 return(await db.query('SELECT id,mime_type,size_bytes,sha256,created_at FROM commerce_number_lab.attachments WHERE workspace_id=$1 AND run_id=$2 ORDER BY created_at,id',[db.workspaceId,runId])).rows
  .map(r=>({attachment_id:String(r.id),mime_type:String(r.mime_type),size_bytes:Number(r.size_bytes),sha256:String(r.sha256),created_at:iso(r.created_at)}));}
/** Bytes of one attachment for its own run (API preview or laboratory worker). */
export async function readNumberLabAttachment(db:ProfileExecutor,runId:string,attachmentId:string,key:Uint8Array){need(uuid.test(runId)&&uuid.test(attachmentId),'LAB_ATTACHMENT_ID');
 const r=(await db.query('SELECT * FROM commerce_number_lab.attachments WHERE workspace_id=$1 AND run_id=$2 AND id=$3',[db.workspaceId,runId,attachmentId])).rows[0];if(!r)return null;
 const v=openLabValue({workspaceId:db.workspaceId,runId,purpose:'attachment',operationId:attachmentId},r.content_ciphertext,key) as {schema_version:number;mime_type:string;sha256:string;base64:string};
 const bytes=Buffer.from(v.base64,'base64');need(v.schema_version===1&&v.mime_type===r.mime_type&&v.sha256===r.sha256&&bytes.length===Number(r.size_bytes)&&createHash('sha256').update(bytes).digest('hex')===r.sha256,'LAB_ATTACHMENT_CHANGED');
 return{id:attachmentId,mime_type:String(r.mime_type),sha256:String(r.sha256),size_bytes:bytes.length,bytes};
}
/** Dedicated lab-control pool, not the API or canonical-engine pool. A claim is
 * usable only after withProfileTransaction confirms COMMIT. No IO inside TX. */
export class NumberLabWorkerStore {
 private readonly key:Uint8Array;
 constructor(private readonly pool:ProfilePool,key:Uint8Array){need(key.length===32,'LAB_CIPHER_KEY');this.key=new Uint8Array(key);}
 private tx<T>(workspaceId:string,work:(db:ProfileExecutor)=>Promise<T>){need(!currentProfileExecutor(),'LAB_OUTER_TRANSACTION');return withProfileTransaction(this.pool,workspaceId,work);}
 async claim(workspaceId:string,runId:string,operationId:string){need(uuid.test(runId)&&uuid.test(operationId),'LAB_OPERATION_ID');return this.tx(workspaceId,async db=>{
  const o=(await db.query('SELECT * FROM commerce_number_lab.operations WHERE workspace_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[workspaceId,runId,operationId])).rows[0];need(o,'LAB_OPERATION_MISSING');if(o.state!=='QUEUED')return{effect:'ALREADY_ATTEMPTED' as const,state:String(o.state)};
  const r=(await db.query('SELECT * FROM commerce_number_lab.runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,runId])).rows[0];need(r,'LAB_RUN_MISSING');
  const payload=openLabValue({workspaceId,runId,purpose:'snapshot'},r.snapshot_ciphertext,this.key) as {snapshot:unknown;estimate:LabEstimate;records:LabCapturedConfiguration['records']};const snapshot=validateLabSnapshot(payload.snapshot);need(labHash(snapshot)===r.snapshot_sha256&&payload.estimate.sha256===r.estimate_sha256&&labHash(payload.records)===snapshot.configuration_sha256,'LAB_SNAPSHOT_CHANGED');
  const action=numberLabOperationSchema.shape.action.parse(openLabValue({workspaceId,runId,purpose:'action',operationId},o.action_ciphertext,this.key));
  await db.query("UPDATE commerce_number_lab.operations SET state='INTENT' WHERE workspace_id=$1 AND run_id=$2 AND id=$3",[workspaceId,runId,operationId]);return{effect:'EXECUTE_ONCE' as const,run:presentLabRun(r),snapshot,estimate:payload.estimate,records:payload.records,action};
 });}
 async finish(workspaceId:string,runId:string,operationId:string,outcome:{state:'APPLIED'|'FAILED'|'UNKNOWN';result:unknown;runState:'RUNNING'|'PARTIAL'|'COMPLETED'|'STOPPED'}){need(uuid.test(runId)&&uuid.test(operationId)&&['APPLIED','FAILED','UNKNOWN'].includes(outcome.state)&&['RUNNING','PARTIAL','COMPLETED','STOPPED'].includes(outcome.runState),'LAB_OUTCOME');return this.tx(workspaceId,async db=>{
  const o=(await db.query('SELECT * FROM commerce_number_lab.operations WHERE workspace_id=$1 AND run_id=$2 AND id=$3 FOR UPDATE',[workspaceId,runId,operationId])).rows[0];need(o,'LAB_OPERATION_MISSING');
  if(o.state!=='INTENT'){need(o.state===outcome.state&&labCanonical(settlement(o,this.key))===labCanonical({schema_version:1,run_state:outcome.runState,result:outcome.result}),'LAB_OPERATION_REPLAY');return presentOperation(o,this.key);}
  const r=(await db.query('SELECT * FROM commerce_number_lab.runs WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,runId])).rows[0];need(r&&amount(r.version)===amount(o.expected_version),'LAB_VERSION_CHANGED');
  const action=numberLabOperationSchema.shape.action.parse(openLabValue({workspaceId,runId,purpose:'action',operationId},o.action_ciphertext,this.key));
  const advanceHours=outcome.state==='APPLIED'&&action.type==='advance'?action.hours:0;
  const result=sealLabValue({workspaceId,runId,purpose:'result',operationId},{schema_version:1,run_state:outcome.runState,result:outcome.result},this.key);
  const saved=(await db.query('UPDATE commerce_number_lab.operations SET state=$4,result_ciphertext=$5 WHERE workspace_id=$1 AND run_id=$2 AND id=$3 RETURNING *',[workspaceId,runId,operationId,outcome.state,result])).rows[0];
  await db.query("UPDATE commerce_number_lab.runs SET state=$3,version=version+1,virtual_now=virtual_now+($4::int*interval '1 hour') WHERE workspace_id=$1 AND id=$2",[workspaceId,runId,outcome.runState,advanceHours]);return presentOperation(saved,this.key);
 });}
}
export type {NumberLabOperation,NumberLabAction};
/** Lost start response is queried by its original operation UUID, even after
 * the estimate expires. A query cannot reserve a second run or renew a price. */
export async function readNumberLabStartOperation(db:ProfileExecutor,a:ProfileAuthority,operationId:string){await authorize(db,a,false);need(uuid.test(operationId),'LAB_OPERATION_ID');const r=(await db.query('SELECT * FROM commerce_number_lab.runs WHERE workspace_id=$1 AND actor_id=$2 AND start_operation_id=$3',[db.workspaceId,a.membership.userId,operationId])).rows[0];await authorize(db,a,false);return r?presentLabRun(r):null;}
