import {offerSalesFlowAssetIds,workflowAssetIds} from '../../../packages/domain/src/sales/workflow-assets.js';
import type {FastifyInstance} from 'fastify';
import {pool,getRecord,listRecords,readOperationalSettings,readEffectiveHealthBatch,currentProviderHealthReady} from '../../../packages/db/src/index.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {warmupIdentityMatches} from '../../../packages/db/src/warmup.js';
import {accountAssignmentSnapshot,commercialAssignmentNonCurrentReason,commercialAssignmentResourceIds,commercialAssignmentSnapshot,commercialAuthorizationStatus} from '../../../packages/db/src/commercial-assignments.js';
import {integrationReadiness} from '../../../packages/db/src/integration-settings.js';
import {readiness as offerReadiness} from '../../../packages/domain/src/catalog/validation.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {channelProgress} from '../../../packages/domain/src/operations/service-progress.js';
import {automationProgress} from '../../../packages/domain/src/operations/automation-progress.js';
import {principal,envOf,resourcePermitted,fail,sanitize} from './context.js';
import {mailMetadata,readMailSetting} from './identity-mail.js';
import type {Body} from '../../../packages/contracts/src/index.js';
const evidenceKinds=['backup_external','restore_assets','smtp_received','alert_received','ai_evaluation','provider_capability','commercial_pilot','warmup_pilot','staging_24h','accessibility_human'] as const;
type Check={key:string;label:string;status:string;source:string;observed_at:string|null;href:string;message?:string;details?:{available_bytes:number;total_bytes:number}};
const iso=(value:any)=>value?new Date(value).toISOString():null;
const configured=(checks:Check[])=>checks.every(c=>['CONFIGURED','VERIFIED','NOT_APPLICABLE'].includes(c.status));
export async function readinessRoutes(app:FastifyInstance){
 app.get('/v1/readiness',async req=>{
  const p=principal(req),environment=envOf(req);if(p.service)assertPermission(p,'channels:read');else if(!['owner','operator'].includes(p.role))throw fail(403,'FORBIDDEN');
  const observedDate=await numberNow(pool,p.workspace_id,environment),observed_at=observedDate.toISOString(),policy=await readOperationalSettings(pool,p.workspace_id,environment);
  const records=(await listRecords(pool,p.workspace_id,'channel_account',environment)).filter(r=>!r.body.deleted_at&&resourcePermitted(p,r.id));
  const ownershipByAccount=new Map((environment==='REAL'&&records.length?(await pool.query('SELECT account_id,frozen,release_frozen,lease_expires_at,updated_at FROM session_ownership WHERE workspace_id=$1 AND account_id=ANY($2::text[])',[p.workspace_id,records.map(record=>record.id)])).rows:[]).map(row=>[row.account_id,row]));
  const healthByAccount=await readEffectiveHealthBatch(pool,{workspaceId:p.workspace_id,environment,accountIds:records.map(record=>record.id),now:observedDate});
  const assignmentSnapshot=await commercialAssignmentSnapshot(pool,p.workspace_id,environment,records.map(record=>record.id),observedDate);
  const accounts=[];const requiredCommercialIds=new Set<string>(),requiredAgentIds=new Set<string>();
  for(const account of records){
   const checks:Check[]=[],at=iso(account.updated_at),href='/sales/channels/whatsapp';
   const add=(key:string,label:string,status:string,source='RECORD_METADATA',message?:string)=>checks.push({key,label,status,source,observed_at:at,href,message});
   add('connection','Número conectado',account.body.status==='WORKING'?'CONFIGURED':'BLOCKED','PROVIDER_SESSION_RECORD','WORKING registrado; no acredita entrega de mensajes.');
   add('identity','Identidad del número',account.body.provider==='simulator'?'NOT_APPLICABLE':account.body.identity_verified===true&&!account.body.identity_conflict?'VERIFIED':'UNAVAILABLE','PROVIDER_IDENTITY_RECORD');
   // All REAL transports pass the dispatch ownership gate, including Cloud.
   // SIMULATION readiness is configuration evidence, not a REAL lease claim.
   const ownership=ownershipByAccount.get(account.id),leaseAt=ownership?new Date(ownership.lease_expires_at).getTime():NaN;
   const ownershipCode=!ownership?'OWNERSHIP_NOT_CONFIRMED':ownership.release_frozen?'RELEASE_RECOVERY_PENDING':ownership.frozen?'OWNERSHIP_FROZEN':!Number.isFinite(leaseAt)||leaseAt<=observedDate.getTime()?'OWNERSHIP_EXPIRED':leaseAt<=observedDate.getTime()+2000?'OWNERSHIP_EXPIRING':undefined;
   add('ownership','Control vigente de la sesión',environment==='SIMULATION'?'NOT_APPLICABLE':ownershipCode?'BLOCKED':'VERIFIED','SESSION_OWNERSHIP',environment==='REAL'?ownershipCode:undefined);
   checks.at(-1)!.observed_at=iso(ownership?.updated_at);
   const accountAssignments=accountAssignmentSnapshot(assignmentSnapshot,account.id),permitted=(assignment:{account_id:string;product_id:string;body:Body})=>commercialAssignmentResourceIds(assignment).every(resourceId=>resourcePermitted(p,resourceId)),current=accountAssignments.current.filter(permitted),legacy=!accountAssignments.has_canonical&&accountAssignments.legacy&&permitted(accountAssignments.legacy)?accountAssignments.legacy:undefined;
   const routes:Array<{assignment?:typeof current[number];product_id:string;body:Body}> = current.length?current.map(assignment=>({assignment,product_id:assignment.product_id,body:assignment.body})):legacy?[{product_id:legacy.product_id,body:legacy.body}]:[];
   const assignmentReason=routes.length?'ACTIVE_IN_VALIDITY_WINDOW':accountAssignments.has_canonical?accountAssignments.current.length?'ASSIGNMENT_NOT_VISIBLE':commercialAssignmentNonCurrentReason(accountAssignments.canonical,assignmentSnapshot.observed_at):accountAssignments.legacy?'ASSIGNMENT_NOT_VISIBLE':'ASSIGNMENT_MISSING';
   add('assignment','Asignación comercial vigente',routes.length?'CONFIGURED':p.service?'UNAVAILABLE':'BLOCKED','COMMERCIAL_ASSIGNMENT_SNAPSHOT',routes.length?undefined:p.service?'ASSIGNMENT_NOT_VISIBLE_OR_MISSING':assignmentReason);checks.at(-1)!.observed_at=assignmentSnapshot.observed_at;
   let offersReady=routes.length>0,flowsReady=routes.length>0,materialsReady=routes.length>0,paymentsReady=routes.length>0;
   requiredCommercialIds.add(account.id);
   for(const route of routes){
    const offerId=route.body.offer_version_id,productId=route.product_id;
    const offer=offerId&&resourcePermitted(p,offerId)?await getRecord(pool,p.workspace_id,'offer',offerId):undefined;
    const product=productId&&resourcePermitted(p,productId)?await getRecord(pool,p.workspace_id,'product',productId):undefined;
    const flowId=route.body.workflow_version_id??offer?.body.workflow_version_id??product?.body.workflow_template_version_id;
    const flow=flowId&&resourcePermitted(p,flowId)?await getRecord(pool,p.workspace_id,'workflow',flowId):undefined;
    if(product?.environment===environment)requiredCommercialIds.add(product.id);if(offer?.environment===environment)requiredCommercialIds.add(offer.id);if(flow?.environment===environment)requiredCommercialIds.add(flow.id);
    const agentId=route.body.agent_version_id??offer?.body.agent_version_id??product?.body.agent_version_id??flow?.body.agent_version_id;if(agentId&&resourcePermitted(p,agentId))requiredAgentIds.add(agentId);
    offersReady&&=offer?.environment===environment&&offer.body.status==='PUBLISHED';
    flowsReady&&=flow?.environment===environment&&flow.body.status==='PUBLISHED';
    paymentsReady&&=offer?.environment===environment&&offerReadiness(offer.body).ready;
    const materialIds=new Set<string>((offer?.body.fulfillment??[]).map((f:any)=>f.asset_id));for(const id of offerSalesFlowAssetIds(offer?.body??{}))materialIds.add(id);for(const id of workflowAssetIds(flow?.body??{}))materialIds.add(id);
    let routeMaterialsReady=materialIds.size>0;for(const id of materialIds){if(!resourcePermitted(p,id)){routeMaterialsReady=false;continue;}const asset=await getRecord(pool,p.workspace_id,'asset',id);if(asset?.environment!==environment||asset.body.status!=='READY')routeMaterialsReady=false;}materialsReady&&=routeMaterialsReady;
   }
   add('offer','Ofertas publicadas',offersReady?'CONFIGURED':'BLOCKED','CATALOG_VERSION');
   add('workflow','Flujos publicados',flowsReady?'CONFIGURED':'BLOCKED','CATALOG_VERSION');
   add('materials','Materiales finalizados',materialsReady?'CONFIGURED':'BLOCKED','ASSET_METADATA','Estado READY; recepción, reproducción y acceso requieren evidencia separada.');
   add('payment','Cobro y comprobantes',paymentsReady?'CONFIGURED':'BLOCKED','CATALOG_VERSION','El ingreso depende del comprobante validado.');
   const health=healthByAccount.get(account.id)!;
   const healthOk=currentProviderHealthReady(health,String(account.body.provider));
   const currentHealth=health.signals.some(signal=>signal.current);add('health','Salud reciente del canal',currentHealth?healthOk?'VERIFIED':'BLOCKED':'UNAVAILABLE','PROVIDER_HEALTH_RECORD','La sesión y transporte observados no acreditan calidad cuando el proveedor no la expone.');
   checks.at(-1)!.observed_at=health.signals.length?iso(health.signals.reduce((a,b)=>Date.parse(a.observed_at)>Date.parse(b.observed_at)?a:b).observed_at):null;
   const warmup=(await pool.query('SELECT s.status,s.updated_at,i.address_fingerprint,i.address_ciphertext FROM warmup_states s LEFT JOIN warmup_identities i ON i.id=s.identity_id AND i.account_id=s.account_id WHERE s.workspace_id=$1 AND s.environment=$2 AND s.account_id=$3',[p.workspace_id,environment,account.id])).rows[0];
   add('warmup','Preparación del número',account.body.provider==='cloud'||environment==='SIMULATION'?'NOT_APPLICABLE':warmup?.status==='GRADUATED'&&warmupIdentityMatches(account,warmup)?'VERIFIED':warmup?'BLOCKED':'UNAVAILABLE','WARMUP_STATE',warmup?.status==='GRADUATED'&&!warmupIdentityMatches(account,warmup)?'La identidad conectada no coincide con el número preparado.':undefined);
   checks.at(-1)!.observed_at=iso(warmup?.updated_at);
   const canonicalAuthorization=current.length>0&&current.every(assignment=>commercialAuthorizationStatus(assignment,assignmentSnapshot.observed_at)==='REGISTERED');
	   const legacyAuthorization=!accountAssignments.has_canonical&&!!account.body.active_authorization_id&&((await pool.query('SELECT id FROM operation_authorizations WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND revoked_at IS NULL AND expires_at>$4',[p.workspace_id,environment,account.body.active_authorization_id,observedDate])).rowCount??0)>0;
   const authorization=accountAssignments.has_canonical?canonicalAuthorization:legacyAuthorization;
   add('sending','Política y permiso operativo',environment==='SIMULATION'?'NOT_APPLICABLE':!policy.body.dispatch_frozen&&policy.body.real_sends_enabled&&policy.body.allow_real_operations&&account.body.sending_enabled&&authorization?'CONFIGURED':'BLOCKED','OPERATIONAL_POLICY','Presencia de autorización; el dispatcher vuelve a validar todos sus límites.');
   const unknown=(await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status='UNKNOWN'",[p.workspace_id,environment,account.id])).rows[0].count;
   add('uncertain','Efectos con resultado incierto',unknown?'BLOCKED':'VERIFIED','OUTBOX_QUERY',unknown?'Revisar UNKNOWN; no reenviar automáticamente.':'No hay resultados UNKNOWN en la consulta.');
   accounts.push({id:account.id,name:account.body.name,version:account.version,checks,configuration_ready:configured(checks)});
  }
  // A channel token cannot discover unrelated catalog, SMTP, credentials,
  // backups, global worker activity or human attestations, even when unbounded.
  if(p.service)return{data:{environment,scope:'RESOURCE',observed_at,configuration_ready:accounts.length>0&&accounts.every(a=>a.configuration_ready),ready:false,checks:[],accounts,evidence:[]}};
  const checks:Check[]=[{key:'operations',label:'Política operativa',status:environment==='SIMULATION'?'NOT_APPLICABLE':!policy.body.dispatch_frozen&&policy.body.real_sends_enabled&&policy.body.allow_real_operations?'CONFIGURED':'BLOCKED',source:'SERVER_CONFIGURATION',observed_at:iso(policy.updated_at),href:'/settings',message:'REAL predeterminado no habilita envíos.'}];
  const ai=await integrationReadiness(pool,p.workspace_id,environment,'openai:default');checks.push({key:'ai_configuration',label:'Proveedor de IA configurado',status:ai.configured&&ai.enabled?'CONFIGURED':'UNAVAILABLE',source:'INTEGRATION_METADATA',observed_at,href:'/settings',message:'Configurar no acredita evaluación del modelo ni llamadas externas.'});
  const mail=mailMetadata(await readMailSetting());checks.push({key:'smtp_configuration',label:'Correo de recuperación',status:mail.enabled&&mail.credentials_configured?'CONFIGURED':'UNAVAILABLE',source:'SMTP_METADATA',observed_at:iso(mail.diagnosed_at),href:'/settings/security',message:'La configuración y SMTP_CONNECTION_OK no acreditan recepción.'});
  const heartbeats=await listRecords(pool,p.workspace_id,'service_heartbeat',environment);
  for(const name of ['automation-worker','channel-worker']){
   const beat=heartbeats.filter(h=>h.body.service===name).sort((a,b)=>new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime())[0];
   const progress=name==='channel-worker'?channelProgress(beat?.body):name==='automation-worker'?automationProgress(beat?.body):undefined,at=Date.parse(beat?.body.observed_at??'');
   const status=progress?progress.ready?'VERIFIED':progress.code.endsWith('_UNAVAILABLE')?'UNAVAILABLE':progress.code.endsWith('_STALE')?'STALE':'BLOCKED':beat?Date.parse(beat.body.expires_at??'')<=Date.now()||!Number.isFinite(Date.parse(beat.body.expires_at??''))?'STALE':beat.body.status==='OK'?'VERIFIED':'BLOCKED':'UNAVAILABLE';
   checks.push({key:name,label:name,status,source:'WORKER_HEARTBEAT',observed_at:Number.isFinite(at)?iso(at):null,href:'/system',message:progress&&!progress.ready?progress.code:'Última instancia registrada; su progreso no acredita efectos externos.'});
  }
  const disk=(await pool.query("SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='operational_metric' AND body->>'key'='private_storage_disk' ORDER BY updated_at DESC LIMIT 1",[p.workspace_id,environment])).rows[0]?.body;
  const diskValues=disk?.status==='OBSERVED'&&disk.source==='MOUNTED_PRIVATE_STORAGE_STATFS'&&Number.isSafeInteger(disk.available_bytes)&&Number.isSafeInteger(disk.total_bytes)&&disk.available_bytes>=0&&disk.total_bytes>0&&disk.available_bytes<=disk.total_bytes;
  const diskObserved=Date.parse(disk?.observed_at??''),diskExpires=Date.parse(disk?.expires_at??'');
  const diskFresh=Number.isFinite(diskObserved)&&diskObserved<=Date.now()+60000&&Number.isFinite(diskExpires)&&diskExpires>Date.now();
  checks.push({key:'private_storage_disk',label:'Espacio del almacenamiento privado',status:!diskValues?'UNAVAILABLE':!diskFresh?'STALE':disk.available_bytes<Math.max(1024**3,disk.total_bytes*0.05)?'BLOCKED':'VERIFIED',source:'MOUNTED_PRIVATE_STORAGE_STATFS',observed_at:Number.isFinite(diskObserved)?iso(diskObserved):null,href:'/system',message:diskValues?`Disponibles ${(disk.available_bytes/1024**3).toFixed(2)} GiB de ${(disk.total_bytes/1024**3).toFixed(2)} GiB. Umbral: 1 GiB o 5%; no acredita backup ni capacidad remota.`:'No hay una medición válida del volumen privado montado.',...(diskValues?{details:{available_bytes:disk.available_bytes,total_bytes:disk.total_bytes}}:{})});
  const evidence=(await pool.query('SELECT DISTINCT ON(kind) id,kind,status,source,evidence_ref,details,observed_at,expires_at FROM operational_evidence WHERE workspace_id=$1 AND environment=$2 ORDER BY kind,observed_at DESC,created_at DESC',[p.workspace_id,environment])).rows;
  for(const kind of evidenceKinds){const e=evidence.find(r=>r.kind===kind);
   const required=kind==='commercial_pilot'?[...requiredCommercialIds]:kind==='provider_capability'||kind==='warmup_pilot'?records.filter(a=>a.body.provider==='waha').map(a=>a.id):kind==='ai_evaluation'?[...requiredAgentIds]:[];
   const coversScope=required.every(id=>e?.details?.resource_ids?.includes(id));
   checks.push({key:kind,label:kind,status:e?new Date(e.expires_at).getTime()<Date.now()?'STALE':!coversScope?'UNAVAILABLE':e.status:'UNAVAILABLE',source:e?.source??'NO_EVIDENCE',observed_at:iso(e?.observed_at),href:'/settings',message:!coversScope?'La evidencia no cubre todas las cuentas y versiones vigentes.':e?.source==='HUMAN_ATTESTATION'?'Declaración humana registrada; no medición automática.':undefined});}

  return{data:{environment,scope:'WORKSPACE',observed_at,configuration_ready:accounts.length>0&&accounts.every(a=>a.configuration_ready),ready:accounts.length>0&&accounts.every(a=>a.configuration_ready)&&configured(checks),checks,accounts,evidence:sanitize(evidence)}};
 });
}
