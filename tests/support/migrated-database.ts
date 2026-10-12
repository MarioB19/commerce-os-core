import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {migrate,migrationFiles} from '../../packages/db/src/migrate.js';
import {selectProfileFromSession} from '../../packages/db/src/profile-identity-bootstrap.js';
import type {InteractiveSession,ProfileFence} from '../../packages/db/src/profile-session.js';

/** The isolated group database already ran every migration (test-isolated.mjs).
 * V7 profile tests require it instead of applying transition sources by hand. */
export async function requireMigratedProfileSchema(db:{query:(sql:string)=>Promise<{rows:any[]}>}){
 const names=(await db.query("SELECT name FROM schema_migrations WHERE name>='0069' ORDER BY name")).rows.map(row=>row.name);
 const expected=(await migrationFiles()).filter(name=>name>='0069');
 if(JSON.stringify(names)!==JSON.stringify(expected))throw new Error('MIGRATED_PROFILE_SCHEMA_REQUIRED');
}
export function isolatedAdminUrl(){
 const url=new URL(localInventoryTarget(process.env.DATABASE_URL));
 if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
 return url;
}
/** SQL text of one numbered migration, exactly as the migrator applies it. */
export async function migrationSql(prefix:string){
 const name=(await migrationFiles()).find(file=>file.startsWith(prefix+'_'));
 if(!name)throw new Error('MIGRATION_NOT_FOUND:'+prefix);
 return readFile(new URL('../../packages/db/migrations/'+name,import.meta.url),'utf8');
}
/** The exact block a migration promoted from a transition source (between its
 * `-- >>> promoted from` and `-- <<< end` markers), for component tests that
 * exercise the installed text on a database migrated through the previous
 * migration. Role creation in that text is the reviewed adoption form. */
export async function promotedSource(source:string){
 const start='-- >>> promoted from packages/db/profile-transition/'+source+' ',end='-- <<< end '+source+'\n';
 for(const name of await migrationFiles()){
  const sql=await readFile(new URL('../../packages/db/migrations/'+name,import.meta.url),'utf8'),from=sql.indexOf(start);
  if(from<0)continue;
  const to=sql.indexOf(end,from);if(to<0)throw new Error('PROMOTED_SOURCE_UNTERMINATED:'+source);
  return sql.slice(sql.indexOf('\n',from)+1,to);
 }
 throw new Error('PROMOTED_SOURCE_NOT_FOUND:'+source);
}
/** A second, empty database in the same cluster migrated through `through`
 * (four digits), for tests of a migration's own adoption guards on prepared
 * historical data. close() drops it. */
export async function openMigratedDatabase(through:string):Promise<{pool:pg.Pool;url:URL;close:()=>Promise<void>}>{
 const parentUrl=isolatedAdminUrl(),parent=new pg.Pool({connectionString:parentUrl.toString(),max:1});
 const name='commerce_test_sub_'+randomBytes(8).toString('hex'),url=new URL(parentUrl);url.pathname='/'+name;
 await parent.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
 const pool=new pg.Pool({connectionString:url.toString(),max:4});
 let closed=false;
 const close=async()=>{
  if(closed)return;closed=true;await pool.end().catch(()=>undefined);
  // Every pool of this database is ended by its test; wait for the backends
  // to exit instead of terminating them (which would surface client errors).
  try{for(let attempt=0;;attempt++){try{await parent.query(`DROP DATABASE IF EXISTS "${name}"`);break;}catch(error){if(attempt>=50||(error as {code?:string}).code!=='55006')throw error;await new Promise(resolve=>setTimeout(resolve,100));}}}
  finally{await parent.end();}
 };
 try{await migrate({pool,through,log:()=>undefined});}catch(error){await close();throw error;}
 return{pool,url,close};
}
export async function withMigratedDatabase<T>(through:string,work:(pool:pg.Pool,url:URL)=>Promise<T>):Promise<T>{
 const database=await openMigratedDatabase(through);
 try{return await work(database.pool,database.url);}finally{await database.close();}
}
/** Explicit session selection through the closed V7 bootstrap port, outside
 * any profile context (as the identity route does), committed on its own. */
