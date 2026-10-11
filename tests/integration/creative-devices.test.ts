import {afterAll,beforeAll,expect,it} from 'vitest';
import {pool} from '../../packages/db/src/index.js';
import {retirementFixture} from './platform-retirement-fixture.js';
let f:Awaited<ReturnType<typeof retirementFixture>>;
beforeAll(async()=>{f=await retirementFixture();});afterAll(async()=>{await f.app.close();await pool.end();});
it.each(['pairing/start','pairing/00000000-0000-4000-8000-000000000000/poll','jobs/claim','heartbeat','complete','fail','reconcile'])('retires device capability %s before creating pairing or claims',async path=>{const response=await f.app.inject({method:'POST',url:'/creative-device/v1/'+path,payload:{}});expect(response.statusCode).toBe(410);expect(response.json().error.code).toBe('PLATFORM_PRODUCTION_RETIRED');});
it('rejects legacy render producers at database boundary after rollback',async()=>{await expect(pool.query('INSERT INTO creative_jobs DEFAULT VALUES')).rejects.toThrow('PLATFORM_PRODUCTION_RETIRED');expect((await pool.query('SELECT count(*)::int n FROM creative_jobs WHERE workspace_id=$1',[f.workspace])).rows[0].n).toBe(0);});
