import {createHash} from 'node:crypto';
import {z} from 'zod';
import {labCanonical,labHash} from '../../domain/src/laboratory/number-lab.js';
import {compileNumberLabConfiguration,type NumberLabConfigurationPlan} from '../../domain/src/laboratory/configuration-plan.js';
import {labVirtualMaterialSchema,numberLabVirtualMaterialPath} from '../../domain/src/laboratory/virtual-material.js';
import {NumberLabWorkerStore} from './number-laboratory.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from './profile-context.js';
import {currentProfileExecutor} from './profile-query-routing.js';
import {currentWorkerProfile} from './profile-worker-scope.js';
import type {NumberLabEngineIdentity} from './number-lab-engine-runtime.js';
import {putRecord} from './index.js';

function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema=z.object({database:z.string().regex(/^commerce_lab_engine_[a-z0-9_]+$/).max(63),installationId:uuid,engineSha256:sha}).strict();
const inputSchema=z.object({workspaceId:z.string().min(1).max(256),runId:uuid,operationId:uuid}).strict();
const fileSchema=z.object({id:uuid,source_sha256:sha,content_sha256:sha,size_bytes:z.number().int().min(0).max(20971520),storage_key:z.string().regex(/^[a-f0-9-]{36}-[a-f0-9]{64}$/)}).strict();
const copiesSchema=z.object({run_id:uuid,snapshot_sha256:sha,files:z.array(fileSchema).max(6000),virtual_materials:z.array(labVirtualMaterialSchema).max(6000).optional()}).strict();
/** Private server port. It must authenticate original metadata and physically
 * copy/check files into lab custody. HTTP callers cannot provide this result.
 * Link/access descriptors must bind the same authenticated capture; no fake file fallback. */
export interface NumberLabMaterialPort {
 copy(input:Readonly<{workspaceId:string;runId:string;snapshotSha256:string;materials:ReadonlyArray<NumberLabConfigurationPlan['variants'][number]['materials'][number]>}>):Promise<z.infer<typeof copiesSchema>>;
}
const identitySql=`SELECT current_database() AS database,current_user AS role,
 r.rolsuper,r.rolbypassrls,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolcanlogin,r.rolinherit,
 EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS memberships,
 m.installation_id::text,m.engine_sha256,m.database_name,clock_timestamp() AS now
 FROM pg_roles r CROSS JOIN commerce_number_lab_engine.installation m
 WHERE r.rolname=current_user AND m.singleton=true`;
