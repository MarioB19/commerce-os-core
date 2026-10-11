import {activeAt,accountAssignmentSnapshot,channelIdentityHash,commercialAssignmentNonCurrentReason,commercialAssignmentResourceIds,commercialAssignmentSnapshot,commercialAuthorizationStatus,listAssignments,type CommercialAssignment,type LegacyCommercialBinding} from '../../../packages/db/src/commercial-assignments.js';
import {assignmentInput,saveAssignment} from './product-assignments.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {salesAiConfiguration} from '../../../packages/db/src/sales-ai-configuration.js';
import {offerSalesFlowAssetIds,workflowAssetIds} from '../../../packages/domain/src/sales/workflow-assets.js';
import {resolveSellerAssignment} from '../../../packages/domain/src/sales/seller-context.js';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,getRecord,listRecords,putRecord,hash,stableJson,readNumberOperationalState,type QueryExecutor} from '../../../packages/db/src/index.js';
import {readOperationalSettings} from '../../../packages/db/src/operational-settings.js';
import {integrationReadiness,listIntegrationSettings} from '../../../packages/db/src/integration-settings.js';
import {readEffectiveHealth,currentEffectiveSignal,currentProviderHealthReady} from '../../../packages/db/src/effective-health.js';
import type {Body,DomainRecord} from '../../../packages/contracts/src/index.js';
import {readiness} from '../../../packages/domain/src/catalog/validation.js';
import {validateWorkflow} from '../../../packages/domain/src/sales/workflow.js';
import {principal,parseBody,envOf,scopedRecord,resourcePermitted,present,mutate,fail,audit,command} from './context.js';
import {lineageId,lockCatalogRecord} from './catalog-versions.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';

