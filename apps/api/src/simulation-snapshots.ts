import {readFile,writeFile,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {getRecord,putRecord,uuid,hash,stableJson,encrypt,decrypt,type QueryExecutor} from '../../../packages/db/src/index.js';
import {schemas,type Body,type DomainRecord} from '../../../packages/contracts/src/index.js';
import {assertPermission,type Principal} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,parseBody,mutate,fail,audit,assertResource,readPermission} from './context.js';

const referenceKinds:Record<string,string>={category_id:'category',product_id:'product',asset_id:'asset',audio_asset_id:'asset',pack_image_asset_id:'asset',core_asset_id:'asset',offer_version_id:'offer',workflow_version_id:'workflow',workflow_template_version_id:'workflow',agent_version_id:'agent',payment_profile_version_id:'bank_profile',receipt_policy_version_id:'receipt_policy',campaign_id:'acquisition_campaign',ad_set_id:'ad_set',ad_id:'ad'};
const mutableKinds=new Set(['category','product','workflow']);
// Only schema-owned commercial fields cross the boundary. History, arbitrary
// internal metadata and operational authorization never become lab input.
function commercialBody(record:DomainRecord):Body{
 const schema=schemas[record.kind] as z.ZodObject<any>;
 const picked=Object.fromEntries(Object.keys(schema.shape).filter(key=>key in record.body).map(key=>[key,record.body[key]]));
 if(record.kind==='offer')picked.product_id=record.body.product_id;
 return picked;
}

export interface SimulationGraphSnapshot{
 sources:Map<string,DomainRecord>;
 mapped:Map<string,string>;
 materials:Body[];
}

/**
 * Copies a closed commercial graph into SIMULATION. Callers provide only REAL
 * roots and create their own simulator account/assignments afterwards. The
 * helper never copies operational authorization, provider configuration or a
 * real access/bank secret.
 */
