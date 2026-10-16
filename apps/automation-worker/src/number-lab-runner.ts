import pg from 'pg';
import type {ProfilePool} from '../../../packages/db/src/profile-context.js';
import {withProfileTransaction} from '../../../packages/db/src/profile-context.js';
import {numberLabKeys} from '../../../packages/db/src/number-laboratory.js';
import {advanceNumberLabSuites} from '../../../packages/db/src/number-lab-suites.js';
import {createNumberLabMaterialCustody,createNumberLabMaterialReader,createNumberLabReceiptCustody} from '../../../packages/db/src/number-lab-material-custody.js';
import type {NumberLabEngineIdentity} from '../../../packages/db/src/number-lab-engine-runtime.js';
import {createNumberLabDriver,type NumberLabDriverSellerConfiguration} from './number-lab-driver.js';
import {aiCredentialKey} from '../../../packages/ai-providers/src/profile-integrations.js';
import {profileAiPool} from './ai-runtime.js';

/** V7 F6 (RF-19): the number laboratory runs inside the automation worker
 * host but only through its own logins: control (commerce_number_lab), engine
 * and seed (dedicated `commerce_lab_engine_*` database), material source
 * (commerce_api read path) and, for the seller, the business AI login. Nothing
 * here can reach REAL commercial tables, WAHA or the outbox: the transport is
 * the in-engine simulator. Absent configuration disables the laboratory. */
export interface NumberLabRuntime {control:ProfilePool;engine:ProfilePool;seed:ProfilePool;source:ProfilePool;identity:NumberLabEngineIdentity;
 keys:ReturnType<typeof numberLabKeys>;sourceRoot:string;laboratoryRoot:string;ai:{pool:pg.Pool;custodyKey:Uint8Array}|null;fetcher?:typeof fetch;close():Promise<void>}
function rolePool(url:string,role:string,max=3):{pool:ProfilePool;native:pg.Pool}{
 const native=new pg.Pool({connectionString:url,max,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
 native.on('error',()=>{process.stderr.write('number_lab_idle_connection_failed\n');});
 return{native,pool:{async connect(){const c=await native.connect();try{await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:c.release.bind(c)};}catch(e){c.release(true);throw e;}}}};
}
export function numberLabRuntimeFromEnv(env=process.env):NumberLabRuntime|null{
 const need=['LAB_CONTROL_DATABASE_URL','LAB_ENGINE_DATABASE_URL','LAB_SEED_DATABASE_URL','LAB_SOURCE_DATABASE_URL','LAB_ENGINE_DATABASE','LAB_INSTALLATION_ID','LAB_ENGINE_SHA256','LAB_PRIVATE_STORAGE_DIR'];
 if(need.some(k=>!env[k]))return null;
 const sourceRoot=env.PRIVATE_STORAGE_DIR??env.ASSET_STORAGE_DIR;if(!sourceRoot)return null;
 const control=rolePool(env.LAB_CONTROL_DATABASE_URL!,'commerce_number_lab',4),engine=rolePool(env.LAB_ENGINE_DATABASE_URL!,'commerce_lab_engine',4),
  seed=rolePool(env.LAB_SEED_DATABASE_URL!,'commerce_lab_engine_seed',3),source=rolePool(env.LAB_SOURCE_DATABASE_URL!,'commerce_api',2);
 const aiPool=profileAiPool(),custody=(()=>{try{return aiPool?aiCredentialKey():null;}catch{return null;}})();
 return{control:control.pool,engine:engine.pool,seed:seed.pool,source:source.pool,
  identity:Object.freeze({database:env.LAB_ENGINE_DATABASE!,installationId:env.LAB_INSTALLATION_ID!,engineSha256:env.LAB_ENGINE_SHA256!}),
  keys:numberLabKeys(),sourceRoot,laboratoryRoot:env.LAB_PRIVATE_STORAGE_DIR!,ai:aiPool&&custody?{pool:aiPool,custodyKey:custody}:null,
  async close(){await Promise.all([control.native.end(),engine.native.end(),seed.native.end(),source.native.end()]);}};
}
/** Laboratory grants of one run: the seller (task laboratory.chat) and the
 * receipt reading (task laboratory.vision, RF-19.d), each on exactly the model
 * the run was priced with (its run_releases quote, which also guards every AI
 * binding). A variant may hold grants for several providers after the owner
 * changes the profile's model; an older one must never be picked. */
async function labGrants(ai:{pool:pg.Pool},workspaceId:string,runId:string,task:'laboratory.chat'|'laboratory.vision'){
 return withProfileTransaction(ai.pool as never,workspaceId,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");
  const rows=(await db.query(`SELECT DISTINCT ON(g.variant_id) g.id,g.variant_id FROM ai_runtime_grants g
    JOIN commerce_number_lab.run_releases v ON v.workspace_id=g.workspace_id AND v.run_id=$3::uuid AND v.variant_id=g.variant_id
   WHERE g.workspace_id=$1 AND g.environment='REAL' AND g.task=$2 AND NOT g.is_test AND g.revoked_at IS NULL AND g.variant_id IS NOT NULL
    AND g.expires_at>clock_timestamp()+interval '5 minutes'
    AND (g.provider,g.model,g.model_revision,g.price_version)=(v.quote->>'provider',v.quote->>'model',v.quote->>'modelRevision',v.quote->>'priceVersion')
   ORDER BY g.variant_id,g.expires_at DESC,g.id`,[workspaceId,task,runId])).rows as {id:string;variant_id:string}[];
  return Object.fromEntries(rows.map(r=>[r.variant_id,r.id])) as Record<string,string>;});
}
export const LAB_SELLER_MAXIMUM_MICROUSD=250_000;
/** One bounded pass: the next queued operation of each run, executed once by
 * the canonical driver. A failure is reported by code; the operation keeps its
 * native state (INTENT/UNKNOWN) for reconciliation, never a blind retry. */