const id=z.string().uuid(),revision=z.number().int().positive(),reason=z.string().trim().min(3).max(2000);
const assignmentSchema=z.object({expected_version:revision,product_id:id,offer_version_id:id,workflow_version_id:id,agent_version_id:id.nullable().optional(),gateway_ref:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),reason}).strict();
function owner(req:FastifyRequest){const p=principal(req);if(p.service){assertPermission(p,'assignments:write');return p;}if(p.role!=='owner')throw fail(403,'FORBIDDEN');return p;}
function reader(req:FastifyRequest){const p=principal(req);if(p.service){assertPermission(p,'channels:read');return p;}if(!['owner','operator'].includes(p.role))throw fail(403,'FORBIDDEN');return p;}
async function resolved(req:FastifyRequest,client:QueryExecutor,account:DomainRecord,legacy?:LegacyCommercialBinding){
 const binding=legacy?{id:legacy.id,body:legacy.body}:undefined,offerId=binding?.body.offer_version_id??account.body.offer_version_id;
 const offer=offerId?await getRecord(client,account.workspace_id,'offer',offerId):undefined;
 const productId=offer?.body.product_id??account.body.product_id;
 const product=productId?await getRecord(client,account.workspace_id,'product',productId):undefined;
 const workflowId=binding?.body.workflow_version_id??offer?.body.workflow_version_id??account.body.workflow_version_id??product?.body.workflow_template_version_id;
 const workflow=workflowId?await getRecord(client,account.workspace_id,'workflow',workflowId):undefined;
 const assignment=resolveSellerAssignment({binding:binding?.body,offer:offer?.body,account:account.body,product:product?.body,workflow:workflow?.body});const agentId=assignment.agent_version_id;
 if([productId,offerId,workflowId,agentId].some(resourceId=>resourceId&&!resourcePermitted(principal(req),resourceId)))return{product_id:null,offer_version_id:null,workflow_version_id:null,agent_version_id:null,agent_assignment_origin:'none',gateway_ref:account.body.gateway_ref??null,binding_id:null};
 return{product_id:productId??null,offer_version_id:offerId??null,workflow_version_id:workflowId??null,agent_version_id:agentId??null,agent_assignment_origin:assignment.origin,gateway_ref:account.body.gateway_ref??(account.body.provider==='waha'?'WAHA':null),binding_id:binding?.id??null};
}
export async function compatible(req:FastifyRequest,client:QueryExecutor,a:Body){
 const product=await scopedRecord(req,'product',a.product_id,client),offer=await scopedRecord(req,'offer',a.offer_version_id,client),workflow=await scopedRecord(req,'workflow',a.workflow_version_id,client);
 if([product,offer,workflow].some(r=>r.body.archived_at||r.body.status==='ARCHIVED'))throw fail(409,'CONFIGURATION_ARCHIVED');
 const productRoot=await lineageId(req,'product',product,client);
 const sameProduct=async(productId:string)=>await lineageId(req,'product',await scopedRecord(req,'product',productId,client),client)===productRoot;
 if(!offer.body.product_id||!await sameProduct(offer.body.product_id)||workflow.body.product_id&&!await sameProduct(workflow.body.product_id))throw fail(400,'ASSIGNMENT_PRODUCT_MISMATCH','La oferta y el flujo deben pertenecer al producto seleccionado.');
 if(workflow.body.offer_version_id){const linked=await scopedRecord(req,'offer',workflow.body.offer_version_id,client);if(await lineageId(req,'offer',linked,client)!==await lineageId(req,'offer',offer,client))throw fail(400,'ASSIGNMENT_OFFER_MISMATCH','El flujo corresponde a otra oferta.');}
 const selected=resolveSellerAssignment({binding:{agent_version_id:a.agent_version_id},offer:offer.body,product:product.body,workflow:workflow.body});if(selected.agent_version_id){const agent=await scopedRecord(req,'agent',selected.agent_version_id,client);if(agent.body.archived_at)throw fail(409,'CONFIGURATION_ARCHIVED');if(agent.body.product_id&&agent.body.product_id!==product.id||agent.body.offer_version_id&&agent.body.offer_version_id!==offer.id)throw fail(400,'AGENT_CONTEXT_MISMATCH','El vendedor corresponde a otro producto o versión de oferta. Crea una revisión compatible.');}
 return{product,offer,workflow};
}
export async function channelSetup(req:FastifyRequest,client:QueryExecutor=pool,account?:DomainRecord,assignmentId?:string,effectiveAt?:Date){
 const p=reader(req);account??=await scopedRecord(req,'channel_account',id.parse((req.params as Body).id),client);
 const environment=account.environment,now=effectiveAt??await numberNow(client,p.workspace_id,environment),operational=await readNumberOperationalState(client,account,now),settings=await readOperationalSettings(client,p.workspace_id,environment);
 const snapshot=await commercialAssignmentSnapshot(client,p.workspace_id,environment,[account.id],now),accountSnapshot=accountAssignmentSnapshot(snapshot,account.id);
 const permitted=(assignment:{account_id:string;product_id:string;body:Body})=>commercialAssignmentResourceIds(assignment).every(resourceId=>resourcePermitted(p,resourceId));
 const relationships=accountSnapshot.current.filter(permitted),visibleLegacy=accountSnapshot.legacy&&permitted(accountSnapshot.legacy)?accountSnapshot.legacy:undefined;
 const selectionId=assignmentId??(req.query as Body)?.assignment_id,selected=selectionId?relationships.find(a=>a.id===selectionId):relationships.length===1?relationships[0]:undefined;
 if(selectionId&&!selected){const visible=accountSnapshot.canonical.some(a=>a.id===selectionId&&permitted(a));if(visible)throw fail(409,'ASSIGNMENT_NOT_CURRENT','La asignación existe, pero no está activa y vigente.',{observed_at:snapshot.observed_at,reason:commercialAssignmentNonCurrentReason(accountSnapshot.canonical.filter(a=>a.id===selectionId),snapshot.observed_at)});throw fail(404,'NOT_FOUND');}
 const fallback=!accountSnapshot.has_canonical&&!selected&&(!accountSnapshot.legacy||visibleLegacy)?await resolved(req,client,account,visibleLegacy):undefined;
 const emptyAssignment={product_id:null,offer_version_id:null,workflow_version_id:null,agent_version_id:null,gateway_ref:account.body.gateway_ref??null,binding_id:null};
 const assignment:Body=selected?{...selected.body,product_id:selected.product_id,binding_id:selected.binding_id,assignment_id:selected.id,assignment_revision:selected.revision,gateway_ref:account.body.gateway_ref??null,agent_assignment_origin:'assignment'}:accountSnapshot.has_canonical||relationships.length>1?emptyAssignment:fallback??emptyAssignment,checks:Array<{key:string;label:string;ok:boolean;message?:string;href:string}>=[];
 const visibleCanonical=accountSnapshot.canonical.filter(permitted);
 const canonicalCandidates=visibleCanonical.map(a=>({assignment_id:a.id,binding_id:a.binding_id,revision:a.revision,product_id:a.product_id}));
 const assignmentResolution=selected?{state:'CURRENT',source:'commercial_assignments',reason:'ACTIVE_IN_VALIDITY_WINDOW',observed_at:snapshot.observed_at,assignment_id:selected.id,binding_id:selected.binding_id,revision:selected.revision}:relationships.length>1?{state:'REQUIRES_ATTENTION',source:'commercial_assignments',reason:'PRODUCT_SELECTION_REQUIRED',observed_at:snapshot.observed_at,candidates:relationships.map(a=>({assignment_id:a.id,binding_id:a.binding_id,revision:a.revision,product_id:a.product_id}))}:accountSnapshot.has_canonical?{state:'HISTORICAL',source:'commercial_assignments',reason:visibleCanonical.length?commercialAssignmentNonCurrentReason(visibleCanonical,snapshot.observed_at):'ASSIGNMENT_NOT_VISIBLE',observed_at:snapshot.observed_at,...(canonicalCandidates.length===1?canonicalCandidates[0]:{candidates:canonicalCandidates})}:visibleLegacy?{state:'CURRENT',source:'legacy_binding',reason:'LEGACY_BINDING_CURRENT',observed_at:snapshot.observed_at,binding_id:visibleLegacy.id}:accountSnapshot.legacy?{state:'NO_DATA',source:'legacy_binding',reason:'ASSIGNMENT_NOT_VISIBLE',observed_at:snapshot.observed_at}:fallback?.product_id?{state:'HISTORICAL',source:'legacy_account',reason:'ACCOUNT_CONFIGURATION_IS_HISTORICAL',observed_at:snapshot.observed_at}:{state:'NO_DATA',source:'none',reason:'ASSIGNMENT_MISSING',observed_at:snapshot.observed_at};
 const check=(key:string,label:string,ok:unknown,href:string,message?:string)=>checks.push({key,label,ok:Boolean(ok),href,...(message?{message}:{})});
 let offer:DomainRecord|undefined,workflow:DomainRecord|undefined;
 try{const refs=await compatible(req,client,assignment);offer=refs.offer;workflow=refs.workflow;const seller=resolveSellerAssignment({binding:assignment,offer:offer.body,product:refs.product.body,workflow:workflow.body});assignment.agent_version_id=seller.agent_version_id??null;assignment.agent_assignment_origin=seller.origin;const current=assignmentResolution.source!=='legacy_account';check('assignment',current?'Producto, oferta y flujo compatibles':'Revisa la configuración histórica de producto, oferta y flujo',current,'/sales/channels/whatsapp',current?undefined:'La cuenta conserva referencias anteriores, pero no una asignación canónica vigente.');}catch{check('assignment','Selecciona producto, oferta y flujo compatibles',false,'/sales/channels/whatsapp',assignmentResolution.reason);}
 check('offer','Oferta publicada',offer?.body.status==='PUBLISHED','/catalog');
 check('workflow','Flujo publicado y válido',workflow?.body.status==='PUBLISHED'&&validateWorkflow(workflow.body as any).valid,'/sales/flows');
 const offerReadiness=readiness(offer?.body??{});check('delivery_payment','Material de entrega y cobro configurados',offer&&offerReadiness.ready,'/catalog',offerReadiness.blockers.join('. '));
 const assets=new Set<string>((offer?.body.fulfillment??[]).map((f:Body)=>f.asset_id));
 for(const id of offerSalesFlowAssetIds(offer?.body??{}))assets.add(id);
 for(const id of workflowAssetIds(workflow?.body??{}))assets.add(id);
 let assetsReady=assets.size>0,access=false;for(const assetId of assets){const asset=await getRecord(client,p.workspace_id,'asset',assetId);if(!asset||asset.environment!==environment||asset.body.status!=='READY')assetsReady=false;if(asset?.body.kind==='access'&&asset.body.adapter==='webhook')access=true;}
 check('assets','Archivos y accesos de entrega disponibles',assetsReady,'/catalog');
 if(access)check('fulfillment','Servicio de entrega configurado',(await integrationReadiness(client,p.workspace_id,environment,'fulfillment:default')).configured,'/settings');
 if(assignment.agent_version_id){const agent=await getRecord(client,p.workspace_id,'agent',assignment.agent_version_id);if(agent&&agent.body.provider!=='deterministic'){const ai=await salesAiConfiguration(client,p.workspace_id,environment,agent.body);check('ai','Proveedor de IA, modelo y presupuesto configurados',ai.configured,'/settings',ai.state);}}
 const real=environment==='REAL';
 check('provider','Proveedor compatible con el entorno',real?['waha','cloud'].includes(account.body.provider):account.body.provider==='simulator','/sales/channels/whatsapp');
 if(real){const key=`${account.body.provider}:${assignment.gateway_ref??'default'}`;let configured=false;try{configured=(await integrationReadiness(client,p.workspace_id,environment,key)).configured;}catch{/* Invalid legacy reference is visible as a blocker. */}check('connection','Conexión del proveedor configurada',configured,'/settings');
 check('operations','Envíos reales habilitados en este entorno',!settings.body.dispatch_frozen&&settings.body.real_sends_enabled&&settings.body.allow_real_operations,'/settings');}
 check('session','Número conectado',operational.connection==='CONNECTED'&&operational.fresh,'/sales/channels/whatsapp',operational.cause);
	 const ownership=(await client.query('SELECT owner_id,generation,frozen,lease_expires_at FROM session_ownership WHERE workspace_id=$1 AND account_id=$2',[p.workspace_id,account.id])).rows[0];
 const hasReceipt=ownership&&(await client.query("SELECT 1 FROM ownership_isolation_receipts WHERE workspace_id=$1 AND account_id=$2 AND previous_owner_id=$3 AND generation=$4 AND method='container_stopped_and_access_revoked' AND consumed_at IS NULL AND verified_at<=$5 AND verified_at>$5-interval '24 hours' LIMIT 1",[p.workspace_id,account.id,ownership.owner_id,ownership.generation,now])).rowCount;
	 check('ownership','Sesión bajo control del worker o transferencia verificada',ownership&&!ownership.frozen&&(new Date(ownership.lease_expires_at).getTime()>now.getTime()+2000||hasReceipt),'/sales/channels/whatsapp','La conexión o reanudación debe confirmar quién opera esta sesión.');
 if(real&&account.body.provider==='waha')check('identity','Identidad del número verificada',account.body.identity_verified===true&&account.body.identity_conflict!==true,'/sales/channels/whatsapp');
 const health=await readEffectiveHealth(client,{workspaceId:p.workspace_id,environment,accountId:account.id,now:new Date(snapshot.observed_at)}),transportSignal=currentEffectiveSignal(health,'transport');
 check('health','Estado reciente del canal sin bloqueos',currentProviderHealthReady(health,String(account.body.provider)),'/sales/channels/whatsapp');
 if(real&&account.body.provider==='waha')check('identity_health','Evidencia reciente de la identidad conectada',transportSignal?.status==='OK'&&(transportSignal.value as Body|undefined)?.identity_fingerprint===account.body.identity_fingerprint,'/sales/channels/whatsapp');
 const globalPause=(await client.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND scope_type='workspace' AND scope_id=$1 AND (paused OR suppressed)",[p.workspace_id])).rowCount;
 check('global_pause','Pausa general del workspace liberada',!globalPause,'/settings');
 const uncertain=(await client.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('SENDING','UNKNOWN') LIMIT 1",[p.workspace_id,environment,account.id])).rowCount;
 check('uncertain','Sin envíos en curso o con resultado incierto',!uncertain,'/sales/channels/whatsapp');
 const options:Body={};for(const[kind,key]of [['product','products'],['offer','offers'],['workflow','workflows'],['agent','agents']]){options[key!]=[];for(const row of await listRecords(client,p.workspace_id,kind!,environment)){if(!resourcePermitted(p,row.id)||row.body.product_id&&!resourcePermitted(p,row.body.product_id)||row.body.offer_version_id&&!resourcePermitted(p,row.body.offer_version_id))continue;const item:Body=present(row);item.lineage_id=await lineageId(req,kind!,row,client);if(row.body.product_id)item.product_lineage_id=await lineageId(req,'product',await scopedRecord(req,'product',row.body.product_id,client),client);if(kind==='workflow'&&row.body.offer_version_id)item.offer_lineage_id=await lineageId(req,'offer',await scopedRecord(req,'offer',row.body.offer_version_id,client),client);if(!row.body.archived_at&&row.body.status!=='ARCHIVED')options[key!].push(item);}}
 options.gateways=(await listIntegrationSettings(client,p.workspace_id,environment)).filter(i=>i.type===account!.body.provider).map(i=>({id:i.reference,name:i.label,provider:i.type}));
 const authorizationId=selected?.authorization_id??(accountSnapshot.has_canonical?null:account.body.active_authorization_id);const authorization=authorizationId?(await client.query('SELECT id,created_at,expires_at,scope,revoked_at,configuration_version FROM operation_authorizations WHERE workspace_id=$1 AND environment=$2 AND id=$3',[p.workspace_id,environment,authorizationId])).rows[0]??null:null;
 const authorizationStatus=selected?commercialAuthorizationStatus(selected,snapshot.observed_at):authorization?'INVALIDATED':'NONE';
 return{assignments:relationships.map(a=>({id:a.id,revision:a.revision,product_id:a.product_id,state:a.state,...a.body})),assignment_resolution:assignmentResolution,account_version:account.version,configuration_version:settings.version,options,effective_assignment:assignment,checks,ready:checks.every(c=>c.ok),blockers:checks.filter(c=>!c.ok).map(c=>c.label),sending_enabled:account.body.sending_enabled===true,authorization,authorization_status:authorizationStatus,authorization_registered:authorizationStatus==='REGISTERED'};
}

export function projectAssignmentAuthorization(input:{setup:Body;assignment:CommercialAssignment;account:DomainRecord;authorization:Body|null;usage:number;now?:Date}){
 const now=input.now??new Date(),authorization=input.authorization,scope=authorization?.scope??{},blockers:string[]=[];
 for(const check of input.setup.checks??[])if(!check.ok)blockers.push(`SETUP_${String(check.key??'UNKNOWN').toUpperCase()}`);
 if(!activeAt(input.assignment,now.toISOString()))blockers.push('ASSIGNMENT_NOT_CURRENT');
 if(input.setup.sending_enabled!==true)blockers.push('ACCOUNT_NOT_ACTIVATED');
 if(!authorization)blockers.push('EXPLICIT_AUTHORIZATION_REQUIRED');
 else{
  if(authorization.revoked_at)blockers.push('AUTHORIZATION_REVOKED');
  if(!authorization.expires_at||Date.parse(authorization.expires_at)<=now.getTime())blockers.push('AUTHORIZATION_EXPIRED');
  if(authorization.configuration_version!==input.setup.configuration_version)blockers.push('CONFIGURATION_CHANGED');
  if(scope.mode!=='product_assignment'||scope.assignment_id!==input.assignment.id||scope.assignment_revision!==input.assignment.revision||scope.binding_id!==input.assignment.binding_id||scope.product_id!==input.assignment.product_id)blockers.push('AUTHORIZATION_SCOPE_CHANGED');
  if(!Array.isArray(scope.account_ids)||!scope.account_ids.includes(input.account.id)||scope.channel_identity_hash!==channelIdentityHash(input.account))blockers.push('CHANNEL_IDENTITY_CHANGED');
  if(!Number.isInteger(scope.max_messages)||scope.max_messages<1||input.usage>=scope.max_messages)blockers.push('AUTHORIZATION_LIMIT_REACHED');
 }
 return{ready:blockers.length===0,blockers:[...new Set(blockers)]};
}

export async function assignmentAuthorizationEligibility(req:FastifyRequest,client:QueryExecutor,account:DomainRecord,assignment:CommercialAssignment,now=new Date()){
 const setup=await channelSetup(req,client,account,assignment.id,now),authorization=setup.authorization;
 const usage=authorization?Number((await client.query("SELECT count(*)::int count FROM outbox WHERE authorization_id=$1 AND status IN('SENDING','SENT','DELIVERED','READ','UNKNOWN')",[authorization.id])).rows[0]?.count??0):0;
 return{setup,authorization,usage,...projectAssignmentAuthorization({setup,assignment,account,authorization,usage,now})};
}
async function revoke(client:QueryExecutor,account:DomainRecord){if(account.body.active_authorization_id)await client.query('UPDATE operation_authorizations SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND workspace_id=$2 AND environment=$3',[account.body.active_authorization_id,account.workspace_id,account.environment]);}
async function currentPreflight(req:FastifyRequest,c:QueryExecutor,input:Body){
 // Settings first is the shared lock order used by integration and operational mutations.
 const settings=await readOperationalSettings(c,principal(req).workspace_id,envOf(req),{lock:'share'});
 if(settings.version!==input.configuration_version)throw fail(409,'CONFIGURATION_CHANGED','La configuración cambió. Actualiza la validación.');
 const account=await lockCatalogRecord(req,'channel_account',id.parse((req.params as Body).id),c);
 if(account.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT','El número cambió. Actualiza la validación.');
 const setup=await channelSetup(req,c,account);if(!setup.ready)throw fail(409,'CHANNEL_NOT_READY','Resuelve las condiciones pendientes antes de activar.',setup.blockers);
 return{account,setup};
}

async function saveAccountAssignment(req:FastifyRequest,input:z.infer<typeof assignmentSchema>,accountId:string){
 const result=await mutate(req,'channel.setup:'+accountId+':'+input.product_id,async c=>{
 const account=await lockCatalogRecord(req,'channel_account',accountId,c);if(account.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
 await compatible(req,c,input);
 if(input.gateway_ref&&input.gateway_ref!==account.body.gateway_ref){if(!['DISCONNECTED','STOPPED','FAILED'].includes(account.body.status))throw fail(409,'DISCONNECT_BEFORE_CONNECTION_CHANGE','Desconecta el número antes de cambiar su conexión.');const profiles=await listIntegrationSettings(c,account.workspace_id,account.environment);if(!profiles.some(i=>i.type===account.body.provider&&i.reference===input.gateway_ref))throw fail(400,'CONNECTION_NOT_FOUND');if(account.body.provider==='waha'){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['qr-gateway:'+input.gateway_ref]);if((await c.query("SELECT 1 FROM records WHERE kind='channel_account' AND NOT (body ? 'deleted_at') AND environment='REAL' AND body->>'provider'='waha' AND body->>'gateway_ref'=$1 AND id<>$2",[input.gateway_ref,account.id])).rowCount)throw fail(409,'CHANNEL_GATEWAY_ALREADY_ASSIGNED');}}
 const existing=(await listAssignments(c,account.workspace_id,account.environment,{account_id:account.id,product_id:input.product_id}))[0];
 const {gateway_ref:_,...definition}=input;const assignment=await saveAssignment(req,c,assignmentInput.parse({...definition,account_id:account.id,expected_version:existing?.revision??0}));
 let saved=await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:'channel_account',version:account.version,body:{...account.body,assignment_manifest_revision:Number(account.body.assignment_manifest_revision??0)+1}});if(input.gateway_ref&&input.gateway_ref!==account.body.gateway_ref){await revoke(c,account);saved=await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:'channel_account',version:saved.version,body:{...saved.body,gateway_ref:input.gateway_ref,identity_verified:false,identity_fingerprint:null,identity_conflict:false,sending_enabled:false,active_authorization_id:null}});}
 return{data:{account:present(saved),binding_id:assignment.binding_id,assignment}};});return result.data;
}

