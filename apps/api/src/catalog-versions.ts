import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,putRecord,listRecords,type QueryExecutor} from '../../../packages/db/src/index.js';
import {productSchema,offerSchema,offerVersionCreateInputSchema,workflowSchema,type Body,type DomainRecord} from '../../../packages/contracts/src/index.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {validateOffer,readiness} from '../../../packages/domain/src/catalog/validation.js';
import {validateWorkflow,validateWorkflowDraft} from '../../../packages/domain/src/sales/workflow.js';
import {principal,resourcePermitted,parseBody,scopedRecord,readPermission,writePermission,present,mutate,fail,audit} from './context.js';

const revision=z.number().int().positive();
const recordId=(req:FastifyRequest)=>z.string().uuid().parse((req.params as Body).id);
const suppliedChanges=(req:FastifyRequest,parsed:Body)=>Object.fromEntries(Object.keys(parseBody(req).changes??{}).map(key=>[key,parsed[key]]));
const pick=(body:Body,schema:z.ZodObject<any>)=>Object.fromEntries(Object.keys(schema.shape).filter(key=>key in body).map(key=>[key,body[key]]));
export function publishPermission(req:FastifyRequest,resource:'products'|'offers'|'workflows'){
 const p=principal(req);assertPermission(p,p.service?`${resource}:publish`:resource==='workflows'?'workflows:write':'catalog:write');
}
export async function lockCatalogRecord(req:FastifyRequest,kind:string,id:string,client:QueryExecutor){
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${principal(req).workspace_id}:catalog-lifecycle`]);
 await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${principal(req).workspace_id}:${kind}:${id}`]);
 const row=await scopedRecord(req,kind,id,client);
 await client.query('SELECT id FROM records WHERE id=$1 AND workspace_id=$2 FOR UPDATE',[row.id,row.workspace_id]);
 return scopedRecord(req,kind,id,client);
}

/** Resolve existing immutable IDs without rewriting historical records. */
export async function lineageId(req:FastifyRequest,kind:string,row:DomainRecord,client:QueryExecutor=pool):Promise<string>{
 const visited=new Set<string>();let current=row;
 while(!visited.has(current.id)){
  visited.add(current.id);if(current.body.series_id)return current.body.series_id;
  // The previous API used parent_id for duplicates too. Those DRAFT records
  // start an independent history; published descendants follow them normally.
  if(kind==='workflow'&&current.body.status==='DRAFT'&&current.body.parent_id&&!current.body.source_version_id)return current.id;
  const parent=current.body.source_version_id??(kind==='workflow'?current.body.parent_id:undefined);
  if(!parent)return current.id;
  current=await scopedRecord(req,kind,parent,client);
 }
 throw fail(409,'INVALID_VERSION_LINEAGE','El historial requiere revisión técnica.');
}

