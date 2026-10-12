import type {ProfileExecutor} from './profile-context.js';
import {resultOptionQuerySchema} from '../../contracts/src/results.js';
const sources={
 family:"SELECT id::text,body->>'name' label FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='product' AND NOT(body?'deleted_at')",
 variant:"SELECT id::text,(draft->'locale'->>'market')||' · '||(draft->'locale'->>'language')||' · '||(draft->'locale'->>'currency') label FROM market_variants WHERE workspace_id=$1 AND environment='REAL' AND ($5::text IS NULL OR family_id::text=$5)",
 market:"SELECT DISTINCT draft->'locale'->>'market' id,draft->'locale'->>'market' label FROM market_variants WHERE workspace_id=$1 AND environment='REAL'",
 account:"SELECT id::text,COALESCE(body->>'alias',body->>'name','Número') label FROM records WHERE workspace_id=$1 AND environment='REAL' AND kind='channel_account' AND NOT(body?'deleted_at')",
 campaign:"SELECT campaign_id id,min(campaign_name) label FROM meta_ad_metadata WHERE workspace_id=$1 AND environment='REAL' GROUP BY campaign_id",
 ad:"SELECT ad_id id,min(ad_name) label FROM meta_ad_metadata WHERE workspace_id=$1 AND environment='REAL' GROUP BY ad_id",
};
export async function resultOptions(db:ProfileExecutor,input:unknown){
 const q=resultOptionQuerySchema.parse(input),native=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) AS workspace")).rows[0];if(native?.role!=='commerce_api'||native.workspace!==db.workspaceId)throw Error('RESULT_PROFILE_CONTEXT_REQUIRED');
 const source=sources[q.kind],query=source.includes('$5')?source:source+' AND ($5::text IS NULL OR $5::text IS NOT NULL)';
 // Campaign/ad grouped sources cannot append a WHERE clause after GROUP BY.
 const sql=q.kind==='campaign'||q.kind==='ad'?source.replace(' GROUP BY',' AND ($5::text IS NULL OR $5::text IS NOT NULL) GROUP BY'):query;
 const rows=(await db.query(`WITH choices AS(${sql}) SELECT id,label FROM choices WHERE id IS NOT NULL AND label IS NOT NULL AND ($2::text IS NULL OR id>$2) AND ($3::text IS NULL OR label ILIKE '%'||$3||'%') ORDER BY id LIMIT $4`,[db.workspaceId,q.after??null,q.search??null,q.limit+1,q.family_id??null])).rows;
 return{workspace_id:db.workspaceId,kind:q.kind,data:rows.slice(0,q.limit).map(r=>({id:r.id as string,label:r.label as string})),next:rows.length>q.limit?rows[q.limit-1]!.id as string:null};
}
