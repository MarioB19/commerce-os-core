import {createHash,randomUUID} from 'node:crypto';
import {continuousAuthorizationSchema,type ContinuousSource} from '../../contracts/src/continuous-authorization.js';
import type {QueryExecutor} from './index.js';

/** V7 cutover (ADR-V7-03, prompt V7 §2 "REAL continuo"): the one-time adoption
 * of commercial assignments that a human had already authorized before V7 into
 * permanent continuity grants. Nothing else is adopted: a draft, retired or
 * changed assignment, a revoked authorization, a deleted number, an authorization
 * whose scope does not name exactly this assignment revision and binding, or a
 * profile that is not ACTIVE. Expiry and configuration revision are the legacy
 * contract V7 retires, so they do not exclude an otherwise authorized grant.
 *
 * Runs only as the reviewed migration owner, one profile context at a time. It
 * never sends, connects, unfreezes or lifts a pause: a later human pause stays,
 * and each effect keeps its own gates. The plan is deterministic and replays
 * idempotently through the source hash (an existing origin is never rewritten).
 */
export interface AdoptionCandidate {workspaceId:string;assignmentId:string;assignmentRevision:number;bindingId:string;accountId:string;productId:string;authorizationId:string;authorizedBy:string;authorizedAt:string}
export interface AdoptionExclusion {workspaceId:string;assignmentId:string;reason:string}
export interface AdoptionPlan {schema_version:1;profiles:string[];candidates:AdoptionCandidate[];excluded:AdoptionExclusion[];already_adopted:number}

function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
/** Same source hash as issueCommercialContinuity, so a human issue and the
 * adoption converge on one origin. */
export function commercialSourceHash(workspaceId:string,environment:'REAL',accountId:string,source:ContinuousSource){return digest({workspaceId,environment,accountId,source});}

async function bind(db:QueryExecutor,workspaceId:string){
 const row=(await db.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true) AS workspace,pg_catalog.set_config('app.environment','REAL',true) AS environment",[workspaceId])).rows[0];
 if(row?.workspace!==workspaceId||row?.environment!=='REAL')throw new Error('ADOPTION_PROFILE_CONTEXT_REQUIRED');
}
async function requireOwner(db:QueryExecutor){
 const row=(await db.query("SELECT current_user=pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid='public.continuous_authorizations'::regclass")).rows[0];
 if(row?.owner!==true)throw new Error('ADOPTION_MIGRATION_OWNER_REQUIRED');
}

export async function planContinuityAdoption(db:QueryExecutor):Promise<AdoptionPlan>{
 await requireOwner(db);
 const profiles=(await db.query("SELECT id,state FROM profiles ORDER BY id")).rows as {id:string;state:string}[];
 const plan:AdoptionPlan={schema_version:1,profiles:[],candidates:[],excluded:[],already_adopted:0};
 for(const profile of profiles){
  await bind(db,profile.id);
  const rows=(await db.query(`SELECT a.id,a.revision,a.state,a.account_id,a.product_id,a.binding_id,a.authorization_id,
    auth.actor_id,auth.created_at AS authorized_at,auth.revoked_at,auth.scope,n.body->>'deleted_at' AS deleted_at,
    b.body->>'account_id' AS binding_account,
    CASE WHEN pg_input_is_valid(b.body->>'valid_from','timestamp with time zone') AND (b.body->>'valid_to' IS NULL OR pg_input_is_valid(b.body->>'valid_to','timestamp with time zone'))
     THEN (b.body->>'valid_from')::timestamptz<=clock_timestamp() AND (b.body->>'valid_to' IS NULL OR (b.body->>'valid_to')::timestamptz>clock_timestamp()) ELSE false END AS binding_current,
    EXISTS(SELECT 1 FROM continuous_authorizations c WHERE c.workspace_id=a.workspace_id AND c.environment=a.environment AND c.assignment_id=a.id
     AND c.state->'source'->>'assignmentRevision'=a.revision::text) AS adopted
   FROM commercial_assignments a
   JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
   JOIN records n ON n.id=a.account_id AND n.workspace_id=a.workspace_id AND n.environment=a.environment AND n.kind='channel_account'
   LEFT JOIN operation_authorizations auth ON auth.id=a.authorization_id AND auth.workspace_id=a.workspace_id AND auth.environment=a.environment
   WHERE a.workspace_id=$1 AND a.environment='REAL' AND a.authorization_id IS NOT NULL ORDER BY a.created_at,a.id`,[profile.id])).rows;
  if(!rows.length)continue;
  plan.profiles.push(profile.id);
  for(const row of rows){
   const scope=row.scope??{},reason=profile.state!=='ACTIVE'?'PROFILE_NOT_ACTIVE'
    :row.state!=='ACTIVE'?'ASSIGNMENT_NOT_ACTIVE'
    :row.deleted_at?'NUMBER_DELETED'
    :!row.actor_id?'AUTHORIZATION_MISSING'
    :row.revoked_at?'AUTHORIZATION_REVOKED'
    :row.binding_account!==row.account_id?'BINDING_ACCOUNT_CHANGED'
    :row.binding_current!==true?'BINDING_NOT_CURRENT'
    :scope.mode!=='product_assignment'||scope.assignment_id!==row.id||Number(scope.assignment_revision)!==Number(row.revision)||scope.binding_id!==row.binding_id||scope.product_id!==row.product_id?'AUTHORIZATION_SCOPE_CHANGED'
    :null;
   if(row.adopted){plan.already_adopted++;continue;}
   if(reason){plan.excluded.push({workspaceId:profile.id,assignmentId:row.id,reason});continue;}
   plan.candidates.push({workspaceId:profile.id,assignmentId:row.id,assignmentRevision:Number(row.revision),bindingId:row.binding_id,accountId:row.account_id,productId:row.product_id,
    authorizationId:row.authorization_id,authorizedBy:row.actor_id,authorizedAt:new Date(row.authorized_at).toISOString()});
  }
 }
 return plan;
}

