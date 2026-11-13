import {appendEvent,putRecord,type QueryExecutor} from './index.js';
import {bindRecordEnvironment} from './profile-environment.js';
import type {Environment} from '../../contracts/src/index.js';

/** V7.5.2 N01 — the operational permit of a REAL number
 * (`channel_account.sending_enabled`).
 *
 * V5 set it with POST /v1/channel-accounts/:id/activate, retired in V7. V7 kept
 * the permit as a gate (dispatch, automation, lifecycle resume, readiness) but
 * no V7 path established it, so a number a person assigned could never attend,
 * not even after its warm-up graduated.
 *
 * D-01: the human assignment of a variant to a number is the permanent
 * authorization to attend that number's REAL conversations. So the permit is
 * established by that human act (HUMAN_ASSIGNMENT), or once, for human
 * assignments already in force before this transition existed
 * (ASSIGNMENT_ADOPTION). It requires the live commercial authorization of an
 * ACTIVE assignment — which only a person's session can issue
 * (issueCommercialContinuity) — and never lifts anything else: human pause, protections,
 * warm-up, manual controls, release hold and the REAL policy keep their own
 * gates. A permit once established and later turned off (removal, unlink,
 * logout) is never re-established by adoption; only a new human act does.
 * No message, command or external call happens here. */
export type SendingPermitSource='HUMAN_ASSIGNMENT'|'ASSIGNMENT_ADOPTION';
export type SendingPermitResult={state:'ESTABLISHED'|'UNCHANGED'|'NOT_ELIGIBLE';reason?:string;assignment_id?:string;continuity_id?:string};

export async function establishSendingPermit(db:QueryExecutor,environment:Environment,workspaceId:string,accountId:string,
 input:{source:SendingPermitSource;actorId:string|null;causationId?:string}):Promise<SendingPermitResult>{
 if(environment!=='REAL')return{state:'NOT_ELIGIBLE',reason:'ENVIRONMENT_NOT_REAL'};
 await bindRecordEnvironment(db,workspaceId,'REAL');
 const account=(await db.query(`SELECT id,version,body FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='channel_account' AND id=$2 FOR UPDATE`,[workspaceId,accountId])).rows[0];
 if(!account)return{state:'NOT_ELIGIBLE',reason:'NUMBER_NOT_FOUND'};
 const body=account.body as Record<string,unknown>;
 if(body.deleted_at||body.removal_requested_at)return{state:'NOT_ELIGIBLE',reason:'NUMBER_REMOVAL'};
 if(body.unlinked_at)return{state:'NOT_ELIGIBLE',reason:'NUMBER_UNLINKED'};
 if(!['waha','cloud'].includes(String(body.provider))||body.lab_snapshot||body.flow_test_transport)return{state:'NOT_ELIGIBLE',reason:'PROVIDER_NOT_REAL'};
 if(body.sending_enabled===true)return{state:'UNCHANGED'};
 if(input.source==='ASSIGNMENT_ADOPTION'&&body.sending_permit)return{state:'NOT_ELIGIBLE',reason:'PERMIT_TURNED_OFF_REQUIRES_HUMAN'};
 const grant=(await db.query(`SELECT g.id::text AS continuity_id,x.id::text AS assignment_id,x.revision FROM continuous_authorizations g
  JOIN commercial_assignments x ON x.id=g.assignment_id AND x.workspace_id=g.workspace_id AND x.environment=g.environment AND x.account_id=g.account_id AND x.state='ACTIVE'
  WHERE g.workspace_id=$1 AND g.environment='REAL' AND g.account_id=$2::uuid AND g.state->'revokedAt'='null'::jsonb AND g.state->'source'->>'kind'='COMMERCIAL_ASSIGNMENT'
   AND (g.state->'source'->>'assignmentRevision')::int=x.revision AND g.state->'source'->>'bindingId'=x.binding_id::text
  ORDER BY g.id LIMIT 1`,[workspaceId,accountId])).rows[0];
 if(!grant)return{state:'NOT_ELIGIBLE',reason:'HUMAN_ASSIGNMENT_REQUIRED'};
 const at=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
 await putRecord(db,{id:account.id,workspaceId,environment:'REAL',kind:'channel_account',version:account.version,body:{...body,sending_enabled:true,
  sending_permit:{source:input.source,assignment_id:grant.assignment_id,assignment_revision:Number(grant.revision),continuity_id:grant.continuity_id,
   identity_fingerprint:typeof body.identity_fingerprint==='string'?body.identity_fingerprint:null,established_at:new Date(at).toISOString(),established_by:input.actorId}}});
 await appendEvent(db,{workspace_id:workspaceId,environment:'REAL',event_type:'channel.sending_permit_established',aggregate_id:accountId,
  ...(input.causationId?{causation_id:input.causationId}:{}),actor:input.actorId?{type:'human',id:input.actorId}:{type:'system',id:'assignment-adoption'},
  payload:{source:input.source,assignment_id:grant.assignment_id,assignment_revision:Number(grant.revision),continuity_id:grant.continuity_id,external_effects:0}});
 return{state:'ESTABLISHED',assignment_id:grant.assignment_id,continuity_id:grant.continuity_id};
}

/** Accounts of one profile whose human assignment is in force but whose permit
 * was never established (bounded; the caller adopts each in its own transaction).
 * It applies the same eligibility as establishSendingPermit (real provider, no
 * laboratory transport, live grant of the assignment's current revision and
 * binding), so a number adoption would refuse is never selected again and can
 * not starve the eligible ones behind the bound: passes converge to zero. */
export async function adoptionCandidates(db:QueryExecutor,workspaceId:string,limit=20){
 await bindRecordEnvironment(db,workspaceId,'REAL');
 return(await db.query(`SELECT DISTINCT r.id::text FROM records r
  JOIN continuous_authorizations g ON g.workspace_id=r.workspace_id AND g.environment=r.environment AND g.account_id=r.id
  JOIN commercial_assignments x ON x.id=g.assignment_id AND x.workspace_id=g.workspace_id AND x.environment=g.environment AND x.account_id=g.account_id AND x.state='ACTIVE'
  WHERE r.workspace_id=$1 AND r.environment='REAL' AND r.kind='channel_account' AND NOT(r.body?'deleted_at') AND NOT(r.body?'sending_permit')
   AND COALESCE(r.body->>'sending_enabled','false')<>'true' AND r.body->>'removal_requested_at' IS NULL AND r.body->>'unlinked_at' IS NULL
   AND r.body->>'provider' IN ('waha','cloud')
   AND COALESCE(r.body->'lab_snapshot','null'::jsonb) IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
   AND COALESCE(r.body->'flow_test_transport','null'::jsonb) IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)
   AND g.state->'revokedAt'='null'::jsonb AND g.state->'source'->>'kind'='COMMERCIAL_ASSIGNMENT'
   AND (g.state->'source'->>'assignmentRevision')::int=x.revision AND g.state->'source'->>'bindingId'=x.binding_id::text
  ORDER BY 1 LIMIT $2`,[workspaceId,limit])).rows.map(r=>String(r.id));
}
