import type {DomainRecord} from '../../contracts/src/index.js';
import type {ProfileExecutor} from './profile-context.js';
import {putRecord} from './index.js';
import {warmupModeOf,type WarmupMode} from './number-link.js';

/** V7.4 D: apply the owner's warm-up choice to an existing number, inside the
 * caller's profile transaction with the warm-up profile lock and the number
 * lock already held.
 *
 * Declaring a number ready keeps every record (states, episodes, credits,
 * receipts, sent messages) and stops only what has not started: unsent warm-up
 * effects where the number sends or is a recorded recipient are cancelled, the
 * programs that counted on it are paused and must be reviewed again, and its
 * reservation is released. Deliveries whose result is uncertain are left to
 * reconcile. Asking for warm-up again starts nothing: the number goes back to
 * «elige un grupo». A human pause is a different control and is never touched. */
export async function applyWarmupMode(c:ProfileExecutor,account:DomainRecord,target:WarmupMode,actor:string){
 const current=warmupModeOf(account.body),effects={cancelled_unsent:0,programs_paused:0,deliveries_to_confirm:0},id=account.id;
 if(target==='DECLARED_READY'&&current!=='DECLARED_READY'){
  const programs=(await c.query('SELECT g.id,g.pool_id FROM warmup_account_reservations v JOIN warmup_programs g ON g.id=v.program_id WHERE v.account_id=$1 AND g.workspace_id=$2 AND g.environment=$3 ORDER BY g.id FOR UPDATE OF g',[id,account.workspace_id,account.environment])).rows;
  effects.cancelled_unsent=(await c.query(`UPDATE outbox o SET status='CANCELLED',result=result||'{"reason":"OWNER_DECLARED_READY"}'::jsonb,updated_at=now()
   WHERE o.workspace_id=$1 AND o.environment=$2 AND o.kind='warmup' AND o.status IN('READY','BLOCKED') AND
    (o.account_id=$3::text OR o.contact_id=$3::text OR EXISTS(SELECT 1 FROM warmup_turns t WHERE t.effect_id=o.id AND $3::uuid=ANY(t.recipient_ids)) OR o.payload->>'warmup_pool_id'=ANY($4::text[]))`,
   [account.workspace_id,account.environment,id,programs.filter(g=>g.pool_id).map(g=>String(g.pool_id))])).rowCount??0;
  effects.deliveries_to_confirm=Number((await c.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND environment=$2 AND kind='warmup' AND account_id=$3::text AND status IN('SENDING','UNKNOWN')",[account.workspace_id,account.environment,id])).rows[0].n);
  for(const g of programs){
   await c.query("UPDATE warmup_programs SET status=CASE WHEN status='ACTIVE' THEN 'PAUSED' ELSE status END,review_hash=NULL,version=version+1,updated_at=now() WHERE id=$1",[g.id]);
   if(g.pool_id)await c.query("UPDATE warmup_pools SET paused=true,breaker_reason='PARTICIPANT_WARMUP_CHOICE_CHANGED',version=version+1 WHERE id=$1",[g.pool_id]);
   effects.programs_paused++;
  }
  await c.query('DELETE FROM warmup_account_reservations WHERE account_id=$1',[id]);
  await c.query("UPDATE warmup_states SET status=CASE WHEN status='GRADUATED' THEN status ELSE 'PAUSED' END,reason=CASE WHEN status='GRADUATED' THEN reason ELSE 'OWNER_DECLARED_READY' END,group_required=true,version=version+1,updated_at=now() WHERE account_id=$1 AND workspace_id=$2 AND environment=$3",[id,account.workspace_id,account.environment]);
 }
 if(target==='REQUIRED'&&current!=='REQUIRED')await c.query("UPDATE warmup_states SET status='AWAITING_PEER',reason='GROUP_SELECTION_REQUIRED',group_required=true,version=version+1,updated_at=now() WHERE account_id=$1 AND workspace_id=$2 AND environment=$3 AND status='PAUSED' AND reason='OWNER_DECLARED_READY'",[id,account.workspace_id,account.environment]);
 const {warmup_declared_identity:_previous,...body}=account.body;
 const saved=await putRecord(c,{id,workspaceId:account.workspace_id,environment:account.environment,kind:account.kind,version:account.version,
  body:{...body,warmup_mode:target,warmup_mode_source:'owner_choice',warmup_mode_set_at:new Date().toISOString(),warmup_mode_set_by:actor,...(target==='DECLARED_READY'&&account.body.identity_fingerprint?{warmup_declared_identity:account.body.identity_fingerprint}:{})}});
 return{saved,effects};
}
