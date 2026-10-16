import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {pool} from '../../packages/db/src/index.js';
import {createProfileWorkerRuntime} from '../../packages/db/src/profile-worker-scope.js';
import type {ProfilePool} from '../../packages/db/src/profile-context.js';
import {processResultProjections} from '../../apps/automation-worker/src/result-projection-runner.js';
import {resultsReport} from '../../packages/db/src/results.js';
import {withProfileTransaction} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 F7 (RF-12.j): the automation worker projects Resultados with the reviewed
// commerce_results login; without it the loop is a no-op.
const P='projections-'+randomUUID(),login='results_'+randomBytes(5).toString('hex');
let results:pg.Pool,automation:pg.Pool;
const rolePool=(native:pg.Pool,role:string):ProfilePool=>({async connect(){const c=await native.connect();await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:c.release.bind(c)};}});
beforeAll(async()=>{
 const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
 await fixtureProfiles({id:P,numbers:2});
 const secret=randomBytes(24).toString('hex');await pool.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOINHERIT NOSUPERUSER NOBYPASSRLS;GRANT commerce_results TO "${login}"`);
 const u=new URL(url);u.username=login;u.password=secret;results=new pg.Pool({connectionString:u.toString(),max:2});automation=new pg.Pool({connectionString:url.toString(),max:2});
});
afterAll(async()=>{await results.end();await automation.end();await pool.query(`DROP ROLE IF EXISTS "${login}"`).catch(()=>undefined);await pool.end();});
it('projects every profile and Resultados reads the new generation',async()=>{
 const workers=createProfileWorkerRuntime(rolePool(automation,'commerce_automation'),'commerce_automation','REAL');
 expect(await processResultProjections({pool:null,workers})).toBe(0);
 const generation=async()=>(await pool.query("SELECT generation::text g FROM result_projection_state WHERE workspace_id=$1 AND environment='REAL' AND phase='READY'",[P])).rows[0]?.g??null;
 const day=new Date().toISOString().slice(0,10);
 // Never projected: Resultados cannot answer yet (it never shows zeros it did not measure).
 await expect(withProfileTransaction(rolePool(automation,'commerce_api'),P,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return resultsReport(db,{from:day,to:day,currency:'MXN'});})).rejects.toThrow('RESULT_PROJECTION_NOT_READY');
 const before=await generation();
 expect(await processResultProjections({pool:rolePool(results,'commerce_results'),workers})).toBeGreaterThanOrEqual(1);
 const after=await generation();expect(after).not.toBeNull();expect(after).not.toBe(before);
 // The report as the API reads it (commerce_api), now from the new generation.
 const report=await withProfileTransaction(rolePool(automation,'commerce_api'),P,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");return resultsReport(db,{from:day,to:day,currency:'MXN'});});
 expect(report.generation).toBe(after);expect(report.summary.totals.sales).toBe('0');
},120000);
