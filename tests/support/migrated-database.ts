import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {migrate,migrationFiles} from '../../packages/db/src/migrate.js';

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
