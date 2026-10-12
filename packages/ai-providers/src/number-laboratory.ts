import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../db/src/profile-context.js';
import {currentProfileExecutor} from '../../db/src/profile-query-routing.js';
import {PostgresAiPorts} from './persistence.js';
import {requireAi,type AdmissionPort,type CredentialPort,type Scope,type Quote,type RequestIdentity,type Outcome,type Provider} from './contracts.js';
import {labCanonical,labHash,type LabEstimate} from '../../domain/src/laboratory/number-lab.js';
import {marketReleaseHash} from '../../domain/src/catalog/market-variants.js';
import type {NumberLabSnapshot} from '../../contracts/src/number-laboratory.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface LabAiBinding {workspaceId:string;runId:string;operationId:string;variantId:string;releaseId:string;snapshotSha256:string;attemptId:string;grantId:string}
/** Called in the same authorized transaction as startNumberLab. A missing row
 * cannot be filled later after execution begins; the budget/price stays frozen. */
export async function bindNumberLabReleases(db:ProfileExecutor,runId:string,snapshot:NumberLabSnapshot,estimate:LabEstimate){
 requireAi(uuid.test(runId)&&snapshot.workspace_id===db.workspaceId&&labHash(snapshot)===estimate.snapshot_sha256,'AUTHORITY');
 for(const c of snapshot.candidates){const cases=estimate.cases.filter(x=>x.variant_id===c.release.variant_id);requireAi(cases.length>0&&cases.every(x=>x.release_id===c.release.id&&labCanonical(x.quote)===labCanonical(cases[0]!.quote)),'AUTHORITY');
  const quote=cases[0]!.quote,maximumCalls=cases.reduce((sum,c)=>sum+c.maximum_ai_calls,0);
  await db.query('INSERT INTO commerce_number_lab.run_releases(workspace_id,run_id,variant_id,release_id,release_sha256,quote,maximum_calls) VALUES($1,$2,$3,$4,$5,$6,$7)',[db.workspaceId,runId,c.release.variant_id,c.release.id,marketReleaseHash(c.release),quote,maximumCalls]);
 }
}
/** Explicit environment bridge, not a user-selected provider/environment flag.
 * The base 019 ports and native budget lock remain unchanged. Lab callers only
 * receive a capability for the fixed run/operation/variant/attempt constructor.
 * A normal 019 port lacks the control-role privilege to create its binding. */
export class NumberLabAiPorts implements AdmissionPort,CredentialPort {
 private readonly binding:Readonly<LabAiBinding>;
 private readonly enterprise:PostgresAiPorts;
 constructor(private readonly labControlPool:ProfilePool,enterprisePool:ProfilePool,binding:LabAiBinding,key:Uint8Array){
  requireAi(typeof binding.workspaceId==='string'&&binding.workspaceId.length>0&&binding.workspaceId.length<=256&&!binding.workspaceId.includes('\0')&&Object.keys(binding).sort().join(',')==='attemptId,grantId,operationId,releaseId,runId,snapshotSha256,variantId,workspaceId'&&[binding.runId,binding.operationId,binding.variantId,binding.releaseId,binding.attemptId,binding.grantId].every(v=>uuid.test(v))&&/^[a-f0-9]{64}$/.test(binding.snapshotSha256),'AUTHORITY');
  this.binding=Object.freeze({...binding});this.enterprise=new PostgresAiPorts(enterprisePool,binding.grantId,key);
 }
 private inner(scope:Scope):Scope {const b=this.binding;requireAi(!currentProfileExecutor()&&scope.workspaceId===b.workspaceId&&scope.profileId===b.workspaceId&&scope.variantId===b.variantId&&scope.attemptId===b.attemptId&&scope.environment==='SIMULATION'&&scope.conversationId===undefined&&['laboratory.chat','laboratory.vision','laboratory.audio'].includes(scope.task),'AUTHORITY');return{...scope,environment:'REAL'};}
 async reserve(scope:Scope,quote:Quote,request:RequestIdentity){const inner=this.inner(scope),b=this.binding;requireAi(scope.task==='laboratory.'+request.capability,'AUTHORITY');
  await withProfileTransaction(this.labControlPool,b.workspaceId,async db=>{
   await db.query('SELECT public.ai_scope_lock($1,$2)',[b.workspaceId,'REAL']);
   const prior=(await db.query('SELECT * FROM commerce_number_lab.ai_bindings WHERE workspace_id=$1 AND budget_environment=$2 AND attempt_id=$3',[b.workspaceId,'REAL',b.attemptId])).rows[0];
   const expected=[b.runId,b.operationId,b.variantId,b.releaseId,b.snapshotSha256,b.grantId,request.sha256,request.bytes,request.capability,quote.maximumMicrousd];
   if(prior){requireAi(labCanonical([prior.run_id,prior.operation_id,prior.variant_id,prior.release_id,prior.snapshot_sha256,prior.grant_id,prior.request_sha256,prior.request_bytes,prior.capability,Number(prior.maximum_microusd)])===labCanonical(expected),'AUTHORITY');return;}
   await db.query('INSERT INTO commerce_number_lab.ai_bindings(workspace_id,attempt_id,run_id,operation_id,variant_id,release_id,snapshot_sha256,grant_id,request_sha256,request_bytes,capability,maximum_microusd) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[b.workspaceId,b.attemptId,...expected]);
  });
  return this.enterprise.reserve(inner,quote,request);
 }
 async acquire(scope:Scope,provider:Provider){const inner=this.inner(scope),key=await this.enterprise.acquire(inner,provider);requireAi(key.environment==='REAL'&&key.workspaceId===this.binding.workspaceId&&key.profileId===this.binding.workspaceId,'CREDENTIAL_SCOPE');return{...key,environment:'SIMULATION' as const};}
 beforeSend(scope:Scope,q:Quote,reservationId:string,binding:{request:RequestIdentity;credentialVersion:number}){return this.enterprise.beforeSend(this.inner(scope),q,reservationId,binding);}
 record(scope:Scope,reservationId:string,outcome:Outcome){return this.enterprise.record(this.inner(scope),reservationId,outcome);}
}
