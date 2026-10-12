import {z} from 'zod';
import {withProfileTransaction,type ProfilePool} from '../../db/src/profile-context.js';
import {currentProfileExecutor} from '../../db/src/profile-query-routing.js';
import {currentWorkerProfile} from '../../db/src/profile-worker-scope.js';
import {parseProposal,sellerProposalInstructions,type AgentProposal} from '../../domain/src/sales/ai.js';
import {ProviderAdapter,type Invocation} from './client.js';
import {NumberLabAiPorts,type LabAiBinding} from './number-laboratory.js';
import {modelFromRow} from './persistence.js';
import {request,requestIdentity} from './protocol.js';
import {requireAi,type Input,type Scope,type Provider} from './contracts.js';

const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema=z.object({workspaceId:z.string().min(1).max(256).refine(s=>!s.includes('\0')),
 runId:uuid,operationId:uuid,variantId:uuid,releaseId:uuid,snapshotSha256:sha,attemptId:uuid,grantId:uuid}).strict();
/** Same instructions and semantic payload as the canonical seller. The context
 * is produced by composeSellerContext, never interpreted as instructions. */
export function laboratorySellerInput(instructions:string,context:Record<string,unknown>):Input{
 requireAi(typeof instructions==='string'&&Buffer.byteLength(instructions)<=32768&&context!==null&&typeof context==='object'&&!Array.isArray(context),'INPUT_LIMIT');
 const text=JSON.stringify({context,knowledge:''});requireAi(Buffer.byteLength(text)<=524288,'INPUT_LIMIT');
 return{capability:'chat',instructions:sellerProposalInstructions(instructions),text};
}
export function parseLaboratorySeller(text:string):AgentProposal{
 requireAi(typeof text==='string'&&Buffer.byteLength(text)<=65536,'OUTPUT_REJECTED');
 return parseProposal(JSON.parse(text));
}
export type LaboratorySellerResult={provider:Provider;model:string;attemptId:string;executionEnvironment:'SIMULATION';operationClass:'TEST';invocation:Invocation<AgentProposal>};
/** Protected host composition only. The public action cannot supply this
 * object or its binding. It does not mint any grant or copy a credential. */
export class PostgresNumberLabSellerAi {
 private readonly key:Uint8Array;
 readonly binding:Readonly<LabAiBinding>;
 constructor(private readonly options:{controlPool:ProfilePool;enterprisePool:ProfilePool;binding:LabAiBinding;
  custodyKey:Uint8Array;maximumMicrousd:number;timeoutMs?:number;fetcher?:typeof fetch;clock?:()=>number}){
  this.binding=Object.freeze(bindingSchema.parse(options.binding));
  requireAi(options.custodyKey.length===32&&Number.isSafeInteger(options.maximumMicrousd)&&options.maximumMicrousd>0,'CONFIGURATION');
  requireAi(options.timeoutMs===undefined||Number.isInteger(options.timeoutMs)&&options.timeoutMs>=1000&&options.timeoutMs<=60000,'CONFIGURATION');this.key=new Uint8Array(options.custodyKey);
 }
 /** Read-only reuse of an already paid result. Locks stay held while the
  * caller commits one engine SQL phase; no key is decrypted or sent. */
 async withCachedAuthority<T>(instructions:string,context:Record<string,unknown>,work:(admitted:boolean,checkClock:()=>Promise<void>)=>Promise<T>):Promise<T>{
  requireAi(!currentProfileExecutor()&&!currentWorkerProfile(),'AUTHORITY');
  const b=this.binding,input=laboratorySellerInput(instructions,context);
  return withProfileTransaction(this.options.controlPool,b.workspaceId,async db=>{
   const role=(await db.query('SELECT current_user AS role')).rows;requireAi(role.length===1&&role[0].role==='commerce_number_lab','AUTHORITY');
   await db.query("SELECT set_config('app.environment','REAL',true)");
   const rows=(await db.query('SELECT commerce_number_lab.lock_cached_seller($1,$2,$3,$4,$5,$6,$7,$8) AS authority',
    [b.workspaceId,b.runId,b.operationId,b.attemptId,b.variantId,b.releaseId,b.grantId,b.snapshotSha256])).rows;
   requireAi(rows.length===1,'AUTHORITY');const a=rows[0].authority;
   if(a===null)return work(false,async()=>undefined);
   const model=modelFromRow(a,new Date(a.observed_at).getTime()),wire=request(model,input),identity=requestIdentity(model,input,wire.bytes);
   if(identity.sha256!==a.request_sha256||identity.bytes!==a.request_bytes)return work(false,async()=>undefined);
   requireAi(typeof a.valid_until_cache==='string','AUTHORITY');
   return work(true,async()=>{const current=(await db.query('SELECT $1::timestamptz>clock_timestamp() AS live',[a.valid_until_cache])).rows;
    requireAi(current.length===1&&current[0].live===true,'AUTHORITY');});
  });
 }
 async invoke(instructions:string,context:Record<string,unknown>,beforeAdmission:()=>Promise<void>):Promise<LaboratorySellerResult>{
  requireAi(!currentProfileExecutor()&&!currentWorkerProfile(),'AUTHORITY');
  const o=this.options,b=this.binding,input=laboratorySellerInput(instructions,context);
  const scope:Scope={workspaceId:b.workspaceId,profileId:b.workspaceId,variantId:b.variantId,attemptId:b.attemptId,task:'laboratory.chat',environment:'SIMULATION'};
  const model=await withProfileTransaction(o.enterprisePool,b.workspaceId,async db=>{
   const role=(await db.query('SELECT current_user AS role')).rows;requireAi(role.length===1&&role[0].role==='commerce_ai','AUTHORITY');
   await db.query("SELECT set_config('app.environment','REAL',true)");
   const rows=(await db.query(`SELECT g.*,p.model_document,p.valid_from,p.valid_until,p.input_ceiling,p.output_ceiling,p.input_rate,p.output_rate,p.cache_read_rate,p.cache_write_rate,p.audio_input_rate
    FROM ai_runtime_grants g JOIN ai_model_prices p ON(p.provider,p.model,p.model_revision,p.price_version)=(g.provider,g.model,g.model_revision,g.price_version)
    WHERE g.workspace_id=$1 AND g.environment='REAL' AND g.id=$2`,[b.workspaceId,b.grantId])).rows;
   const g=rows[0],now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
   requireAi(rows.length===1&&g.variant_id===b.variantId&&g.task===scope.task&&!g.is_test&&!g.revoked_at&&new Date(g.expires_at).getTime()>now,'AUTHORITY');
   const model=modelFromRow(g,now);requireAi(model.capabilities.includes('chat'),'CAPABILITY');return model;
  });
  const ports=new NumberLabAiPorts(o.controlPool,o.enterprisePool,b,this.key);
  const adapter=new ProviderAdapter(model.provider,{credentials:ports,admission:{reserve:(...args)=>ports.reserve(...args),record:(...args)=>ports.record(...args),
   // Canonical controls first, then native019/021 INTENT is the last I/O. A
   // callback revoking key/grant/profile cannot leave stale authority to POST.
   beforeSend:async(...args)=>{await beforeAdmission();await ports.beforeSend(...args);},
  },fetcher:o.fetcher,clock:o.clock});
  const invocation=await adapter.invoke({scope,model,input,budgetMicrousd:o.maximumMicrousd,timeoutMs:o.timeoutMs??15000,parse:parseLaboratorySeller});
  return{provider:model.provider,model:model.model,attemptId:b.attemptId,executionEnvironment:'SIMULATION',operationClass:'TEST',invocation};
 }
}