async function identity(db:ProfileExecutor,expected:NumberLabEngineIdentity,expiresAt?:string){
 const rows=(await db.query(identitySql)).rows,r=rows[0];
 need(rows.length===1&&r.database===expected.database&&r.database_name===expected.database&&r.role==='commerce_lab_engine_seed'
  &&['rolsuper','rolbypassrls','rolcreaterole','rolcreatedb','rolreplication','rolcanlogin','rolinherit','memberships'].every(k=>r[k]===false)
  &&r.installation_id===expected.installationId&&r.engine_sha256===expected.engineSha256,'LAB_SEED_IDENTITY_REQUIRED');
 const at=new Date(r.now).getTime();need(Number.isFinite(at)&&(!expiresAt||Date.parse(expiresAt)>at),'LAB_SEED_EXPIRED');
}
function assignmentId(runId:string,variantId:string){const h=createHash('sha256').update(labCanonical({protocol:'commerce.number-lab.assignment.v1',runId,variantId})).digest('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);}
function validateCopies(plan:NumberLabConfigurationPlan,raw:unknown){
 const value=copiesSchema.parse(raw),materials=plan.variants.flatMap(v=>v.materials);
 need(value.run_id===plan.run_id&&value.snapshot_sha256===plan.snapshot_sha256&&value.files.length+(value.virtual_materials?.length??0)===materials.length,'LAB_MATERIAL_BINDING');
 const files=new Map<string,z.infer<typeof fileSchema>>();
 for(const f of value.files){const m=materials.find(m=>m.id===f.id);need(m&&m.kind==='file'&&m.source.sha256===f.source_sha256&&m.sha256===f.content_sha256&&m.size_bytes===f.size_bytes&&!files.has(f.id),'LAB_MATERIAL_BINDING');
  need(f.storage_key===f.id+'-'+f.content_sha256,'LAB_MATERIAL_STORAGE_BINDING');files.set(f.id,f);
 }
 const virtual=new Map<string,z.infer<typeof labVirtualMaterialSchema>>();
 for(const v of value.virtual_materials??[]){const variant=plan.variants.find(p=>p.variant_id===v.variant_id),m=variant?.materials.find(m=>m.id===v.id);
  need(m&&m.kind===v.kind&&v.run_id===plan.run_id&&v.snapshot_sha256===plan.snapshot_sha256&&labCanonical(m.source)===labCanonical(v.source)&&!virtual.has(v.id)&&!files.has(v.id),'LAB_MATERIAL_BINDING');virtual.set(v.id,v);
 }
 return{files,virtual,sha256:labHash({...value,files:[...value.files].sort((a,b)=>a.id.localeCompare(b.id)),...(value.virtual_materials?{virtual_materials:[...value.virtual_materials].sort((a,b)=>a.id.localeCompare(b.id))}:{})})};
}
/** Factory inputs are protected server configuration. Only identity IDs cross
 * its public boundary; no plan, SQL, role or claim may be supplied by a caller. */
export function createNumberLabMaterializer(options:{controlPool:ProfilePool;seedPool:ProfilePool;identity:NumberLabEngineIdentity;key:Uint8Array;materials:NumberLabMaterialPort}){
 const installed=Object.freeze(identitySchema.parse(options.identity)),store=new NumberLabWorkerStore(options.controlPool,options.key);
 const outside=()=>need(!currentProfileExecutor()&&!currentWorkerProfile(),'LAB_SEED_OUTER_SCOPE');
 const inspect=async(input:ReturnType<typeof inputSchema.parse>)=>withProfileTransaction(options.seedPool,'number-lab:'+input.runId,async db=>{
  await db.query("SELECT pg_catalog.set_config('app.environment','SIMULATION',true)");await identity(db,installed);
  const rows=(await db.query(`SELECT m.run_id::text,m.snapshot_sha256,m.configuration_sha256,m.plan_sha256,m.materials_sha256,m.engine_sha256,m.state,
   e.operation_id::text,e.state AS operation_state,e.expires_at>clock_timestamp() AS live
   FROM commerce_number_lab_engine.materializations m JOIN commerce_number_lab_engine.executions e ON e.run_id=m.run_id
   WHERE m.run_id=$1 AND e.operation_id=$2`,[input.runId,input.operationId])).rows;
  await identity(db,installed);return rows[0]??null;
 });
 return Object.freeze({
  /** Read-only recovery after a lost ACK. Does not reclaim, mint a lease or retry. */
  async observe(raw:unknown){
   outside();const input=inputSchema.parse(raw);
   const control=await withProfileTransaction(options.controlPool,input.workspaceId,async db=>(await db.query(`SELECT r.snapshot_sha256,r.engine_sha256,o.state
    FROM commerce_number_lab.runs r JOIN commerce_number_lab.operations o ON o.workspace_id=r.workspace_id AND o.run_id=r.id
    WHERE r.workspace_id=$1 AND r.id=$2 AND o.id=$3`,[input.workspaceId,input.runId,input.operationId])).rows[0]);
   need(control&&control.engine_sha256===installed.engineSha256,'LAB_SEED_CONTROL_REQUIRED');
   const observed=await inspect(input);need(!observed||(observed.snapshot_sha256===control.snapshot_sha256&&observed.engine_sha256===control.engine_sha256),'LAB_SEED_CAPTURE_BINDING');return observed;
  },
  async prepare(raw:unknown){
   outside();const input=inputSchema.parse(raw),claim=await store.claim(input.workspaceId,input.runId,input.operationId);
   if(claim.effect!=='EXECUTE_ONCE')return{state:'ALREADY_ATTEMPTED' as const,operation_state:claim.state,read_only:true as const};
   const plan=compileNumberLabConfiguration({snapshot:claim.snapshot,records:claim.records},input.runId);
   need(plan.engine_sha256===installed.engineSha256&&plan.snapshot_sha256===claim.run.snapshot_sha256&&claim.snapshot.workspace_id===input.workspaceId,'LAB_SEED_CAPTURE_BINDING');
   // No transaction is open while the private material broker copies content.
   const materials=plan.variants.flatMap(v=>v.materials);
   need(materials.every(m=>['file','link','access'].includes(m.kind)),'LAB_MATERIAL_ADAPTER_REQUIRED');
   const copies=validateCopies(plan,await options.materials.copy(Object.freeze({workspaceId:input.workspaceId,runId:input.runId,snapshotSha256:plan.snapshot_sha256,materials:structuredClone(materials)})));
   const result=await withProfileTransaction(options.seedPool,plan.workspace_id,async db=>{
    await db.query("SELECT pg_catalog.set_config('app.environment','SIMULATION',true)");await identity(db,installed,claim.run.expires_at);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['commerce.number-lab.materialization:'+input.runId]);
    const old=(await db.query('SELECT * FROM commerce_number_lab_engine.materializations WHERE run_id=$1 FOR UPDATE',[input.runId])).rows[0];
    if(old)need(old.state==='READY'&&old.snapshot_sha256===plan.snapshot_sha256&&old.configuration_sha256===plan.configuration_sha256&&old.plan_sha256===plan.sha256&&old.materials_sha256===copies.sha256&&old.engine_sha256===installed.engineSha256,'LAB_MATERIALIZATION_CHANGED');
    // No ON CONFLICT success: an already-existing operation is uncertainty,
    // never an admission to repeat seed or canonical work.
    await db.query(`INSERT INTO commerce_number_lab_engine.executions(run_id,operation_id,workspace_id,snapshot_sha256,engine_sha256,state,expires_at)
     VALUES($1,$2,$3,$4,$5,'INTENT',$6)`,[input.runId,input.operationId,plan.workspace_id,plan.snapshot_sha256,installed.engineSha256,claim.run.expires_at]);
    if(!old){
     await db.query(`INSERT INTO commerce_number_lab_engine.materializations(run_id,operation_id,workspace_id,snapshot_sha256,configuration_sha256,plan_sha256,materials_sha256,engine_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[input.runId,input.operationId,plan.workspace_id,plan.snapshot_sha256,plan.configuration_sha256,plan.sha256,copies.sha256,installed.engineSha256]);
     const write=(id:string,kind:string,body:Record<string,unknown>,version?:number)=>putRecord(db,{id,workspaceId:plan.workspace_id,environment:'SIMULATION',kind,body,...(version!==undefined?{version}:{})});
     await write(plan.account_id,'channel_account',{name:'Laboratorio de número',provider:'simulator',status:'WORKING',sending_enabled:false,lab_snapshot:true,flow_test_transport:'ISOLATED_SIMULATOR',lab_run_id:input.runId});
     for(const variant of plan.variants){
      const records=new Map(variant.records.map(r=>[r.id,r])),aid=assignmentId(input.runId,variant.variant_id);
      const body=(id:string)=>{const record=records.get(id)!,value={...record.body};if(record.kind==='asset'){
       if(record.body.kind==='file')value.storage_key=copies.files.get(id)!.storage_key;
       else{const descriptor=copies.virtual.get(id)!;delete value.url;value.lab_delivery=descriptor;if(record.body.kind==='link')value.url=numberLabVirtualMaterialPath(descriptor);}
      }return{...value,...(record.kind==='binding'?{product_id:variant.roots.product_id,assignment_id:aid,assignment_revision:1}:{})};};
      for(const id of variant.write_order.skeletons)await write(id,records.get(id)!.kind,{lab_materialization_skeleton:true,status:'DRAFT'});
      for(const id of variant.write_order.immutable)await write(id,records.get(id)!.kind,body(id));
      for(const id of variant.write_order.finalize)await write(id,records.get(id)!.kind,body(id),1);
      await db.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,revision,state) VALUES($1,$2,'SIMULATION',$3,$4,$5,1,'ACTIVE')",[aid,plan.workspace_id,plan.account_id,variant.roots.product_id,variant.roots.binding_id]);
     }
     await db.query("UPDATE commerce_number_lab_engine.materializations SET state='READY' WHERE run_id=$1",[input.runId]);
    }
    await identity(db,installed,claim.run.expires_at);
    return{state:'READY' as const,run_id:input.runId,operation_id:input.operationId,snapshot_sha256:plan.snapshot_sha256,configuration_sha256:plan.configuration_sha256,plan_sha256:plan.sha256,account_id:plan.account_id,seeded:!old};
   });
   // The caller may request an engine lease only after this acknowledged COMMIT.
   return result;
  },
 });
}
