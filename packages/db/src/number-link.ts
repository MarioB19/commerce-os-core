import {createHmac,hkdfSync} from 'node:crypto';
import type {DomainRecord} from '../../contracts/src/index.js';
import {canonicalIdentity} from '../../messaging/src/security.js';
import {observedPhoneDigits} from '../../domain/src/numbers/phone.js';
import {decrypt,hash,putRecord,type QueryExecutor} from './index.js';

/** V7 F3 number link (RF-07.a, RF-17.f, wireframe D). The owner registers a
 * number with its private phone, scans one QR and the platform confirms the
 * line by itself: no identity, health, worker or authorization steps are shown.
 * Confirmation needs the identity read back from the provider after the scan,
 * equal to the registered phone (when one was given) and not confirmed on any
 * other live number of the installation. */
export type NumberLinkState='REMOVED'|'REMOVING'|'PHONE_MISMATCH'|'NUMBER_UNAVAILABLE'|'PREPARING'|'PREPARATION_FAILED'|'READY_TO_LINK'|'WAITING_SCAN'|'CONFIRMING'|'CONNECTED'|'NEEDS_QR'|'RECONNECTING'|'DISCONNECTED';
export const numberLinkLabels:Record<NumberLinkState,string>={REMOVED:'Eliminado',REMOVING:'Eliminación en curso',PHONE_MISMATCH:'El teléfono vinculado no coincide',NUMBER_UNAVAILABLE:'Este número no está disponible',
 PREPARING:'Preparando el número',PREPARATION_FAILED:'No se pudo preparar el número',READY_TO_LINK:'Listo para vincular',WAITING_SCAN:'Esperando escaneo',CONFIRMING:'Conectando',
 CONNECTED:'Conectado',NEEDS_QR:'Necesita QR',RECONNECTING:'Reconectando',DISCONNECTED:'Desconectado'};

export function phoneKey(secret=process.env.PRIVATE_DATA_KEY??process.env.DATA_ENCRYPTION_KEY??process.env.ENCRYPTION_KEY){
 if(typeof secret!=='string'||!secret)throw new Error('PRIVATE_DATA_KEY_REQUIRED');
 const raw=Buffer.from(secret,/^[a-f0-9]{64}$/i.test(secret)?'hex':'base64');if(raw.length!==32)throw new Error('PRIVATE_DATA_KEY_MUST_BE_32_BYTES');
 return Buffer.from(hkdfSync('sha256',raw,Buffer.from('commerce-os'),Buffer.from('commerce.number.phone.v1'),32));
}
/** Keyed, so a stored fingerprint cannot be reversed by enumerating numbers. */
export const phoneFingerprint=(digits:string)=>createHmac('sha256',phoneKey()).update('phone:'+digits).digest('hex');

export interface NumberLinkFacts {account:DomainRecord;session?:Record<string,any>;profileReady:boolean;provision?:{state:string}|undefined;connectPending:boolean;now:Date}
export function numberLinkState(f:NumberLinkFacts):{state:NumberLinkState;qr:boolean}{
 const a=f.account.body,s=f.session??{},fresh=!!s.health_expires_at&&new Date(s.health_expires_at)>f.now;
 if(a.deleted_at)return{state:'REMOVED',qr:false};
 if(a.removal_requested_at)return{state:'REMOVING',qr:false};
 if(a.link_problem==='PHONE_MISMATCH'||a.link_problem==='NUMBER_UNAVAILABLE')return{state:a.link_problem,qr:false};
 const connected=fresh&&s.observed_state==='CONNECTED',confirmed=!!a.ownership_confirmed_at&&!!a.identity_fingerprint;
 if(connected)return{state:confirmed?'CONNECTED':'CONFIRMING',qr:false};
 if(!f.profileReady)return{state:f.provision?.state==='FAILED'?'PREPARATION_FAILED':'PREPARING',qr:false};
 const waiting=fresh&&(s.observed_state==='QR_REQUIRED'||s.observed_state==='STARTING');
 if(waiting||f.connectPending)return{state:'WAITING_SCAN',qr:fresh&&s.observed_state==='QR_REQUIRED'};
 if(confirmed){
  if(s.auth_state==='QR_REQUIRED'||s.recovery_stage==='AWAITING_NEW_QR'||a.unlinked_at)return{state:'NEEDS_QR',qr:false};
  if(s.desired_state==='RUNNING')return{state:'RECONNECTING',qr:false};
  return{state:'DISCONNECTED',qr:false};
 }
 return{state:'READY_TO_LINK',qr:false};
}

