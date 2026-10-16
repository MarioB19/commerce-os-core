import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type pg from 'pg';
import {pool as defaultPool,hash} from './index.js';
export interface MigrationOptions {
 /** Defaults to the process pool. Tests pass a pool for a dedicated database. */
 pool?:Pick<pg.Pool,'query'|'connect'>;
 /** Apply only migrations whose four-digit number is <= this value. */
 through?:string;
 log?:(line:string)=>void;
}
const directory=fileURLToPath(new URL('../migrations/',import.meta.url));
export async function migrationFiles():Promise<string[]>{
 const files=(await readdir(directory)).filter(x=>x.endsWith('.sql')).sort();
 if(files.some(x=>!/^\d{4}_[a-z0-9_]+\.sql$/.test(x)))throw new Error('MIGRATION_NAME_INVALID');
 return files;
}
export async function migrate(options:MigrationOptions={}){
 const pool=options.pool??defaultPool,log=options.log??(line=>console.log(line));
 if(options.through!==undefined&&!/^\d{4}$/.test(options.through))throw new Error('MIGRATION_THROUGH_INVALID');
 await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz DEFAULT now())');
 for(const file of await migrationFiles()){
  if(options.through!==undefined&&file.slice(0,4)>options.through)break;
  const sql=await readFile(directory+file,'utf8');
  const old=(await pool.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[file])).rows[0];
  if(old){if(old.sha256!==hash(sql))throw new Error('MIGRATION_CHANGED:'+file);continue;}
  const c=await pool.connect();
  try{
   await c.query('BEGIN');
   await c.query('SELECT pg_advisory_xact_lock(83947101)');
   const concurrent=(await c.query('SELECT sha256 FROM schema_migrations WHERE name=$1',[file])).rows[0];
   if(concurrent){if(concurrent.sha256!==hash(sql))throw new Error('MIGRATION_CHANGED:'+file);await c.query('ROLLBACK');continue;}
   await c.query(sql);
   await c.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)',[file,hash(sql)]);
   await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK').catch(()=>undefined);throw error;}
  finally{c.release();}
  log('Applied migration '+file);
 }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){await migrate();await defaultPool.end();}