export async function processNumberLabOperations(runtime:NumberLabRuntime|null,limit=3){
 if(!runtime)return 0;
 // RF-19.p: the automatic buyer queues the next step of each due journey
 // first; the queued steps then run below like any other operation.
 try{await advanceNumberLabSuites(runtime.control,runtime.keys.control,10);}catch(error){process.stderr.write(`number_lab_suites_failed ${code(error)}\n`);if(process.env.LAB_DEBUG)console.error(error);}
 // Discovery crosses profiles only through the SECURITY DEFINER function, which
 // binds each profile itself and returns identifiers, never content.
 let queued:{workspace_id:string;run_id:string;operation_id:string;stage:'EXECUTE'|'RECONCILE'}[]=[];
 try{const c=await runtime.control.connect();try{queued=(await c.query('SELECT workspace_id,run_id::text,operation_id::text,stage FROM commerce_number_lab.queued_operations($1)',[limit])).rows as typeof queued;}finally{c.release();}}
 catch(error){process.stderr.write(`number_lab_queue_failed ${code(error)}\n`);return 0;}
 for(const q of queued){
  try{
   let seller:NumberLabDriverSellerConfiguration|undefined;
   if(runtime.ai){const grants=await labGrants(runtime.ai,q.workspace_id,q.run_id,'laboratory.chat'),visionGrants=await labGrants(runtime.ai,q.workspace_id,q.run_id,'laboratory.vision');
    if(Object.keys(grants).length||Object.keys(visionGrants).length)seller={workspaceId:q.workspace_id,enterprisePool:runtime.ai.pool as never,custodyKey:runtime.ai.custodyKey,grants,visionGrants,maximumMicrousd:LAB_SELLER_MAXIMUM_MICROUSD,...(runtime.fetcher?{fetcher:runtime.fetcher}:{})};}
   const materials=createNumberLabMaterialCustody({controlPool:runtime.control,sourcePool:runtime.source,controlKey:runtime.keys.control,sourceKey:runtime.keys.source,laboratoryKey:runtime.keys.files,sourceRoot:runtime.sourceRoot,laboratoryRoot:runtime.laboratoryRoot});
   const driver=createNumberLabDriver({controlPool:runtime.control,seedPool:runtime.seed,enginePool:runtime.engine,identity:runtime.identity,key:runtime.keys.control,materials,...(seller?{seller}:{}),
    transport:{key:runtime.keys.transport,reader:createNumberLabMaterialReader({laboratoryRoot:runtime.laboratoryRoot,laboratoryKey:runtime.keys.files})},
    receipts:{custody:createNumberLabReceiptCustody({laboratoryRoot:runtime.laboratoryRoot,laboratoryKey:runtime.keys.files})}});
   const input={workspaceId:q.workspace_id,runId:q.run_id,operationId:q.operation_id};
   if(q.stage==='EXECUTE')await driver.execute(input);
   // A stale INTENT settles only from its engine receipt; without one it stays uncertain.
   else if((await driver.observe(input)).receipt)await driver.reconcile(input);
  }catch(error){process.stderr.write(`number_lab_operation_failed ${code(error)}\n`);if(process.env.LAB_DEBUG)console.error(error);}
 }
 return queued.length;
}
const code=(error:unknown)=>error instanceof Error&&/^[A-Z0-9_]+$/.test(error.message)?error.message:'UNEXPECTED';