export async function channelSetupRoutes(app:FastifyInstance){
 app.get('/v1/channel-accounts/:id/setup',async req=>({data:await channelSetup(req)}));
 app.patch('/v1/channel-accounts/:id/setup',async req=>{owner(req);return{data:await saveAccountAssignment(req,assignmentSchema.parse(parseBody(req)),id.parse((req.params as Body).id))};});
 app.post('/v1/channel-accounts/setup-batch',async(req,reply)=>{
  owner(req);const input=z.object({assignments:z.array(assignmentSchema.extend({account_id:id})).min(1).max(50)}).strict().parse(parseBody(req));
  if(new Set(input.assignments.map(a=>a.account_id+':'+a.product_id)).size!==input.assignments.length)throw fail(400,'DUPLICATE_ASSIGNMENT');
  const results=[];for(const {account_id,...assignment} of input.assignments){try{const result=await saveAccountAssignment(req,assignment,account_id);results.push({account_id,ok:true,result});}catch(error){const e=error as {statusCode?:number;code?:string};results.push({account_id,ok:false,status:e.statusCode??500,code:e.statusCode&&e.statusCode<500?e.code:'ASSIGNMENT_FAILED'});}}
  const failed=results.filter(r=>!r.ok).length;reply.code(failed?207:200);return{data:{status:failed?'PARTIAL_FAILURE':'COMPLETE',succeeded:results.length-failed,failed,results,sending_enabled:false}};
 });
 app.post('/v1/channel-accounts/:id/activate',async(req,reply)=>{const actor=owner(req);if(actor.service)assertPermission(actor,'assignments:authorize');const input=z.object({expected_version:revision,configuration_version:z.number().int().min(0),reason,confirmation:z.literal('ENABLE_REAL_ACCOUNT')}).strict().parse(parseBody(req));const result=await mutate(req,'channel.activate:'+(req.params as Body).id,async c=>{const{account}=await currentPreflight(req,c,input);await revoke(c,account);const saved=await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:'channel_account',version:account.version,body:{...account.body,sending_enabled:true,active_authorization_id:null}});const cmd=await command(c,req,'channel_command',account.id,{type:'resume',reason:input.reason});await audit(c,req,'channel.activated',account.id,{configuration_version:input.configuration_version,reason:input.reason});return{data:{account:present(saved),command_id:cmd.id},status:202};});reply.code(result.status??202);return{data:result.data};});
 app.post('/v1/channel-accounts/:id/deactivate',async(req,reply)=>{const actor=owner(req);if(actor.service)assertPermission(actor,'assignments:authorize');const input=z.object({expected_version:revision,reason}).strict().parse(parseBody(req));const result=await mutate(req,'channel.deactivate:'+(req.params as Body).id,async c=>{const account=await lockCatalogRecord(req,'channel_account',id.parse((req.params as Body).id),c);if(account.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');await revoke(c,account);const saved=await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:'channel_account',version:account.version,body:{...account.body,sending_enabled:false,active_authorization_id:null}});const cmd=await command(c,req,'channel_command',account.id,{type:'freeze',reason:input.reason});await audit(c,req,'channel.deactivated',account.id,{reason:input.reason});return{data:{account:present(saved),command_id:cmd.id},status:202};});reply.code(result.status??202);return{data:result.data};});
 app.post('/v1/channel-accounts/:id/authorize',async(req,reply)=>{const p=owner(req);if(p.service)throw fail(403,'USE_ASSIGNMENT_AUTHORIZATION');const input=z.object({expected_version:revision,configuration_version:z.number().int().min(0),recipient_mode:z.enum(['selected_contacts','new_inbound']).default('selected_contacts'),contact_ids:z.array(id).max(200).default([]),max_messages:z.number().int().min(1).max(10000),expires_at:z.string().datetime({offset:true}),allow_automation:z.boolean(),reason,confirmation:z.literal('AUTHORIZE_REAL_SCOPE')}).strict().refine(v=>v.recipient_mode==='new_inbound'?v.contact_ids.length===0:v.contact_ids.length>0,{message:'Selecciona contactos o elige nuevas conversaciones entrantes.',path:['contact_ids']}).parse(parseBody(req));if(Date.parse(input.expires_at)<=Date.now()||Date.parse(input.expires_at)>Date.now()+7*86400000)throw fail(400,'INVALID_EXPIRY');const result=await mutate(req,'channel.authorize:'+(req.params as Body).id,async c=>{const{account,setup}=await currentPreflight(req,c,input);if((await listAssignments(c,p.workspace_id,account.environment,{account_id:account.id})).length)throw fail(409,'USE_ASSIGNMENT_AUTHORIZATION','Autoriza cada producto por su vínculo.');if(!account.body.sending_enabled)throw fail(409,'ACTIVATE_ACCOUNT_FIRST');
 for(const contactId of input.contact_ids){const contact=await scopedRecord(req,'contact',contactId,c);if(contact.body.status==='SUPPRESSED')throw fail(409,'CONTACT_SUPPRESSED');if(!(await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'account_id'=$3 AND body->>'contact_id'=$4",[p.workspace_id,account.environment,account.id,contactId])).rowCount)throw fail(400,'CONTACT_NOT_OBSERVED_ON_ACCOUNT','Selecciona un contacto que haya conversado con este número.');}
 await revoke(c,account);const scope={mode:'channel_setup',recipient_mode:input.recipient_mode,assignment_revision:Number(account.body.assignment_revision??0),account_ids:[account.id],offer_version_ids:[setup.effective_assignment.offer_version_id],workflow_version_ids:[setup.effective_assignment.workflow_version_id],agent_version_id:setup.effective_assignment.agent_version_id,contact_ids:[...new Set(input.contact_ids)].sort(),max_messages:input.max_messages,allow_automation:input.allow_automation,purpose:input.reason};
 const configHash=hash(stableJson({scope,configuration_version:setup.configuration_version,assignment:setup.effective_assignment,expires_at:input.expires_at}));const auth=(await c.query('INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[p.workspace_id,account.environment,p.user.id,scope,configHash,input.expires_at,setup.configuration_version])).rows[0];
 const saved=await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:'channel_account',version:account.version,body:{...account.body,active_authorization_id:auth.id}});await audit(c,req,'channel.scope_authorized',account.id,{authorization_id:auth.id,scope,configuration_version:setup.configuration_version});return{data:{authorization:auth,account:present(saved)},status:201};});reply.code(result.status??201);return{data:result.data};});
}