/** API reference checks supplement DB foreign scopes, including node/asset arrays. */
export async function catalogReferences(req:FastifyRequest,body:Body,client:QueryExecutor=pool,publishing=false){
 if(client!==pool)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${principal(req).workspace_id}:catalog-lifecycle`]);
 const errors:string[]=[];
 const kinds:Record<string,string>={category_id:'category',product_id:'product',asset_id:'asset',offer_version_id:'offer',workflow_version_id:'workflow',workflow_template_version_id:'workflow',agent_version_id:'agent',payment_profile_version_id:'bank_profile',receipt_policy_version_id:'receipt_policy'};
 const entries:Array<{value:Body;path:string;expectedMime?:string}>=[{value:body,path:''},...(body.nodes??[]).map((node:Body,index:number)=>({value:node.config??{},path:`nodes.${index}.config.`})),...(body.fulfillment??[]).map((item:Body,index:number)=>({value:item,path:`fulfillment.${index}.`}))];
 if(body.madrina?.core_asset_id)entries.push({value:{asset_id:body.madrina.core_asset_id},path:'madrina.core.'});
 if(body.initial_offer?.madrina?.core_asset_id)entries.push({value:{asset_id:body.initial_offer.madrina.core_asset_id},path:'initial_offer.madrina.core.'});
 for(const [index,node] of (body.nodes??[]).entries())for(const [touchIndex,touch] of (node.config?.followups?.touches??[]).entries())entries.push({value:{asset_id:touch.asset_id},path:`nodes.${index}.config.followups.touches.${touchIndex}.`});
 const content=body.sales_flow?.content;
 if(content){
  entries.push({value:{asset_id:content.presentation.audio_asset_id},path:'sales_flow.content.presentation.audio.',expectedMime:'audio/'});
  entries.push({value:{asset_id:content.presentation.pack_image_asset_id},path:'sales_flow.content.presentation.pack_image.',expectedMime:'image/'});
  entries.push({value:{asset_id:content.agreement.audio_asset_id},path:'sales_flow.content.agreement.audio.',expectedMime:'audio/'});
  entries.push({value:{asset_id:content.collection.audio_asset_id},path:'sales_flow.content.collection.audio.',expectedMime:'audio/'});
 }
 for(const [slotIndex,slot] of (body.sales_flow?.remarketing?.slots??[]).entries())for(const stage of ['awaiting_agreement','awaiting_payment'])entries.push({value:{asset_id:slot.stages?.[stage]?.asset_id},path:`sales_flow.remarketing.slots.${slotIndex}.stages.${stage}.`,expectedMime:`${slot.stages?.[stage]?.medium??'audio'}/`});
 for(const id of body.asset_ids??[])entries.push({value:{asset_id:id},path:'asset_ids.'});
 if(body.initial_offer)entries.push({value:body.initial_offer,path:'initial_offer.'},...(body.initial_offer.fulfillment??[]).map((item:Body,index:number)=>({value:item,path:`initial_offer.fulfillment.${index}.`})))
 for(const{value,path,expectedMime}of entries)for(const[key,kind]of Object.entries(kinds)){
  if(value[key]==null||!publishing&&value[key]==='')continue;
  try{const ref=await scopedRecord(req,kind,z.string().uuid().parse(value[key]),client);
   if(ref.body.archived_at||ref.body.status==='ARCHIVED')errors.push(`Restaura la referencia archivada en ${path}${key} antes de usarla en una configuración nueva.`);
   if(publishing&&kind==='workflow'&&ref.body.status!=='PUBLISHED')errors.push(`Publica la versión de ${path}${key}.`);
   if(kind==='asset'&&(path.startsWith('fulfillment.')||path.startsWith('initial_offer.fulfillment.')||path.startsWith('nodes.')||path.startsWith('sales_flow.'))&&(ref.body.delivery_eligible===false||ref.body.usage==='MARKETING_REFERENCE'))errors.push(`El material de ${path}${key} es sólo una referencia de marketing y no puede entregarse al cliente.`);
   if(kind==='asset'&&expectedMime&&!String(ref.body.mime_type??'').startsWith(expectedMime))errors.push(`El material de ${path}${key} debe ser ${expectedMime==='image/'?'una imagen':expectedMime==='video/'?'un video':'un audio'}.`);
   if(publishing&&kind==='asset'&&ref.body.status!=='READY')errors.push(`Finaliza el material de ${path}${key}.`);
   if(kind==='workflow'&&body.product_id&&ref.body.product_id&&ref.body.product_id!==body.product_id)errors.push(`El flujo de ${path}${key} pertenece a otro producto.`);
   if(kind==='agent'&&body.product_id&&ref.body.product_id&&ref.body.product_id!==body.product_id)errors.push(`El vendedor de ${path}${key} pertenece a otro producto.`);
   if(kind==='offer'&&body.product_id&&ref.body.product_id!==body.product_id)errors.push(`La oferta de ${path}${key} pertenece a otro producto.`);
  }catch{errors.push(`Referencia inválida en ${path}${key}.`);}
 }
 return errors;
}
export async function workflowValidation(req:FastifyRequest,body:Body,client:QueryExecutor=pool,publishing=false){
 const validation=validateWorkflow(body as any);
 validation.errors.push(...validateWorkflowDraft(body as any).errors);
 validation.errors.push(...await catalogReferences(req,body,client,publishing));
 return{valid:validation.errors.length===0,errors:validation.errors,issues:validation.errors.map(message=>({code:'WORKFLOW_INVARIANT',path:'nodes',node_id:body.nodes?.find((n:Body)=>message.includes(n.id))?.id,message}))};
}

export async function catalogVersionRoutes(app:FastifyInstance){
 app.post('/v1/products/:id/versions',async(req,reply)=>{
  writePermission(principal(req),'product');const input=z.object({expected_version:revision,changes:productSchema.omit({initial_offer:true}).partial().default({})}).strict().parse(parseBody(req));
  const result=await mutate(req,'product.version:'+recordId(req),async c=>{
   const source=await lockCatalogRecord(req,'product',recordId(req),c);if(source.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   const body=productSchema.omit({initial_offer:true}).parse({...pick(source.body,productSchema),...suppliedChanges(req,input.changes)});
   const errors=await catalogReferences(req,body,c);if(errors.length)throw fail(400,'INVALID_REFERENCE','Revisa las referencias.',errors);
   const row=await putRecord(c,{id:source.id,workspaceId:source.workspace_id,environment:source.environment,kind:'product',version:input.expected_version,body:{...body,status:'DRAFT'}});
   await audit(c,req,'product.version_created',row.id,{previous_version:source.version});return{data:present(row),status:201};
  });reply.code(result.status??201);return{data:result.data};
 });
 app.post('/v1/products/:id/transition',async req=>{
  const input=z.object({expected_version:revision,status:z.enum(['DRAFT','PUBLISHED','ARCHIVED'])}).strict().parse(parseBody(req));
  if(input.status==='PUBLISHED')publishPermission(req,'products');else writePermission(principal(req),'product');
  const result=await mutate(req,'product.transition:'+recordId(req),async c=>{
   const old=await lockCatalogRecord(req,'product',recordId(req),c);if(old.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   const transitions:Record<string,string[]>={DRAFT:['PUBLISHED','ARCHIVED'],PUBLISHED:['ARCHIVED'],ARCHIVED:['DRAFT']};
   if(!transitions[old.body.status??'DRAFT']?.includes(input.status))throw fail(409,'INVALID_TRANSITION','Esta transición de estado no está permitida.');
   const errors=await catalogReferences(req,old.body,c,input.status==='PUBLISHED');if(errors.length)throw fail(409,'PRODUCT_NOT_READY','Completa las referencias antes de publicar.',errors);
   const row=await putRecord(c,{id:old.id,workspaceId:old.workspace_id,environment:old.environment,kind:'product',version:input.expected_version,body:{...old.body,status:input.status}});
   await audit(c,req,'product.state_changed',row.id,{from:old.body.status,to:input.status});return{data:{...present(row),sending_enabled:false}};
  });return{data:result.data};
 });
 for(const kind of ['offer','workflow'] as const){
  const path=kind==='offer'?'offers':'workflows';
  app.get(`/v1/${path}/:id/versions`,async req=>{
   readPermission(principal(req),kind);const source=await scopedRecord(req,kind,recordId(req)),restricted=principal(req).service&&!!principal(req).resource_ids,series=restricted?(source.body.series_id??source.id):await lineageId(req,kind,source);
   const rows=await listRecords(pool,source.workspace_id,kind,source.environment),versions:DomainRecord[]=[];
   for(const row of rows)if(resourcePermitted(principal(req),row.id)&&(restricted?(row.body.series_id??row.id):await lineageId(req,kind,row))===series)versions.push(row);
   return{data:versions.map(present),meta:{total:versions.length,series_id:series}};
  });
	 app.post(`/v1/${path}/:id/versions`,async(req,reply)=>{
	  writePermission(principal(req),kind);const schema:z.ZodObject<any>=kind==='offer'?offerSchema:workflowSchema;
	  const input:Body=(kind==='offer'?offerVersionCreateInputSchema:z.object({expected_version:revision,changes:schema.omit({status:true}).partial().default({})}).strict()).parse(parseBody(req));
   const result=await mutate(req,kind+'.version:'+recordId(req),async c=>{
    const old=await lockCatalogRecord(req,kind,recordId(req),c);if(old.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
    const body:Body={...schema.parse({...pick(old.body,schema),...suppliedChanges(req,input.changes),status:'DRAFT'}),...(kind==='offer'?{product_id:old.body.product_id}:{})};
    if(kind==='offer')validateOffer(body);else{const validation=validateWorkflowDraft(body as any);if(!validation.valid)throw fail(400,'INVALID_WORKFLOW','Corrige el flujo.',validation.errors);}
    const errors=await catalogReferences(req,body,c);if(errors.length)throw fail(400,'INVALID_REFERENCE','Revisa las referencias.',errors);
    const row=await putRecord(c,{workspaceId:old.workspace_id,environment:old.environment,kind,body:{...body,...(kind==='offer'?{product_id:old.body.product_id}:{}),series_id:await lineageId(req,kind,old,c),source_version_id:old.id}});
    await audit(c,req,kind+'.version_created',row.id,{source_version_id:old.id});return{data:{...present(row),...(kind==='offer'?{readiness:readiness(row.body)}:{})},status:201};
   });reply.code(result.status??201);return{data:result.data};
  });
 }
 app.post('/v1/workflows/:id/validate',async req=>{
  readPermission(principal(req),'workflow');const row=await scopedRecord(req,'workflow',recordId(req));return{data:await workflowValidation(req,row.body)};
 });
 for(const action of ['publish','duplicate','rollback'] as const)app.post(`/v1/workflows/:id/${action}`,async req=>{
  if(action!=='duplicate')publishPermission(req,'workflows');else writePermission(principal(req),'workflow');
  const input=(action==='publish'?z.object({expected_version:revision}).strict():action==='rollback'?z.object({version_id:z.string().uuid(),expected_version:revision.optional()}).strict():z.object({name:z.string().trim().min(1).max(160).optional()}).strict()).parse(parseBody(req)) as Body;
  const result=await mutate(req,`workflow.${action}:`+recordId(req),async c=>{
   const current=await lockCatalogRecord(req,'workflow',recordId(req),c);if(current.body.archived_at)throw fail(409,'CONFIGURATION_ARCHIVED');let source=current;
   if(input.expected_version!==undefined&&current.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   if(action==='publish'){
    if(current.body.status==='PUBLISHED')throw fail(409,'ALREADY_PUBLISHED');
    const published=await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='workflow' AND body->>'parent_id'=$3 AND body->>'status'='PUBLISHED' AND COALESCE(body->>'version_action','publish')='publish'",[current.workspace_id,current.environment,current.id]);
    if(published.rowCount)throw fail(409,'ALREADY_PUBLISHED');
   }
   if(action==='rollback'){
    source=await scopedRecord(req,'workflow',input.version_id,c);if(source.body.status!=='PUBLISHED')throw fail(400,'NOT_PUBLISHED');
    if(await lineageId(req,'workflow',source,c)!==await lineageId(req,'workflow',current,c))throw fail(409,'VERSION_LINEAGE_MISMATCH','La versión pertenece a otro flujo.');
   }
   const validation=action==='duplicate'?validateWorkflowDraft(source.body as any):await workflowValidation(req,source.body,c,true);if(!validation.valid)throw fail(400,'INVALID_WORKFLOW','Corrige el flujo.',validation.errors);
   const definition=pick(source.body,workflowSchema);
   const body=action==='duplicate'?{...definition,name:input.name??source.body.name,status:'DRAFT',copied_from:source.id}:{...definition,status:'PUBLISHED',parent_id:current.id,series_id:await lineageId(req,'workflow',current,c),version_action:action,published_at:new Date().toISOString(),published_by:principal(req).user.id,...(action==='rollback'?{restored_from_version_id:source.id}:{})};
   const row=await putRecord(c,{workspaceId:current.workspace_id,environment:current.environment,kind:'workflow',body});await audit(c,req,`workflow.${action}`,row.id,{source_id:source.id});return{data:{...present(row),sending_enabled:false}};
  });return{data:result.data};
 });
}
