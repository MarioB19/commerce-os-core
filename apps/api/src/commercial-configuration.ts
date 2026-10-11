import {retirementDependencies,prepareRetirement} from './catalog-retirement.js';
import {accountAssignmentSnapshot,commercialAssignmentNonCurrentReason,commercialAssignmentResourceIds,commercialAssignmentSnapshot,commercialAuthorizationStatus} from '../../../packages/db/src/commercial-assignments.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,listRecords,putRecord} from '../../../packages/db/src/index.js';
import {salesAiConfiguration} from '../../../packages/db/src/sales-ai-configuration.js';
import {resolveSellerAssignment} from '../../../packages/domain/src/sales/seller-context.js';
import {offerSalesFlowAssetIds,workflowAssetIds} from '../../../packages/domain/src/sales/workflow-assets.js';
import {principal,resourcePermitted,envOf,scopedRecord,readPermission,writePermission,parseBody,mutate,present,audit,fail} from './context.js';
import {lockCatalogRecord,catalogReferences,publishPermission,lineageId} from './catalog-versions.js';
import {simulationProof} from './number-setup.js';
import type {Body,DomainRecord} from '../../../packages/contracts/src/index.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';

async function productSimulationEvidence(workspace:string,product:DomainRecord){
 const candidates=(await pool.query<DomainRecord>(`WITH target_products AS (
   SELECT id::text id FROM records
   WHERE workspace_id=$1 AND kind='product'
     AND (id=$2 OR (environment='SIMULATION' AND body->'lab_source'->>'id'=$2::text))
  )
  SELECT s.*
  FROM records s
  WHERE s.workspace_id=$1 AND s.environment='SIMULATION' AND s.kind='simulation'
    AND s.body->>'mode'='NUMBER_FLOW_TEST_V1'
    AND EXISTS (
     SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.body->'assignments')='array' THEN s.body->'assignments' ELSE '[]'::jsonb END) assignment
     WHERE assignment->>'product_id' IN (SELECT id FROM target_products)
    )
  ORDER BY s.updated_at DESC LIMIT 20`,[workspace,product.id])).rows;
 let latestReason='SIMULATION_REQUIRED';
 for(const candidate of candidates){
  // Only a completed run can establish the proof. Historical RUNNING/RESET
  // runs must not trigger the graph-wide verification query on a product read.
  if(candidate.body.status!=='COMPLETED'){latestReason='SIMULATION_NOT_COMPLETED';continue;}
  const proof=await simulationProof(pool,candidate);latestReason=proof.cause;if(proof.complete)return{status:'COMPLETED',observed_at:candidate.body.completed_at??candidate.updated_at,source:'records.simulation+canonical_flow_proof',environment:'SIMULATION',external_effects:false,verification:proof.cause};
 }
 return{status:'NO_DATA',observed_at:candidates[0]?.updated_at??null,source:'records.simulation+canonical_flow_proof',environment:'SIMULATION',external_effects:null,verification:latestReason};
}

