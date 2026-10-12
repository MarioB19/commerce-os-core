import {createCipheriv,createDecipheriv,randomBytes,randomUUID} from 'node:crypto';
import {numberLabStartSchema,numberLabOperationSchema,labCiphertextSchema,type NumberLabOperation,type NumberLabAction} from '../../contracts/src/number-laboratory.js';
import {labHash,labCanonical,validateLabSnapshot,type LabEstimate} from '../../domain/src/laboratory/number-lab.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import {withProfileTransaction,type ProfileExecutor,type ProfilePool} from './profile-context.js';
import {currentProfileExecutor} from './profile-query-routing.js';
import type {LabCapturedConfiguration} from './number-lab-snapshot.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function need(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
const iso=(v:unknown)=>new Date(v instanceof Date?v.getTime():String(v)).toISOString();
const amount=(v:unknown)=>{const n=Number(v);need(Number.isSafeInteger(n)&&n>=0,'LAB_INVALID_COUNT');return n;};
export interface LabCipherBinding {workspaceId:string;runId:string;purpose:'snapshot'|'action'|'result';operationId?:string}
function aad(b:LabCipherBinding){need(typeof b.workspaceId==='string'&&b.workspaceId.length>0&&b.workspaceId.length<=256&&!b.workspaceId.includes('\0')&&uuid.test(b.runId)&&['snapshot','action','result'].includes(b.purpose)&&(b.purpose==='snapshot'?b.operationId===undefined:typeof b.operationId==='string'&&uuid.test(b.operationId)),'LAB_CIPHER_SCOPE');return Buffer.from(labCanonical({protocol:'commerce.number-lab.v1',...b}));}
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
export async function startNumberLab(db:ProfileExecutor,a:ProfileAuthority,raw:unknown,captured:LabCapturedConfiguration,estimate:LabEstimate,key:Uint8Array){
 const now=await authorize(db,a,true),input=numberLabStartSchema.parse(raw),snapshot=validateLabSnapshot(captured.snapshot);
 need(Array.isArray(captured.records)&&labHash(captured.records)===snapshot.configuration_sha256&&captured.records.length===snapshot.sources.length&&captured.records.every(r=>snapshot.sources.some(s=>s.kind===r.kind&&labCanonical(s.ref)===labCanonical(r.ref))),'LAB_CAPTURE_BINDING');
 need(snapshot.workspace_id===db.workspaceId&&snapshot.account.id===input.account_id&&labHash(snapshot)===input.snapshot_sha256&&estimate.snapshot_sha256===input.snapshot_sha256&&estimate.sha256===input.estimate_sha256&&estimate.mode===input.mode,'LAB_START_BINDING');
 const {sha256,...estimated}=estimate;need(labHash(estimated)===sha256&&Date.parse(snapshot.captured_at)<=now.getTime()&&now.getTime()-Date.parse(snapshot.captured_at)<=120000&&Date.parse(estimate.valid_until)>now.getTime(),'LAB_ESTIMATE_EXPIRED');
 const request=labHash({input,actor_id:a.membership.userId});
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('commerce.number-lab.start:'||$1||':'||$2,0))",[db.workspaceId,input.operation_id]);
 const existing=(await db.query('SELECT * FROM commerce_number_lab.runs WHERE workspace_id=$1 AND start_operation_id=$2',[db.workspaceId,input.operation_id])).rows[0];
 if(existing){need(existing.start_request_sha256===request&&existing.actor_id===a.membership.userId,'LAB_OPERATION_CONFLICT');await authorize(db,a,true);return{...presentLabRun(existing),created:false};}
 const runId=randomUUID(),ciphertext=sealLabValue({workspaceId:db.workspaceId,runId,purpose:'snapshot'},{snapshot,estimate,records:captured.records},key);
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
export async function readNumberLabOperation(db:ProfileExecutor,a:ProfileAuthority,runId:string,operationId:string,key:Uint8Array){await authorize(db,a,false);need(uuid.test(runId)&&uuid.test(operationId),'LAB_OPERATION_ID');const o=(await db.query('SELECT * FROM commerce_number_lab.operations WHERE workspace_id=$1 AND run_id=$2 AND id=$3',[db.workspaceId,runId,operationId])).rows[0];await authorize(db,a,false);return o?presentOperation(o,key):null;}
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
