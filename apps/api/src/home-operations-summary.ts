import type {FastifyInstance,FastifyRequest} from 'fastify';
import {pool,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import {withReadBudget} from '../../../packages/db/src/read-budget.js';
import type {Body} from '@commerce/contracts';
import {assertPermission,permits,type Principal} from '../../../packages/domain/src/core/permissions.js';
import {channelProgress} from '../../../packages/domain/src/operations/service-progress.js';
import {maskedAlias} from '../../../packages/domain/src/warmup/number-state.js';
import {principal,envOf,fail,sanitize} from './context.js';
import {readCapacityDiscrepancies,readCapacitySnapshot} from './number-capacity.js';

type SummaryStatus='READY'|'REQUIRES_ATTENTION'|'BLOCKED'|'IN_PROGRESS'|'UNKNOWN'|'UNAVAILABLE'|'NO_DATA'|'HISTORICAL';
type Section={key:string;title:string;status:string;summary:{primary:string;secondary:string;metrics:Body};queue:Body[];freshness:Body};
const priorityRank:Record<string,number>={CRITICAL:0,HIGH:1,MEDIUM:2,LOW:3};
const retainedEffectReasons=new Set([
 'REAL_OPERATION_NOT_ENABLED','ACCOUNT_SENDING_NOT_ENABLED','OPERATION_PAUSED','CONTACT_SUPPRESSED','HUMAN_TAKEOVER',
 'BUSINESS_WINDOW_CLOSED','QUIET_HOURS','CONTACT_FREQUENCY_LIMIT','CAUSAL_PREDECESSOR_UNRESOLVED','CAUSAL_DELAY_PENDING',
 'SHARED_CHAT_UNRESOLVED_EFFECT','SHARED_CHAT_OTHER_PRODUCT_TURN','COMMERCIAL_PRIORITY','WARMUP_RATE_LIMIT','WARMUP_TURN_NOT_DUE',
 'WARMUP_PEER_RECEIPT_PENDING','AUTHORIZATION_MESSAGE_LIMIT','WARMUP_AUTHORIZATION_INVALID','PRODUCT_ASSIGNMENT_NOT_AUTHORIZED',
 'ACCOUNT_NOT_AUTHORIZED','OFFER_VERSION_NOT_AUTHORIZED','WORKFLOW_VERSION_NOT_AUTHORIZED','CAMPAIGN_AUTHORIZATION_REQUIRED',
 'AUTHORIZATION_MISSING_OR_EXPIRED','AUTHORIZATION_REQUIRED','AUTOMATION_NOT_AUTHORIZED',
]);
function retainedByAuthorizationOrPolicy(reason:unknown){const value=typeof reason==='string'?reason:'';return retainedEffectReasons.has(value)||value.includes('AUTHORIZATION')||value.endsWith('_NOT_AUTHORIZED')||value.endsWith('_NOT_ENABLED');}
function access(req:FastifyRequest){const p=principal(req);assertPermission(p,'reports:read');if(p.resource_ids)throw fail(403,'OPERATIONS_SUMMARY_WORKSPACE_SCOPE_REQUIRED');return p;}
function freshness(source:string,observed_at:string|null,expires_at:string|null){const valid=!!expires_at&&new Date(expires_at)>new Date();return{state:!observed_at?'UNKNOWN':valid?'FRESH':'STALE',observed_at,expires_at,source};}
function unavailable(key:string,title:string){return{key,title,status:'UNAVAILABLE' as SummaryStatus,summary:{primary:'No disponible',secondary:'La fuente falló sin ocultar las demás secciones.',metrics:{}},queue:[],freshness:{state:'UNKNOWN',observed_at:null,expires_at:null,source:key},error:{code:'SECTION_SOURCE_UNAVAILABLE'}};}
function canReadSales(p:Principal){return permits(p,'sales:read');}
function canReadNumbers(p:Principal){return permits(p,p.service?'channels:read':'sales:read');}
function canReadOperations(p:Principal){return p.service?permits(p,'commands:read'):['owner','operator','reconciler'].includes(p.role);}
function canReadReceipts(p:Principal){return p.service?permits(p,'sales:read'):['owner','operator','reconciler'].includes(p.role);}
function destinationAllowed(p:Principal,href:unknown){
 if(typeof href!=='string')return false;
 const path=href.split('?')[0];
 if(path==='/results')return permits(p,'reports:read');
 if(path==='/sales'||path==='/sales/inbox')return canReadSales(p);
 if(path==='/sales/orders'||path==='/sales/receipts')return canReadReceipts(p);
 if(path==='/sales/channels/whatsapp')return canReadNumbers(p);
 if(path==='/settings')return !p.service&&canReadOperations(p);
 return false;
}
function fallbackPriority(p:Principal){
 if(p.service)return null;
 if(canReadSales(p))return{severity:'LOW',section:'sales',code:'NO_ACCESSIBLE_OPERATIONAL_TASK',title:'No hay una tarea crítica pendiente',summary:'Las fuentes accesibles para tu rol no reportan una intervención prioritaria.',href:'/sales',status:'READY',next_action:'Revisar la cola de Ventas'};
 return{severity:'LOW',section:'results',code:'REPORTS_ONLY_ROLE',title:'Revisa resultados verificables',summary:'Tu rol puede consultar resultados sin exponer colas operativas restringidas.',href:'/results',status:'READY',next_action:'Abrir Resultados'};
}

async function numbersSection(c:QueryExecutor,workspace:string,environment:string){
 const rows=(await c.query(`SELECT a.id,a.body->>'name' name,a.body->>'identity_conflict' identity_conflict,o.frozen owner_frozen,o.release_frozen,o.lease_expires_at,
  s.observed_state,s.raw_state,s.disconnect_reason,s.last_health_at,s.health_expires_at,
  (SELECT min(auth.expires_at) FROM commercial_assignments ca JOIN operation_authorizations auth ON auth.id=ca.authorization_id WHERE ca.account_id=a.id AND ca.state='ACTIVE' AND auth.revoked_at IS NULL) authorization_expires_at,
  EXISTS(SELECT 1 FROM commands c WHERE c.workspace_id=a.workspace_id AND c.environment=a.environment AND c.resource_id=a.id::text AND c.kind='channel_command' AND c.status='PENDING') pending,
  EXISTS(SELECT 1 FROM commands c WHERE c.workspace_id=a.workspace_id AND c.environment=a.environment AND c.resource_id=a.id::text AND c.kind='channel_command' AND c.status='FAILED' AND COALESCE(c.result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(c.result?'reconciled_at')) uncertain
  FROM records a LEFT JOIN channel_sessions s ON s.account_id=a.id AND s.archived_at IS NULL LEFT JOIN session_ownership o ON o.account_id=a.id::text
  WHERE a.workspace_id=$1 AND a.environment=$2 AND a.kind='channel_account' AND NOT a.body?'deleted_at' ORDER BY a.updated_at DESC`,[workspace,environment])).rows;
 const connected=rows.filter(row=>row.observed_state==='CONNECTED'&&row.health_expires_at&&new Date(row.health_expires_at)>new Date()).length;
 const queue=rows.filter(row=>row.uncertain||row.pending||row.identity_conflict==='true'||row.release_frozen||row.owner_frozen||!row.lease_expires_at||new Date(row.lease_expires_at)<=new Date()||row.authorization_expires_at&&new Date(row.authorization_expires_at).getTime()<Date.now()+24*3600000||row.observed_state!=='CONNECTED'||!row.health_expires_at||new Date(row.health_expires_at)<=new Date()).slice(0,12).map(row=>{const unknown=Boolean(row.uncertain),pending=Boolean(row.pending),blocked=row.identity_conflict==='true'||row.observed_state==='AUTH_FAILURE',release=Boolean(row.release_frozen),ownership=Boolean(row.owner_frozen),ownershipExpired=!row.lease_expires_at||new Date(row.lease_expires_at)<=new Date(),expiry=row.authorization_expires_at?new Date(row.authorization_expires_at).getTime():null,expired=expiry!==null&&expiry<=Date.now(),expiring=expiry!==null&&expiry>Date.now()&&expiry<Date.now()+24*3600000;return{id:row.id,status:unknown?'UNKNOWN':blocked?'BLOCKED':pending?'IN_PROGRESS':'REQUIRES_ATTENTION',priority:unknown||blocked||expired||ownershipExpired?'HIGH':'MEDIUM',title:maskedAlias(row.name??'Número'),summary:unknown?'Hay un resultado remoto por conciliar.':blocked?'Identidad o autenticación bloqueada.':pending?'Hay un comando de ciclo de vida en proceso.':release?'El relevo de publicación aún no confirmó salud y propiedad.':ownership?'La propiedad del número está congelada.':ownershipExpired?'El worker no tiene control vigente de la sesión; no puede enviar.':expired?'La autorización venció; requiere una nueva decisión del dueño.':expiring?'La autorización vence en menos de 24 horas.':'Conexión o salud requiere atención.',href:`/sales/channels/whatsapp?number=${row.id}`,reason_code:unknown?'REMOTE_OUTCOME_UNKNOWN':row.identity_conflict==='true'?'IDENTITY_CONFLICT':pending?'LIFECYCLE_COMMAND_PENDING':release?'RELEASE_RECOVERY_PENDING':ownership?'OWNERSHIP_FROZEN':ownershipExpired?'OWNERSHIP_EXPIRED':expired?'AUTHORIZATION_EXPIRED':expiring?'AUTHORIZATION_EXPIRING':row.disconnect_reason??'SESSION_NOT_CONNECTED'};});
 const latest=rows.map(row=>row.last_health_at).filter(Boolean).sort().at(-1)??null,expiry=rows.map(row=>row.health_expires_at).filter(Boolean).sort().at(-1)??null;
 return{key:'numbers',title:'Números',status:queue.some(row=>row.status==='UNKNOWN')?'UNKNOWN':queue.some(row=>row.status==='BLOCKED')?'BLOCKED':queue.some(row=>row.status==='REQUIRES_ATTENTION')?'REQUIRES_ATTENTION':queue.some(row=>row.status==='IN_PROGRESS')?'IN_PROGRESS':rows.length?'READY':'NO_DATA',summary:{primary:rows.length?`${connected} de ${rows.length} con salud vigente`:'Sin números',secondary:queue.length?`${queue.length} requieren atención o seguimiento.`:'Sin bloqueos observados.',metrics:{total:rows.length,connected,attention:queue.length,pending:rows.filter(row=>row.pending).length,unknown:rows.filter(row=>row.uncertain).length}},queue,freshness:freshness('channel_sessions',latest,expiry)};
}

async function salesSection(c:QueryExecutor,workspace:string,environment:string,includeReceipts:boolean){
 const metrics=(await c.query(`SELECT
  count(*) FILTER(WHERE kind='conversation' AND body->>'status'='OPEN')::int open_conversations,
  count(*) FILTER(WHERE kind='conversation' AND (body->>'stage'='HUMAN_REVIEW' OR body->'flow_state'->>'status'='HUMAN_REVIEW'))::int human_review,
  count(*) FILTER(WHERE $3::boolean AND kind='receipt' AND body->>'status'='HUMAN_REVIEW')::int receipts_review,
  max(updated_at) observed_at
  FROM records WHERE workspace_id=$1 AND environment=$2 AND (kind='conversation' OR $3::boolean AND kind IN('receipt','order'))`,[workspace,environment,includeReceipts])).rows[0];
 const conversations=(await c.query(`SELECT id,'conversation' kind,body->>'stage' state,updated_at FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND (body->>'stage'='HUMAN_REVIEW' OR body->'flow_state'->>'status'='HUMAN_REVIEW') ORDER BY updated_at DESC LIMIT 12`,[workspace,environment])).rows;
 const receipts=includeReceipts?(await c.query(`SELECT id,'receipt' kind,body->>'status' state,updated_at FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='receipt' AND body->>'status'='HUMAN_REVIEW' ORDER BY updated_at DESC LIMIT 12`,[workspace,environment])).rows:[];
 const candidates=[...conversations,...receipts].sort((a,b)=>new Date(b.updated_at).getTime()-new Date(a.updated_at).getTime()).slice(0,12);
 const queue=candidates.map(row=>({id:row.id,status:'REQUIRES_ATTENTION',priority:'HIGH',title:row.kind==='receipt'?'Comprobante por revisar':'Conversación por revisar',summary:row.kind==='receipt'?'Requiere una decisión humana; no se reconoce ingreso automáticamente.':'El flujo está detenido para revisión humana.',href:row.kind==='receipt'?`/sales/receipts?receipt=${row.id}`:`/sales/inbox?conversation=${row.id}`,reason_code:row.kind==='receipt'?'RECEIPT_HUMAN_REVIEW':'WORKFLOW_HUMAN_REVIEW'}));
 const total=Number(metrics.open_conversations??0),review=Number(metrics.human_review??0)+Number(metrics.receipts_review??0);
 return{key:'sales',title:'Ventas',status:review?'REQUIRES_ATTENTION':total?'READY':'NO_DATA',summary:{primary:total?`${total} conversaciones abiertas`:'Sin trabajo abierto',secondary:review?`${review} decisiones humanas pendientes.`:'Sin revisiones pendientes.',metrics:{open_conversations:total,human_review:Number(metrics.human_review??0),receipts_review:Number(metrics.receipts_review??0)}},queue,freshness:{state:metrics.observed_at?'FRESH':'UNKNOWN',observed_at:metrics.observed_at??null,expires_at:null,source:'sales_records'}};
}

async function operationsSection(c:QueryExecutor,workspace:string,environment:string,p:Principal){
 const policy=environment==='REAL'?await readOperationalSettings(c,workspace,'REAL'):null;
 const commands=(await c.query("SELECT status,count(*)::int count,min(created_at) oldest,max(updated_at) observed_at FROM commands WHERE workspace_id=$1 AND environment=$2 AND (status='PENDING' OR status='FAILED' AND kind='channel_command' AND payload->>'type' IN('connect','restart','disconnect','logout') AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at')) GROUP BY status",[workspace,environment])).rows;
 const effects=(await c.query("SELECT status,result->>'reason' reason,count(*)::int count,min(created_at) oldest,max(updated_at) observed_at FROM outbox WHERE workspace_id=$1 AND environment=$2 AND status IN('SENDING','UNKNOWN','BLOCKED') GROUP BY status,result->>'reason'",[workspace,environment])).rows;
 const heartbeat=(await c.query("SELECT body,updated_at FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='service_heartbeat' AND body->>'service'='channel-worker' ORDER BY updated_at DESC LIMIT 1",[workspace,environment])).rows[0];
 const needsWorker=Boolean((await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT body?'deleted_at' LIMIT 1",[workspace,environment])).rowCount),worker=channelProgress(heartbeat?.body),workerBlocked=needsWorker&&!worker.ready;
 const unknown=Number(commands.find(row=>row.status==='FAILED')?.count??0)+effects.filter(row=>row.status==='UNKNOWN').reduce((total,row)=>total+Number(row.count??0),0),pending=Number(commands.find(row=>row.status==='PENDING')?.count??0)+effects.filter(row=>row.status==='SENDING').reduce((total,row)=>total+Number(row.count??0),0),blockedRows=effects.filter(row=>row.status==='BLOCKED'),blocked=blockedRows.reduce((total,row)=>total+Number(row.count??0),0),retained=blockedRows.filter(row=>retainedByAuthorizationOrPolicy(row.reason)).reduce((total,row)=>total+Number(row.count??0),0),technicalBlocked=blocked-retained,queue:Body[]=[];
 const href=!p.service?'/settings?section=audit':null;
 if(unknown&&href)queue.push({id:'unknown-remote-results',status:'UNKNOWN',priority:'CRITICAL',title:'Resultados inciertos',summary:`${unknown} operaciones requieren readback; no se reintentan a ciegas.`,href,reason_code:'REMOTE_OUTCOME_UNKNOWN'});
 if(pending&&href)queue.push({id:'operations-in-progress',status:'IN_PROGRESS',priority:'MEDIUM',title:'Operaciones en proceso',summary:`${pending} trabajos o envíos siguen en curso.`,href,reason_code:'OPERATION_IN_PROGRESS'});
 if(technicalBlocked&&href)queue.push({id:'technical-blocked-effects',status:'BLOCKED',priority:'HIGH',title:'Bloqueos técnicos',summary:`${technicalBlocked} efectos requieren diagnóstico técnico.`,href,reason_code:'TECHNICAL_EFFECT_BLOCKED'});
 if(workerBlocked&&href)queue.push({id:'channel-worker-unavailable',status:'BLOCKED',priority:'HIGH',title:'Mensajería sin progreso confirmado',summary:'El worker no acredita ejecución reciente de sus tareas; revisa su salud antes de enviar.',href,reason_code:worker.code});
 if(policy?.release_hold&&href)queue.push({id:'release-hold',status:'BLOCKED',priority:'HIGH',title:'Publicación aún pausa REAL',summary:'El release hold sigue activo; revisa el despliegue y su recuperación.',href:'/settings',reason_code:'RELEASE_HOLD_ACTIVE'});
 else if(policy?.body.dispatch_frozen&&href)queue.push({id:'real-policy-frozen',status:'REQUIRES_ATTENTION',priority:'MEDIUM',title:'REAL congelado',summary:'La política no permite despachos. Revisa el interruptor y el alcance autorizado.',href:'/settings',reason_code:'REAL_POLICY_FROZEN'});
 if(retained&&href)queue.push({id:'retained-effects',status:'REQUIRES_ATTENTION',priority:'MEDIUM',title:'Mensajes retenidos',summary:`${retained} efectos permanecen bloqueados por política o autorización; revisa su causa antes de liberar.`,href:'/sales/channels/whatsapp',reason_code:'RETAINED_EFFECTS'});
 const latest=[...commands,...effects].map(row=>row.observed_at).filter(Boolean).sort().at(-1)??heartbeat?.updated_at;
 const retainedReasons=Object.fromEntries(blockedRows.filter(row=>retainedByAuthorizationOrPolicy(row.reason)).map(row=>[row.reason??'POLICY_UNSPECIFIED',Number(row.count??0)]));
 const secondary=technicalBlocked?`${technicalBlocked} efectos tienen un bloqueo técnico${retained?`; ${retained} permanecen retenidos por autorización/política`:''}.`:retained?`${retained} efectos retenidos por autorización/política.`:'Sin readback incierto observado.';
 return{key:'operations',title:'Operaciones',status:unknown?'UNKNOWN':technicalBlocked||workerBlocked||policy?.release_hold?'BLOCKED':policy?.body.dispatch_frozen||retained?'REQUIRES_ATTENTION':pending?'IN_PROGRESS':'READY',summary:{primary:unknown?`${unknown} resultados inciertos`:technicalBlocked?technicalBlocked===1?'1 bloqueo técnico':`${technicalBlocked} bloqueos técnicos`:workerBlocked?'Mensajería sin progreso confirmado':policy?.release_hold?'Publicación sin recuperar':policy?.body.dispatch_frozen?'REAL congelado':pending?`${pending} operaciones en curso`:'Operación técnica estable',secondary,metrics:{unknown,pending,blocked,retained,technical_blocked:technicalBlocked,channel_worker:needsWorker?worker:{ready:null,code:'NOT_REQUIRED'},retained_reasons:retainedReasons,release_hold:policy?.release_hold??false}},queue,freshness:{state:latest?'FRESH':'UNKNOWN',observed_at:latest??null,expires_at:null,source:'commands+outbox+heartbeats'}};
}

async function capacitySection(c:QueryExecutor,workspace:string,environment:string){
 const snapshot=await readCapacitySnapshot(c,workspace,environment),discrepancies=await readCapacityDiscrepancies(c,workspace,environment,snapshot),metrics=snapshot.metrics;
 const queue=discrepancies.items.slice(0,12).map((item:Body)=>({id:item.id,status:item.severity==='HIGH'?'BLOCKED':'REQUIRES_ATTENTION',priority:item.severity,title:'Capacidad por conciliar',summary:item.summary,href:'/sales/channels/whatsapp?view=capacity',reason_code:item.code}));
 return{key:'capacity',title:'Capacidad',status:discrepancies.counts.HIGH?'BLOCKED':queue.length?'REQUIRES_ATTENTION':'READY',summary:{primary:`${metrics.reserved} reservadas · ${metrics.connected_sessions} conectadas`,secondary:metrics.physical_capacity_measured===null?'Capacidad física no medida.':`${metrics.physical_capacity_measured} sesiones físicas medidas.`,metrics},queue,freshness:freshness('number_capacity_observations',snapshot.observation?.observed_at??null,snapshot.observation?.expires_at??null)};
}

export async function homeOperationsSummaryRoutes(app:FastifyInstance){
 app.get('/v1/home/operations-summary',async req=>{
  const p=access(req),environment=envOf(req),definitions=[
   {key:'numbers',title:'Números',allowed:canReadNumbers(p),loader:(c:QueryExecutor)=>numbersSection(c,p.workspace_id,environment)},
   {key:'sales',title:'Ventas',allowed:canReadSales(p),loader:(c:QueryExecutor)=>salesSection(c,p.workspace_id,environment,canReadReceipts(p))},
   {key:'operations',title:'Operaciones',allowed:canReadOperations(p),loader:(c:QueryExecutor)=>operationsSection(c,p.workspace_id,environment,p)},
   {key:'capacity',title:'Capacidad',allowed:canReadNumbers(p),loader:(c:QueryExecutor)=>capacitySection(c,p.workspace_id,environment)},
  ].filter(definition=>definition.allowed);
  const results=await Promise.allSettled(definitions.map(definition=>withReadBudget<Section>(pool,4000,definition.loader)));
  const sections=results.map((result,index)=>result.status==='fulfilled'?{...result.value,queue:result.value.queue.filter((item:Body)=>destinationAllowed(p,item.href))}:unavailable(definitions[index]!.key,definitions[index]!.title));
  const queue:Body[]=sections.flatMap(section=>section.queue.map((item:Body)=>({...item,section:section.key}))).filter((item:Body)=>destinationAllowed(p,item.href)).sort((a:Body,b:Body)=>(priorityRank[a.priority]??99)-(priorityRank[b.priority]??99));
  const first=queue[0],priority=first?{severity:first.priority,section:first.section,code:first.reason_code,title:first.title,summary:first.summary,href:first.href}:fallbackPriority(p);
  const partial=sections.some(section=>section.status==='UNAVAILABLE');
  const status:SummaryStatus=sections.some(section=>section.status==='UNKNOWN')?'UNKNOWN':sections.some(section=>section.status==='BLOCKED')?'BLOCKED':sections.some(section=>section.status==='REQUIRES_ATTENTION')?'REQUIRES_ATTENTION':sections.some(section=>section.status==='IN_PROGRESS')?'IN_PROGRESS':partial?'UNAVAILABLE':sections.every(section=>section.status==='NO_DATA')?'NO_DATA':'READY';
  return{data:sanitize({status,environment,partial,generated_at:new Date().toISOString(),priority,sections})};
 });
}
