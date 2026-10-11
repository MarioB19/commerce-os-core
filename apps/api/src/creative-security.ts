import type {FastifyRequest} from 'fastify';
import type {QueryExecutor} from '../../../packages/db/src/index.js';
import {pool} from '../../../packages/db/src/index.js';
import {principal,fail,envOf} from './context.js';
export const CREATIVE_SCOPES=['intelligence:read','intelligence:write','intelligence:refresh','intelligence:analyze','studio:read','studio:admin'] as const;
export async function creativePermission(req:FastifyRequest,scope:string,projectId?:string,db:QueryExecutor=pool){
 const p=principal(req);
 if(p.service){
  if(!p.scopes.includes(scope))throw fail(403,'CREATIVE_SCOPE_REQUIRED',`Falta permiso ${scope}.`);
  if(projectId&&p.resource_ids&&!p.resource_ids.includes(projectId))throw fail(404,'NOT_FOUND');
  // Human MCP tokens are bounded by both issuance and the actor's current membership.
  const membership=(await db.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND active=true',[p.workspace_id,p.user.id])).rows[0];
  if(!membership)throw fail(403,'NO_MEMBERSHIP');
  if(membership.role==='owner')return;
  const grant=(await db.query('SELECT scopes,project_ids FROM creative_members WHERE workspace_id=$1 AND user_id=$2',[p.workspace_id,p.user.id])).rows[0];
  if(!grant?.scopes.includes(scope))throw fail(403,'CREATIVE_SCOPE_REQUIRED',`Falta permiso ${scope}.`);
  if(projectId&&grant.project_ids&&!grant.project_ids.includes(projectId))throw fail(404,'NOT_FOUND');
  return;
 }
 if(p.role==='owner')return;
 const member=(await db.query('SELECT scopes,project_ids FROM creative_members WHERE workspace_id=$1 AND user_id=$2',[p.workspace_id,p.user.id])).rows[0];
 if(!member?.scopes.includes(scope))throw fail(403,'CREATIVE_SCOPE_REQUIRED',`Falta permiso ${scope}.`);
 if(projectId&&member.project_ids&&!member.project_ids.includes(projectId))throw fail(404,'NOT_FOUND');
}
export function expectedVersion(body:Record<string,any>){const v=body.expected_version??body.expectedVersion;if(!Number.isInteger(v)||v<0)throw fail(400,'EXPECTED_VERSION_REQUIRED','Incluye la versión que estás editando.');return Number(v);}
export async function creativeProject(req:FastifyRequest,id:string,scope='studio:read',db:QueryExecutor=pool){await creativePermission(req,scope,id,db);const r=(await db.query('SELECT * FROM creative_projects WHERE id=$1 AND workspace_id=$2 AND environment=$3',[id,principal(req).workspace_id,envOf(req)])).rows[0];if(!r)throw fail(404,'NOT_FOUND');return r;}
export const creativeScope=(req:FastifyRequest)=>({workspaceId:principal(req).workspace_id,environment:envOf(req),actorId:principal(req).user.id});
