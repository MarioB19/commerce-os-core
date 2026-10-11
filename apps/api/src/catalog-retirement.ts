import type {FastifyRequest} from 'fastify';
import {pool,hash,stableJson,type QueryExecutor} from '../../../packages/db/src/index.js';
import type {Body,DomainRecord} from '../../../packages/contracts/src/index.js';
import {principal,resourcePermitted,fail,audit,command} from './context.js';
/** References are enumerated separately from historical usage; nothing is cascaded. */
export async function retirementDependencies(req:FastifyRequest,row:DomainRecord,c:QueryExecutor=pool){
 const key=row.kind==='workflow'?'workflow_version_id':'agent_version_id';
 const references=(await c.query(`SELECT id,kind,version,body FROM records WHERE workspace_id=$1 AND environment=$2 AND id::text<>$3 AND (body->>$4=$3 OR body->>'workflow_template_version_id'=$3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(body->'nodes','[]'::jsonb)) node WHERE node->'config'->>$4=$3)) ORDER BY kind,id`,[row.workspace_id,row.environment,row.id,key])).rows;
 const assignments=(await c.query(`SELECT a.id,a.revision,a.state,a.product_id,a.authorization_id FROM commercial_assignments a JOIN records b ON b.id=a.binding_id WHERE a.workspace_id=$1 AND a.environment=$2 AND b.body->>$3=$4 ORDER BY a.id`,[row.workspace_id,row.environment,key,row.id])).rows;
 const journeys=references.filter(r=>r.kind==='conversation');const journeyIds=journeys.map(r=>r.id);
 const effects=(await c.query(`SELECT id,status,attempts,conversation_id,payload->>'kind' message_kind,payload->>'fulfillment_id' fulfillment_id FROM outbox WHERE workspace_id=$1 AND environment=$2 AND (conversation_id=ANY($3::text[]) OR payload->>$4=$5) AND status IN('READY','BLOCKED','SENDING','UNKNOWN') ORDER BY id`,[row.workspace_id,row.environment,journeyIds,key,row.id])).rows;
 const timers=(await c.query("SELECT id,status,conversation_id FROM timers WHERE workspace_id=$1 AND environment=$2 AND conversation_id=ANY($3::text[]) AND status='PENDING' ORDER BY id",[row.workspace_id,row.environment,journeyIds])).rows;
 const jobs=(await c.query("SELECT id,kind,status FROM commands WHERE workspace_id=$1 AND environment=$2 AND status='PENDING' AND (resource_id=ANY($3::text[]) OR payload->>$4=$5) ORDER BY id",[row.workspace_id,row.environment,journeyIds,key,row.id])).rows;
 const authorizations=(await c.query("SELECT id,expires_at FROM operation_authorizations WHERE workspace_id=$1 AND environment=$2 AND revoked_at IS NULL AND expires_at>now() AND (scope->>'agent_version_id'=$3 OR scope->'workflow_version_ids' ? $3) ORDER BY id",[row.workspace_id,row.environment,row.id])).rows;
 const configuration=references.filter(r=>['product','offer','workflow','agent'].includes(r.kind)&&!r.body.archived_at&&r.body.status!=='ARCHIVED');
 const activeAssignments=assignments.filter(a=>a.state==='ACTIVE');
 if(principal(req).service&&principal(req).resource_ids&&references.some(r=>!resourcePermitted(principal(req),r.id)))throw fail(403,'DEPENDENCY_SCOPE_REQUIRED','La credencial necesita acceso a las referencias para revisar este retiro.');
 const visible=(items:Body[]):Body[]=>items.map(({body,...r})=>({...r,name:body?.name??null,visible:resourcePermitted(principal(req),r.id)}));
 const snapshot={revision:row.version,references:visible(references),assignments,effects,timers,jobs,authorizations};
 return{...snapshot,dependency_hash:hash(stableJson(snapshot)),blocked:configuration.length>0||activeAssignments.length>0,blockers:[...configuration.map(r=>({kind:r.kind,id:r.id,reason:'CONFIGURATION_REFERENCES_RESOURCE'})),...activeAssignments.map(a=>({kind:'assignment',id:a.id,reason:'ACTIVE_ASSIGNMENT_REQUIRES_RETIRE_OR_REPLACE'}))],requires_handoff:journeys.some(j=>j.body.status==='OPEN')||effects.length>0||timers.length>0,policy:'Retire or replace active configuration references first. Explicit handoff stops unattempted messages and timers; delivery and UNKNOWN remain recorded. Restore never resumes them.'};
}
export async function prepareRetirement(req:FastifyRequest,c:QueryExecutor,row:DomainRecord,input:{dependency_hash?:string;existing_policy?:string}){
 const deps=await retirementDependencies(req,row,c);
 if(input.dependency_hash&&deps.dependency_hash!==input.dependency_hash)throw fail(409,'DEPENDENCIES_CHANGED','Las dependencias cambiaron. Actualiza la revisión.',deps);
 if(deps.blocked)throw fail(409,'RESOURCE_IN_USE','Retira el vínculo o reemplaza las referencias antes de eliminar.',deps);
 if(deps.requires_handoff&&(!input.dependency_hash||input.existing_policy!=='handoff'))throw fail(409,'RETIREMENT_HANDOFF_REQUIRED','Revisa dependencias y confirma cierre con atención humana.',deps);
 const ids=deps.references.filter(r=>r.kind==='conversation').map(r=>r.id);
 await c.query(`UPDATE outbox SET status='CANCELLED',result=result||'{"reason":"CONFIGURATION_RETIRED","superseded_before_send":true}'::jsonb,updated_at=now() WHERE workspace_id=$1 AND environment=$2 AND conversation_id=ANY($3::text[]) AND status IN('READY','BLOCKED') AND attempts=0 AND NOT payload ? 'fulfillment_id' AND payload->>'kind' IS DISTINCT FROM 'grant'`,[row.workspace_id,row.environment,ids]);
 await c.query("UPDATE timers SET status='CANCELLED' WHERE workspace_id=$1 AND environment=$2 AND conversation_id=ANY($3::text[]) AND status='PENDING'",[row.workspace_id,row.environment,ids]);
 for(const conversationId of ids)await command(c,req,'conversation_command',conversationId,{type:'retirement_handoff',retirement_resource_id:row.id,reason:'CONFIGURATION_RETIRED'},row.environment);
 if(deps.authorizations.length)await c.query('UPDATE operation_authorizations SET revoked_at=now() WHERE id=ANY($1::uuid[])',[deps.authorizations.map(a=>a.id)]);
 await audit(c,req,'catalog.retirement_prepared',row.id,{dependency_hash:deps.dependency_hash,policy:'handoff',unknown_and_delivery_preserved:true});
}