export async function commercialConfigurationRoutes(app:FastifyInstance){
 app.post('/v1/agents/:id/publish',async req=>{
  publishPermission(req,'workflows');const input=z.object({expected_version:z.number().int().positive()}).strict().parse(parseBody(req));
  const result=await mutate(req,'agent.publish:'+(req.params as Body).id,async c=>{
   const row=await lockCatalogRecord(req,'agent',(req.params as Body).id,c);
   if(row.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
   if(row.body.archived_at)throw fail(409,'CONFIGURATION_ARCHIVED');
   if(row.body.status==='PUBLISHED')throw fail(409,'ALREADY_PUBLISHED');
   if(!row.body.instructions?.trim()||!row.body.knowledge?.trim())throw fail(409,'SELLER_CONTENT_REQUIRED');
   const errors=await catalogReferences(req,row.body,c);if(errors.length)throw fail(409,'INVALID_REFERENCE');
   const saved=await putRecord(c,{id:row.id,workspaceId:row.workspace_id,environment:row.environment,kind:'agent',version:row.version,body:{...row.body,status:'PUBLISHED',published_at:new Date().toISOString(),published_by:principal(req).user.id}});
   await audit(c,req,'agent.published',row.id,{external_effects:false});return{data:present(saved)};
  });return{data:result.data};
 });
 for(const [path,kind] of Object.entries({workflows:'workflow',agents:'agent'})){app.get(`/v1/${path}/:id/dependencies`,async req=>{readPermission(principal(req),kind);const row=await scopedRecord(req,kind,(req.params as Body).id);return{data:await retirementDependencies(req,row)};});}
 for(const [path,kind] of Object.entries({products:'product',offers:'offer',workflows:'workflow',agents:'agent',assets:'asset'})){
  app.post(`/v1/${path}/:id/archive`,async req=>{
   writePermission(principal(req),kind);const input=z.object({expected_version:z.number().int().positive(),archived:z.boolean(),reason:z.string().trim().min(3).max(1000),dependency_hash:z.string().optional(),existing_policy:z.literal('handoff').optional()}).strict().parse(parseBody(req));
   const result=await mutate(req,kind+'.archive:'+(req.params as Body).id,async c=>{
    const row=await lockCatalogRecord(req,kind,(req.params as Body).id,c);if(row.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
    if(input.archived&&['workflow','agent'].includes(kind))await prepareRetirement(req,c,row,input);
    const body={...row.body};if(input.archived){body.archived_at=new Date().toISOString();body.archive_reason=input.reason;}else{delete body.archived_at;delete body.archive_reason;if(body.status==='ARCHIVED')body.status='DRAFT';}
    const saved=await putRecord(c,{id:row.id,workspaceId:row.workspace_id,environment:row.environment,kind,version:row.version,body});
    await audit(c,req,kind+(input.archived?'.archived':'.restored'),row.id,{reason:input.reason,historical_references_preserved:true});return{data:present(saved)};
   });return{data:result.data};
  });
 }
	 app.get('/v1/products/:id/configuration',async req=>{
	  const p=principal(req);readPermission(p,'product');const product=await scopedRecord(req,'product',(req.params as Body).id),environment=envOf(req),assignmentsVisible=p.service?p.scopes.includes('channels:read'):['owner','operator'].includes(p.role),productRoot=await lineageId(req,'product',product,pool);
  const offers=[];for(const row of await listRecords(pool,p.workspace_id,'offer',environment)){const offerProductId=row.body.product_id;if(!resourcePermitted(p,row.id)||typeof offerProductId!=='string'||!resourcePermitted(p,offerProductId)||row.body.archived_at)continue;const offerProduct=await scopedRecord(req,'product',offerProductId);if(await lineageId(req,'product',offerProduct,pool)===productRoot)offers.push(row);}
  const visibleAccounts=assignmentsVisible?(await listRecords(pool,p.workspace_id,'channel_account',environment)).filter(account=>resourcePermitted(p,account.id)):[],observedAt=assignmentsVisible?await numberNow(pool,p.workspace_id,environment):undefined;
  const assignmentSnapshot=assignmentsVisible?await commercialAssignmentSnapshot(pool,p.workspace_id,environment,visibleAccounts.map(account=>account.id),observedAt):undefined;
  const permitted=(assignment:{account_id:string;product_id:string;body:Body})=>commercialAssignmentResourceIds(assignment).every(resourceId=>resourcePermitted(p,resourceId));
  const pinnedOfferIds=new Set<string>();if(assignmentSnapshot){for(const assignment of assignmentSnapshot.current)if(assignment.product_id===product.id&&permitted(assignment)&&typeof assignment.body.offer_version_id==='string')pinnedOfferIds.add(assignment.body.offer_version_id);for(const binding of assignmentSnapshot.legacy)if(binding.product_id===product.id&&permitted(binding)&&typeof binding.body.offer_version_id==='string')pinnedOfferIds.add(binding.body.offer_version_id);}
  const selected=(req.query as Body).offer_id,assignedOfferId=pinnedOfferIds.size===1?[...pinnedOfferIds][0]:undefined;
  const offer=selected?offers.find(r=>r.id===selected):assignedOfferId?offers.find(r=>r.id===assignedOfferId):pinnedOfferIds.size>1?undefined:offers.filter(r=>r.body.status==='PUBLISHED').sort((a,b)=>new Date(b.created_at).getTime()-new Date(a.created_at).getTime())[0];
  if(selected&&!offer)throw fail(404,'NOT_FOUND');
  const offerSelection=selected?{state:'EXPLICIT',offer_id:offer!.id}:assignedOfferId&&offer?{state:'ASSIGNED_CURRENT',offer_id:offer.id}:pinnedOfferIds.size>1?{state:'SELECTION_REQUIRED',reason:'MULTIPLE_CURRENT_OFFERS',offer_ids:[...pinnedOfferIds].sort()} :offer?{state:'LATEST_PUBLISHED_UNASSIGNED',offer_id:offer.id}:{state:'NO_OFFER'};
  const workflowId=offer?.body.workflow_version_id??product.body.workflow_template_version_id;
  const workflow=workflowId?await scopedRecord(req,'workflow',workflowId):undefined;
  const assignment=resolveSellerAssignment({offer:offer?.body,product:product.body,workflow:workflow?.body});
  const agent=assignment.agent_version_id?await scopedRecord(req,'agent',assignment.agent_version_id):undefined;
  const ai=agent?await salesAiConfiguration(pool,p.workspace_id,envOf(req),agent.body):{configured:false,state:'SELLER_PENDING'};
  const assetIds=new Set<string>([...(product.body.asset_ids??[]),...(offer?.body.fulfillment??[]).map((f:Body)=>f.asset_id),...offerSalesFlowAssetIds(offer?.body??{}),...workflowAssetIds(workflow?.body??{})]);
  const materials=[];for(const assetId of assetIds){const asset=await scopedRecord(req,'asset',assetId);materials.push(present(asset));}
  const active=(row:typeof product|undefined)=>!!row&&!row.body.archived_at&&row.body.status==='PUBLISHED';
  const checks={product:active(product),offer:active(offer),workflow:active(workflow),seller:active(agent),materials:materials.length>0&&materials.every(a=>a.status==='READY'&&!a.archived_at)};
	  const accounts=[];
	  if(assignmentsVisible){
	   const snapshot=assignmentSnapshot!;
	   const targetOfferIds=new Set(offers.map(row=>row.id));
	   for(const account of visibleAccounts){
	    const resolved=accountAssignmentSnapshot(snapshot,account.id),assignments=resolved.current.filter(permitted);
	    const relevant=assignments.find(a=>a.product_id===product.id),canonicalForTarget=resolved.canonical.filter(a=>a.product_id===product.id),canonicalForProduct=canonicalForTarget.filter(permitted);
	    const legacy=resolved.legacy&&permitted(resolved.legacy)?resolved.legacy:undefined,legacyRelevant=legacy?.product_id===product.id?legacy:undefined;
	    const historicalRefs=[account.id,product.id,account.body.offer_version_id,account.body.workflow_version_id,account.body.agent_version_id].filter((value):value is string=>typeof value==='string'),historicalPermitted=historicalRefs.every(resourceId=>resourcePermitted(p,resourceId));
	    const historicalAccount=!resolved.has_canonical&&!resolved.legacy&&historicalPermitted&&(account.body.product_id===product.id||targetOfferIds.has(account.body.offer_version_id));
	    const authorizationAssignment=relevant??canonicalForProduct[0],authorizationStatus=authorizationAssignment?commercialAuthorizationStatus(authorizationAssignment,snapshot.observed_at):account.body.active_authorization_id?'INVALIDATED':'NONE';
	    const effective=relevant?{...relevant.body,product_id:relevant.product_id,binding_id:relevant.binding_id,assignment_id:relevant.id,assignment_revision:relevant.revision}:legacyRelevant?{...legacyRelevant.body,product_id:legacyRelevant.product_id,binding_id:legacyRelevant.id,assignment_id:null,assignment_revision:null}:historicalAccount?{product_id:product.id,offer_version_id:account.body.offer_version_id??null,workflow_version_id:account.body.workflow_version_id??null,agent_version_id:account.body.agent_version_id??null,binding_id:null}:null;
	    const historicalCanonical=canonicalForProduct[0],resolution=relevant?{state:'CURRENT',source:'commercial_assignments',reason:'ACTIVE_IN_VALIDITY_WINDOW',observed_at:snapshot.observed_at,assignment_id:relevant.id,binding_id:relevant.binding_id,revision:relevant.revision}:historicalCanonical?{state:'HISTORICAL',source:'commercial_assignments',reason:commercialAssignmentNonCurrentReason(canonicalForProduct,snapshot.observed_at),observed_at:snapshot.observed_at,assignment_id:historicalCanonical.id,binding_id:historicalCanonical.binding_id,revision:historicalCanonical.revision}:legacyRelevant?{state:'CURRENT',source:'legacy_binding',reason:'LEGACY_BINDING_CURRENT',observed_at:snapshot.observed_at,binding_id:legacyRelevant.id}:historicalAccount?{state:'HISTORICAL',source:'legacy_account',reason:'ACCOUNT_CONFIGURATION_IS_HISTORICAL',observed_at:snapshot.observed_at}:canonicalForTarget.length?{state:'NO_DATA',source:'commercial_assignments',reason:'ASSIGNMENT_NOT_VISIBLE',observed_at:snapshot.observed_at}:{state:'NO_DATA',source:resolved.has_canonical?'commercial_assignments':'none',reason:'PRODUCT_NOT_ASSIGNED',observed_at:snapshot.observed_at};
	    accounts.push({id:account.id,name:account.body.alias??account.body.name,version:account.version,provider:account.body.provider,status:account.body.status,sending_enabled:account.body.sending_enabled===true,uses_product:!!relevant||!!legacyRelevant,assignments:assignments.map(a=>({...a.body,id:a.id,revision:a.revision,product_id:a.product_id,binding_id:a.binding_id,state:a.state})),effective_assignment:effective,assignment_resolution:resolution,authorization_status:authorizationStatus,authorization_registered:authorizationStatus==='REGISTERED'});
	   }
	  }
	  const simulation=await productSimulationEvidence(p.workspace_id,product);
	  return{data:{product:present(product),offer:offer?present(offer):null,offer_selection:offerSelection,offers:offers.map(present),workflow:workflow?present(workflow):null,seller:agent?present(agent):null,assignment_origin:assignment.origin,materials,checks,configuration_published:Object.values(checks).every(Boolean),simulation,visibility:{assignments:assignmentsVisible},assignment_snapshot:assignmentSnapshot?{observed_at:assignmentSnapshot.observed_at,source:'commercial_assignments+legacy_binding',current_visible:accounts.reduce((sum,account)=>sum+account.assignments.length,0)}:null,connections:{sales_ai:{configured:ai.configured,state:ai.state,model:ai.agent?.model??null},assigned_accounts:assignmentsVisible?accounts.filter(a=>a.uses_product).length:null},operation:{authorized:false,scope:'CONFIGURATION_ONLY',message:'Cada número requiere preflight y autorización propios.'},accounts}};
	 });
}
