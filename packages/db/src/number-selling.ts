import type {DomainRecord} from '../../contracts/src/index.js';
import {commercialWarmupGuard} from './warmup.js';
import {readOperationalSettings} from './operational-settings.js';
import type {QueryExecutor} from './index.js';
import {bindRecordEnvironment} from './profile-environment.js';

/** V7.5.2 N01: one meaning of «asignado», «calentando», «apto para atender» and
 * «atendiendo» for Inicio, Números, the product's numbers and diagnostics.
 *
 * - assigned: a human assignment (D-01) with its live permanent commercial
 *   authorization (not revoked).
 * - warming: the dispatcher's own warm-up guard (commercialWarmupGuard) still
 *   blocks commercial sends; no calendar day is inferred.
 * - ready («apto para atender»): connected, under operational control, not
 *   paused, assigned, warm-up satisfied, operational permit established, REAL
 *   policy open, no protection — every gate a consented inbound reply meets.
 * - attending («atendiendo»): ready and with a customer conversation of an
 *   assignment whose last inbound is within the last 24 hours. Being assigned
 *   or ready never claims activity.
 * Read only; it never changes a permit, pause or program. */
export type SellingStage='DISCONNECTED'|'PAUSED'|'NOT_ASSIGNED'|'NOT_OPERATIONAL'|'WARMING'|'NOT_AUTHORIZED'|'READY'|'ATTENDING';
export const sellingLabels:Record<SellingStage,string>={
 DISCONNECTED:'Desconectado',PAUSED:'Pausado por ti',NOT_ASSIGNED:'Sin variante asignada',NOT_OPERATIONAL:'Asignado · sin control operativo vigente',
 WARMING:'Asignado · calentando; atenderá al terminar',NOT_AUTHORIZED:'Asignado · sin permiso operativo',READY:'Apto para atender',ATTENDING:'Atendiendo'};
export interface NumberSelling {stage:SellingStage;label:string;assigned:boolean;warming:boolean;permit:boolean;ready:boolean;attending:boolean;
 /** Why a connected, assigned number cannot attend (stable codes, no data). */
 reasons:string[]}
const WARMUP_REASONS=new Set(['ACCOUNT_WARMING','ACCOUNT_PREPARATION_REQUIRED','WARMUP_REGISTERED_IDENTITY_CHANGED','WARMUP_DECLARATION_IDENTITY_CHANGED','WARMUP_PEER_INVENTORY_OVERFLOW']);

