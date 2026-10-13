import {afterAll,beforeAll,expect,it} from 'vitest';
import {createApp} from '../../apps/api/src/app.js';
import {pool} from '../../packages/db/src/index.js';

// V7 F1 (RNF-03.e/h): the external uptime check reads one content-free route.
// The test cluster does not archive WAL, so the route must say so with codes only.
let app:Awaited<ReturnType<typeof createApp>>;
beforeAll(async()=>{app=await createApp();});
afterAll(async()=>{await app.close();await pool.end();});

it('reports archiving and base backups as problem codes only',async()=>{
 const r=await app.inject({method:'GET',url:'/healthz/platform'});
 expect(r.statusCode).toBe(503);
 const body=r.json();
 expect(Object.keys(body).sort()).toEqual(['problems','service','status']);
 expect(body).toMatchObject({status:'degraded',service:'platform'});
 expect(body.problems).toEqual(expect.arrayContaining(['ARCHIVING_DISABLED','BACKUP_STALE','FULL_BACKUP_STALE']));
 expect(r.headers['cache-control']).toBe('no-store');
});

it('keeps backup rows owner-only and exposes the bounded status to the API role',async()=>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query(`SELECT public.record_platform_backup_run('{"kind":"PITR_FULL","status":"SUCCEEDED","label":"20261013-100000F","started_at":"2026-10-13T10:00:00Z","finished_at":"2026-10-13T10:05:00Z","database_bytes":10,"repository_bytes":2}'::jsonb)`);
  await expect(client.query(`SELECT public.record_platform_backup_run('{"kind":"PITR_FULL","status":"SUCCEEDED","started_at":"2026-10-13T10:00:00Z","finished_at":"2026-10-13T10:05:00Z"}'::jsonb)`)).rejects.toThrow();
  await client.query('ROLLBACK');await client.query('BEGIN');
  await client.query(`SELECT public.record_platform_backup_run('{"kind":"PITR_FULL","status":"SUCCEEDED","label":"20261013-100000F","started_at":"2026-10-13T10:00:00Z","finished_at":"2026-10-13T10:05:00Z","database_bytes":10,"repository_bytes":2}'::jsonb)`);
  await client.query('SET LOCAL ROLE commerce_api');
  const status=(await client.query('SELECT public.platform_recovery_status() AS s')).rows[0].s;
  expect(status).toMatchObject({archive_mode:'off',last_full_at:'2026-10-13T10:05:00+00:00',pending:0});
  await client.query('SAVEPOINT s');
  await expect(client.query('SELECT count(*) FROM platform_backup_runs')).rejects.toThrow(/permission denied/);
  await client.query('ROLLBACK TO SAVEPOINT s');
  await expect(client.query(`SELECT public.record_platform_backup_run('{}'::jsonb)`)).rejects.toThrow(/permission denied/);
 }finally{await client.query('ROLLBACK').catch(()=>undefined);client.release();}
});
