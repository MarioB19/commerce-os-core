import type {ProfileExecutor} from './profile-context.js';
import {currentProfileExecutor} from './profile-query-routing.js';

/** Bind SQL visibility inside an already authorized profile transaction. This
 * grants no session/token authority and cannot switch an established context. */
export async function bindProfileEnvironment(db:ProfileExecutor,environment:'REAL'|'SIMULATION'):Promise<void>{
 if(environment!=='REAL'&&environment!=='SIMULATION')throw Error('PROFILE_ENVIRONMENT_INVALID');
 const result=await db.query(`SELECT CASE
  WHEN NULLIF(current_setting('app.workspace_id',true),'')=$1
   AND (NULLIF(current_setting('app.environment',true),'') IS NULL
    OR current_setting('app.environment',true)=$2)
  THEN pg_catalog.set_config('app.environment',$2,true)
  ELSE NULL END AS environment`,[db.workspaceId,environment]);
 if(result.rows.length!==1||result.rows[0]?.environment!==environment)throw Error('PROFILE_ENVIRONMENT_CONTEXT_MISMATCH');
}

/** Binds the environment of the explicit record a worker or gate processes,
 * inside the profile transaction that already owns it: the executor itself
 * when it is a profile executor, otherwise the routed profile scope. A
 * historical global worker without any profile context is left unchanged; a
 * foreign scope fails closed. */
export async function bindRecordEnvironment(c:unknown,workspaceId:string,environment:unknown):Promise<void>{
 const own=c as Partial<ProfileExecutor>|null;
 const scoped=own&&typeof own.workspaceId==='string'&&typeof own.query==='function'?own as ProfileExecutor:currentProfileExecutor(workspaceId);
 if(!scoped)return;
 if(scoped.workspaceId!==workspaceId)throw Error('PROFILE_QUERY_CONTEXT_MISMATCH');
 await bindProfileEnvironment(scoped,environment as 'REAL'|'SIMULATION');
}
