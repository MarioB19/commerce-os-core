import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {continuousAuthorizationSchema,continuousHumanCommandSchema,assertProtectionSchema,clearProtectionSchema,commercialContinuityIssueSchema,continuityListSchema,
 type ContinuousAuthorization,type ContinuousSource} from '../../contracts/src/continuous-authorization.js';
import {continuousHumanTransition,assertContinuousProtection,clearContinuousProtection,type ContinuityTransition} from '../../domain/src/sales/continuous-authorization.js';
import {authorizeProfileAction,type ProfileAuthority} from '../../domain/src/core/profile-authorization.js';

const uuid=z.uuid().transform(value=>value.toLowerCase()),environmentSchema=z.enum(['REAL','SIMULATION']);
type Environment=z.infer<typeof environmentSchema>;
const qrIssueSchema=z.object({operationId:uuid,connectionId:uuid,accountId:uuid,
 expectedSessionRevision:z.number().int().positive().max(Number.MAX_SAFE_INTEGER),identityFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export class ContinuousStoreError extends Error{
 constructor(readonly code:string,readonly statusCode=409){super(code);this.name='ContinuousStoreError';}
}
function need(value:unknown,code:string,status=409):asserts value{if(!value)throw new ContinuousStoreError(code,status);}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 const result=JSON.stringify(value);need(result!==undefined,'CONTINUITY_REQUEST_INVALID',400);return result;
}
function digest(value:unknown){return createHash('sha256').update(canonical(value)).digest('hex');}
function context(db:ProfileExecutor,environment:Environment){need(typeof db.workspaceId==='string'&&db.workspaceId.length>0,'CONTINUITY_PROFILE_CONTEXT_REQUIRED');environmentSchema.parse(environment);}
async function clock(db:ProfileExecutor){const now=(await db.query('SELECT clock_timestamp() AS now')).rows[0]?.now;
 need(now instanceof Date&&Number.isFinite(now.getTime()),'CONTINUITY_DATABASE_CLOCK_REQUIRED',503);return now;}
function state(row:unknown,db:ProfileExecutor,environment:Environment,id?:string){
 const value=continuousAuthorizationSchema.parse(row);
 need(value.workspaceId===db.workspaceId&&value.environment===environment&&(!id||value.id===id),'CONTINUITY_STORED_SCOPE_CHANGED');return value;
}
function action(authority:ProfileAuthority,db:ProfileExecutor,kind:ContinuousSource['kind'],mutation:boolean,now=new Date()){
 authorizeProfileAction(authority,{workspaceId:db.workspaceId,mutation,
  scope:kind==='COMMERCIAL_ASSIGNMENT'?(mutation?'assignments:write':'assignments:read'):(mutation?'warmup:write':'warmup:read')},now);
}
async function lockedState(db:ProfileExecutor,environment:Environment,id:string,lock=false){
 context(db,environment);id=uuid.parse(id);
 const row=(await db.query('SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2 AND id=$3'+(lock?' FOR UPDATE':''),[db.workspaceId,environment,id])).rows[0];
 need(row,'CONTINUITY_NOT_FOUND',404);return state(row.state,db,environment,id);
}
/** Durable operation result and event commit together. A transport retry must
 * reuse its original operationId; content or actor changes cannot adopt it.
 */
async function operation(db:ProfileExecutor,environment:Environment,actorKey:string,operationId:string,request:unknown,work:()=>Promise<ContinuousAuthorization>){
 context(db,environment);operationId=uuid.parse(operationId);
 const key=canonical(['continuous',db.workspaceId,environment,actorKey,operationId]);
 need((await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired',[key])).rows[0]?.acquired===true,'CONTINUITY_OPERATION_BUSY');
 const old=(await db.query('SELECT request_hash,result FROM continuous_authorization_operations WHERE workspace_id=$1 AND environment=$2 AND actor_key=$3 AND operation_id=$4',
  [db.workspaceId,environment,actorKey,operationId])).rows[0],requestHash=digest(request);
 if(old){need(old.request_hash===requestHash,'CONTINUITY_OPERATION_CONFLICT');return state(old.result,db,environment);}
 const result=await work();
 const saved=await db.query('INSERT INTO continuous_authorization_operations(workspace_id,environment,actor_key,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5,$6) RETURNING operation_id',
  [db.workspaceId,environment,actorKey,operationId,requestHash,result]);
 need(saved.rows.length===1&&saved.rows[0].operation_id===operationId,'CONTINUITY_OPERATION_UNCONFIRMED');return result;
}
async function event(db:ProfileExecutor,value:ContinuousAuthorization,operationId:string,detail:object){
 const saved=await db.query('INSERT INTO continuous_authorization_events(workspace_id,environment,authorization_id,version,operation_id,event,state) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING version',
  [db.workspaceId,value.environment,value.id,value.version,operationId,detail,value]);
 need(saved.rows.length===1&&Number(saved.rows[0].version)===value.version,'CONTINUITY_EVENT_UNCONFIRMED');
}
async function persist(db:ProfileExecutor,before:ContinuousAuthorization,transition:ContinuityTransition){
 if(!transition.event)return before;
 const next=transition.state;
 const row=(await db.query('UPDATE continuous_authorizations SET version=$4,state=$5 WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND version=$6 RETURNING state',
  [db.workspaceId,before.environment,before.id,next.version,next,before.version])).rows[0];
 need(row&&canonical(row.state)===canonical(next),'CONTINUITY_VERSION_OR_WRITE_CONFLICT');
 await event(db,next,transition.event.operationId,transition.event);return next;
}
async function lockHumanScope(db:ProfileExecutor,environment:Environment,accountId:string,source:ContinuousSource){
 try{await db.query('SELECT lock_continuous_human_scope($1,$2,$3,$4)',[db.workspaceId,environment,accountId,source]);}
 catch(error){if(error instanceof Error&&error.message==='CONTINUITY_SCOPE_BUSY')throw new ContinuousStoreError('CONTINUITY_SCOPE_BUSY');throw error;}
 const row=(await db.query('SELECT continuous_human_pause($1,$2,$3,$4) AS paused',[db.workspaceId,environment,accountId,source])).rows[0];
 need(typeof row?.paused==='boolean','CONTINUITY_HUMAN_STATE_REQUIRED',503);return row.paused as boolean;
}

export async function readContinuousAuthorization(db:ProfileExecutor,environment:Environment,id:string,kind:ContinuousSource['kind'],authority:ProfileAuthority){
 action(authority,db,kind,false);const value=await lockedState(db,environment,id);
 need(value.source.kind===kind,'CONTINUITY_NOT_FOUND',404);return value;
}
export async function listContinuousAuthorizations(db:ProfileExecutor,kind:ContinuousSource['kind'],input:unknown,authority:ProfileAuthority){
 action(authority,db,kind,false);const query=continuityListSchema.parse(input);context(db,query.environment);
 const rows=(await db.query(`SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2
  AND state->'source'->>'kind'=$3 AND ($4::uuid IS NULL OR account_id=$4) AND ($5::uuid IS NULL OR id>$5)
  ORDER BY id LIMIT $6`,[db.workspaceId,query.environment,kind,query.accountId??null,query.afterId??null,query.limit+1])).rows;
 const data=rows.slice(0,query.limit).map(row=>state(row.state,db,query.environment));
 need(data.every(row=>row.source.kind===kind),'CONTINUITY_STORED_SCOPE_CHANGED');
 return {data,nextAfterId:rows.length>query.limit?data.at(-1)!.id:null};
}
/** Read an uncertain human operation without replaying it. Only its originating
 * actor can read the immutable outcome, under current authority and source scope.
 */
export async function readContinuousHumanOperation(db:ProfileExecutor,environment:Environment,operationId:string,kind:ContinuousSource['kind'],authority:ProfileAuthority){
 action(authority,db,kind,false);context(db,environment);operationId=uuid.parse(operationId);
 const row=(await db.query(`SELECT result FROM continuous_authorization_operations
  WHERE workspace_id=$1 AND environment=$2 AND actor_key=$3 AND operation_id=$4`,[db.workspaceId,environment,'human:'+authority.membership.userId,operationId])).rows[0];
 if(!row)return null;const result=state(row.result,db,environment);
 need(result.source.kind===kind,'CONTINUITY_NOT_FOUND',404);return result;
}
export async function applyContinuousHumanCommand(db:ProfileExecutor,environment:Environment,id:string,kind:ContinuousSource['kind'],input:unknown,authority:ProfileAuthority){
 action(authority,db,kind,true);id=uuid.parse(id);const command=continuousHumanCommandSchema.parse(input);
 return operation(db,environment,'human:'+authority.membership.userId,command.operationId,{kind,id,command},async()=>{
  const observed=await lockedState(db,environment,id);need(observed.source.kind===kind,'CONTINUITY_NOT_FOUND',404);
  await lockHumanScope(db,environment,observed.accountId,observed.source);
  const rows=(await db.query(`SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2
   AND continuous_human_scope(account_id,state->'source')=continuous_human_scope($3,$4) ORDER BY id FOR UPDATE`,
   [db.workspaceId,environment,observed.accountId,observed.source])).rows.map(row=>state(row.state,db,environment));
  const before=rows.find(row=>row.id===id);need(before,'CONTINUITY_NOT_FOUND',404);const now=await clock(db);
  // Validate the requested resource/version first. One operation owns all
  // changes in its human scope, but revocation stays terminal and individual.
  const transition=continuousHumanTransition(before,command,authority,now);
  const result=await persist(db,before,transition);
  if(command.action!=='revoke')for(const other of rows){
   if(other.id===id||other.revokedAt)continue;
   await persist(db,other,continuousHumanTransition(other,{...command,expectedVersion:other.version},authority,now));
  }
  return result;
 });
}
/** Internal-only entry. PostgreSQL runtime role is read from the connection;
 * public routes cannot supply it or select a protection operation.
 */
export async function applyContinuousProtection(db:ProfileExecutor,environment:Environment,id:string,verb:'assert'|'clear',input:unknown){
 context(db,environment);id=uuid.parse(id);need(verb==='assert'||verb==='clear','CONTINUITY_PROTECTION_ACTION_INVALID',400);
 const command=verb==='assert'?assertProtectionSchema.parse(input):clearProtectionSchema.parse(input);
 const role=(await db.query('SELECT current_user AS role')).rows[0]?.role;
 need(role==='commerce_channel'||role==='commerce_automation','CONTINUITY_INTERNAL_ROLE_REQUIRED',403);
 return operation(db,environment,'worker:'+role,command.operationId,{verb,id,command},async()=>{
  const before=await lockedState(db,environment,id,true),now=await clock(db);
  const transition=verb==='assert'?assertContinuousProtection(before,assertProtectionSchema.parse(command),db.workspaceId,now):
   clearContinuousProtection(before,clearProtectionSchema.parse(command),db.workspaceId,now);
  return persist(db,before,transition);
 });
}
/** Explicit human assignment act, inside the F2 authority transaction. This
 * does not adopt historical expiring grants or activate an account/channel.
 */
export async function issueCommercialContinuity(db:ProfileExecutor,environment:Environment,input:unknown,authority:ProfileAuthority){
 action(authority,db,'COMMERCIAL_ASSIGNMENT',true);const command=commercialContinuityIssueSchema.parse(input);
 return operation(db,environment,'human:'+authority.membership.userId,command.operationId,{kind:'issue-commercial',command},async()=>{
  const row=(await db.query(`SELECT a.account_id,a.binding_id,a.revision,a.state,b.body
   FROM commercial_assignments a JOIN records b ON b.id=a.binding_id AND b.workspace_id=a.workspace_id AND b.environment=a.environment AND b.kind='binding'
   JOIN records n ON n.id=a.account_id AND n.workspace_id=a.workspace_id AND n.environment=a.environment AND n.kind='channel_account'
   WHERE a.workspace_id=$1 AND a.environment=$2 AND a.id=$3 FOR SHARE OF a,b,n`,[db.workspaceId,environment,command.assignmentId])).rows[0];
  need(row,'CONTINUITY_NOT_FOUND',404);need(row.revision===command.expectedRevision&&row.state==='ACTIVE'&&row.body.account_id===row.account_id,'CONTINUITY_ASSIGNMENT_CHANGED');
  const now=await clock(db);action(authority,db,'COMMERCIAL_ASSIGNMENT',true,now);
  const source:ContinuousSource={kind:'COMMERCIAL_ASSIGNMENT',assignmentId:command.assignmentId,assignmentRevision:row.revision,bindingId:row.binding_id};
  const humanPaused=await lockHumanScope(db,environment,row.account_id,source);
  const sourceHash=digest({workspaceId:db.workspaceId,environment,accountId:row.account_id,source});
  const prior=(await db.query('SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2 AND source_hash=$3 FOR UPDATE',[db.workspaceId,environment,sourceHash])).rows[0];
  if(prior)return state(prior.state,db,environment); // Never revive/rewrite this origin.
  const created=continuousAuthorizationSchema.parse({id:randomUUID(),workspaceId:db.workspaceId,environment,accountId:row.account_id,source,
   createdBy:authority.membership.userId,createdAt:now.toISOString(),version:1,humanPaused,revokedAt:null,protections:[]});
  const saved=(await db.query(`INSERT INTO continuous_authorizations(id,workspace_id,environment,account_id,assignment_id,binding_id,source_hash,version,state)
   VALUES($1,$2,$3,$4,$5,$6,$7,1,$8) RETURNING state`,[created.id,db.workspaceId,environment,created.accountId,source.assignmentId,source.bindingId,sourceHash,created])).rows[0];
  need(saved&&canonical(saved.state)===canonical(created),'CONTINUITY_ISSUE_UNCONFIRMED');
  await event(db,created,command.operationId,{type:'CREATED',actorId:authority.membership.userId,source,at:created.createdAt});return created;
 });
}

/** A channel worker calls this after committing the authenticated connect
 * command and observing its matching provider identity. No public input can
 * claim that a connection succeeded or select the creator of this grant.
 */
export async function issueVerifiedQrContinuity(db:ProfileExecutor,environment:Environment,input:unknown){
 context(db,environment);const command=qrIssueSchema.parse(input);
 const role=(await db.query('SELECT current_user AS role')).rows[0]?.role;
 need(role==='commerce_channel','CONTINUITY_INTERNAL_ROLE_REQUIRED',403);
 return operation(db,environment,'worker:'+role,command.operationId,{kind:'issue-qr',command},async()=>{
  const row=(await db.query(`SELECT c.actor_id,s.revision,s.expected_identity_fingerprint
   FROM commands c JOIN channel_sessions s ON s.workspace_id=c.workspace_id AND s.environment=c.environment AND s.account_id::text=c.resource_id
   JOIN records n ON n.id=s.account_id AND n.workspace_id=c.workspace_id AND n.environment=c.environment AND n.kind='channel_account'
   WHERE c.workspace_id=$1 AND c.environment=$2 AND c.id=$3 AND c.resource_id=$4
    AND c.kind='channel_command' AND c.payload->>'type'='connect' AND c.status='APPLIED'
    AND s.archived_at IS NULL AND s.observed_state='CONNECTED' AND s.auth_state='VERIFIED'
    AND s.health_expires_at>clock_timestamp() AND s.provider_observed_at>=c.created_at
   FOR SHARE OF c,s,n`,[db.workspaceId,environment,command.connectionId,command.accountId])).rows[0];
  need(row,'CONTINUITY_VERIFIED_CONNECTION_REQUIRED');
  need(row.revision===command.expectedSessionRevision&&row.expected_identity_fingerprint===command.identityFingerprint,'CONTINUITY_CONNECTION_CHANGED');
  const source:ContinuousSource={kind:'VERIFIED_QR_CONNECTION',connectionId:command.connectionId,identityFingerprint:row.expected_identity_fingerprint};
  const humanPaused=await lockHumanScope(db,environment,command.accountId,source);
  const sourceHash=digest({workspaceId:db.workspaceId,environment,accountId:command.accountId,source});
  const prior=(await db.query('SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND environment=$2 AND source_hash=$3 FOR UPDATE',[db.workspaceId,environment,sourceHash])).rows[0];
  if(prior)return state(prior.state,db,environment);
  const now=await clock(db),created=continuousAuthorizationSchema.parse({id:randomUUID(),workspaceId:db.workspaceId,environment,
   accountId:command.accountId,source,createdBy:row.actor_id,createdAt:now.toISOString(),version:1,humanPaused,revokedAt:null,protections:[]});
  const saved=(await db.query(`INSERT INTO continuous_authorizations(id,workspace_id,environment,account_id,qr_command_id,source_hash,version,state)
   VALUES($1,$2,$3,$4,$5,$6,1,$7) RETURNING state`,[created.id,db.workspaceId,environment,created.accountId,command.connectionId,sourceHash,created])).rows[0];
  need(saved&&canonical(saved.state)===canonical(created),'CONTINUITY_ISSUE_UNCONFIRMED');
  await event(db,created,command.operationId,{type:'CREATED',actorId:created.createdBy,source,at:created.createdAt});return created;
 });
}
