import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema} from '../support/migrated-database.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {readProfileCatalog} from '../../packages/db/src/profile-inventory.js';
import {buildPrivacyInventoryPlan,privacyInventoryPolicy,type PrivacyInventoryCatalog} from '../../packages/db/src/privacy-inventory-plan.js';
let admin:pg.Pool,worker:pg.Pool;const login='privacy_inventory_'+randomBytes(8).toString('hex');
const w='privacy_inventory_a',other='privacy_inventory_b';
async function record(kind:string,body:Record<string,unknown>={},workspace=w,environment='REAL'){
 const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true)",[workspace,environment]);const row=(await c.query('INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,$3,$4) RETURNING *',[workspace,environment,kind,body])).rows[0];await c.query('COMMIT');return row;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function read(id:string,version=1,workspace=w,environment='REAL',isolation='REPEATABLE READ',role='commerce_privacy_worker'){
 const c=await worker.connect();try{await c.query('BEGIN ISOLATION LEVEL '+isolation);await c.query('SET LOCAL ROLE '+role);await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment',$2,true)",[workspace,environment]);const row=(await c.query('SELECT privacy_reference_inventory($1,$2) result',[id,version])).rows[0].result;await c.query('COMMIT');return row;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
describe('D18 complete native reference inventory, no erase permission',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:3});
  // V7 F2: the canonical chain, its components and the isolation model are
  // installed by the migrations (0069-0100); no transition source is applied here.
  await requireMigratedProfileSchema(admin);
  for(const workspace of [w,other])await admin.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic privacy inventory','UTC',0,0,100)",[workspace]);
  for(const workspace of [w,other]){const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true)",[workspace]);await c.query('SELECT adopt_profile_quota_inventory($1,profile_quota_inventory($1))',[workspace]);await c.query('COMMIT');}finally{c.release();}}
  const catalog=await readProfileCatalog(admin,[]) as PrivacyInventoryCatalog;
  // V7 F8-E: 0109 dropped 39 retired tables (227 relations through 0108).
  const plan=buildPrivacyInventoryPlan(catalog,privacyInventoryPolicy(catalog.tables.map(t=>t.name)));expect(plan.relations).toBe(189);
  await admin.query(plan.prepare_sql);
  const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${login}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT commerce_privacy_worker TO "${login}"`);
  const u=new URL(url);u.username=login;u.password=secret;worker=new pg.Pool({connectionString:u.toString(),max:2});
  await admin.query(plan.seal_sql);
 },60000);
 afterAll(async()=>{await worker?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}"`);}finally{await admin.end();}}});
 it('discovers native children and all versions without returning content or source keys',async()=>{
  const j=await record('conversation',{status:'CLOSED',private_note:'PRIVATE_SENTINEL'}),m=await record('message',{conversation_id:j.id,text:'PRIVATE_SENTINEL'});await admin.query("UPDATE records SET version=version+1,body=body||'{\"text\":\"REPLACED_PRIVATE\"}' WHERE id=$1",[m.id]);const r=await read(j.id);expect(r.entries.filter((x:any)=>x.relation==='records').map((x:any)=>x.identity)).toEqual(expect.arrayContaining([j.id,m.id]));expect(r.entries.filter((x:any)=>x.relation==='record_versions')).toHaveLength(3);expect(JSON.stringify(r)).not.toContain('PRIVATE_SENTINEL');expect(JSON.stringify(r)).not.toContain('REPLACED_PRIVATE');expect(r.erasure_authorized).toBe(false);
 });
 it('follows nested JSON values and keys across command/event descendants',async()=>{
  const j=await record('conversation'),cmd=randomUUID(),event=randomUUID();await admin.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'REAL','fixture','fixture','PRIVATE_ACTOR',$3,$4)",[cmd,w,{nested:{[j.id]:{secret:'PRIVATE_COMMAND'}}},randomUUID()]);await admin.query("INSERT INTO domain_events(id,workspace_id,environment,event_type,aggregate_id,correlation_id,payload) VALUES($1,$2,'REAL','fixture','fixture',$3,$4)",[event,w,cmd,{private:'PRIVATE_EVENT'}]);const r=await read(j.id);expect(r.entries.find((x:any)=>x.identity===cmd)?.classification).toBe('CONTENT');expect(r.entries.find((x:any)=>x.identity===event)?.classification).toBe('CONTENT');expect(JSON.stringify(r)).not.toContain('PRIVATE_');
 });
 it('finds original envelopes only via actual native identities',async()=>{
  const j=await record('conversation'),e=randomUUID();await admin.query("INSERT INTO inbound_envelopes(id,workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext) VALUES($1,$2,'REAL','fixture','simulator',$3,'PRIVATE_CIPHER')",[e,w,randomUUID()]);await record('message',{conversation_id:j.id,envelope_id:e,text:'PRIVATE_TEXT'});const r=await read(j.id);expect(r.entries.find((x:any)=>x.identity===e)?.relation).toBe('inbound_envelopes');expect(JSON.stringify(r)).not.toContain('PRIVATE_');
 });
 it('finds shared assets and contacts without expanding into unrelated conversations',async()=>{
  const asset=await record('asset',{name:'PRIVATE_ASSET'}),contact=await record('contact',{name:'PRIVATE_CONTACT'}),j=await record('conversation',{contact_id:contact.id}),second=await record('conversation',{contact_id:contact.id});await record('message',{conversation_id:j.id,asset_id:asset.id});const r=await read(j.id);expect(r.entries.find((x:any)=>x.identity===asset.id)?.classification).toBe('SHARED');expect(r.entries.find((x:any)=>x.identity===contact.id)?.classification).toBe('SHARED');expect(r.entries.some((x:any)=>x.identity===second.id)).toBe(false);expect(JSON.stringify(r)).not.toContain('PRIVATE_');
 });
 it('marks another conversation reached via one shared envelope without expanding it',async()=>{
  const j=await record('conversation'),second=await record('conversation'),e=randomUUID();await admin.query("INSERT INTO inbound_envelopes(id,workspace_id,environment,account_id,provider,provider_event_id,payload_ciphertext) VALUES($1,$2,'REAL','fixture','simulator',$3,'PRIVATE_CIPHER')",[e,w,randomUUID()]);await record('message',{conversation_id:j.id,envelope_id:e});const foreign=await record('message',{conversation_id:second.id,envelope_id:e});const r=await read(j.id);expect(r.entries.find((x:any)=>x.identity===foreign.id)?.classification).toBe('SHARED');expect(r.entries.filter((x:any)=>x.relation==='records').length).toBeGreaterThan(2);expect(r.erasure_authorized).toBe(false);
 });
 it('classifies order and receipt references as financial without treating their arbitrary fields as approved retention',async()=>{
  const j=await record('conversation'),o=await record('order',{conversation_id:j.id,private_note:'PRIVATE_FINANCIAL'}),receipt=await record('receipt',{order_id:o.id,conversation_id:j.id,receipt_ai_result:{private:'PRIVATE_AI'},analysis_evidence_ciphertext:'PRIVATE_CIPHER'});const r=await read(j.id);expect(r.entries.find((x:any)=>x.identity===o.id)?.classification).toBe('FINANCIAL');expect(r.entries.find((x:any)=>x.identity===receipt.id)?.classification).toBe('FINANCIAL');expect(JSON.stringify(r)).not.toContain('PRIVATE_');
 });
 it('unknown content kinds become blockers with no arbitrary kind string in the result',async()=>{
  const j=await record('conversation');await record('PRIVATE_UNKNOWN_KIND',{nested:{reference:j.id},private:'PRIVATE_UNKNOWN'});const r=await read(j.id);expect(r.unclassified_references).toBeGreaterThan(0);expect(JSON.stringify(r)).not.toContain('PRIVATE_');
 });
 it('encrypted caches with no visible identity cannot be silently declared unrelated',async()=>{
  const j=await record('conversation'),key=randomUUID();const c=await admin.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[w]);await c.query("INSERT INTO idempotency(workspace_id,environment,actor_id,operation,key,request_hash,response,status_code) VALUES($1,'REAL','PRIVATE_ACTOR','fixture',$2,'fixture',$3,200)",[w,key,{_encrypted_response:'PRIVATE_CIPHER'}]);await c.query('COMMIT');}finally{c.release();}try{const r=await read(j.id);expect(r.entries.find((x:any)=>x.relation==='idempotency')?.classification).toBe('OPAQUE');expect(r.unclassified_references).toBeGreaterThan(0);expect(JSON.stringify(r)).not.toContain('PRIVATE_');}finally{await admin.query('DELETE FROM idempotency WHERE workspace_id=$1 AND key=$2',[w,key]);}
 });
 it('ignores another profile and SIMULATION even when they contain an opaque matching UUID',async()=>{
  const j=await record('conversation'),b=await record('fixture',{nested:j.id},other),sim=await record('fixture',{nested:j.id},w,'SIMULATION');const r=await read(j.id);expect(r.entries.some((x:any)=>[b.id,sim.id].includes(x.identity))).toBe(false);
 });
 it('requires current source version, correct profile, REAL and repeatable-read context',async()=>{
  const j=await record('conversation');await expect(read(j.id,2)).rejects.toThrow('SOURCE_CHANGED');await expect(read(j.id,1,other)).rejects.toThrow('SOURCE_CHANGED');await expect(read(j.id,1,w,'SIMULATION')).rejects.toThrow('CONTEXT_REQUIRED');await expect(read(j.id,1,w,'REAL','READ COMMITTED')).rejects.toThrow('CONTEXT_REQUIRED');
 });
 it('rejects structure drift before returning any partial evidence',async()=>{
  const j=await record('conversation');await admin.query('ALTER TABLE records ADD COLUMN privacy_fixture_extra text');try{await expect(read(j.id)).rejects.toThrow('ACCESS_CHANGED');}finally{await admin.query('ALTER TABLE records DROP COLUMN privacy_fixture_extra');}
 });
 it('new materialized copies invalidate the catalog instead of escaping retention inventory',async()=>{
  const j=await record('conversation');await admin.query('CREATE MATERIALIZED VIEW privacy_fixture_copy AS SELECT id FROM records');try{await expect(read(j.id)).rejects.toThrow('SCHEMA_CHANGED');}finally{await admin.query('DROP MATERIALIZED VIEW privacy_fixture_copy');}
 });
 it('rejects RLS/ACL drift rather than returning a falsely empty inventory',async()=>{
  const j=await record('conversation');await admin.query('ALTER TABLE records DISABLE ROW LEVEL SECURITY');try{await expect(read(j.id)).rejects.toThrow('ACCESS_CHANGED');}finally{await admin.query('ALTER TABLE records ENABLE ROW LEVEL SECURITY');}expect((await read(j.id)).entries.length).toBeGreaterThan(0);
 });
 it('an added function EXECUTE grant fails the dedicated-port access pin',async()=>{
  const j=await record('conversation');await admin.query('GRANT EXECUTE ON FUNCTION privacy_reference_inventory(uuid,integer) TO commerce_api');try{await expect(read(j.id)).rejects.toThrow('ACCESS_CHANGED');}finally{await admin.query('REVOKE EXECUTE ON FUNCTION privacy_reference_inventory(uuid,integer) FROM commerce_api');}expect((await read(j.id)).entries.length).toBeGreaterThan(0);
 });
 it('worker privilege drift blocks before data even when row ACLs are unchanged',async()=>{
  const j=await record('conversation');await admin.query('ALTER ROLE commerce_privacy_worker INHERIT');try{await expect(read(j.id)).rejects.toThrow('ACCESS_CHANGED');}finally{await admin.query('ALTER ROLE commerce_privacy_worker NOINHERIT');}expect((await read(j.id)).entries.length).toBeGreaterThan(0);
 });
 it('a new worker membership cannot silently expand the inventory caller set',async()=>{
  const j=await record('conversation');await admin.query('GRANT commerce_privacy_worker TO commerce_api');try{await expect(read(j.id)).rejects.toThrow('ACCESS_CHANGED');}finally{await admin.query('REVOKE commerce_privacy_worker FROM commerce_api');}expect((await read(j.id)).entries.length).toBeGreaterThan(0);
 });
 it('readback has stable hashes and no row/version mutations',async()=>{
  const j=await record('conversation',{status:'CLOSED'}),before=(await admin.query('SELECT to_jsonb(r) row FROM records r WHERE id=$1',[j.id])).rows[0];const a=await read(j.id),b=await read(j.id);expect(a.inventory_sha256).toBe(b.inventory_sha256);expect(a.source_sha256).toBe(b.source_sha256);expect((await admin.query('SELECT to_jsonb(r) row FROM records r WHERE id=$1',[j.id])).rows[0]).toEqual(before);
 });
 it('worker cannot read base tables, modify history or assume the closed owner',async()=>{
  await expect(worker.query('SELECT body FROM records')).rejects.toThrow('permission denied');await expect(worker.query("UPDATE record_versions SET body='{}'" )).rejects.toThrow('permission denied');await expect(worker.query('SET ROLE commerce_privacy_inventory_owner')).rejects.toThrow('permission denied');
 });
});
