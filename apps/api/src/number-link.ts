import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,putRecord,readIntegrationSettings,readOperationalSettings,type QueryExecutor} from '@commerce/db';
import type {DomainRecord} from '@commerce/contracts';
import {withProfileTransaction} from '../../../packages/db/src/profile-context.js';
import {confirmLinkedNumber,numberLinkLabels,numberLinkState,phoneFingerprint,warmupModeOf,declarationCurrent,PREPARATION_EXPECTED_MS,type NumberLinkState,type WarmupMode} from '../../../packages/db/src/number-link.js';
import {lockWarmupProfile} from '../../../packages/db/src/group-warmup.js';
import {applyWarmupMode} from '../../../packages/db/src/number-warmup-mode.js';
import {bindProfileEnvironment} from '../../../packages/db/src/profile-environment.js';
import {normalizePhone,numberCountries,PhoneError,type NumberCountry} from '../../../packages/domain/src/numbers/phone.js';
import {STANDARD_POLICY} from '../../../packages/domain/src/warmup/preparation.js';
import {maskedAlias} from '../../../packages/domain/src/warmup/number-state.js';
import {onboardingEnabled} from '../../../packages/messaging/src/onboarding.js';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,parseBody,mutate,fail,audit,scopedRecord,command} from './context.js';
import {capacityReserve} from './number-capacity.js';
import {verifiedPhysicalProvision} from './number-capacity-lifecycle.js';
import {capacityReadbackIsFresh,gatewaySlot} from './number-capacity-state.js';
import {lifecycleSafety} from './channel-command-safety.js';
import {numberNow} from '../../../packages/db/src/number-clock.js';
import {randomUUID} from 'node:crypto';

/** V7 F3 number journey (RF-07.a/c/d, RF-17.f, wireframe D): register with a
 * private phone, scan one QR, the platform confirms the line by itself, and a
 * removal shows its impact before the last button. Legacy setup endpoints
 * remain for compatibility; these add no new authority over sending. */
const idOf=(req:FastifyRequest)=>z.object({id:z.uuid()}).parse(req.params).id;
/** The installation quota guard takes a non-blocking global lock (0079) and
 * fails fast when another admission overlaps. Number registration and removal
 * are rare and human-paced: they wait for it first, so two profiles adding
 * numbers at once are serialized instead of one failing. Re-entrant per
 * transaction, so the guard's own try-lock then succeeds. */
const awaitQuotaTurn=(c:QueryExecutor)=>c.query('SELECT pg_advisory_xact_lock(743912014::bigint)');
const manage=(req:FastifyRequest)=>{const p=principal(req);assertPermission(p,'channels:manage');return p;};
/** V7.4 D: «required» = the line waits for a warm-up group after its QR;
 * «ready» = the owner declares the phone already prepared and no warm-up is
 * scheduled for it. Clients that predate the choice omit it and keep the
 * earlier behaviour (required); an omitted value never changes a stored one. */
const warmupChoice=z.enum(['required','ready']);
const modeOfChoice=(choice:z.infer<typeof warmupChoice>):WarmupMode=>choice==='ready'?'DECLARED_READY':'REQUIRED';
const quickSchema=z.object({alias:z.string().trim().min(2).max(100),country:z.enum(Object.keys(numberCountries) as [NumberCountry,...NumberCountry[]]),phone:z.string().trim().min(4).max(32).optional(),warmup:warmupChoice.optional()}).strict();
const nextAction:Record<NumberLinkState,{code:string;label:string}|null>={REMOVED:null,REMOVING:null,PHONE_MISMATCH:{code:'unlink',label:'Desvincular y volver a intentar'},
 NUMBER_UNAVAILABLE:{code:'unlink',label:'Desvincular este teléfono'},PREPARING:null,PREPARATION_DELAYED:null,PREPARATION_FAILED:{code:'retry_preparation',label:'Reintentar la preparación'},READY_TO_LINK:{code:'link',label:'Mostrar QR'},
 WAITING_SCAN:{code:'qr',label:'Mostrar QR'},CONFIRMING:null,CONNECTED:{code:'view',label:'Ver número'},NEEDS_QR:{code:'link',label:'Volver a vincular'},RECONNECTING:null,DISCONNECTED:{code:'link',label:'Volver a vincular'}};

