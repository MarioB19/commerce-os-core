import type {ProfileExecutor} from './profile-context.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
import type {ProfileScope} from '../../contracts/src/profiles.js';
import {readOnboarding} from './profile-integrations.js';

/** V7 F2 profile reads for Inicio (RF-04), usage (RF-01.8), audit (RNF-04.b)
 * and operation lookup (RF-15). Aggregates only; no message text, contact
 * identity or secret leaves these functions. */
export class ProfileReadError extends Error{constructor(readonly code:string,readonly statusCode=400){super(code);}}
async function authorize(db:ProfileExecutor,authority:ProfileAuthority,scope:ProfileScope){
 const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);
 authorizeProfileAction(authority,{scope,workspaceId:db.workspaceId,mutation:false},now);return now;
}
const n=(v:unknown)=>Number(v??0);
const iso=(v:unknown)=>v===null||v===undefined?null:new Date(v as string).toISOString();
async function timezone(db:ProfileExecutor){return(await db.query('SELECT timezone FROM profiles WHERE id=$1',[db.workspaceId])).rows[0]?.timezone as string??'UTC';}

export type NumberCause='DISCONNECTED'|'PAUSED'|'NOT_AUTHORIZED';
export async function readProfileHome(db:ProfileExecutor,authority:ProfileAuthority){
 await authorize(db,authority,'home:read');const tz=await timezone(db);
 const numbers=(await db.query(`SELECT a.id,COALESCE(a.body->>'status','NEW') AS status,COALESCE((a.body->>'sending_enabled')::boolean,false) AS sending,COALESCE(s.operational_pause,false) AS paused
  FROM records a LEFT JOIN channel_sessions s ON s.account_id=a.id AND s.workspace_id=a.workspace_id AND s.environment=a.environment
  WHERE a.workspace_id=$1 AND a.environment='REAL' AND a.kind='channel_account' AND NOT(a.body?'deleted_at')`,[db.workspaceId])).rows;
 const causes:Record<NumberCause,number>={DISCONNECTED:0,PAUSED:0,NOT_AUTHORIZED:0};let attending=0,connected=0;
 for(const row of numbers){
  if(row.status!=='WORKING'){causes.DISCONNECTED++;continue;}
  connected++;
  if(row.paused)causes.PAUSED++;else if(!row.sending)causes.NOT_AUTHORIZED++;else attending++;
 }
 const today=(await db.query(`WITH day AS (SELECT (date_trunc('day',clock_timestamp() AT TIME ZONE $2) AT TIME ZONE $2) AS start)
  SELECT (SELECT count(*) FROM records r,day WHERE r.workspace_id=$1 AND r.environment='REAL' AND r.kind='conversation' AND r.created_at>=day.start) AS conversations,
   (SELECT count(*) FROM records r,day WHERE r.workspace_id=$1 AND r.environment='REAL' AND r.kind='order' AND r.created_at>=day.start) AS orders,
   (SELECT count(*) FROM records r,day WHERE r.workspace_id=$1 AND r.environment='REAL' AND r.kind='receipt' AND r.body->>'status'='APPROVED' AND r.updated_at>=day.start) AS approved,
   (SELECT count(*) FROM records r WHERE r.workspace_id=$1 AND r.environment='REAL' AND r.kind='receipt' AND COALESCE(r.body->>'status','') NOT IN('APPROVED','REJECTED')) AS to_review,
   (SELECT count(*) FROM operational_alerts o WHERE o.workspace_id=$1 AND o.environment='REAL' AND o.status<>'RESOLVED') AS alerts,
   (SELECT count(*) FROM operational_alerts o WHERE o.workspace_id=$1 AND o.environment='REAL' AND o.status<>'RESOLVED' AND o.severity='CRITICAL') AS critical`,[db.workspaceId,tz])).rows[0];
 const onboarding=await readOnboarding(db,authority).catch(()=>null);
 const next=onboarding&&!onboarding.complete&&!onboarding.dismissed?{kind:'ONBOARDING' as const,step:onboarding.next}
  :n(today.to_review)>0?{kind:'REVIEW_RECEIPTS' as const,count:n(today.to_review)}
  :causes.DISCONNECTED>0?{kind:'RECONNECT_NUMBERS' as const,count:causes.DISCONNECTED}
  :n(today.alerts)>0?{kind:'REVIEW_ALERTS' as const,count:n(today.alerts)}:null;
 return{timezone:tz,numbers:{registered:numbers.length,connected,attending,causes},
  today:{conversations:n(today.conversations),orders:n(today.orders),approvedReceipts:n(today.approved)},
  pending:{receiptsToReview:n(today.to_review),alerts:n(today.alerts),criticalAlerts:n(today.critical)},
  onboarding:onboarding?{complete:onboarding.complete,dismissed:onboarding.dismissed,next:onboarding.next}:null,next};
}