export async function selectFixtureSession(pool:{connect():Promise<pg.PoolClient>},session:InteractiveSession,workspaceId:string,expectedVersion:number):Promise<ProfileFence>{
 const c=await pool.connect();
 try{await c.query('BEGIN');const fence=await selectProfileFromSession(c,session,workspaceId,expectedVersion);await c.query('COMMIT');return fence;}
 catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
}
/** Seals the quota baseline of profiles a fixture inserted directly (as the
 * migration and ensureProfile do), so REAL quota records can be admitted. */
export async function sealFixtureProfiles(pool:{connect():Promise<pg.PoolClient>},...workspaces:string[]){
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  for(const workspace of workspaces){await c.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true)",[workspace]);await c.query('SELECT public.adopt_profile_quota_inventory($1,public.profile_quota_inventory($1))',[workspace]);}
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
}
/** Runs owner fixture work with one profile's context (privacy-fenced rows such
 * as `profiles` accept updates only from their own profile context). */
export async function asProfileOwner<T>(pool:{connect():Promise<pg.PoolClient>},workspace:string,work:(c:pg.PoolClient)=>Promise<T>,environment='REAL'):Promise<T>{
 const c=await pool.connect();
 try{
  await c.query('BEGIN');await c.query("SELECT pg_catalog.set_config('app.workspace_id',$1,true),pg_catalog.set_config('app.environment',$2,true)",[workspace,environment]);
  const result=await work(c);await c.query('COMMIT');return result;
 }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
}
/** Test-only: removes a fixture profile and every row that names it, so a file
 * whose cases each need a fresh profile stays within the installation's three
 * profiles and 20 numbers (D-14). Triggers and FK checks are bypassed only in
 * this owner transaction (session_replication_role=replica); product code never
 * deletes a profile. */
export async function disposeFixtureProfile(pool:{connect():Promise<pg.PoolClient>},workspace:string){
 const c=await pool.connect();
 try{
  if(!/^commerce_test_[a-z0-9_]+$/.test((await c.query('SELECT current_database() name')).rows[0].name))throw new Error('ISOLATED_TEST_DATABASE_REQUIRED');
  await c.query('BEGIN');await c.query("SET LOCAL session_replication_role='replica'");
  const tables=(await c.query(`SELECT DISTINCT c.relname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attname='workspace_id' AND NOT a.attisdropped ORDER BY 1`)).rows as {relname:string}[];
  for(const {relname} of tables)await c.query(`DELETE FROM public."${relname.replaceAll('"','""')}" WHERE workspace_id::text=$1`,[workspace]);
  await c.query('DELETE FROM public.profiles WHERE id=$1',[workspace]);
  await c.query('COMMIT');
 }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}finally{c.release();}
}
/** Inserts one sealed fixture profile, first disposing the oldest profiles this
 * file created (`created`, oldest first) until the installation admits it. */
export async function fixtureProfileRow(pool:{connect():Promise<pg.PoolClient>;query:(sql:string,values?:unknown[])=>Promise<{rows:any[]}>},created:string[],id:string,
 options:{businessName?:string;timezone?:string;numbers?:number;products?:number;daily?:number;state?:'ACTIVE'|'SUSPENDED'}={}){
 const numbers=options.numbers??0;
 for(;;){
  const total=(await pool.query('SELECT count(*)::int profiles,COALESCE(sum(number_limit),0)::int numbers FROM profiles')).rows[0] as {profiles:number;numbers:number};
  if(total.profiles<3&&total.numbers+numbers<=20)break;
  const oldest=created.shift();if(!oldest)throw new Error('FIXTURE_PROFILE_ROOM_UNAVAILABLE');
  await disposeFixtureProfile(pool,oldest);
 }
 await pool.query('INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit,state) VALUES($1,$2,$3,$4,$5,$6,$7)',
  [id,options.businessName??'Synthetic fixture',options.timezone??'UTC',numbers,options.products??100,options.daily??100,options.state??'ACTIVE']);
 await sealFixtureProfiles(pool,id);created.push(id);return id;
}
/** Test-only: disposes every profile of this file's isolated database (see
 * disposeFixtureProfile), for legacy files whose cases each start from a fresh
 * workspace while an installation admits only three profiles. */
export async function disposeAllFixtureProfiles(pool:{connect():Promise<pg.PoolClient>;query:(sql:string,values?:unknown[])=>Promise<{rows:any[]}>},keep:readonly string[]=[]){
 for(const {id} of (await pool.query('SELECT id FROM profiles ORDER BY id')).rows as {id:string}[])if(!keep.includes(id))await disposeFixtureProfile(pool,id);
}