async function linkFacts(c:QueryExecutor,account:DomainRecord){
 const session=(await c.query('SELECT * FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND archived_at IS NULL',[account.id,account.workspace_id])).rows[0];
 const profile=account.body.gateway_ref?await readIntegrationSettings(c,account.workspace_id,account.environment,'waha:'+account.body.gateway_ref,{secrets:false}).catch(()=>undefined):undefined;
 const provision=(await c.query("SELECT id,state,version,created_at,updated_at,result->>'reason' AS reason,result->>'retry_requested_at' AS retry_requested_at FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND action='PROVISION' AND input->>'account_id'=$3 ORDER BY created_at DESC LIMIT 1",[account.workspace_id,account.environment,account.id])).rows[0];
 const connectPending=!!(await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type' IN('connect','restart') AND status='PENDING' LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount;
 return{account,session,profileReady:profile?.enabled===true||account.environment==='SIMULATION',provision,connectPending,now:await numberNow(c,account.workspace_id,account.environment)};
}
const preparationDetail:Record<string,string>={PREPARING:'Estamos preparando la conexión de este número. Suele tardar entre uno y cinco minutos; el QR aparece aquí en cuanto esté lista.',
 PREPARATION_DELAYED:'La preparación está tardando más de lo normal. Seguimos intentándolo automáticamente y tu número está guardado: no necesitas registrarlo otra vez. Puedes cerrar esta ventana y volver después.',
 PREPARATION_FAILED:'No pudimos preparar la conexión de este número. Tu número está guardado; puedes reintentar la preparación sin registrarlo otra vez.'};
function view(facts:Awaited<ReturnType<typeof linkFacts>>){
 const {state,qr}=numberLinkState(facts),a=facts.account,preparing=state==='PREPARING'||state==='PREPARATION_DELAYED'||state==='PREPARATION_FAILED';
 return{id:a.id,version:a.version,alias:maskedAlias(String(a.body.name??'Número')),masked_number:a.body.masked_number??null,state,label:numberLinkLabels[state],qr_available:qr,
  next_action:nextAction[state],confirmed_at:a.body.link_confirmed_at??a.body.ownership_confirmed_at??null,observed_at:facts.session?.last_health_at??null,
  detail:preparing?preparationDetail[state]:null,
  preparation:preparing?{since:facts.provision?.retry_requested_at??(facts.provision?.created_at?new Date(facts.provision.created_at).toISOString():null),expected_seconds:PREPARATION_EXPECTED_MS/1000,automatic_retry:state!=='PREPARATION_FAILED',retryable:state==='PREPARATION_FAILED'}:null,
  warmup_mode:warmupModeOf(a.body)};
}
/** V7.4 D/E: what is true about this number's warm-up, without counting a
 * calendar day as progress. Effective days are credited by observed evidence. */
const WARMUP_TARGET_DAYS=14;
async function warmupSummary(c:QueryExecutor,account:DomainRecord,connected:boolean){
 const mode=warmupModeOf(account.body),base={mode,source:String(account.body.warmup_mode_source??'compatibility_default'),effective_days:0,target_days:WARMUP_TARGET_DAYS,program:null as null|{id:string;name:string;status:string;role:'sender'|'receiver'}};
 const row=(await c.query(`SELECT s.status,s.reason,s.group_required,s.effective_days,s.paused,s.confirmed_block,g.id AS program_id,g.name AS program_name,g.status AS program_status,COALESCE(g.scope->'senderIds' ? s.account_id::text,false) AS sender
  FROM warmup_states s LEFT JOIN warmup_account_reservations v ON v.account_id=s.account_id LEFT JOIN warmup_programs g ON g.id=v.program_id AND g.workspace_id=s.workspace_id AND g.environment=s.environment
  WHERE s.account_id=$1 AND s.workspace_id=$2 AND s.environment=$3`,[account.id,account.workspace_id,account.environment])).rows[0];
 const days=Number(row?.effective_days??0);
 if(mode==='DECLARED_READY')return declarationCurrent(account.body)?{...base,effective_days:days,state:'NOT_REQUESTED',label:'Ya preparado: sin calentamiento automático'}:{...base,effective_days:days,state:'CHOICE_REQUIRED',label:'Elige de nuevo si este teléfono necesita calentamiento'};
 if(!connected)return{...base,effective_days:days,state:'WAITING_CONNECTION',label:'El calentamiento se configura cuando el número esté conectado'};
 if(!row)return{...base,state:'REGISTERING',label:'Registrando la línea para calentamiento'};
 const program=row.program_id?{id:row.program_id as string,name:String(row.program_name),status:String(row.program_status),role:row.sender?'sender' as const:'receiver' as const}:null,withProgram={...base,effective_days:days,program};
 if(row.status==='GRADUATED')return{...withProgram,state:'COMPLETED',label:'Calentamiento completado'};
 if(row.paused||row.confirmed_block||row.status==='QUARANTINED')return{...withProgram,state:'ATTENTION',label:'Calentamiento detenido: revisa este número'};
 if(!program||row.group_required)return{...withProgram,program:null,state:'GROUP_REQUIRED',label:'Elige un grupo para empezar'};
 if(program.status==='ACTIVE')return program.role==='sender'?{...withProgram,state:'ACTIVE',label:`Calentamiento activo · ${days} de ${WARMUP_TARGET_DAYS} días efectivos`}:{...withProgram,state:'RECEIVING',label:'Recibe mensajes del grupo; no envía'};
 if(program.status==='PAUSED')return{...withProgram,state:'PROGRAM_PAUSED',label:'Calentamiento en pausa: revísalo para continuar'};
 return{...withProgram,state:'PROGRAM_PENDING',label:'Calentamiento configurado; falta iniciarlo'};
}
/** Read, and confirm the line once the provider identity is back. */
async function readLink(req:FastifyRequest,id:string){
 const p=manage(req);
 return withProfileTransaction(pool,p.workspace_id,async c=>{
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['number-link:'+id]);
  let account=await scopedRecord(req,'channel_account',id,c);
  if(!account.body.deleted_at&&!account.body.removal_requested_at&&!account.body.link_problem){
   const result=await confirmLinkedNumber(c,account,await numberNow(c,account.workspace_id,account.environment));
   if(result.confirmed&&!account.body.ownership_confirmed_at)await audit(c,req,'number.link_confirmed',id,{automatic:true,source:'provider_identity_after_qr',external_effects:0},account.environment);
   if(result.problem)await audit(c,req,'number.link_problem',id,{code:result.problem},account.environment);
   account=await scopedRecord(req,'channel_account',id,c);
  }
  if(account.body.removal_requested_at&&!account.body.deleted_at)account=await finalizeRemoval(req,c,account);
  return{...view(await linkFacts(c,account)),...await removalView(c,account)};
 });
}
async function finalizeRemoval(req:FastifyRequest,c:QueryExecutor,account:DomainRecord){
 const ownership=(await c.query('SELECT frozen FROM session_ownership WHERE workspace_id=$1 AND account_id=$2',[account.workspace_id,account.id])).rows[0];
 const pending=(await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND status='PENDING' LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount;
 const inflight=(await c.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('SENDING','UNKNOWN') LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount;
 const unlinked=!ownership||!!account.body.unlinked_at;
 if(pending||inflight||!unlinked||!['NEW','DISCONNECTED','STOPPED'].includes(String(account.body.status??'NEW')))return account;
 await awaitQuotaTurn(c);
 await c.query('UPDATE session_ownership SET frozen=true,updated_at=now() WHERE workspace_id=$1 AND account_id=$2',[account.workspace_id,account.id]);
 await c.query("UPDATE operation_authorizations SET revoked_at=COALESCE(revoked_at,now()) WHERE workspace_id=$1 AND environment=$2 AND scope->'account_ids' ? $3",[account.workspace_id,account.environment,account.id]);
 const deleted=await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:'channel_account',version:account.version,
  body:{...account.body,deleted_at:new Date().toISOString(),deleted_by:account.body.removal_requested_by??principal(req).user.id,sending_enabled:false,active_authorization_id:null,identity_verified:false}});
 // The physical slot returns to this same profile only (its gateway volume may
 // still hold this profile's media): a verified gateway becomes a prepared
 // spare, an unprovisioned reservation becomes available. Another profile can
 // receive it only through the reviewed drain that wipes the session state.
 const released=(await c.query(`UPDATE number_capacity_slots SET account_id=NULL,state=CASE WHEN readback->>'verified'='true' THEN 'PREPARED' ELSE 'AVAILABLE' END,version=version+1,updated_at=now()
  WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND state NOT IN('DRAINING','PREPARING') RETURNING slot,state`,[account.workspace_id,account.environment,account.id])).rows;
 await audit(c,req,'channel.deleted',account.id,{reason:'Eliminación solicitada desde Números',history_preserved:true,v7_removal:true,slot_released_to_profile:released.map(r=>Number(r.slot))},account.environment);
 return deleted;
}
/** V7.4 E: why a requested removal has not finished, and what unblocks it.
 * A session whose technical owner predates a migration cannot be closed from
 * here without an isolation proof (that protection stays). The owner can then
 * unlink the device on the phone and confirm it; the confirmation is accepted
 * only with a fresh, empty readback of this number's current gateway and no
 * pending or uncertain work. It is recorded as an unlink accredited by the
 * owner, never as a remote logout that did not run. */