/** Configured limits next to observed use; never a forecast. */
export async function readProfileUsage(db:ProfileExecutor,authority:ProfileAuthority){
 await authorize(db,authority,'usage:read');const tz=await timezone(db);
 const row=(await db.query(`SELECT p.number_limit,p.product_limit,p.daily_conversation_limit,
   (SELECT count(*) FROM records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at')) AS numbers,
   (SELECT count(*) FROM records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='product' AND NOT(r.body?'deleted_at')) AS products,
   (SELECT count(*) FROM records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='conversation' AND r.created_at>=(date_trunc('day',clock_timestamp() AT TIME ZONE $2) AT TIME ZONE $2)) AS conversations_today,
   (SELECT count(*) FROM records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='asset' AND NOT(r.body?'deleted_at')) AS assets,
   (SELECT COALESCE(sum(NULLIF(r.body->>'size_bytes','')::bigint),0) FROM records r WHERE r.workspace_id=p.id AND r.environment='REAL' AND r.kind='asset' AND NOT(r.body?'deleted_at') AND r.body->>'size_bytes' ~ '^[0-9]{1,15}$') AS asset_bytes
  FROM profiles p WHERE p.id=$1`,[db.workspaceId,tz])).rows[0];
 const ai=(await db.query(`SELECT p.starts_at,p.ends_at,p.profile_limit_microusd,
   COALESCE((SELECT sum(a.charged_microusd) FROM ai_attempt_allocations x JOIN ai_attempts a USING(workspace_id,environment,attempt_id) WHERE x.workspace_id=p.workspace_id AND x.environment=p.environment AND x.period_id=p.id),0)::text AS used,
   COALESCE((SELECT sum(a.charged_microusd) FROM ai_attempt_allocations x JOIN ai_attempts a USING(workspace_id,environment,attempt_id) WHERE x.workspace_id=p.workspace_id AND x.environment=p.environment AND x.period_id=p.id AND a.is_test),0)::text AS tests
  FROM ai_budget_periods p WHERE p.workspace_id=$1 AND p.environment='REAL' AND p.starts_at<=clock_timestamp() AND p.ends_at>clock_timestamp()`,[db.workspaceId])).rows[0];
 return{timezone:tz,numbers:{used:n(row.numbers),limit:row.number_limit},products:{used:n(row.products),limit:row.product_limit},
  conversationsToday:{used:n(row.conversations_today),limit:row.daily_conversation_limit},storage:{assets:n(row.assets),bytes:n(row.asset_bytes)},
  aiCost:ai?{startsAt:iso(ai.starts_at),endsAt:iso(ai.ends_at),limitMicrousd:n(ai.profile_limit_microusd),usedMicrousd:n(ai.used),testMicrousd:n(ai.tests)}:null};
}

/** Sensitive actions only (RNF-04.b): actor, action, object and a reviewed
 * subset of the payload; never message text, recipients or secrets. */
