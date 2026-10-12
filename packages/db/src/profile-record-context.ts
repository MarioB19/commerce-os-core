import type {QueryExecutor} from './index.js';
import type {ProfileExecutor} from './profile-context.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';

/** Worker transactions that act on one explicit, already locked record bind
 * the profile context to that record's own workspace/environment (V7 F2).
 * Nothing is selected for convenience: the IDs come from the record itself.
 * An established, different context is never switched; the binding lasts
 * until the caller's transaction ends. Requires a transaction client. */
export async function bindRecordProfile(client:QueryExecutor,workspaceId:string,environment:'REAL'|'SIMULATION'):Promise<ProfileExecutor>{
 if(!profileIdSchema.safeParse(workspaceId).success||(environment!=='REAL'&&environment!=='SIMULATION'))throw Object.assign(new Error('RECORD_PROFILE_CONTEXT_INVALID'),{statusCode:500});
 const row=(await client.query(`SELECT
  CASE WHEN NULLIF(current_setting('app.workspace_id',true),'') IS NULL OR current_setting('app.workspace_id',true)=$1 THEN pg_catalog.set_config('app.workspace_id',$1,true) END AS workspace,
  CASE WHEN NULLIF(current_setting('app.environment',true),'') IS NULL OR current_setting('app.environment',true)=$2 THEN pg_catalog.set_config('app.environment',$2,true) END AS environment`,[workspaceId,environment])).rows[0];
 if(row?.workspace!==workspaceId||row?.environment!==environment)throw Object.assign(new Error('RECORD_PROFILE_CONTEXT_MISMATCH'),{statusCode:500});
 return Object.freeze({workspaceId,query:client.query.bind(client) as ProfileExecutor['query']});
}