export async function cloneSimulationGraph(
 c:QueryExecutor,
 p:Principal,
 roots:Array<{kind:string;id:string}>,
 createdFiles:string[],
):Promise<SimulationGraphSnapshot>{
 const sources=new Map<string,DomainRecord>(),mapped=new Map<string,string>(),bodies=new Map<string,Body>();
 const collect=async(kind:string,id:string):Promise<void>=>{
  if(sources.has(id))return;
  if(sources.size>=300)throw fail(400,'SNAPSHOT_TOO_LARGE');
  assertResource(p,id);
  await c.query('SELECT id FROM records WHERE workspace_id=$1 AND id=$2 FOR SHARE',[p.workspace_id,id]);
  const source=await getRecord(c,p.workspace_id,kind,id);
  if(!source||source.environment!=='REAL')throw fail(404,'NOT_FOUND');
  const schema=schemas[source.kind];
  if(!schema)throw fail(400,'SNAPSHOT_KIND_UNSUPPORTED',source.kind);
  sources.set(id,source);mapped.set(id,uuid());
  const body=commercialBody(source);bodies.set(id,body);
  const visit=async(value:any):Promise<void>=>{
   if(Array.isArray(value)){for(const item of value)await visit(item);return;}
   if(!value||typeof value!=='object')return;
   for(const[key,item]of Object.entries(value)){
    if(referenceKinds[key]&&typeof item==='string')await collect(referenceKinds[key]!,item);
    else if(key==='asset_ids'&&Array.isArray(item))for(const assetId of item)await collect('asset',String(assetId));
    else await visit(item);
   }
  };
  await visit(body);
 };
 for(const root of roots)await collect(root.kind,root.id);

 const rewrite=(value:any,key=''):any=>{
  if(Array.isArray(value))return value.map(item=>key==='asset_ids'?mapped.get(String(item)):rewrite(item));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
   .filter(([candidate])=>!/(ciphertext|storage_key|delivery_reference|gateway|authorization|access_code|password|token)/i.test(candidate))
   .map(([candidate,item])=>[candidate,rewrite(item,candidate)]));
  return referenceKinds[key]&&typeof value==='string'?mapped.get(value):value;
 };
 const materials:Body[]=[],prepared=new Map<string,Body>();
 for(const[id,record]of sources){
  const body:Body=rewrite(bodies.get(id)!);
  body.lab_source={id,version:record.version,content_hash:hash(stableJson(record.body))};
  body.lab_snapshot=true;
  if(record.kind==='asset'){
   if(record.body.status!=='READY')throw fail(409,'ASSET_NOT_READY');
   const material={id:mapped.get(id),source_asset_id:id,source_revision:record.version,name:record.body.name,kind:record.body.kind,mime_type:record.body.mime_type,size_bytes:record.body.size_bytes,sha256:record.body.sha256,content:record.body.kind==='file'?'IMMUTABLE_FILE_REFERENCE':'PLACEHOLDER_ONLY'};
   materials.push(material);
   const url='https://example.invalid/commerce-laboratory/'+mapped.get(id);
   if(record.body.kind==='access')Object.assign(body,{kind:'access',adapter:'link',delivery_ciphertext:encrypt({adapter:'link',delivery_reference:JSON.stringify({url,code:'LAB-ONLY',instructions:'Acceso ficticio de laboratorio; no acredita el portal real.'})})});
   else if(record.body.kind==='file'){
    const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;
    const key=record.body.storage_key??record.id;
    if(!root||!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(key))throw fail(409,'ASSET_CONTENT_UNAVAILABLE');
    const bytes=Buffer.from(decrypt(await readFile(join(root,'assets',key+'.enc'),'utf8')),'base64');
    if(hash(bytes)!==record.body.sha256||bytes.length!==record.body.size_bytes)throw fail(409,'CHECKSUM_MISMATCH');
    const copyKey=mapped.get(id)+'-'+record.body.sha256,copyPath=join(root,'assets',copyKey+'.enc');
    await writeFile(copyPath,encrypt(bytes.toString('base64')),{mode:0o600,flag:'wx'});createdFiles.push(copyPath);
    Object.assign(body,{kind:'file',storage_key:copyKey});
   }else Object.assign(body,{kind:'link',url,adapter:'link'});
   body.status='READY';body.lab_material_placeholder=record.body.kind!=='file';body.material_evidence=material;
  }
  if(record.kind==='bank_profile')Object.assign(body,{name:'Banco de laboratorio',bank:'SIMULATION',last4:'0000',secret_ciphertext:encrypt({holder:'Ensayo',account_number:'0000',instructions:'No realizar transferencias. Ensayo aislado.'})});
  if(record.kind==='agent')Object.assign(body,{provider:'deterministic',model:'deterministic-v1'});
  if(record.kind==='workflow'||record.kind==='offer')body.status='PUBLISHED';
  prepared.set(id,body);
 }

 for(const[id,source]of sources)if(mutableKinds.has(source.kind))await putRecord(c,{id:mapped.get(id),workspaceId:p.workspace_id,environment:'SIMULATION',kind:source.kind,body:{name:source.body.name,status:'DRAFT'}});
 const pending=new Map([...sources].filter(([,source])=>!mutableKinds.has(source.kind)));
 const dependencies=(value:any,key=''):string[]=>{
  if(Array.isArray(value))return value.flatMap(item=>key==='asset_ids'&&typeof item==='string'?[item]:dependencies(item));
  if(!value||typeof value!=='object')return referenceKinds[key]&&typeof value==='string'?[value]:[];
  return Object.entries(value).flatMap(([candidate,item])=>dependencies(item,candidate));
 };
 while(pending.size){let advanced=false;for(const[id,source]of pending){
  if(dependencies(bodies.get(id)!).some(reference=>pending.has(reference)))continue;
  await putRecord(c,{id:mapped.get(id),workspaceId:p.workspace_id,environment:'SIMULATION',kind:source.kind,body:prepared.get(id)!});pending.delete(id);advanced=true;
 }if(!advanced)throw fail(409,'SNAPSHOT_REFERENCE_CYCLE');}
 for(const[id,source]of sources)if(mutableKinds.has(source.kind))await putRecord(c,{id:mapped.get(id),workspaceId:p.workspace_id,environment:'SIMULATION',kind:source.kind,version:1,body:prepared.get(id)!});
 return{sources,mapped,materials};
}
export async function simulationSnapshotRoutes(app:FastifyInstance){
 app.post('/v1/simulation-snapshots',async(req,reply)=>{
  const p=principal(req);assertPermission(p,p.service?'simulations:run':'workflows:write');
  if(p.service)assertPermission(p,'workflows:read');
  if(envOf(req)!=='SIMULATION')throw fail(400,'SIMULATION_ONLY');
  if(p.service&&p.allowed_environments&&!p.allowed_environments.includes('REAL'))throw fail(403,'ENVIRONMENT_FORBIDDEN');
  const input=z.object({workflow_version_id:z.string().uuid(),expected_version:z.number().int().positive(),offer_version_id:z.string().uuid().optional(),expected_offer_version:z.number().int().positive().optional()}).strict().refine(value=>(value.offer_version_id===undefined)===(value.expected_offer_version===undefined),{message:'La selección explícita requiere oferta y revisión juntas.',path:['expected_offer_version']}).parse(parseBody(req));
  if(input.offer_version_id)readPermission(p,'offer');
  const createdFiles:string[]=[];
  try{const result=await mutate(req,'simulation.snapshot',async c=>{
   const sources=new Map<string,DomainRecord>(),mapped=new Map<string,string>(),bodies=new Map<string,Body>();
   const collect=async(kind:string,id:string):Promise<void>=>{
    if(sources.has(id))return;if(sources.size>=300)throw fail(400,'SNAPSHOT_TOO_LARGE');
    assertResource(p,id);
    await c.query('SELECT id FROM records WHERE workspace_id=$1 AND id=$2 FOR SHARE',[p.workspace_id,id]);
    const source=await getRecord(c,p.workspace_id,kind,id);if(!source||source.environment!=='REAL')throw fail(404,'NOT_FOUND');
    sources.set(id,source);mapped.set(id,uuid());const body=commercialBody(source);bodies.set(id,body);
    const visit=async(value:any):Promise<void>=>{
     if(Array.isArray(value)){for(const item of value)await visit(item);return;}
     if(!value||typeof value!=='object')return;
     for(const[key,item]of Object.entries(value)){if(referenceKinds[key]&&typeof item==='string')await collect(referenceKinds[key]!,item);else if(key==='asset_ids'&&Array.isArray(item)){for(const id of item)await collect('asset',id);}else await visit(item);}
    };
    await visit(body);
   };
   await collect('workflow',input.workflow_version_id);
   const source=sources.get(input.workflow_version_id)!;
   if(source.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   const sourceOfferId=input.offer_version_id??source.body.offer_version_id;
   if(!sourceOfferId)throw fail(409,'OFFER_REQUIRED');
   if(input.offer_version_id){
    if(source.body.offer_version_id&&source.body.offer_version_id!==input.offer_version_id)throw fail(409,'OFFER_CONFLICT');
    if(source.body.status!=='PUBLISHED'||source.body.archived_at)throw fail(409,'WORKFLOW_NOT_PUBLISHED');
    await collect('offer',input.offer_version_id);
    const selectedOffer=sources.get(input.offer_version_id)!;
    if(selectedOffer.version!==input.expected_offer_version)throw fail(409,'OFFER_VERSION_CONFLICT');
    if(selectedOffer.body.status!=='PUBLISHED'||selectedOffer.body.archived_at)throw fail(409,'OFFER_NOT_PUBLISHED');
    if(!source.body.product_id||selectedOffer.body.product_id!==source.body.product_id)throw fail(409,'OFFER_PRODUCT_MISMATCH');
    if(selectedOffer.body.workflow_version_id!==source.id)throw fail(409,'OFFER_WORKFLOW_MISMATCH');
    // Only the prepared laboratory body changes; the locked REAL source stays intact.
    bodies.get(source.id)!.offer_version_id=input.offer_version_id;
   }
   const sourceOffer=sources.get(sourceOfferId)!;
   const rewrite=(value:any,key=''):any=>{
    if(Array.isArray(value))return value.map(item=>key==='asset_ids'?mapped.get(item):rewrite(item));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(ciphertext|storage_key|delivery_reference|gateway|authorization|access_code|password|token)/i.test(k)).map(([k,v])=>[k,rewrite(v,k)]));
    return referenceKinds[key]&&typeof value==='string'?mapped.get(value):value;
   };
   const materialSources:Body[]=[];
   const prepared=new Map<string,Body>();
   for(const[id,record]of sources){
    const body:Body=rewrite(bodies.get(id)!);body.lab_source={id,version:record.version,content_hash:hash(stableJson(record.body))};body.lab_snapshot=true;
    if(record.kind==='asset'){
     if(record.body.status!=='READY')throw fail(409,'ASSET_NOT_READY');
     const material={id:mapped.get(id),source_asset_id:id,source_revision:record.version,kind:record.body.kind,mime_type:record.body.mime_type,size_bytes:record.body.size_bytes,sha256:record.body.sha256,content:record.body.kind==='file'?'IMMUTABLE_FILE_REFERENCE':'PLACEHOLDER_ONLY'};
     materialSources.push(material);
     const url='https://example.invalid/commerce-laboratory/'+mapped.get(id);
     if(record.body.kind==='access')Object.assign(body,{kind:'access',adapter:'link',delivery_ciphertext:encrypt({adapter:'link',delivery_reference:JSON.stringify({url,code:'LAB-ONLY',instructions:'Acceso ficticio de laboratorio; no acredita el portal real.'})})});
     else if(record.body.kind==='file'){
      const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;
      const key=record.body.storage_key??record.id;
      if(!root||!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(key))throw fail(409,'ASSET_CONTENT_UNAVAILABLE');
      const bytes=Buffer.from(decrypt(await readFile(join(root,'assets',key+'.enc'),'utf8')),'base64');
      if(hash(bytes)!==record.body.sha256||bytes.length!==record.body.size_bytes)throw fail(409,'CHECKSUM_MISMATCH');
      const copyKey=mapped.get(id)+'-'+record.body.sha256,copyPath=join(root,'assets',copyKey+'.enc');
      await writeFile(copyPath,encrypt(bytes.toString('base64')),{mode:0o600,flag:'wx'});createdFiles.push(copyPath);
      Object.assign(body,{kind:'file',storage_key:copyKey});
     }else Object.assign(body,{kind:'link',url,adapter:'link'});
     body.status='READY';body.lab_material_placeholder=record.body.kind!=='file';body.material_evidence=material;
    }
    if(record.kind==='bank_profile')Object.assign(body,{name:'Banco de laboratorio',bank:'SIMULATION',last4:'0000',secret_ciphertext:encrypt({holder:'Ensayo',account_number:'0000',instructions:'No realizar transferencias. Ensayo aislado.'})});
    if(record.kind==='agent')Object.assign(body,{provider:'deterministic',model:'deterministic-v1'});
    if(record.kind==='workflow'||record.kind==='offer')body.status='PUBLISHED';
    prepared.set(id,body);
   }
   // Mutable skeletons resolve cyclic product/offer/workflow assignments. Offers
   // and payment policies remain insert-only, honoring existing DB invariants.
   for(const[id,source]of sources)if(mutableKinds.has(source.kind))await putRecord(c,{id:mapped.get(id),workspaceId:p.workspace_id,environment:'SIMULATION',kind:source.kind,body:{name:source.body.name,status:'DRAFT'}});
   for(const kind of ['asset','bank_profile','receipt_policy'])for(const[id,source]of sources)if(source.kind===kind)await putRecord(c,{id:mapped.get(id),workspaceId:p.workspace_id,environment:'SIMULATION',kind,body:prepared.get(id)!});
   // Agents and offers are immutable. Their persisted source dependencies are a
   // DAG: insert in dependency order instead of ever updating a sealed agent.
   const pending=new Map([...sources].filter(([,r])=>['offer','agent'].includes(r.kind)));
   while(pending.size){let advanced=false;for(const[id,source]of pending){
    const refs=[bodies.get(id)!.offer_version_id,bodies.get(id)!.agent_version_id].filter(Boolean);
    if(refs.some(ref=>pending.has(ref)))continue;
    await putRecord(c,{id:mapped.get(id),workspaceId:p.workspace_id,environment:'SIMULATION',kind:source.kind,body:prepared.get(id)!});pending.delete(id);advanced=true;
   }if(!advanced)throw fail(409,'SNAPSHOT_REFERENCE_CYCLE');}

   for(const[id,source]of sources)if(mutableKinds.has(source.kind))await putRecord(c,{id:mapped.get(id),workspaceId:p.workspace_id,environment:'SIMULATION',kind:source.kind,version:1,body:prepared.get(id)!});
   const workflowId=mapped.get(source.id)!,offerId=mapped.get(sourceOfferId)!,offer=sourceOffer;
   const account=await putRecord(c,{workspaceId:p.workspace_id,environment:'SIMULATION',kind:'channel_account',body:{name:'Laboratorio · '+source.body.name,provider:'simulator',status:'WORKING',sending_enabled:false,workflow_version_id:workflowId,offer_version_id:offerId,lab_snapshot:true}});
   const data={id:uuid(),environment:'SIMULATION',workflow_version_id:workflowId,workflow_revision:2,offer_version_id:offerId,product_id:mapped.get(offer.body.product_id),account_id:account.id,source:{workflow_version_id:source.id,version:source.version,offer_version_id:sourceOffer.id,offer_version:sourceOffer.version,offer_selection:input.offer_version_id?'EXPLICIT':'WORKFLOW'},materials:materialSources,external_effects:false};
   await audit(c,req,'simulation.snapshot_created',workflowId,{source_id:source.id,source_version:source.version,source_offer_id:sourceOffer.id,source_offer_version:sourceOffer.version,offer_selection:data.source.offer_selection,resource_count:sources.size});
   return{data,status:201};
  });reply.code(result.status??201);return{data:result.data};}catch(error){await Promise.allSettled(createdFiles.map(path=>unlink(path)));throw error;}
 });
}
