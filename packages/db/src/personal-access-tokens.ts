import {randomBytes,randomUUID} from 'node:crypto';
import {hash,type QueryExecutor} from './index.js';

export const newPersonalToken=()=> 'cos_pat_'+randomBytes(32).toString('base64url');
export type PersonalTokenInput={workspace_id:string;user_id:string;name:string;allowed_environments:string[];expires_at:string};
export async function insertPersonalToken(c:QueryExecutor,input:PersonalTokenInput,token=newPersonalToken(),id:string=randomUUID()) {
 const row=(await c.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,allowed_environments,expires_at,revoked_at,version,created_at`,
 [id,input.workspace_id,input.user_id,input.name,hash(token),JSON.stringify(input.allowed_environments),input.expires_at])).rows[0];
 return {...row,token};
}

/** A PAT delegates a real user's current role; it never upgrades a service token. */
export async function readPersonalToken(c:QueryExecutor,token:string) {
 return (await c.query(`SELECT t.id,t.workspace_id,t.user_id,t.allowed_environments,t.expires_at,u.name,u.email,m.role
 FROM personal_access_tokens t JOIN "user" u ON u.id=t.user_id
 JOIN memberships m ON m.user_id=t.user_id AND m.workspace_id=t.workspace_id
 WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() AND m.active=true AND m.role='owner'`,[hash(token)])).rows[0];
}

export async function lockPersonalAuthority(c:QueryExecutor,id:string,workspaceId:string,userId:string) {
 return (await c.query(`SELECT t.id FROM personal_access_tokens t JOIN memberships m ON m.user_id=t.user_id AND m.workspace_id=t.workspace_id
 WHERE t.id=$1 AND t.workspace_id=$2 AND t.user_id=$3 AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp()
 AND m.active=true AND m.role='owner' FOR SHARE OF t,m`,[id,workspaceId,userId])).rows[0];
}