/** Idempotent confirmation, inside the caller's transaction with the account
 * locked. Returns the problem when the line cannot be confirmed. */
export async function confirmLinkedNumber(c:QueryExecutor,account:DomainRecord,now:Date):Promise<{confirmed:boolean;problem?:'PHONE_MISMATCH'|'NUMBER_UNAVAILABLE';identityRequested?:boolean}>{
 if(account.body.ownership_confirmed_at&&account.body.identity_fingerprint)return{confirmed:true};
 const s=(await c.query('SELECT observed_state,auth_state,health_expires_at,last_health_at,observed_identity_ciphertext FROM channel_sessions WHERE account_id=$1 AND workspace_id=$2 AND archived_at IS NULL',[account.id,account.workspace_id])).rows[0];
 if(!s||s.observed_state!=='CONNECTED'||s.auth_state!=='VERIFIED'||!s.health_expires_at||new Date(s.health_expires_at)<=now)return{confirmed:false};
 const fresh=s.observed_identity_ciphertext&&account.body.identity_fingerprint&&s.last_health_at&&now.getTime()-new Date(s.last_health_at).getTime()<=120_000;
 if(!fresh){
  // Read the provider identity once through the reviewed number operation.
  const pending=(await c.query("SELECT 1 FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND input->>'account_id'=$3 AND action='IDENTITY_OBSERVE' AND state IN('REQUESTED','RESERVED','PREPARING','UNKNOWN')",[account.workspace_id,account.environment,account.id])).rowCount;
  if(!pending)await c.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,input) VALUES($1,$2,'number-link','IDENTITY_OBSERVE',$3)",[account.workspace_id,account.environment,{account_id:account.id}]);
  return{confirmed:false,identityRequested:!pending};
 }
 const raw=decrypt(s.observed_identity_ciphertext);
 if(hash(raw)!==account.body.identity_fingerprint)return{confirmed:false};
 let digits:string;try{digits=observedPhoneDigits(canonicalIdentity(raw));}catch{return problem(c,account,'NUMBER_UNAVAILABLE');}
 if(account.body.declared_phone_fingerprint&&account.body.declared_phone_fingerprint!==phoneFingerprint(digits))return problem(c,account,'PHONE_MISMATCH');
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['number-identity:'+account.body.identity_fingerprint]);
 if((await c.query('SELECT number_identity_claimed_elsewhere($1,$2,$3) AS claimed',[account.environment,account.id,account.body.identity_fingerprint])).rows[0]?.claimed===true)return problem(c,account,'NUMBER_UNAVAILABLE');
 await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:account.version,
  body:{...account.body,identity_verified:true,identity_conflict:false,ownership_confirmed_at:now.toISOString(),link_confirmed_at:now.toISOString(),masked_number:'•••• '+digits.slice(-4),link_problem:null}});
 await c.query("UPDATE number_capacity_slots SET state='CONNECTED',version=version+1,updated_at=now() WHERE account_id=$1 AND state IN('RESERVED','QR_PENDING','PREPARED')",[account.id]);
 return{confirmed:true};
}
async function problem(c:QueryExecutor,account:DomainRecord,code:'PHONE_MISMATCH'|'NUMBER_UNAVAILABLE'){
 if(account.body.link_problem!==code)await putRecord(c,{id:account.id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:account.version,body:{...account.body,link_problem:code}});
 return{confirmed:false,problem:code};
}
