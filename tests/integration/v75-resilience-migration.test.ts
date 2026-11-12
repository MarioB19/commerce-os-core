import {randomBytes,randomUUID} from 'node:crypto';
import {afterAll,describe,expect,it} from 'vitest';
import {openMigratedDatabase,fixtureProfileRow} from '../support/migrated-database.js';
import {migrate} from '../../packages/db/src/migrate.js';

/** V7.5 0121 (docs/adr-v7-5-resilience.md): additive upgrade from 0120 with
 * historical alert duplicates and legacy status-only resolutions; ownership
 * freeze causes. Synthetic rows only; no provider or host. */
const closers:Array<()=>Promise<void>>=[];
afterAll(async()=>{for(const close of closers)await close();});
describe('V7.5 migration 0121',()=>{
 it('reconciles historical alerts idempotently without losing acknowledgement or declaring unknown causes resolved',async()=>{
  const db=await openMigratedDatabase('0120');closers.push(db.close);
  const w=await fixtureProfileRow(db.pool,[],'v75_mig_'+randomBytes(4).toString('hex'),{numbers:1});
  const insert=(key:string,kind:string,extra:Record<string,unknown>={})=>db.pool.query(`INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code,status,created_at,updated_at,acknowledged_at,resolved_at)
   VALUES($1,'REAL',$2,$3,'CRITICAL',$3,$4,$5,$6,$7,$8) RETURNING id`,[w,key,kind,extra.status??'PENDING',extra.created??'2026-11-10T00:00:00Z',extra.updated??'2026-11-10T00:00:00Z',extra.ack??null,extra.resolved??null]).then(r=>r.rows[0].id as string);
  const backup=[] as string[];
  for(let h=0;h<5;h++)backup.push(await insert('EXTERNAL_BACKUP_NOT_CURRENT:2026-11-10T0'+h,'EXTERNAL_BACKUP_NOT_CURRENT',{created:`2026-11-10T0${h}:00:00Z`,ack:'2026-11-11T19:19:00Z'}));
  const legacy=await insert('legacy-resolved','WARMUP_BREAKER_OPEN',{status:'RESOLVED',updated:'2026-11-09T12:00:00Z'});
  const dated=await insert('dated-resolution','CHANNEL_PROVIDER_UNAVAILABLE',{status:'ACCEPTED',resolved:'2026-11-10T05:00:00Z'});
  const unread=await insert('unread','QUEUE_OLDER_THAN_30_MINUTES');
  await migrate({pool:db.pool,log:()=>undefined});await migrate({pool:db.pool,log:()=>undefined});
  expect((await db.pool.query('SELECT count(*)::int n FROM schema_migrations')).rows[0].n).toBe(121);
  const rows=new Map((await db.pool.query('SELECT * FROM operational_alerts WHERE workspace_id=$1',[w])).rows.map(r=>[r.id,r]));
  expect(rows.size).toBe(8);
  const episode=rows.get(backup[0]!)!;
  expect(episode).toMatchObject({superseded_by:null,resolved_at:null,observations:5});expect(episode.acknowledged_at).not.toBeNull();
  expect(new Date(episode.last_observed_at).toISOString()).toBe('2026-11-10T04:00:00.000Z');
  for(const id of backup.slice(1))expect(rows.get(id)).toMatchObject({superseded_by:backup[0],resolved_at:null});
  expect(rows.get(backup[1]!)!.acknowledged_at).not.toBeNull();
  expect(rows.get(legacy)!.resolved_at).toEqual(new Date('2026-11-09T12:00:00Z'));expect(rows.get(legacy)!.evidence.resolution).toBe('LEGACY_STATUS_RESOLVED');
  expect(rows.get(dated)).toMatchObject({status:'ACCEPTED',superseded_by:null});expect(rows.get(dated)!.resolved_at).toEqual(new Date('2026-11-10T05:00:00Z'));
  expect(rows.get(unread)).toMatchObject({resolved_at:null,superseded_by:null,acknowledged_at:null,observations:1});
  await expect(db.pool.query("INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code) VALUES($1,'REAL','dup','EXTERNAL_BACKUP_NOT_CURRENT','CRITICAL','X')",[w])).rejects.toMatchObject({code:'23505'});
  await db.close();
 },60000);
 it('records why an ownership is frozen and never downgrades a non-recoverable freeze',async()=>{
  const db=await openMigratedDatabase('0121');closers.push(db.close);
  const w=await fixtureProfileRow(db.pool,[],'v75_own_'+randomBytes(4).toString('hex'),{numbers:2});
  const account=randomUUID();await db.pool.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','channel_account','{\"provider\":\"waha\"}')",[account,w]);
  const reason=async()=>(await db.pool.query('SELECT frozen,freeze_reason FROM session_ownership WHERE account_id=$1',[account])).rows[0];
  const freeze=async(cause:string|null)=>{const c=await db.pool.connect();try{await c.query('BEGIN');if(cause)await c.query("SELECT set_config('commerce.freeze_reason',$1,true)",[cause]);await c.query('UPDATE session_ownership SET frozen=true WHERE account_id=$1',[account]);await c.query('COMMIT');}finally{c.release();}};
  await db.pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'w1',true,now()+interval '1 minute')",[account,w]);
  expect(await reason()).toEqual({frozen:true,freeze_reason:'UNSPECIFIED'});
  await db.pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account]);expect(await reason()).toEqual({frozen:false,freeze_reason:null});
  await freeze('HEALTH_UNKNOWN');expect((await reason()).freeze_reason).toBe('HEALTH_UNKNOWN');
  await freeze('HEALTH_DISCONNECTED');expect((await reason()).freeze_reason).toBe('HEALTH_DISCONNECTED');
  await freeze(null);expect((await reason()).freeze_reason).toBe('UNSPECIFIED');
  await freeze('HEALTH_DISCONNECTED');expect((await reason()).freeze_reason).toBe('UNSPECIFIED');
  await db.pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account]);await freeze('HEALTH_BLOCKED');await freeze('HEALTH_DISCONNECTED');
  expect((await reason()).freeze_reason).toBe('HEALTH_BLOCKED');
  await db.pool.query("UPDATE session_ownership SET lease_expires_at=now()+interval '2 minutes' WHERE account_id=$1",[account]);expect((await reason()).freeze_reason).toBe('HEALTH_BLOCKED');
  expect((await db.pool.query("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname='warmup_observations_kind_check'")).rows[0].d).toContain("'UNKNOWN'");
  await db.close();
 },60000);
});