const auditTypes=['profile.%','platform.%','privacy.%','payment.%','receipt.%','continuous.%','market.%','result_goal.%'];
const auditPayloadKeys=['before','after','provider','revision','enabled','state','reason','version','role','active','default_provider','default_model','monthly_limit_microusd','action','status'];
function auditPayload(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))return{};
 const out:Record<string,unknown>={};for(const key of auditPayloadKeys)if(Object.hasOwn(value,key)){const v=(value as Record<string,unknown>)[key];out[key]=v&&typeof v==='object'?JSON.parse(JSON.stringify(v,(k,x)=>/email|phone|token|secret|key_hint|text|message|name/i.test(k)?undefined:x)):v;}
 return out;
}
export async function listProfileAudit(db:ProfileExecutor,authority:ProfileAuthority,input:{before?:string;limit?:number;export?:boolean}={}){
 await authorize(db,authority,input.export?'audit:export':'audit:read');
 const limit=Math.min(Math.max(input.limit??50,1),input.export?5000:200);
 if(input.before!==undefined&&!(typeof input.before==='string'&&Number.isFinite(Date.parse(input.before))))throw new ProfileReadError('AUDIT_QUERY_INVALID');
 const rows=(await db.query(`SELECT id,event_type,aggregate_id,actor,payload,recorded_at FROM domain_events WHERE workspace_id=$1 AND environment='REAL' AND event_type LIKE ANY($2)
  AND ($3::timestamptz IS NULL OR recorded_at<$3) ORDER BY recorded_at DESC,id DESC LIMIT $4`,[db.workspaceId,auditTypes,input.before??null,limit+1])).rows;
 const page=rows.slice(0,limit).map(r=>({id:r.id as string,action:r.event_type as string,object:r.aggregate_id as string,
  actor:{type:typeof r.actor?.type==='string'?r.actor.type:'unknown',id:typeof r.actor?.id==='string'?r.actor.id:null},details:auditPayload(r.payload),recordedAt:iso(r.recorded_at)!}));
 return{entries:page,nextBefore:rows.length>limit?page.at(-1)!.recordedAt:null};
}
export function auditCsv(entries:Awaited<ReturnType<typeof listProfileAudit>>['entries']){
 const cell=(v:unknown)=>{const s=typeof v==='string'?v:JSON.stringify(v??'');const safe=/^[=+\-@\t\r]/.test(s)?"'"+s:s;return '"'+safe.replaceAll('"','""')+'"';};
 return['fecha,accion,objeto,actor_tipo,actor_id,detalles',...entries.map(e=>[e.recordedAt,e.action,e.object,e.actor.type,e.actor.id,e.details].map(cell).join(','))].join('\r\n')+'\r\n';
}

/** Result of one of this person's own operations, by its UUID (RF-15). */
const operationSources=[
 {family:'market',sql:'SELECT result,created_at FROM market_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3'},
 {family:'goals',sql:'SELECT result,created_at FROM result_goal_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3'},
 {family:'receipt_rules',sql:'SELECT result,created_at FROM receipt_policy_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3'},
 {family:'tokens',sql:"SELECT jsonb_build_object('action',action,'tokenId',token_id) AS result,created_at FROM profile_token_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3"},
 {family:'ai_keys',sql:'SELECT result,created_at FROM ai_credential_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3'},
] as const;
export async function readProfileOperation(db:ProfileExecutor,authority:ProfileAuthority,operationId:string){
 await authorize(db,authority,'operations:read');
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId))throw new ProfileReadError('OPERATION_ID_INVALID');
 for(const source of operationSources){
  const row=(await db.query(source.sql,[db.workspaceId,authority.membership.userId,operationId.toLowerCase()])).rows[0];
  if(row)return{operationId:operationId.toLowerCase(),family:source.family,state:'RECORDED' as const,recordedAt:iso(row.created_at),result:row.result};
 }
 return{operationId:operationId.toLowerCase(),family:null,state:'NOT_FOUND' as const,recordedAt:null,result:null};
}

/** V7 F3 owner notices (RF-07.e, RNF-02.g, glossary): open alerts of this
 * profile in operator language, one per incident (the worker deduplicates by
 * episode). Technical evidence stays in diagnostics; nothing here names a
 * customer, a phone or a secret. Mail delivery is a separate durable state. */
