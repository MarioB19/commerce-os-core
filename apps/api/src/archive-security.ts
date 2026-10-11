import type {FastifyRequest} from 'fastify';
import {pool} from '../../../packages/db/src/index.js';
import {assertPermission,permissionsFor} from '../../../packages/domain/src/core/permissions.js';
import {principal,envOf,fail} from './context.js';
import {creativePermission} from './creative-security.js';
/** Neutral asset readers and legacy archive readers retain actor membership and intersect both resource fences. */
export async function archivePermission(req:FastifyRequest){
 const p=principal(req),legacy=p.service&&!p.scopes.includes('assets:read');
 if(legacy)await creativePermission(req,'studio:read');else assertPermission(p,p.service?'assets:read':'catalog:read');
 const membership=(await pool.query('SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2 AND active=true',[p.workspace_id,p.user.id])).rows[0];
 if(!membership)throw fail(403,'NO_MEMBERSHIP');
 if(!legacy)assertPermission({...p,service:false,role:membership.role,permissions:permissionsFor(membership.role)},'catalog:read');
 const grant=membership.role==='owner'?null:(await pool.query('SELECT project_ids FROM creative_members WHERE workspace_id=$1 AND user_id=$2',[p.workspace_id,p.user.id])).rows[0];
 return{projects:grant?.project_ids??null,resources:p.resource_ids??null};
}
export async function archivedProject(req:FastifyRequest,id:string){const visible=await archivePermission(req),p=principal(req),row=(await pool.query('SELECT * FROM creative_projects WHERE id=$1 AND workspace_id=$2 AND environment=$3',[id,p.workspace_id,envOf(req)])).rows[0];if(!row||visible.projects&&!visible.projects.includes(row.id)||visible.resources&&!visible.resources.includes(row.id)&&!visible.resources.includes(row.product_id))throw fail(404,'NOT_FOUND');return row;}
