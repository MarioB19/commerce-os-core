import {z} from 'zod';
import type {DomainRecord} from '@commerce/contracts';
import type {ProfileExecutor,ProfilePool} from '../../../packages/db/src/profile-context.js';
import type {NumberLabEnginePorts} from '../../../packages/db/src/number-lab-engine-runtime.js';
import {PostgresNumberLabSellerAi,type LaboratorySellerResult} from '../../../packages/ai-providers/src/laboratory-seller.js';

const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema=z.object({workspaceId:z.string().min(1).max(256),runId:uuid,operationId:uuid,snapshotSha256:sha,
 variantId:uuid,releaseId:uuid,grantId:uuid,conversationId:uuid,accountId:uuid,offerId:uuid,agentId:uuid}).strict();
type Binding=z.infer<typeof bindingSchema>;
export interface NumberLabSeller {readonly kind:'NUMBER_LAB_SELLER'}
export interface NumberLabSellerOptions {
 readonly binding:Binding;readonly controlPool:ProfilePool;readonly enterprisePool:ProfilePool;readonly custodyKey:Uint8Array;
 readonly maximumMicrousd:number;readonly timeoutMs?:number;readonly fetcher?:typeof fetch;readonly clock?:()=>number;
}
interface State {readonly options:Readonly<NumberLabSellerOptions>;used:boolean}
const sellers=new WeakMap<object,State>();
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
/** Protected host factory; there is no public selector for these dependencies. */
export function createNumberLabSeller(options:NumberLabSellerOptions):NumberLabSeller{
 const binding=Object.freeze(bindingSchema.parse(options.binding));
 need(options.custodyKey.length===32&&Number.isSafeInteger(options.maximumMicrousd)&&options.maximumMicrousd>0,'LAB_SELLER_CONFIGURATION');
 const handle=Object.freeze({kind:'NUMBER_LAB_SELLER' as const});
 sellers.set(handle,{options:Object.freeze({...options,binding,custodyKey:new Uint8Array(options.custodyKey)}),used:false});return handle;
}
export function bindNumberLabSeller(handle:NumberLabSeller,ports:NumberLabEnginePorts){
 const state=handle&&sellers.get(handle);need(state&&!state.used,'LAB_SELLER_REQUIRED');
 const o=state.options,b=o.binding;
 need(ports.workspaceId==='number-lab:'+b.runId&&ports.binding.runId===b.runId&&ports.binding.operationId===b.operationId&&ports.binding.snapshotSha256===b.snapshotSha256,'LAB_SELLER_BINDING');state.used=true;
 function validate(conv:DomainRecord,agent?:DomainRecord){
  need(conv.workspace_id===ports.workspaceId&&conv.environment==='SIMULATION'&&conv.id===b.conversationId
   &&conv.body.simulation_id===b.runId&&conv.body.account_id===b.accountId&&conv.body.offer_version_id===b.offerId
   &&conv.body.agent_version_id===b.agentId&&agent?.id===b.agentId&&agent.workspace_id===ports.workspaceId&&agent.environment==='SIMULATION','LAB_SELLER_CONTEXT_CHANGED');
 }
 const client=(attemptId:string)=>new PostgresNumberLabSellerAi({...o,binding:{workspaceId:b.workspaceId,runId:b.runId,operationId:b.operationId,snapshotSha256:b.snapshotSha256,variantId:b.variantId,releaseId:b.releaseId,grantId:b.grantId,attemptId}});
 return Object.freeze({conversationId:b.conversationId,validate,
  async proposalTransaction<T>(conv:DomainRecord,agent:DomainRecord|undefined,run:DomainRecord,fresh:LaboratorySellerResult|undefined,instructions:string,context:Record<string,unknown>,work:(db:ProfileExecutor,admitted:boolean)=>Promise<T>):Promise<T>{
   validate(conv,agent);uuid.parse(run.id);need(run.workspace_id===ports.workspaceId&&run.environment==='SIMULATION'&&run.kind==='ai_run'
    &&run.body.conversation_id===conv.id,'LAB_SELLER_PROPOSAL_REQUIRED');
   if(fresh)need(run.body.status==='RUNNING'&&fresh.attemptId===run.id&&fresh.executionEnvironment==='SIMULATION'
    &&fresh.operationClass==='TEST'&&fresh.invocation.state==='SUCCEEDED','LAB_SELLER_PROPOSAL_REQUIRED');
   else need(run.body.status==='AWAITING_EFFECT'&&run.body.lab_ai?.attempt_id===run.id
    &&run.body.lab_ai.execution_environment==='SIMULATION'&&run.body.lab_ai.operation_class==='TEST'&&run.body.lab_ai.state==='SUCCEEDED','LAB_SELLER_PROPOSAL_REQUIRED');
   let admitted=false;
   return ports.transactionUnderAuthority({withAuthority(binding,phase){
    need(binding===ports.binding,'LAB_SELLER_BINDING');
    return client(run.id).withCachedAuthority(instructions,context,(allowed,clock)=>{admitted=allowed;return phase(clock);});
   }},db=>work(db,admitted));
  },
  async invoke(conv:DomainRecord,agent:DomainRecord|undefined,attemptId:string,instructions:string,context:Record<string,unknown>,beforeAdmission:()=>Promise<void>):Promise<LaboratorySellerResult>{
   validate(conv,agent);uuid.parse(attemptId);
   return client(attemptId).invoke(instructions,context,beforeAdmission);
  },
 });
}
