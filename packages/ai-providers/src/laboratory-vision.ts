import {createHash} from 'node:crypto';
import {z} from 'zod';
import {withProfileTransaction,type ProfilePool} from '../../db/src/profile-context.js';
import {currentProfileExecutor} from '../../db/src/profile-query-routing.js';
import {currentWorkerProfile} from '../../db/src/profile-worker-scope.js';
import {ProviderAdapter,type Invocation} from './client.js';
import {NumberLabAiPorts,type LabAiBinding} from './number-laboratory.js';
import {modelFromRow} from './persistence.js';
import {RECEIPT_DOCUMENT_INSTRUCTIONS,parseReceiptDocument,type ReceiptDocumentExtraction} from './receipt-document.js';
import {requireAi,type Input,type Scope,type Provider} from './contracts.js';

/** V7 RF-19.d: reading an example receipt in «Probar número» with the
 * profile's own key (task laboratory.vision), the same instructions and parser
 * as production (receipt.document). The extraction then goes through the
 * canonical receipt policy of the captured variant in the laboratory engine,
 * so the same inputs give the same reasons. Never REAL, never a customer. */
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema=z.object({workspaceId:z.string().min(1).max(256).refine(s=>!s.includes('\0')),
 runId:uuid,operationId:uuid,variantId:uuid,releaseId:uuid,snapshotSha256:sha,attemptId:uuid,grantId:uuid}).strict();
export const laboratoryReceiptSchema=z.object({attachmentId:uuid,sha256:sha,mimeType:z.enum(['image/png','image/jpeg','image/webp','application/pdf'])}).strict();
/** One stable attempt per run operation: a retried operation never pays twice. */
export function laboratoryVisionAttempt(runId:string,operationId:string){
 const h=createHash('sha256').update(JSON.stringify(['commerce.number-lab.vision.v1',uuid.parse(runId),uuid.parse(operationId)])).digest('hex');
 return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}
export function laboratoryVisionInput(receipt:z.infer<typeof laboratoryReceiptSchema>,bytes:Uint8Array):Input{
 const r=laboratoryReceiptSchema.parse(receipt);
 requireAi(bytes instanceof Uint8Array&&bytes.byteLength>0&&bytes.byteLength<=4*1024*1024,'INPUT_LIMIT');
 requireAi(createHash('sha256').update(bytes).digest('hex')===r.sha256,'AUTHORITY');
 return{capability:'vision',instructions:RECEIPT_DOCUMENT_INSTRUCTIONS,
  text:JSON.stringify({task:'receipt.document',receipt:r.attachmentId,asset_sha256:r.sha256,environment:'SIMULATION'}),media:{mimeType:r.mimeType,bytes}};
}
export type LaboratoryVisionResult={provider:Provider;model:string;attemptId:string;executionEnvironment:'SIMULATION';operationClass:'TEST';invocation:Invocation<ReceiptDocumentExtraction>};
/** Protected host composition only; the public action cannot supply it. */
export class PostgresNumberLabVisionAi {
 private readonly key:Uint8Array;
 readonly binding:Readonly<LabAiBinding>;
 constructor(private readonly options:{controlPool:ProfilePool;enterprisePool:ProfilePool;binding:LabAiBinding;
  custodyKey:Uint8Array;maximumMicrousd:number;timeoutMs?:number;fetcher?:typeof fetch;clock?:()=>number}){
  this.binding=Object.freeze(bindingSchema.parse(options.binding));
  requireAi(options.custodyKey.length===32&&Number.isSafeInteger(options.maximumMicrousd)&&options.maximumMicrousd>0,'CONFIGURATION');
  requireAi(options.timeoutMs===undefined||Number.isInteger(options.timeoutMs)&&options.timeoutMs>=1000&&options.timeoutMs<=60000,'CONFIGURATION');this.key=new Uint8Array(options.custodyKey);
 }
 async invoke(receipt:z.infer<typeof laboratoryReceiptSchema>,bytes:Uint8Array):Promise<LaboratoryVisionResult>{
  requireAi(!currentProfileExecutor()&&!currentWorkerProfile(),'AUTHORITY');
  const o=this.options,b=this.binding,input=laboratoryVisionInput(receipt,Uint8Array.from(bytes));
  const scope:Scope={workspaceId:b.workspaceId,profileId:b.workspaceId,variantId:b.variantId,attemptId:b.attemptId,task:'laboratory.vision',environment:'SIMULATION'};
  const model=await withProfileTransaction(o.enterprisePool,b.workspaceId,async db=>{
   const role=(await db.query('SELECT current_user AS role')).rows;requireAi(role.length===1&&role[0].role==='commerce_ai','AUTHORITY');
   await db.query("SELECT set_config('app.environment','REAL',true)");
   const rows=(await db.query(`SELECT g.*,p.model_document,p.valid_from,p.valid_until,p.input_ceiling,p.output_ceiling,p.input_rate,p.output_rate,p.cache_read_rate,p.cache_write_rate,p.audio_input_rate
    FROM ai_runtime_grants g JOIN ai_model_prices p ON(p.provider,p.model,p.model_revision,p.price_version)=(g.provider,g.model,g.model_revision,g.price_version)
    WHERE g.workspace_id=$1 AND g.environment='REAL' AND g.id=$2`,[b.workspaceId,b.grantId])).rows;
   const g=rows[0],now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
   requireAi(rows.length===1&&g.variant_id===b.variantId&&g.task===scope.task&&!g.is_test&&!g.revoked_at&&new Date(g.expires_at).getTime()>now,'AUTHORITY');
   const model=modelFromRow(g,now);requireAi(model.capabilities.includes('vision'),'CAPABILITY');return model;
  });
  const ports=new NumberLabAiPorts(o.controlPool,o.enterprisePool,b,this.key);
  const adapter=new ProviderAdapter(model.provider,{credentials:ports,admission:{reserve:(...args)=>ports.reserve(...args),record:(...args)=>ports.record(...args),
   beforeSend:(...args)=>ports.beforeSend(...args)},fetcher:o.fetcher,clock:o.clock});
  const invocation=await adapter.invoke({scope,model,input,budgetMicrousd:o.maximumMicrousd,timeoutMs:o.timeoutMs??15000,parse:parseReceiptDocument});
  return{provider:model.provider,model:model.model,attemptId:b.attemptId,executionEnvironment:'SIMULATION',operationClass:'TEST',invocation};
 }
}
