import {afterAll,beforeAll,expect,it} from 'vitest';
import {pool} from '../../packages/db/src/index.js';
import {retirementFixture} from './platform-retirement-fixture.js';
let f:Awaited<ReturnType<typeof retirementFixture>>;
beforeAll(async()=>{f=await retirementFixture();});afterAll(async()=>{await f.app.close();await pool.end();});
it.each(['voice/quote','voice/request','voice/operations','recipes/00000000-0000-4000-8000-000000000000/voice'])('retires voice capability %s without paid operations',async path=>{const before=(await pool.query('SELECT count(*)::int n FROM creative_provider_operations')).rows[0].n;const response=await f.call('POST','/v1/studio/'+path,{});expect(response.statusCode,response.body).toBe(410);expect((await pool.query('SELECT count(*)::int n FROM creative_provider_operations')).rows[0].n).toBe(before);});
it('rejects old voice writers at the persistence boundary',async()=>{await expect(pool.query('INSERT INTO creative_voice_operations DEFAULT VALUES')).rejects.toThrow('PLATFORM_PRODUCTION_RETIRED');});
