import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
// The production test driver is JavaScript, also used by the native FULL stage.
// @ts-expect-error JavaScript harness has no declaration file.
import {runIntegration} from '../../scripts/test-isolated.mjs';
// @ts-expect-error JavaScript metadata custodian has no declaration file.
import {captureIntegrationRoles} from '../../scripts/integration-role-custody.mjs';
const root=fileURLToPath(new URL('../../',import.meta.url));
// V7 F2: every isolated group database is fully migrated, so the reviewed roles
// (here commerce_ai, created by 0082) already exist for the enclosing group.
// Nested groups must adopt them without dropping a role another database uses.
describe('cluster role lifecycle across isolated migrated fixtures',()=>{
 it('adopts migrated reviewed roles in two distinct databases and never drops a shared role',async()=>{
  const url=localInventoryTarget(process.env.DATABASE_URL);if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(new URL(url).pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const admin=new pg.Client({connectionString:url});await admin.connect();const logs:string[]=[],created:string[]=[];
  try{
   const before=await captureIntegrationRoles(admin);expect(before.roles.some((r:{name:string})=>r.name==='commerce_ai')).toBe(true);
   const code=await runIntegration({args:[],entries:[{file:'tests/integration/profile-role-custody-first.test.ts'},{file:'tests/integration/profile-role-custody-second.test.ts'}],env:{...process.env,DATABASE_URL:url},createClient:(o:pg.ClientConfig)=>new pg.Client(o),log:(line:string)=>logs.push(line),
    run:async(cmd:string,args:string[],env:NodeJS.ProcessEnv)=>{
     if(cmd===process.execPath){await promisify(execFile)(cmd,args,{cwd:root,env,timeout:30000,maxBuffer:2*1024*1024});return 0;}
     // A real additive fixture body, replacing only the child Vitest process.
     // These two names are explicit synthetic groups, not claimed test files.
     const db=new pg.Client({connectionString:env.DATABASE_URL});await db.connect();
     try{
      expect((await db.query("SELECT rolcanlogin,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname='commerce_ai'")).rows).toEqual([{rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolinherit:true}]);
      // The nested database's own migration bound the shared role to its objects.
      expect((await db.query("SELECT count(*)::int n FROM pg_shdepend d WHERE d.refobjid='commerce_ai'::regrole AND d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n).toBeGreaterThan(0);
      await db.query('BEGIN');await db.query('COMMIT');created.push(new URL(env.DATABASE_URL!).pathname);return 0;
     }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
    }});
   expect(code).toBe(0);expect(created).toHaveLength(2);expect(new Set(created).size).toBe(2);
   const receipts=logs.filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));expect(receipts).toHaveLength(2);expect(receipts.every(r=>r.state==='ISOLATED_TEST_ROLES_REMOVED'&&r.roles.length===0)).toBe(true);
   expect(await captureIntegrationRoles(admin)).toEqual(before);
   expect((await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[created.map(s=>s.slice(1))])).rows).toEqual([]);
  }finally{await admin.end();}
 },90000);
});
