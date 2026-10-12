import {readFile} from 'node:fs/promises';
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
describe('cluster role lifecycle across isolated transition fixtures',()=>{
 it('installs actual 019 twice in distinct databases without weakening its fresh-role guard',async()=>{
  const url=localInventoryTarget(process.env.DATABASE_URL);if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(new URL(url).pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');
  const admin=new pg.Client({connectionString:url});await admin.connect();const logs:string[]=[],created:string[]=[];
  try{
   const before=await captureIntegrationRoles(admin);expect(before.roles.some((r:{name:string})=>r.name==='commerce_ai')).toBe(false);
   const code=await runIntegration({args:[],entries:[{file:'tests/integration/profile-role-custody-first.test.ts'},{file:'tests/integration/profile-role-custody-second.test.ts'}],env:{...process.env,DATABASE_URL:url},createClient:(o:pg.ClientConfig)=>new pg.Client(o),log:(line:string)=>logs.push(line),
    run:async(cmd:string,args:string[],env:NodeJS.ProcessEnv)=>{
     if(cmd===process.execPath){await promisify(execFile)(cmd,args,{cwd:root,env,timeout:30000,maxBuffer:2*1024*1024});return 0;}
     // A real additive fixture body, replacing only the child Vitest process.
     // These two names are explicit synthetic groups, not claimed test files.
     const db=new pg.Client({connectionString:env.DATABASE_URL});await db.connect();
     try{
      expect((await db.query("SELECT 1 FROM pg_roles WHERE rolname='commerce_ai'")).rows).toEqual([]);
      await db.query('BEGIN');for(const name of ['001_profile_identity.sql','003_profile_settings.sql','008_market_variants.sql','019_ai_admission.sql'])await db.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));
      await db.query('COMMIT');created.push(new URL(env.DATABASE_URL!).pathname);
      expect((await db.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='commerce_ai'")).rows).toEqual([{rolcanlogin:false,rolsuper:false,rolbypassrls:false}]);return 0;
     }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
    }});
   expect(code).toBe(0);expect(created).toHaveLength(2);expect(new Set(created).size).toBe(2);
   const receipts=logs.filter(l=>l.startsWith('{')).map(l=>JSON.parse(l));expect(receipts).toHaveLength(2);expect(receipts.every(r=>r.state==='ISOLATED_TEST_ROLES_REMOVED'&&r.roles.length===1&&r.roles[0]==='commerce_ai')).toBe(true);
   expect(await captureIntegrationRoles(admin)).toEqual(before);
   expect((await admin.query('SELECT datname FROM pg_database WHERE datname=ANY($1::text[])',[created.map(s=>s.slice(1))])).rows).toEqual([]);
  }finally{await admin.end();}
 },90000);
});
