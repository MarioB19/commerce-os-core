import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {ProfileCatalog} from './profile-inventory.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import {verifyPrivacySelectionAuthority} from './privacy-selection-authority.js';
const own=new Set(['public.privacy_reference_epoch','public.privacy_reference_leases']);
const quote=(s:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(s))throw Error('PRIVACY_REFERENCE_IDENTIFIER');return '"'+s+'"';};
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
/** Additive all-table I/U/D guard from the exact metadata catalog. Includes
 * profiles, identities, SIMULATION and registered private schemas; no inferred
 * scope exemptions. Install only after all reviewed transitions are present. */
export function buildPrivacyReferenceFencePlan(catalog:ProfileCatalog){
 verifyPrivacySelectionAuthority(catalog);
 if((catalog.views??[]).some(v=>v.kind==='m')||(catalog.other_relations??[]).some(v=>v.kind==='m'||v.kind==='f'))throw Error('PRIVACY_REFERENCE_STORED_RELATION_UNCLASSIFIED');
 const tables=[...catalog.tables.map(t=>({...t,schema:'public'})),...(catalog.non_public_tables??[])].map(t=>({schema:t.schema,name:t.name})).sort((a,b)=>(a.schema+'.'+a.name)<(b.schema+'.'+b.name)?-1:1);
 if(new Set(tables.map(t=>t.schema+'.'+t.name)).size!==tables.length||!tables.some(t=>t.schema==='public'&&t.name==='profiles')||[...own].some(n=>!tables.some(t=>t.schema+'.'+t.name===n)))throw Error('PRIVACY_REFERENCE_CATALOG');
 for(const t of tables){quote(t.schema);quote(t.name);}
 const expected=JSON.stringify(tables),targets=tables.filter(t=>!own.has(t.schema+'.'+t.name));
 const triggers=targets.map(t=>`CREATE TRIGGER privacy_reference_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON ${quote(t.schema)}.${quote(t.name)} FOR EACH ROW EXECUTE FUNCTION public.privacy_reference_writer_guard();`).join('\n');
 const sql=triggers+`\nCREATE FUNCTION public.privacy_reference_fences_assert() RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $refs$
DECLARE actual jsonb;BEGIN
 SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname) ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C"),'[]') INTO actual FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','f','m');
 IF actual IS DISTINCT FROM ${literal(expected)}::jsonb OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p') AND (n.nspname||'.'||c.relname) NOT IN('public.privacy_reference_epoch','public.privacy_reference_leases') AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='privacy_reference_writer_guard' AND t.tgenabled='O' AND t.tgfoid='public.privacy_reference_writer_guard()'::regprocedure AND t.tgtype=31 AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgattr=''::int2vector AND NOT t.tgisinternal)) THEN RAISE EXCEPTION 'PRIVACY_REFERENCE_FENCES_INCOMPLETE';END IF;
END $refs$;
REVOKE ALL ON FUNCTION public.privacy_reference_fences_assert() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_reference_fences_assert() TO commerce_privacy_reference_worker;
`;
 return{schema_version:1 as const,tables:targets,catalog_sha256:createHash('sha256').update(expected).digest('hex'),sha256:createHash('sha256').update(sql).digest('hex'),sql};
}
/** Global reference EX first, per-profile030 EX second, both before RR. Closed
 * session destroyed on all outcomes. This is fencing, never purge authority.
 * Work must contain SQL only and fit the native30s lease; no I/O retries. */
export async function withPrivacyReferenceFence<T>(pool:Pick<Pool,'connect'>,workspaceId:string,work:(db:PoolClient,leases:{profile:string;references:string})=>Promise<T>):Promise<T>{
 const workspace=profileIdSchema.parse(workspaceId),c=await pool.connect();let begun=false;
 const id=(value:unknown)=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))throw Error('PRIVACY_REFERENCE_RECEIPT_INVALID');return value;};
 try{
  await c.query('SET ROLE commerce_privacy_reference_worker');
  await c.query("SET statement_timeout='10s'; SET lock_timeout='250ms'; SET idle_in_transaction_session_timeout='5s'; SET idle_session_timeout='5s'");
  const references=id((await c.query('SELECT privacy_reference_fence_acquire() receipt')).rows[0]?.receipt?.lease_id);
  await c.query('SET ROLE commerce_privacy_fence_worker');
  await c.query("SELECT set_config('app.workspace_id',$1,false),set_config('app.environment','REAL',false)",[workspace]);
  const profile=id((await c.query('SELECT privacy_writer_fence_acquire($1) receipt',[workspace])).rows[0]?.receipt?.lease_id);
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');begun=true;
  await c.query('SET LOCAL ROLE commerce_privacy_reference_worker');await c.query('SELECT privacy_reference_fences_assert(),privacy_reference_fence_assert($1)',[references]);
  await c.query('SET LOCAL ROLE commerce_privacy_fence_worker');await c.query('SELECT privacy_writer_fence_assert($1)',[profile]);
  const result=await work(c,{profile,references});
  await c.query('SET LOCAL ROLE commerce_privacy_fence_worker');await c.query('SELECT privacy_writer_fence_advance($1)',[profile]);
  await c.query('SET LOCAL ROLE commerce_privacy_reference_worker');await c.query('SELECT privacy_reference_fences_assert(),privacy_reference_fence_advance($1)',[references]);
  const committed=await c.query('COMMIT');begun=false;if(committed.command!=='COMMIT')throw Error('PRIVACY_REFERENCE_COMMIT_NOT_CONFIRMED');return result;
 }catch(error){if(begun)await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{await c.query('SELECT pg_advisory_unlock_all()').catch(()=>undefined);c.release(true);}
}