/** Applies the reviewed plan: the caller passes the plan digest it reviewed;
 * a changed plan is refused rather than partially adopted. */
export async function applyContinuityAdoption(db:QueryExecutor,reviewed:string){
 const plan=await planContinuityAdoption(db);
 if(digest(plan)!==reviewed)throw new Error('ADOPTION_PLAN_CHANGED');
 const adopted:string[]=[];
 for(const candidate of plan.candidates){
  await bind(db,candidate.workspaceId);
  const source:ContinuousSource={kind:'COMMERCIAL_ASSIGNMENT',assignmentId:candidate.assignmentId,assignmentRevision:candidate.assignmentRevision,bindingId:candidate.bindingId};
  const sourceHash=commercialSourceHash(candidate.workspaceId,'REAL',candidate.accountId,source);
  const paused=(await db.query('SELECT continuous_human_pause($1,$2,$3,$4) AS paused',[candidate.workspaceId,'REAL',candidate.accountId,source])).rows[0]?.paused===true;
  const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const state=continuousAuthorizationSchema.parse({id:randomUUID(),workspaceId:candidate.workspaceId,environment:'REAL',accountId:candidate.accountId,source,
   createdBy:candidate.authorizedBy,createdAt:now.toISOString(),version:1,humanPaused:paused,revokedAt:null,protections:[]});
  const inserted=(await db.query(`INSERT INTO continuous_authorizations(id,workspace_id,environment,account_id,assignment_id,binding_id,source_hash,version,state)
   VALUES($1,$2,'REAL',$3,$4,$5,$6,1,$7) ON CONFLICT(workspace_id,environment,source_hash) DO NOTHING RETURNING id`,
   [state.id,candidate.workspaceId,candidate.accountId,candidate.assignmentId,candidate.bindingId,sourceHash,state])).rows[0];
  if(!inserted)continue;
  await db.query(`INSERT INTO continuous_authorization_events(workspace_id,environment,authorization_id,version,operation_id,event,state) VALUES($1,'REAL',$2,1,$3,$4,$5)`,
   [candidate.workspaceId,state.id,randomUUID(),{type:'CREATED',actorId:candidate.authorizedBy,source,at:state.createdAt,
    adoption:{kind:'V7_AUTHORIZED_ASSIGNMENT',operation_authorization_id:candidate.authorizationId,authorized_at:candidate.authorizedAt}},state]);
  adopted.push(state.id);
 }
 return{plan_sha256:reviewed,adopted:adopted.length,excluded:plan.excluded.length,already_adopted:plan.already_adopted,external_effects:0};
}
export const adoptionPlanDigest=(plan:AdoptionPlan)=>digest(plan);
