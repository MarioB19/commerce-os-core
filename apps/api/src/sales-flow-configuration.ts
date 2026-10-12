import {registerCatalogProfileRoute} from './catalog-profile-route.js';
import type {RouteHandlerMethod} from 'fastify';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {offerSchema,salesFlowSaveDraftInputSchema,salesFlowValidateInputSchema,type Body,type DomainRecord} from '../../../packages/contracts/src/index.js';
import {putRecord,stableJson,type QueryExecutor} from '../../../packages/db/src/index.js';
import {validateOffer} from '../../../packages/domain/src/catalog/validation.js';
import {validateSalesFlowOfferDraft,type SalesFlowConfigurationValidation} from '../../../packages/domain/src/sales/sales-flow-configuration.js';
import {catalogReferences,lineageId,lockCatalogRecord} from './catalog-versions.js';
import {audit,fail,mutate,offerReadPermission,parseBody,present,principal,scopedRecord,writePermission} from './context.js';

function editableOfferBody(source:DomainRecord,changes:Body):Body{
 changes=structuredClone(changes);
 const previous=source.body.sales_flow?.remarketing,next=changes.sales_flow?.remarketing;
 if(previous&&next){
  const withoutRevision=(value:Body)=>stableJson({...value,policy_revision:0});
  next.policy_revision=withoutRevision(previous)===withoutRevision(next)?previous.policy_revision:Math.max(Number(previous.policy_revision??0)+1,Number(next.policy_revision??1));
 }
 const known=Object.fromEntries(Object.keys(offerSchema.shape).filter(key=>key in source.body).map(key=>[key,source.body[key]]));
 const parsed=offerSchema.parse({...known,...changes,status:'DRAFT'});
 validateOffer(parsed);
 return{...source.body,...parsed,product_id:source.body.product_id,status:'DRAFT'};
}

async function validation(req:FastifyRequest,source:DomainRecord,changes:Body,client?:QueryExecutor):Promise<{body:Body;validation:SalesFlowConfigurationValidation}> {
 const body=editableOfferBody(source,changes);
 const result=validateSalesFlowOfferDraft(body);
 // Validation answers “ready to publish”, even though saving the draft remains
 // allowed. This keeps Web, API and MCP honest about pending assets/workflows.
 const references=await catalogReferences(req,body,client,true);
 const issues=[...result.issues,...references.map((message,index)=>({code:'INVALID_REFERENCE',path:['references',index],message}))];
 return{body,validation:{...result,ready:result.valid&&issues.length===0,issues}};
}

function publicConfiguration(source:DomainRecord,result:SalesFlowConfigurationValidation){
 const row=present(source);
 return{
  offer:{id:row.id,version:row.version,status:row.status,name:row.name,product_id:row.product_id,series_id:row.series_id,source_version_id:row.source_version_id,currency:row.currency,base_amount_minor:row.base_amount_minor,payment_profile_version_id:row.payment_profile_version_id,receipt_policy_version_id:row.receipt_policy_version_id,workflow_version_id:row.workflow_version_id,agent_version_id:row.agent_version_id,fulfillment:row.fulfillment??[],positive_payment_unlocks_all:row.positive_payment_unlocks_all,billing_delay_seconds:row.billing_delay_seconds,sales_flow:row.sales_flow},
  validation:result,
 };
}

export async function salesFlowConfigurationRoutes(app:FastifyInstance){
 const route=(method:'GET'|'POST'|'PATCH',url:string,handler:RouteHandlerMethod)=>registerCatalogProfileRoute(app,method,url,'offer',handler,method==='PATCH'?'write':'read');
 route('GET','/v1/offers/:id/sales-flow',async req=>{
  offerReadPermission(principal(req));
  const source=await scopedRecord(req,'offer',z.uuid().parse((req.params as Body).id));
  const checked=await validation(req,source,{});
  return{data:publicConfiguration(source,checked.validation)};
 });

	 route('POST','/v1/offers/:id/sales-flow/validate',async req=>{
	  offerReadPermission(principal(req));
	  const input=salesFlowValidateInputSchema.parse(parseBody(req));
  const source=await scopedRecord(req,'offer',z.uuid().parse((req.params as Body).id));
  if(input.expected_version!==undefined&&source.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT','Otra persona guardó una revisión. Actualiza antes de validar de nuevo.');
  const checked=await validation(req,source,input.changes);
  return{data:publicConfiguration({...source,body:checked.body},checked.validation)};
 });

	 route('PATCH','/v1/offers/:id/sales-flow',async req=>{
	  writePermission(principal(req),'offer');
	  const input=salesFlowSaveDraftInputSchema.parse(parseBody(req));
  const result=await mutate(req,'offer.sales_flow_draft:'+(req.params as Body).id,async client=>{
   const source=await lockCatalogRecord(req,'offer',z.uuid().parse((req.params as Body).id),client);
   if(source.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT','Otra persona guardó una revisión. Tus cambios siguen en el editor; actualiza y compara antes de reintentar.');
   if(source.body.status!=='DRAFT')throw fail(409,'IMMUTABLE_VERSION','Crea una nueva versión de la oferta para editar su flujo de venta.');
   const existingChild=(await client.query(
    `SELECT id FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='offer'
     AND body->>'source_version_id'=$3 LIMIT 1`,
    [source.workspace_id,source.environment,source.id],
   )).rows[0];
	   if(existingChild)throw fail(409,'VERSION_CONFLICT','Otra persona guardó una revisión. Tus cambios siguen en el editor; actualiza y compara antes de reintentar.');
	   const checked=await validation(req,source,input.changes,client);
	   const row=await putRecord(client,{workspaceId:source.workspace_id,environment:source.environment,kind:'offer',body:{...checked.body,series_id:await lineageId(req,'offer',source,client),source_version_id:source.id}});
	   const previousSlots=new Map<number,Body>((source.body.sales_flow?.remarketing?.slots??[]).map((slot:Body)=>[Number(slot.position),slot]));
	   const newlyActivatedAcknowledgements=(row.body.sales_flow?.remarketing?.slots??[]).filter((slot:Body)=>[2,3].includes(Number(slot.position))&&slot.enabled===true&&slot.warning_acknowledged===true&&previousSlots.get(Number(slot.position))?.enabled!==true).map((slot:Body)=>({position:Number(slot.position),warning_acknowledged:true}));
	   await audit(client,req,'offer.sales_flow_draft_saved',row.id,{previous_version:source.version,recipe_id:row.body.sales_flow.recipe.recipe_id,policy_revision:row.body.sales_flow.remarketing.policy_revision,maximum:checked.validation.maximum,newly_activated_remarketing_slots:newlyActivatedAcknowledgements});
   return{data:publicConfiguration(row,checked.validation)};
  });
  return{data:result.data};
 });
}