export async function readNumberSelling(c:QueryExecutor,account:DomainRecord):Promise<NumberSelling>{
 await bindRecordEnvironment(c,account.workspace_id,account.environment);
 const facts=(await c.query(`SELECT
   EXISTS(SELECT 1 FROM manual_controls m WHERE m.workspace_id=$1 AND ((m.scope_type='channel_account' AND m.scope_id=$3::text) OR (m.scope_type='workspace' AND m.scope_id=$1)) AND (m.paused OR m.suppressed OR m.takeover)) AS control_paused,
   COALESCE((SELECT s.operational_pause FROM channel_sessions s WHERE s.account_id=$3::uuid AND s.workspace_id=$1 AND s.environment=$2),false) AS session_paused,
   COALESCE((SELECT NOT o.frozen AND o.lease_expires_at>clock_timestamp() FROM session_ownership o WHERE o.account_id=$3::text AND o.workspace_id=$1),false) AS operational,
   (SELECT count(*)::int FROM continuous_authorizations g JOIN commercial_assignments x ON x.id=g.assignment_id AND x.workspace_id=g.workspace_id AND x.environment=g.environment AND x.state='ACTIVE'
     WHERE g.workspace_id=$1 AND g.environment=$2 AND g.account_id=$3::uuid AND g.state->'revokedAt'='null'::jsonb AND g.state->'source'->>'kind'='COMMERCIAL_ASSIGNMENT') AS assigned,
   (SELECT count(*)::int FROM continuous_authorizations g WHERE g.workspace_id=$1 AND g.environment=$2 AND g.account_id=$3::uuid AND g.state->'revokedAt'='null'::jsonb
     AND g.state->'source'->>'kind'='COMMERCIAL_ASSIGNMENT' AND (g.state->>'humanPaused')::boolean) AS human_paused,
   (SELECT count(*)::int FROM continuous_authorizations g WHERE g.workspace_id=$1 AND g.environment=$2 AND g.account_id=$3::uuid AND g.state->'revokedAt'='null'::jsonb
     AND g.state->'source'->>'kind'='COMMERCIAL_ASSIGNMENT' AND jsonb_array_length(g.state->'protections')>0) AS protected,
   EXISTS(SELECT 1 FROM records v WHERE v.workspace_id=$1 AND v.environment=$2 AND v.kind='conversation' AND v.body->>'account_id'=$3::text
     AND v.body->>'assignment_id' IS NOT NULL AND v.body->>'last_inbound_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
     AND (v.body->>'last_inbound_at')::timestamptz BETWEEN clock_timestamp()-interval '24 hours' AND clock_timestamp()) AS recent_inbound`,
  [account.workspace_id,account.environment,account.id])).rows[0];
 const permit=account.body.sending_enabled===true,assigned=Number(facts.assigned)>0,reasons:string[]=[];
 const base={assigned,permit,warming:false,ready:false,attending:false};
 const done=(stage:SellingStage,extra:Partial<NumberSelling>={})=>({...base,...extra,stage,label:sellingLabels[stage],reasons});
 if(account.body.deleted_at||account.body.status!=='WORKING')return done('DISCONNECTED');
 // «Pausado por ti» is a deliberate pause only (manual control or human pause),
 // the same rule Números uses; a session the system holds is operational state.
 if(facts.control_paused||Number(facts.human_paused)>0)return done('PAUSED');
 if(!assigned)return done('NOT_ASSIGNED');
 if(facts.session_paused)reasons.push('SESSION_OPERATIONAL_PAUSE');
 if(!facts.operational||account.environment==='REAL'&&account.body.provider==='waha'&&(account.body.identity_verified!==true||account.body.identity_conflict===true))reasons.push('OPERATIONAL_CONTROL_REQUIRED');
 if(reasons.length)return done('NOT_OPERATIONAL');
 // The same guard the dispatcher applies; a read failure is not a pass and
 // must not abort the caller's transaction (savepoint when inside one).
 let warmup:string|null;
 const savepoint=await c.query('SAVEPOINT number_selling_warmup').then(()=>true,()=>false);
 try{warmup=await commercialWarmupGuard(c,account);if(savepoint)await c.query('RELEASE SAVEPOINT number_selling_warmup');}
 catch{warmup='WARMUP_STATE_UNAVAILABLE';if(savepoint)await c.query('ROLLBACK TO SAVEPOINT number_selling_warmup');}
 if(warmup&&(WARMUP_REASONS.has(warmup)||warmup==='WARMUP_STATE_UNAVAILABLE')){reasons.push(warmup);return done('WARMING',{warming:true});}
 if(warmup)reasons.push(warmup);
 if(account.environment==='REAL'){
  const policy=await readOperationalSettings(c,account.workspace_id,'REAL');
  if(policy.release_hold)reasons.push('RELEASE_HOLD');
  else if(policy.body.dispatch_frozen||!policy.body.real_sends_enabled||!policy.body.allow_real_operations)reasons.push('REAL_OPERATION_NOT_ENABLED');
  if(!permit)reasons.push('ACCOUNT_SENDING_NOT_ENABLED');
 }
 if(Number(facts.protected)>0)reasons.push('CONTINUITY_PROTECTED');
 if(reasons.length)return done('NOT_AUTHORIZED');
 return facts.recent_inbound?done('ATTENDING',{ready:true,attending:true}):done('READY',{ready:true});
}