async function removalFacts(c:QueryExecutor,account:DomainRecord){
 const ownership=(await c.query('SELECT frozen,lease_expires_at>now() AS live FROM session_ownership WHERE workspace_id=$1 AND account_id=$2',[account.workspace_id,account.id])).rows[0];
 const logout=(await c.query("SELECT id,status,result FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type'='logout' ORDER BY created_at DESC,id DESC LIMIT 1",[account.workspace_id,account.environment,account.id])).rows[0];
 const pending=!!(await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND status='PENDING' LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount;
 const uncertain=!!(await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND status='FAILED' AND payload->>'type' IN('connect','restart','disconnect','logout') AND COALESCE(result->>'remote_outcome','UNKNOWN')='UNKNOWN' AND NOT(result?'reconciled_at') LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount;
 const inflight=!!(await c.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('SENDING','UNKNOWN') LIMIT 1",[account.workspace_id,account.environment,account.id])).rowCount;
 const blocked=!!ownership&&!account.body.unlinked_at&&!pending&&!uncertain&&!inflight&&logout?.status==='FAILED'&&logout.result?.remote_outcome==='NOT_ATTEMPTED';
 const phase=!account.body.removal_requested_at||account.body.deleted_at?null:pending?'CLOSING_SESSION':uncertain||inflight?'CONFIRMING_PREVIOUS_WORK':blocked?'UNLINK_CONFIRMATION_REQUIRED':'FINISHING';
 return{ownership,logout,pending,uncertain,inflight,blocked,phase};
}
const removalDetail:Record<string,string>={CLOSING_SESSION:'Estamos cerrando la sesión de este número.',CONFIRMING_PREVIOUS_WORK:'Estamos confirmando el resultado de una operación anterior antes de terminar la eliminación.',
 UNLINK_CONFIRMATION_REQUIRED:'No pudimos cerrar esta sesión desde aquí. En el teléfono abre WhatsApp → Dispositivos vinculados, quita este dispositivo y después confirma aquí que ya lo desvinculaste.',FINISHING:'Terminando la eliminación.'};
async function removalView(c:QueryExecutor,account:DomainRecord){
 const facts=await removalFacts(c,account);
 return facts.phase?{removal:{phase:facts.phase,detail:removalDetail[facts.phase]},...(facts.phase==='UNLINK_CONFIRMATION_REQUIRED'?{next_action:{code:'confirm_unlinked',label:'Ya lo desvinculé en mi teléfono'},detail:removalDetail[facts.phase]}:{detail:removalDetail[facts.phase]})}:{};
}
async function removalImpact(c:QueryExecutor,account:DomainRecord){
 const products=(await c.query("SELECT p.body->>'name' AS name FROM commercial_assignments a JOIN records p ON p.id=a.product_id AND p.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.environment=$2 AND a.account_id=$3 AND a.state='ACTIVE' ORDER BY 1",[account.workspace_id,account.environment,account.id])).rows.map(r=>maskedAlias(String(r.name??'Producto')));
 const conversations=Number((await c.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'account_id'=$3 AND COALESCE(body->>'status','OPEN') NOT IN('CLOSED','ARCHIVED')",[account.workspace_id,account.environment,account.id])).rows[0].n);
 const pendingEffects=Number((await c.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('READY','BLOCKED')",[account.workspace_id,account.environment,account.id])).rows[0].n);
 const timers=Number((await c.query("SELECT count(*)::int n FROM timers t WHERE t.workspace_id=$1 AND t.environment=$2 AND t.status='PENDING' AND t.conversation_id IN(SELECT id::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'account_id'=$3)",[account.workspace_id,account.environment,account.id])).rows[0].n);
 const inflight=Number((await c.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('SENDING','UNKNOWN')",[account.workspace_id,account.environment,account.id])).rows[0].n);
 return{products,open_conversations:conversations,pending_followups:pendingEffects+timers,deliveries_to_confirm:inflight,history_preserved:true,customer_data_deleted:false};
}

/** V7 operator state (glossary): the link state first; once connected, an
 * explicit pause, then selling with a live permanent grant, then warming. */
async function overviewRow(c:QueryExecutor,account:DomainRecord){
 const facts=await linkFacts(c,account),base={...view(facts),...await removalView(c,account)};
 const paused=!!(await c.query("SELECT 1 FROM manual_controls WHERE workspace_id=$1 AND ((scope_type='channel_account' AND scope_id=$2) OR (scope_type='workspace' AND scope_id=$1)) AND (paused OR suppressed OR takeover) LIMIT 1",[account.workspace_id,account.id])).rowCount;
 const grants=(await c.query(`SELECT c.state->'source'->>'kind' AS kind,(c.state->>'humanPaused')::boolean AS paused,p.body->>'name' AS product FROM continuous_authorizations c
  LEFT JOIN commercial_assignments a ON a.id=c.assignment_id AND a.workspace_id=c.workspace_id AND a.environment=c.environment AND a.state='ACTIVE'
  LEFT JOIN records p ON p.id=a.product_id AND p.workspace_id=a.workspace_id
  WHERE c.workspace_id=$1 AND c.environment=$2 AND c.account_id=$3 AND c.state->'revokedAt'='null'::jsonb`,[account.workspace_id,account.environment,account.id])).rows as {kind:string;paused:boolean;product:string|null}[];
 const selling=grants.filter(g=>g.kind==='COMMERCIAL_ASSIGNMENT'&&g.product&&!g.paused),humanPaused=grants.some(g=>g.paused);
 const products=(await c.query("SELECT p.body->>'name' AS name FROM commercial_assignments a JOIN records p ON p.id=a.product_id AND p.workspace_id=a.workspace_id WHERE a.workspace_id=$1 AND a.environment=$2 AND a.account_id=$3 AND a.state='ACTIVE' ORDER BY 1",[account.workspace_id,account.environment,account.id])).rows.map(r=>maskedAlias(String(r.name??'Producto')));
 const warmup=await warmupSummary(c,account,base.state==='CONNECTED');
 let status={code:base.state as string,label:base.label};
 if(base.state==='CONNECTED'){
  if(paused||humanPaused)status={code:'PAUSED_BY_YOU',label:'Pausado por ti'};
  else if(selling.length)status={code:'SELLING',label:'Vendiendo'};
  // V7.4 E: «Calentando» only while a program is active and this line sends.
  else if(warmup.state==='ACTIVE')status={code:'WARMING',label:'Calentando'};
  else if(warmup.state==='GROUP_REQUIRED'||warmup.state==='REGISTERING'||warmup.state==='PROGRAM_PENDING'||warmup.state==='PROGRAM_PAUSED')status={code:'WARMUP_PENDING',label:'Conectado · calentamiento por configurar'};
  else if(warmup.state==='CHOICE_REQUIRED'||warmup.state==='ATTENTION')status={code:'NEEDS_ATTENTION',label:'Necesita atención'};
  else status={code:'READY_TO_ASSIGN',label:'Listo para asignar'};
 }
 // RF-19.n: the latest «Probar número» of this number, informative only (it never gates selling).
 const lab=account.environment==='REAL'?(await c.query(`SELECT r.id::text AS run_id,r.created_at,count(o.id)::int AS actions,count(o.id) FILTER(WHERE o.state IN('FAILED','UNKNOWN'))::int AS problems
  FROM commerce_number_lab.runs r LEFT JOIN commerce_number_lab.operations o ON o.workspace_id=r.workspace_id AND o.run_id=r.id
  WHERE r.workspace_id=$1 AND r.source_account_id=$2 GROUP BY r.id,r.created_at ORDER BY r.created_at DESC,r.id LIMIT 1`,[account.workspace_id,account.id])).rows[0]:undefined;
 return{...base,status,products,warmup,
  last_test:lab&&lab.actions>0?{at:new Date(lab.created_at).toISOString(),ok:lab.problems===0,run_id:String(lab.run_id)}:null};
}

export async function numberLinkRoutes(app:FastifyInstance){
 app.get('/v1/numbers/overview',async req=>{
  const p=principal(req);assertPermission(p,p.service?'channels:read':'sales:read');
  const canManage=p.permissions.includes('*')||p.permissions.includes('channels:manage');
  return{data:await withProfileTransaction(pool,p.workspace_id,async c=>{
   await bindProfileEnvironment(c,envOf(req));
   const accounts=(await c.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT body?'deleted_at' ORDER BY created_at LIMIT 40",[p.workspace_id,envOf(req)])).rows as DomainRecord[];
   const rows=[];
   for(let account of accounts){
    if(canManage&&!account.body.ownership_confirmed_at&&!account.body.removal_requested_at&&!account.body.link_problem){
     const done=await confirmLinkedNumber(c,account,await numberNow(c,account.workspace_id,account.environment));
     if(done.confirmed){await audit(c,req,'number.link_confirmed',account.id,{automatic:true,source:'provider_identity_after_qr',external_effects:0},account.environment);account=(await scopedRecord(req,'channel_account',account.id,c));}
    }
    rows.push(await overviewRow(c,account));
   }
   return{numbers:rows,limit:(await c.query('SELECT number_limit FROM profiles WHERE id=$1',[p.workspace_id])).rows[0]?.number_limit??null};
  })};
 });
 app.post('/v1/numbers/quick',async(req,reply)=>{
  const p=manage(req),input=quickSchema.parse(parseBody(req)),environment=envOf(req);
  let phone:{digits:string;last4:string;masked:string}|undefined;
  try{phone=input.phone?normalizePhone(input.country,input.phone):undefined;}catch(error){if(error instanceof PhoneError)throw fail(400,error.message,'Revisa el país y el número.');throw error;}
  const result=await mutate(req,'number.quick',async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`number-create:${p.workspace_id}:${environment}`]);
   await awaitQuotaTurn(c);
   if((await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT body?'deleted_at' AND lower(body->>'name')=lower($3)",[p.workspace_id,environment,input.alias])).rowCount)throw fail(409,'ALIAS_ALREADY_USED','Ya tienes un número con ese nombre.');
   const fingerprint=phone?phoneFingerprint(phone.digits):undefined;
   if(fingerprint&&(await c.query("SELECT 1 FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='channel_account' AND NOT body?'deleted_at' AND body->>'declared_phone_fingerprint'=$3",[p.workspace_id,environment,fingerprint])).rowCount)throw fail(409,'NUMBER_ALREADY_REGISTERED','Ese número ya está registrado en tu perfil.');
   const slot=await capacityReserve(c,p.workspace_id,environment);
   const account=await putRecord(c,{workspaceId:p.workspace_id,environment,kind:'channel_account',body:{name:input.alias,responsible:p.user.name||'Dueño',device_ref:'v7:'+randomUUID(),
    provider:environment==='SIMULATION'?'simulator':'waha',engine:environment==='SIMULATION'?'SIMULATOR':'GOWS',gateway_ref:'waha-'+String(slot.slot).padStart(2,'0'),session:'default',status:'NEW',
    sending_enabled:false,identity_verified:false,number_policy_version:STANDARD_POLICY,country:input.country,...(phone?{declared_phone_fingerprint:fingerprint,masked_number:phone.masked}:{}),registered_by:'v7_quick',
    // V7.4 D: stored in the same insert as the number, before any worker can see it.
    warmup_mode:modeOfChoice(input.warmup??'required'),warmup_mode_source:input.warmup?'owner_choice':'compatibility_default',warmup_mode_set_at:new Date().toISOString(),warmup_mode_set_by:p.user.id}});
   const op=(await c.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,state,input) VALUES($1,$2,$3,'PROVISION','RESERVED',$4) RETURNING *",[p.workspace_id,environment,p.user.id,{account_id:account.id,slot_id:slot.id}])).rows[0];
   await c.query("UPDATE number_capacity_slots SET state='RESERVED',account_id=$2,operation_id=CASE WHEN $4 THEN operation_id ELSE $3 END,version=version+1 WHERE id=$1",[slot.id,account.id,op.id,await verifiedPhysicalProvision(c,slot.operation_id)]);
   await audit(c,req,'number.registered',account.id,{operation_id:op.id,slot:slot.slot,country:input.country,phone_declared:!!phone,warmup_mode:account.body.warmup_mode,warmup_mode_source:account.body.warmup_mode_source,external_effects:0});
   return{data:{id:account.id,version:account.version,operation_id:op.id,state:'PREPARING',label:numberLinkLabels.PREPARING,warmup_mode:account.body.warmup_mode,warmup_mode_source:account.body.warmup_mode_source},status:202};
  });
  return reply.code(202).send({data:result.data});
 });
 app.get('/v1/numbers/:id/link',async req=>({data:await readLink(req,idOf(req))}));
 app.post('/v1/numbers/:id/link',async(req,reply)=>{
  manage(req);const id=idOf(req),input=z.object({action:z.enum(['link','unlink','retry_preparation'])}).strict().parse(parseBody(req));
  const result=await mutate(req,'number.link:'+id,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+id]);
   const account=await scopedRecord(req,'channel_account',id,c),facts=await linkFacts(c,account),{state}=numberLinkState(facts);
   if(account.body.deleted_at||account.body.removal_requested_at)throw fail(409,'NUMBER_REMOVAL_IN_PROGRESS','Este número se está eliminando.');
   if(input.action==='retry_preparation'){
    // V7.4 A: the same operation is queued again for the bounded administrator;
    // nothing is duplicated and a number that was ever linked is not touched.
    if(state!=='PREPARATION_FAILED')return{data:view(facts)};
    const op=(await c.query("SELECT * FROM number_operations WHERE id=$1 AND workspace_id=$2 AND environment=$3 AND action='PROVISION' FOR UPDATE",[(facts.provision as {id?:string}|undefined)?.id??null,account.workspace_id,account.environment])).rows[0];
    if(!op||!['FAILED','CANCELLED'].includes(op.state)||account.body.identity_fingerprint||account.body.link_confirmed_at)throw fail(409,'PREPARATION_RETRY_NOT_AVAILABLE','La preparación de este número no se puede reintentar ahora.');
    if(!(await c.query('SELECT 1 FROM number_capacity_slots WHERE id::text=$1 AND account_id=$2',[op.input.slot_id??'',id])).rowCount)throw fail(409,'CAPACITY_ACCOUNT_BINDING_CHANGED','La plaza de este número cambió. Elimínalo y regístralo de nuevo.');
    await c.query("UPDATE number_operations SET state='RESERVED',lease_owner=NULL,lease_until=NULL,version=version+1,result=result||$2::jsonb,updated_at=now() WHERE id=$1",[op.id,{retry_requested_at:new Date().toISOString(),retries:Number(op.result?.retries??0)+1,previous_state:op.state,previous_reason:op.result?.reason??null}]);
    await audit(c,req,'number.preparation_retry_requested',id,{operation_id:op.id,previous_state:op.state,retries:Number(op.result?.retries??0)+1,external_effects:0},account.environment);
    return{data:view(await linkFacts(c,account)),status:202};
   }
   if(input.action==='unlink'){
    if(!facts.session||facts.session.desired_state==='STOPPED'&&!facts.connectPending){
     if(account.body.link_problem)await putRecord(c,{id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:account.version,body:{...account.body,link_problem:null}});
     return{data:{...view(await linkFacts(c,await scopedRecord(req,'channel_account',id,c)))}};
    }
    await lifecycleSafety(c,account,'logout');
    await c.query("UPDATE channel_sessions SET desired_state='STOPPED',operational_pause=true,revision=revision+1,updated_at=now() WHERE account_id=$1",[id]);
    const cmd=await command(c,req,'channel_command',id,{type:'logout',reason:'Desvincular desde Números'},account.environment);
    await putRecord(c,{id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:account.version,body:{...account.body,link_problem:null,ownership_confirmed_at:null}});
    return{data:{command_id:cmd.id,...view(await linkFacts(c,await scopedRecord(req,'channel_account',id,c)))},status:202};
   }
   if(['CONNECTED','CONFIRMING','WAITING_SCAN','RECONNECTING'].includes(state))return{data:view(facts)};
   if(state==='PHONE_MISMATCH'||state==='NUMBER_UNAVAILABLE')throw fail(409,state,'Desvincula este teléfono antes de intentar de nuevo.');
   if(!facts.profileReady)throw fail(409,state==='PREPARATION_FAILED'?'NUMBER_PREPARATION_FAILED':'NUMBER_PREPARING',preparationDetail[state]??'Estamos preparando la conexión de este número.');
   if(account.environment==='REAL'){const policy=await readOperationalSettings(c,account.workspace_id,'REAL');if(policy.release_hold)throw fail(409,'RELEASE_HOLD_ACTIVE','Estamos actualizando la plataforma. Intenta en un momento.');if(!onboardingEnabled(policy.body))throw fail(409,'NUMBER_LINKING_DISABLED','La vinculación de números está deshabilitada en este perfil.');}
   await lifecycleSafety(c,account,'connect');
   await c.query("UPDATE channel_sessions SET desired_state='RUNNING',operational_pause=false,revision=revision+1,updated_at=now() WHERE account_id=$1",[id]);
   const cmd=await command(c,req,'channel_command',id,{type:'connect',reason:'Vinculación con QR desde Números'},account.environment);
   return{data:{command_id:cmd.id,...view(await linkFacts(c,account)),state:'WAITING_SCAN',label:numberLinkLabels.WAITING_SCAN},status:202};
  });
  return reply.code(result.status??200).send({data:result.data});
 });
 // RNF-01.e «Pausado por ti»: an explicit pause of this number only; resuming
 // is likewise explicit. No protection, release or reconnection lifts it.
 app.post('/v1/numbers/:id/pause',async req=>{
  const p=manage(req),id=idOf(req),input=z.object({paused:z.boolean()}).strict().parse(parseBody(req));
  const result=await mutate(req,'number.pause:'+id,async c=>{
   const account=await scopedRecord(req,'channel_account',id,c);
   if(account.body.deleted_at||account.body.removal_requested_at)throw fail(409,'NUMBER_REMOVAL_IN_PROGRESS','Este número se está eliminando.');
   const row=(await c.query(`INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,$3,$4,$5)
    ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=EXCLUDED.paused,version=manual_controls.version+1,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id RETURNING version,paused`,
    [account.workspace_id,id,input.paused,input.paused?'Pausado por ti':'Reanudado por ti',p.user.id])).rows[0];
   await audit(c,req,input.paused?'number.paused':'number.resumed',id,{control_version:row.version,external_effects:0},account.environment);
   return{data:{id,paused:row.paused,label:row.paused?'Pausado por ti':'Reanudado'}};
  });
  return{data:result.data};
 });
 // V7.4 D: change the owner's warm-up choice of an existing number. History is
 // kept; only work that has not started is cancelled, uncertain deliveries
 // keep reconciling, a human pause stays, and nothing starts by itself.
 app.post('/v1/numbers/:id/warmup',async req=>{
  const p=manage(req),id=idOf(req),input=z.object({mode:warmupChoice,expected_version:z.number().int().positive()}).strict().parse(parseBody(req)),target=modeOfChoice(input.mode);
  const result=await mutate(req,'warmup.number-mode:'+id,async c=>{
   // Same lock order as group planning, commands and final emission: the
   // warm-up profile lock first, then the shared operational policy.
   await lockWarmupProfile(c,envOf(req));
   if(envOf(req)==='REAL'&&(await readOperationalSettings(c,p.workspace_id,'REAL',{lock:'share'})).release_hold)throw fail(409,'RELEASE_HOLD_ACTIVE','Estamos actualizando la plataforma. Intenta en un momento.');
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+id]);
   const account=await scopedRecord(req,'channel_account',id,c);
   if(account.body.deleted_at||account.body.removal_requested_at)throw fail(409,'NUMBER_REMOVAL_IN_PROGRESS','Este número se está eliminando.');
   const current=warmupModeOf(account.body),rebind=target==='DECLARED_READY'&&current==='DECLARED_READY'&&!declarationCurrent(account.body);
   if(current===target&&!rebind&&account.body.warmup_mode_source==='owner_choice')return{data:{id,version:account.version,warmup_mode:current,changed:false}};
   if(account.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT','El número cambió. Actualiza y vuelve a intentar.');
   const {saved,effects}=await applyWarmupMode(c,account,target,p.user.id);
   await audit(c,req,'number.warmup_mode_changed',id,{from:current,to:target,rebound_to_current_identity:rebind,...effects,history_preserved:true,external_effects:0},account.environment);
   return{data:{id,version:saved.version,warmup_mode:target,changed:true,...effects}};
  });
  return{data:result.data};
 });
 app.get('/v1/numbers/:id/removal',async req=>{const p=manage(req),id=idOf(req);return{data:await withProfileTransaction(pool,p.workspace_id,async c=>({id,...await removalImpact(c,await scopedRecord(req,'channel_account',id,c))}))};});
 app.post('/v1/numbers/:id/removal/unlink-confirmation',async req=>{
  const p=manage(req),id=idOf(req),input=z.object({expected_version:z.number().int().positive(),confirmation:z.literal('DEVICE_UNLINKED_ON_PHONE')}).strict().parse(parseBody(req));
  // What happened on the owner's phone is stated by a person, in the application.
  if(p.service||p.authentication_method==='personal_access_token')throw fail(403,'HUMAN_CONFIRMATION_REQUIRED','Confirma la desvinculación desde la aplicación, con tu sesión.');
  const result=await mutate(req,'number.removal-unlink:'+id,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+id]);
   const account=await scopedRecord(req,'channel_account',id,c);
   if(account.body.deleted_at)return{data:{id,state:'REMOVED',label:numberLinkLabels.REMOVED}};
   if(!account.body.removal_requested_at)throw fail(409,'NUMBER_REMOVAL_NOT_REQUESTED','Solicita primero la eliminación de este número.');
   if(account.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT','El número cambió. Actualiza y vuelve a intentar.');
   const facts=await removalFacts(c,account);
   if(facts.pending||facts.uncertain||facts.inflight)throw fail(409,'RECONCILIATION_REQUIRED','Hay una operación de este número cuyo resultado aún se está confirmando.');
   if(!facts.blocked)throw fail(409,'UNLINK_CONFIRMATION_NOT_REQUIRED','Este número no necesita esta confirmación.');
   if(facts.ownership.live||!facts.ownership.frozen||account.body.sending_enabled===true)throw fail(409,'OWNERSHIP_ISOLATION_REQUIRED','La sesión de este número todavía tiene actividad. Intenta en un momento.');
   const session=(await c.query('SELECT id,revision,desired_state,operational_pause,recovery_enabled,gateway_id FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 AND archived_at IS NULL FOR UPDATE',[id,account.workspace_id,account.environment])).rows[0];
   if(session&&(session.desired_state!=='STOPPED'||!session.operational_pause||session.recovery_enabled))throw fail(409,'STOP_AND_ISOLATE_BEFORE_DRAIN','La sesión de este número aún no está detenida.');
   // Fresh evidence from the bounded administrator for exactly this number's
   // current gateway. It proves the current host holds no session; together
   // with the owner's statement it accredits the unlink. Alone it would not.
   const slot=(await c.query("SELECT id,slot,readback FROM number_capacity_slots WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND host_ref='primary' FOR SHARE",[account.workspace_id,account.environment,id])).rows[0];
   const reference=slot?'waha-'+String(slot.slot).padStart(2,'0'):null;
   const sessionSlot=session?.gateway_id?gatewaySlot(String(session.gateway_id).replace(/^unconfigured:/,'')):null;
   if(!slot||account.body.gateway_ref!==reference||(sessionSlot!==null&&sessionSlot!==Number(slot.slot)))throw fail(409,'GATEWAY_SLOT_MISMATCH','No pudimos identificar el servidor actual de este número. Revísalo con soporte.');
   if(!capacityReadbackIsFresh(slot.readback,await numberNow(c,account.workspace_id,account.environment))||slot.readback?.source!=='bounded_administrator')throw fail(409,'FRESH_GATEWAY_EVIDENCE_REQUIRED','Estamos comprobando el servidor de este número. Intenta de nuevo en un minuto.');
   if(slot.readback.session_count!==0||(slot.readback.connected_sessions??0)!==0)throw fail(409,'GATEWAY_SESSION_STILL_PRESENT','El servidor todavía tiene una sesión de este número. Quita el dispositivo en WhatsApp → Dispositivos vinculados e intenta de nuevo.');
   const at=new Date().toISOString();
   const unlinked=await putRecord(c,{id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:account.version,
    body:{...account.body,status:'STOPPED',sending_enabled:false,identity_verified:false,unlinked_at:at,unlink_method:'primary_device_revocation_confirmed_and_current_gateway_empty',unlink_confirmed_by:p.user.id}});
   await audit(c,req,'channel.unlink_reconciled',id,{method:'primary_device_revocation_confirmed_and_current_gateway_empty',remote_logout_executed:false,owner_confirmation:'DEVICE_UNLINKED_ON_PHONE',
    gateway:{slot:Number(slot.slot),observed_at:slot.readback.observed_at,session_count:0,connected_sessions:0,source:'bounded_administrator'},blocked_command_id:facts.logout.id,blocked_reason:facts.logout.result?.error??null,
    previous_owner_preserved_frozen:true,isolation_proof_fabricated:false,external_effects:0},account.environment);
   const final=await finalizeRemoval(req,c,unlinked),state=final.body.deleted_at?'REMOVED':'REMOVING';
   return{data:{id,state,label:numberLinkLabels[state],unlink_reconciled:true}};
  });
  return{data:result.data};
 });
 app.post('/v1/numbers/:id/removal',async(req,reply)=>{
  const p=manage(req),id=idOf(req),input=z.object({expected_version:z.number().int().positive(),confirmation:z.literal('REMOVE_NUMBER')}).strict().parse(parseBody(req));
  const result=await mutate(req,'number.removal:'+id,async c=>{
   await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+id]);
   const account=await scopedRecord(req,'channel_account',id,c);
   if(account.body.deleted_at)return{data:{id,state:'REMOVED',label:numberLinkLabels.REMOVED}};
   if(account.version!==input.expected_version&&!account.body.removal_requested_at)throw fail(409,'VERSION_CONFLICT','El número cambió. Revisa el impacto otra vez.');
   const impact=await removalImpact(c,account);
   await c.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'channel_account',$2,true,'Eliminación solicitada',$3) ON CONFLICT(workspace_id,scope_type,scope_id) DO UPDATE SET paused=true,version=manual_controls.version+1,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id",[account.workspace_id,id,p.user.id]);
   const cancelled=(await c.query("UPDATE outbox SET status='CANCELLED',result=jsonb_build_object('reason','NUMBER_REMOVED','superseded_before_send',attempts=0),updated_at=now() WHERE workspace_id=$1 AND environment=$2 AND account_id=$3 AND status IN('READY','BLOCKED') RETURNING id",[account.workspace_id,account.environment,id])).rowCount;
   const timers=(await c.query("UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND environment=$2 AND status='PENDING' AND conversation_id IN(SELECT id::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND body->>'account_id'=$3) RETURNING id",[account.workspace_id,account.environment,id])).rowCount;
   let marked=account;
   if(!account.body.removal_requested_at)marked=await putRecord(c,{id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:account.version,body:{...account.body,removal_requested_at:new Date().toISOString(),removal_requested_by:p.user.id,sending_enabled:false}});
   const session=(await c.query('SELECT desired_state,observed_state FROM channel_sessions WHERE account_id=$1 AND archived_at IS NULL',[id])).rows[0];
   const ownership=(await c.query('SELECT 1 FROM session_ownership WHERE workspace_id=$1 AND account_id=$2',[account.workspace_id,id])).rowCount;
   let commandId:string|null=null;
   if(ownership&&!account.body.unlinked_at&&!(await c.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND resource_id=$3 AND kind='channel_command' AND payload->>'type'='logout' AND status='PENDING'",[account.workspace_id,account.environment,id])).rowCount){
    await lifecycleSafety(c,marked,'logout');
    await c.query("UPDATE channel_sessions SET desired_state='STOPPED',operational_pause=true,revision=revision+1,updated_at=now() WHERE account_id=$1",[id]);
    commandId=(await command(c,req,'channel_command',id,{type:'logout',reason:'Eliminación del número'},account.environment)).id;
   }
   await audit(c,req,'number.removal_requested',id,{impact:{products:impact.products.length,open_conversations:impact.open_conversations,pending_followups:impact.pending_followups},cancelled_unsent:cancelled,cancelled_timers:timers,session_close_command:commandId,history_preserved:true,external_effects:0});
   const final=await finalizeRemoval(req,c,marked);
   const state=final.body.deleted_at?'REMOVED':'REMOVING';
   return{data:{id,state,label:numberLinkLabels[state],cancelled_unsent:cancelled,cancelled_timers:timers,command_id:commandId,session_observed:session?.observed_state??null},status:202};
  });
  return reply.code(202).send({data:result.data});
 });
}
