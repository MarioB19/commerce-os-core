import {profileRoutedPool,currentProfileExecutor,profileQueryClient,joinProfileQueryWork} from './profile-query-routing.js';
import {createProfileWorkerRuntime,currentWorkerProfile,withWorkerProfilePhase} from './profile-worker-scope.js';
import pg from 'pg';
import {drizzle} from 'drizzle-orm/node-postgres';
import {createCipheriv,createDecipheriv,randomBytes,randomUUID,createHash} from 'node:crypto';
import type {DomainRecord,Environment,Body} from '../../contracts/src/index.js';
import * as schema from './schema.js';
import type {ProfileQuery} from './profile-context.js';
export type QueryExecutor={query:ProfileQuery};
const nativePool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||5),idleTimeoutMillis:10000,connectionTimeoutMillis:5000});
// V7: production logins (commerce_<service>_login, members of their group)
// assume the reviewed group role so row policies and SQL guards that check
// current_user see commerce_api/commerce_channel/..., never the login name.
// Queued on the new connection before any caller query; other users no-op.
const assumeRuntimeRole=`DO $$DECLARE target text; BEGIN
 IF session_user::text ~ '^commerce_(api|ingress|automation|channel|maintenance)_login$' AND current_user=session_user THEN
  target:=regexp_replace(session_user::text,'_login$','');
  IF pg_has_role(session_user,target,'MEMBER') THEN EXECUTE format('SET ROLE %I',target); END IF;
 END IF;
END$$`;
const runtimeLogin=(()=>{try{return /^commerce_(api|ingress|automation|channel|maintenance)_login$/.test(decodeURIComponent(new URL(process.env.DATABASE_URL??'').username));}catch{return false;}})();
if(runtimeLogin)nativePool.on('connect',client=>{client.query(assumeRuntimeRole).catch(()=>{process.stderr.write('database_runtime_role_not_assumed\n');});});
export const pool=profileRoutedPool(nativePool);
export const createDatabaseWorkerRuntime=(role:'commerce_automation'|'commerce_channel',environment:Environment)=>createProfileWorkerRuntime(nativePool,role,environment);
// pg removes failed idle clients. Keep services alive so readiness and later queries can recover.
// Never log the client or error object: connection details and query text can contain private data.
pool.on('error',()=>{process.stderr.write('database_idle_connection_failed; reconnecting on next query\n');});
export const db=drizzle(pool,{schema});
export const uuid=()=>randomUUID();
export const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
export async function query<T extends pg.QueryResultRow=any>(sql:string,values:any[]=[]):Promise<pg.QueryResult<T>>{return pool.query<T>(sql,values);}
export async function withTransaction<T>(fn:(client:pg.PoolClient)=>Promise<T>):Promise<T>{const scoped=currentProfileExecutor();if(scoped)return joinProfileQueryWork(scoped,()=>fn(profileQueryClient(scoped) as unknown as pg.PoolClient));if(currentWorkerProfile())return withWorkerProfilePhase(db=>fn(profileQueryClient(db) as unknown as pg.PoolClient));const c=await pool.connect();try{await c.query('BEGIN');const result=await fn(c);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
export async function getRecord(client:QueryExecutor,workspace:string,kind:string,id:string):Promise<DomainRecord|undefined>{if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))return undefined;return(await client.query('SELECT * FROM records WHERE workspace_id=$1 AND kind=$2 AND id=$3',[workspace,kind,id])).rows[0];}
export async function listRecords(client:QueryExecutor,workspace:string,kind:string,environment?:Environment):Promise<DomainRecord[]>{return(await client.query(`SELECT * FROM records WHERE workspace_id=$1 AND kind=$2 AND ($3::text IS NULL OR environment=$3) AND (kind<>'channel_account' OR NOT (body ? 'deleted_at')) ORDER BY created_at DESC`,[workspace,kind,environment??null])).rows;}
export async function putRecord(client:QueryExecutor,input:{id?:string;workspaceId:string;environment:Environment;kind:string;body:Body;version?:number}):Promise<DomainRecord>{if(input.id&&input.version!==undefined){const r=await client.query('UPDATE records SET body=$1,version=version+1,updated_at=now() WHERE id=$2 AND workspace_id=$3 AND kind=$4 AND environment=$5 AND version=$6 RETURNING *',[input.body,input.id,input.workspaceId,input.kind,input.environment,input.version]);if(!r.rows[0])throw Object.assign(new Error('VERSION_CONFLICT'),{statusCode:409});return r.rows[0];}return(await client.query('INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,$3,$4,$5) RETURNING *',[input.id??uuid(),input.workspaceId,input.environment,input.kind,input.body])).rows[0];}
export async function appendEvent(client:QueryExecutor,input:{id?:string;workspace_id:string;environment:Environment;event_type:string;aggregate_id:string;correlation_id?:string;causation_id?:string;actor?:Body;payload?:Body;occurred_at?:string|Date}):Promise<any>{return(await client.query('INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,causation_id,actor,payload,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10,now())) RETURNING *',[input.id??uuid(),input.workspace_id,input.environment,input.event_type,input.aggregate_id,input.correlation_id??uuid(),input.causation_id??null,input.actor??{},input.payload??{},input.occurred_at??null])).rows[0];}
function encryptionKey():Buffer{const s=process.env.PRIVATE_DATA_KEY??process.env.DATA_ENCRYPTION_KEY??process.env.ENCRYPTION_KEY;if(!s)throw new Error('PRIVATE_DATA_KEY_REQUIRED');const key=Buffer.from(s,/^[a-f0-9]{64}$/i.test(s)?'hex':'base64');if(key.length!==32)throw new Error('PRIVATE_DATA_KEY_MUST_BE_32_BYTES');return key;}
export function encrypt(value:string|object):string{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',encryptionKey(),iv);const ciphertext=Buffer.concat([c.update(typeof value==='string'?value:JSON.stringify(value),'utf8'),c.final()]);return ['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),ciphertext.toString('base64')].join('.');}
export function decrypt(value:string):string{const[v,iv,tag,data]=value.split('.');if(v!=='v1'||!iv||!tag||!data)throw new Error('INVALID_CIPHERTEXT');const c=createDecipheriv('aes-256-gcm',encryptionKey(),Buffer.from(iv,'base64'));c.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([c.update(Buffer.from(data,'base64')),c.final()]).toString('utf8');}
export function stableJson(value: unknown): string {
  // Match PostgreSQL JSONB/JSON transport semantics before hashing optional fields.
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('JSON_VALUE_REQUIRED');
  const sort = (item: any): string => {
    if (item === null || typeof item !== 'object') return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(sort).join(',') + ']';
    return '{' + Object.keys(item).sort().map(key => JSON.stringify(key) + ':' + sort(item[key])).join(',') + '}';
  };
  return sort(JSON.parse(encoded));
}
export * from './schema.js';

export * from './operational-settings.js';

export * from './integration-settings.js';
export * from './commercial-remarketing.js';
export * from './number-operational-state.js';
export * from './effective-health.js';