export const alertLabels:Record<string,{label:string;href:string}>={
 SESSION_QR_REQUIRED:{label:'Necesita QR: vuelve a vincular el número',href:'/numbers'},
 SESSION_AUTH_REVOKED:{label:'La vinculación fue revocada: vuelve a vincular',href:'/numbers'},
 SESSION_PASSKEY_REQUIRED:{label:'WhatsApp pide una confirmación en el teléfono',href:'/numbers'},
 SESSION_IDENTITY_CONFLICT:{label:'El teléfono vinculado cambió; revisa el número',href:'/numbers'},
 SESSION_RECOVERY_EXHAUSTED:{label:'No se pudo reconectar automáticamente',href:'/numbers'},
 SESSION_OWNER_UNAVAILABLE:{label:'Reconectando el número',href:'/numbers'},
 SESSION_HEALTH_STALE:{label:'Sin comprobación reciente del número',href:'/numbers'},
 EFFECT_UNKNOWN:{label:'Entrega por confirmar',href:'/sales/inbox'},
 BLOCKED_EFFECTS:{label:'Mensajes en espera',href:'/sales/inbox'},
 RELEASE_RECOVERY_PENDING:{label:'Reanudando tras una actualización',href:'/numbers'},
 AUTHORIZATION_EXPIRING:{label:'Autorización anterior por vencer',href:'/numbers'},
 AUTHORIZATION_EXPIRED:{label:'Autorización anterior vencida',href:'/numbers'},
 REAL_POLICY_FROZEN:{label:'Envíos detenidos por la plataforma',href:'/home'},
 RELEASE_HOLD_OVERDUE:{label:'Actualización de la plataforma en curso',href:'/home'},
 CHANNEL_WORKER_UNAVAILABLE:{label:'Servicio de envío no disponible',href:'/home'},
};
export async function listProfileAlerts(db:ProfileExecutor,authority:ProfileAuthority,input:{includeResolved?:boolean}={}){
 await authorize(db,authority,'alerts:read');
 const rows=(await db.query(`SELECT a.id,a.kind,a.severity,a.status,a.account_id,a.created_at,a.resolved_at,a.acknowledged_at,r.body->>'name' AS alias
  FROM operational_alerts a LEFT JOIN records r ON r.id=a.account_id AND r.workspace_id=a.workspace_id AND r.kind='channel_account'
  WHERE a.workspace_id=$1 AND a.environment='REAL' AND ($2::boolean OR a.resolved_at IS NULL) ORDER BY a.resolved_at IS NULL DESC,a.severity='CRITICAL' DESC,a.created_at DESC LIMIT 100`,[db.workspaceId,input.includeResolved===true])).rows;
 return{alerts:rows.map(row=>{const known=alertLabels[row.kind];return{id:row.id as string,kind:row.kind as string,label:known?.label??'Aviso del sistema',href:known?.href??'/home',
  severity:row.severity as 'WARNING'|'CRITICAL',number:row.account_id?{id:row.account_id as string,alias:String(row.alias??'Número').replace(/\+?\d[\d ()-]{8,}\d/g,v=>'•••• '+v.replace(/\D/g,'').slice(-4))}:null,
  createdAt:iso(row.created_at),resolvedAt:iso(row.resolved_at),acknowledgedAt:iso(row.acknowledged_at),notification:row.status==='RESOLVED'?'RESOLVED':['ACCEPTED','RECEIVED'].includes(row.status)?'SENT':row.status==='PENDING'?'PENDING':'UNCONFIRMED'};})};
}
export async function acknowledgeProfileAlert(db:ProfileExecutor,authority:ProfileAuthority,alertId:string){
 const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now);
 authorizeProfileAction(authority,{scope:'alerts:write',workspaceId:db.workspaceId,mutation:true},now);
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alertId))throw new ProfileReadError('ALERT_NOT_FOUND',404);
 const row=(await db.query("UPDATE operational_alerts SET acknowledged_at=COALESCE(acknowledged_at,clock_timestamp()),acknowledged_by=COALESCE(acknowledged_by,$3) WHERE id=$1 AND workspace_id=$2 AND environment='REAL' RETURNING id,acknowledged_at",[alertId.toLowerCase(),db.workspaceId,authority.membership.userId])).rows[0];
 if(!row)throw new ProfileReadError('ALERT_NOT_FOUND',404);
 return{id:row.id as string,acknowledgedAt:iso(row.acknowledged_at)};
}
