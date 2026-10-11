import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool} from '../../../packages/db/src/index.js';
import {principal,envOf,fail} from './context.js';
import {creativeScope} from './creative-security.js';
import {archivePermission,archivedProject} from './archive-security.js';
import {assetAccess} from './creative-storage.js';
/** Archive endpoints keep immutable assets/history reachable, with no renderer, job claims or production mutations. */
export async function productionArchiveRoutes(app:FastifyInstance){
 app.all('/creative-device/*',async()=>{throw fail(410,'PLATFORM_PRODUCTION_RETIRED');});
 app.all('/v1/studio/*',async()=>{throw fail(410,'PLATFORM_PRODUCTION_RETIRED','La producción permanece en Codex. Consulta el archivo de materiales.');});
 app.get('/v1/archive/production/projects',async req=>{const visible=await archivePermission(req),p=principal(req);const q=z.object({product_id:z.uuid().optional(),cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);const rows=(await pool.query('SELECT id,title,product_id,offer_id,created_at,updated_at FROM creative_projects WHERE workspace_id=$1 AND environment=$2 AND ($3::uuid IS NULL OR product_id=$3) AND ($4::uuid IS NULL OR id>$4) AND ($5::text[] IS NULL OR id::text=ANY($5)) AND ($6::text[] IS NULL OR id::text=ANY($6) OR product_id::text=ANY($6)) ORDER BY id LIMIT $7',[p.workspace_id,envOf(req),q.product_id??null,q.cursor??null,visible.projects,visible.resources,q.limit+1])).rows;const page=rows.slice(0,q.limit);return{data:page,meta:{archive_only:true,next_cursor:rows.length>q.limit?page.at(-1)!.id:null}};});
 app.get('/v1/archive/production/assets',async req=>{const q=z.object({project_id:z.uuid(),cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);await archivedProject(req,q.project_id);const rows=(await pool.query('SELECT id,project_id,name,size_bytes,sha256,content_type,purpose,rights,status,version,created_at FROM creative_assets WHERE workspace_id=$1 AND environment=$2 AND project_id=$3 AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5',[principal(req).workspace_id,envOf(req),q.project_id,q.cursor??null,q.limit+1])).rows;const page=rows.slice(0,q.limit);return{data:page,meta:{archive_only:true,next_cursor:rows.length>q.limit?page.at(-1)!.id:null}};});
 app.get('/v1/archive/production/assets/:id/access',async req=>{const id=z.uuid().parse((req.params as any).id),row=(await pool.query('SELECT project_id FROM creative_assets WHERE id=$1 AND workspace_id=$2 AND environment=$3',[id,principal(req).workspace_id,envOf(req)])).rows[0];if(!row)throw fail(404,'NOT_FOUND');await archivedProject(req,row.project_id);return{data:await assetAccess(creativeScope(req),id,(req.query as any).disposition)};});
}
