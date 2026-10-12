import {verifyPrivacySelectionAuthority} from './privacy-selection-authority.js';
import {createHash} from 'node:crypto';
import type {ProfileCatalog} from './profile-inventory.js';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import type {Pool,PoolClient} from 'pg';
const quote=(s:string)=>{if(!/^[a-z_][a-z0-9_]*$/.test(s))throw Error('PRIVACY_FENCE_IDENTIFIER');return '"'+s+'"';};
// F2 retains this retired table behind deny-RLS; its legacy nullable profile
// cannot be invented. It is not an active writer or a D18 conversation store.
const own=new Set(['privacy_writer_epochs','privacy_writer_leases','creative_pairings']);
/** Install only against the complete reviewed catalog, then verify triggers.
 * The inventory port independently pins the resulting structure and access. */
export function buildPrivacyWriterFencePlan(catalog:ProfileCatalog){
 const selectionVerified=verifyPrivacySelectionAuthority(catalog);
 const targets=catalog.tables.filter(t=>!(selectionVerified&&t.name==='profile_session_context')&&!own.has(t.name)&&t.columns.some(c=>c.name==='workspace_id')).sort((a,b)=>a.name.localeCompare(b.name,'en'));
 if(!catalog.tables.some(t=>t.name==='profiles')||!targets.some(t=>t.name==='records')||new Set(catalog.tables.map(t=>t.name)).size!==catalog.tables.length)throw Error('PRIVACY_FENCE_CATALOG');
 for(const t of targets){const c=t.columns.find(c=>c.name==='workspace_id')!;if(c.type!=='text'||!c.not_null)throw Error('PRIVACY_FENCE_SCOPE_UNCLASSIFIED');quote(t.name);}
 const sql=targets.map(t=>`CREATE TRIGGER privacy_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.${quote(t.name)} FOR EACH ROW EXECUTE FUNCTION public.privacy_writer_guard('workspace_id');`).join('\n')+'\n';
 return{schema_version:1 as const,tables:targets.map(t=>t.name),sha256:createHash('sha256').update(sql).digest('hex'),sql};
}
/** Dedicated session: destroy it even on uncertain COMMIT so session locks can
 * never escape to another pool borrower. No callback/network-effect retries. */
export async function withPrivacyWriterFence<T>(pool:Pick<Pool,'connect'>,workspaceId:string,work:(db:PoolClient,leaseId:string)=>Promise<T>):Promise<T>{
 const workspace=profileIdSchema.parse(workspaceId),client=await pool.connect();let begun=false;
 try{
  await client.query('SET ROLE commerce_privacy_fence_worker');
  await client.query("SET statement_timeout='10s'; SET lock_timeout='250ms'; SET idle_in_transaction_session_timeout='5s'; SET idle_session_timeout='5s'");
  await client.query("SELECT set_config('app.workspace_id',$1,false),set_config('app.environment','REAL',false)",[workspace]);
  const lease=(await client.query('SELECT privacy_writer_fence_acquire($1) receipt',[workspace])).rows[0]?.receipt;
  if(!lease||typeof lease.lease_id!=='string'||!/^[a-f0-9-]{36}$/.test(lease.lease_id))throw Error('PRIVACY_FENCE_RECEIPT_INVALID');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');begun=true;
  await client.query('SELECT privacy_writer_fence_assert($1)',[lease.lease_id]);
  const result=await work(client,lease.lease_id);
  await client.query('SET LOCAL ROLE commerce_privacy_fence_worker');
  await client.query('SELECT privacy_writer_fence_advance($1)',[lease.lease_id]);
  const committed=await client.query('COMMIT');begun=false;
  if(committed.command!=='COMMIT')throw Error('PRIVACY_FENCE_COMMIT_NOT_CONFIRMED');
  return result;
 }catch(error){if(begun)await client.query('ROLLBACK').catch(()=>undefined);throw error;}
 finally{client.release(true);}
}
