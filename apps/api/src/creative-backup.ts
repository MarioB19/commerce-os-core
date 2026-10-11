import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {pool,hash,stableJson} from '../../../packages/db/src/index.js';
import {archivedProject} from './archive-security.js';
import {principal,envOf,fail} from './context.js';
function clean(value:any):any{if(Array.isArray(value))return value.map(clean);if(value&&typeof value==='object'){return Object.fromEntries(Object.entries(value).filter(([key])=>!/secret|token|ciphertext|password|api.?key|storage.?key|signed.?url|local.?path/i.test(key)).map(([key,v])=>[key,clean(v)]));}if(typeof value==='string'&&/https?:\/\/\S*[?&](?:x-amz-|signature|token=)/i.test(value))return '[OMITTED_TEMPORARY_URL]';return value;}
/** Library files are immutable by SHA; mutable metadata is explicitly a paginated view, not a PostgreSQL snapshot. */
export async function creativeBackupRoutes(app:FastifyInstance){app.get('/v1/archive/production/projects/:id/backup',async req=>{
 const id=z.string().uuid().parse((req.params as any).id);await archivedProject(req,id);
 const query=z.object({cursor:z.string().regex(/^[0-9]:[a-f0-9-]{36}$/).optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);
 const rows=(await pool.query(`WITH entries AS (
 SELECT '0:'||p.id AS key,'project' AS kind,to_jsonb(p) AS value FROM creative_projects p WHERE p.workspace_id=$1 AND p.environment=$2 AND p.id=$3
 UNION ALL SELECT '1:'||a.id,'asset',to_jsonb(a)-ARRAY['storage_key','verification'] FROM creative_assets a WHERE a.workspace_id=$1 AND a.environment=$2 AND a.project_id=$3
 UNION ALL SELECT '2:'||r.id,'recipe',to_jsonb(r) FROM creative_recipes r WHERE r.workspace_id=$1 AND r.environment=$2 AND r.project_id=$3
 UNION ALL SELECT '3:'||v.id,'recipe_version',to_jsonb(v) FROM creative_recipe_versions v JOIN creative_recipes r ON r.id=v.recipe_id WHERE v.workspace_id=$1 AND v.environment=$2 AND r.project_id=$3
 UNION ALL SELECT '4:'||v.id,'conformity',to_jsonb(v) FROM creative_conformities v JOIN creative_recipes r ON r.id=v.recipe_id WHERE v.workspace_id=$1 AND v.environment=$2 AND r.project_id=$3
 UNION ALL SELECT '5:'||j.id,'job',to_jsonb(j)-ARRAY['active_attempt_id'] FROM creative_jobs j WHERE j.workspace_id=$1 AND j.environment=$2 AND j.project_id=$3
 UNION ALL SELECT '6:'||a.id,'artifact',to_jsonb(a) FROM creative_artifacts a WHERE a.workspace_id=$1 AND a.environment=$2 AND a.project_id=$3
 UNION ALL SELECT '7:'||v.id,'review',to_jsonb(v) FROM creative_reviews v JOIN creative_artifacts a ON a.id=v.artifact_id WHERE a.workspace_id=$1 AND a.environment=$2 AND a.project_id=$3
 ) SELECT * FROM entries WHERE key>$4 ORDER BY key LIMIT $5`,[principal(req).workspace_id,envOf(req),id,query.cursor??'',query.limit+1])).rows;
 const page:typeof rows=[],records:any[]=[];let bytes=0;for(const row of rows.slice(0,query.limit)){const record={kind:row.kind,value:clean(row.value)},size=Buffer.byteLength(JSON.stringify(record));if(bytes+size>4*1024**2){if(!page.length)throw fail(413,'BACKUP_METADATA_RECORD_TOO_LARGE');break;}bytes+=size;page.push(row);records.push(record);}const hasMore=rows.length>page.length;
 return{data:{schema_version:1,project_id:id,environment:envOf(req),consistency:'PAGINATED_METADATA_IMMUTABLE_ASSET_HASHES',records,sha256:hash(stableJson(records)),next_cursor:hasMore?page.at(-1)!.key:null,restore_policy:'LOCAL_ARCHIVE_ONLY_REVIEW_REQUIRED_NO_REPLAY'}};
});}
