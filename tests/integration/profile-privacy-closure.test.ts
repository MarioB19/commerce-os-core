/** Native database proof using the canonical close command. No erasure performed. */
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema,fixtureProfileRow} from '../support/migrated-database.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
// V7 F2: an installation admits three profiles and 20 numbers; each fresh
// fixture profile is sealed and the oldest are disposed to make room.
const createdProfiles:string[]=[];
const suffix=randomBytes(8).toString('hex'),login='privacy_closure_'+suffix,apiLogin='privacy_closure_api_'+suffix;
let admin:pg.Pool,worker:pg.Pool,api:pg.Pool,scoped:ProfilePool,apiScope:ProfilePool;
async function journey(body:Record<string,unknown>={},environment='REAL'){
 const w='privacy_'+randomUUID(),id=randomUUID();
 await fixtureProfileRow(admin,createdProfiles,w,{businessName:'Synthetic privacy',timezone:'UTC',numbers:1,products:5,daily:100});
 await admin.query('INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,$3,$4,$5)',[id,w,environment,'conversation',{status:'OPEN',...body}]);return{w,id,environment};
}
type Journey=Awaited<ReturnType<typeof journey>>;
async function close(j:Journey,abort=false){
 const c=await admin.connect();try{
  await c.query('BEGIN');
  const cmd=(await c.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'conversation_command',$3,'synthetic-owner',$4,$5) RETURNING *",[j.w,j.environment,j.id,{type:'close_conversation',reason:'SYNTHETIC_RESOLVED'},randomUUID()])).rows[0];
  const result=await applyCommand(c,cmd);await c.query("UPDATE commands SET status='APPLIED',result=$2,updated_at=now() WHERE id=$1",[cmd.id,result]);
  const clock=(await c.query('SELECT now()::text at')).rows[0].at;
  if(abort)throw Error('ABORT_CLOSE');await c.query('COMMIT');return{id:cmd.id,at:clock};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function edit(j:Journey,patch:Record<string,unknown>){await admin.query('UPDATE records SET body=body||$2,version=version+1,updated_at=now() WHERE id=$1',[j.id,patch]);}
async function read(j:Journey,version?:number,pool=scoped,isolation=true,capture=false,abort=false){
 const n=version??(await admin.query('SELECT version FROM records WHERE id=$1',[j.id])).rows[0].version;
 const p:ProfilePool={async connect(){const c=await pool.connect();return{query:(sql,values)=>c.query(sql==='BEGIN'&&isolation?'BEGIN ISOLATION LEVEL REPEATABLE READ':sql,values),release:c.release.bind(c)};}};
 return withProfileTransaction(p,j.w,async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[j.environment]);const result=(await db.query(capture?'SELECT capture_privacy_closure($1,$2) proof':'SELECT privacy_closure_proof($1,$2) proof',[j.id,n])).rows[0].proof;if(abort)throw Error('ABORT_CAPTURE');return result;});
}
describe('D18 authenticated continuous closure',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:4});await requireMigratedProfileSchema(admin);
  
  for(const[name,role]of [[login,'commerce_results'],[apiLogin,'commerce_api']]){
   const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const native=new URL(url);native.username=name;native.password=secret;const pool=new pg.Pool({connectionString:native.toString(),max:3});
   const p:ProfilePool={async connect(){const c=await pool.connect();await c.query(`SET ROLE ${role}`);return{query:c.query.bind(c),release:()=>c.release()};}};if(role==='commerce_results'){worker=pool;scoped=p;}else{api=pool;apiScope=p;}
  }
 },60000);
 afterAll(async()=>{await worker?.end();await api?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}","${apiLogin}"`);}finally{await admin.end();}}});
 it('accepts canonical applied command/event/version and uses the database closure clock',async()=>{
  const j=await journey(),cmd=await close(j),r=await read(j);expect(r.verified).toBe(true);expect(r.closure_version).toBe(2);expect(Date.parse(r.closed_at)).toBe(Date.parse(cmd.at));expect(Date.parse(r.due_at)-Date.parse(r.closed_at)).toBe(180*86400000);expect(r.source_sha256).toMatch(/^[a-f0-9]{64}$/);expect(r.workspace_id).toBe(j.w);expect(JSON.stringify(r)).not.toContain('synthetic-owner');
 });
 it('later incidental edits preserve the original closure clock and advance source identity',async()=>{
  const j=await journey();await close(j);const before=await read(j);await edit(j,{stage:'ARCHIVED',private_note:'SYNTHETIC_PRIVATE_NOTE'});const after=await read(j);expect(after.verified).toBe(true);expect(after.closed_at).toBe(before.closed_at);expect(after.due_at).toBe(before.due_at);expect(after.source_version).toBe(3);expect(after.source_sha256).not.toBe(before.source_sha256);expect(JSON.stringify(after)).not.toContain('SYNTHETIC_PRIVATE_NOTE');
 });
 it('body CLOSED, ancient closed_at and FINISHED workflow without the command do not authorize retention',async()=>{
  const a=await journey({flow_state:{status:'FINISHED'}});expect((await read(a)).reason).toBe('NOT_CLOSED');await edit(a,{status:'CLOSED',closed_at:'2000-01-01T00:00:00Z',closed_by:'synthetic-owner',closed_reason:'SYNTHETIC_RESOLVED'});expect((await read(a)).reason).toBe('CLOSURE_UNVERIFIED');
  const b=await journey({status:'CLOSED',closed_at:'2000-01-01T00:00:00Z'});expect((await read(b)).verified).toBe(false);
 });
 it('backdating the visible closure after a real close loses its authentication',async()=>{
  const j=await journey();await close(j);await edit(j,{closed_at:'2000-01-01T00:00:00Z'});expect((await read(j)).reason).toBe('CLOSURE_UNVERIFIED');
 });
 it('a reopen invalidates old closure and a new canonical close starts a new clock',async()=>{
  const j=await journey();await close(j);await edit(j,{status:'OPEN'});expect((await read(j)).reason).toBe('NOT_CLOSED');await edit(j,{status:'CLOSED'});expect((await read(j)).reason).toBe('CLOSURE_UNVERIFIED');const cmd=await close(j);const r=await read(j);expect(r.verified).toBe(true);expect(r.closure_version).toBe(5);expect(Date.parse(r.closed_at)).toBe(Date.parse(cmd.at));
 });
 it('TEST gets exactly 30 days with identical closure authentication',async()=>{
  const j=await journey({commercial_classification:'TEST'});await close(j);const r=await read(j);expect(r.verified).toBe(true);expect(r.execution_kind).toBe('TEST');expect(Date.parse(r.due_at)-Date.parse(r.closed_at)).toBe(30*86400000);
 });
 it('an unapplied command cannot provide a closure proof',async()=>{
  const j=await journey(),cmd=await close(j);await admin.query("UPDATE commands SET status='FAILED' WHERE id=$1",[cmd.id]);expect((await read(j)).reason).toBe('CLOSURE_UNVERIFIED');
 });
 it('command actor or scope drift cannot authenticate the immutable event',async()=>{
  const j=await journey(),cmd=await close(j);await admin.query("UPDATE commands SET actor_id='different-owner' WHERE id=$1",[cmd.id]);expect((await read(j)).reason).toBe('CLOSURE_UNVERIFIED');
 });
 it('version conflict, foreign journey, SIMULATION, ordinary API and weak isolation reject',async()=>{
  const a=await journey(),b=await journey();await close(a);await expect(read(a,1)).rejects.toThrow('PRIVACY_SOURCE_CHANGED');await expect(read({...a,id:b.id},1)).rejects.toThrow('PRIVACY_SOURCE_CHANGED');await expect(read({...a,environment:'SIMULATION'})).rejects.toThrow('PRIVACY_CONTEXT_REQUIRED');await expect(read(a,undefined,apiScope)).rejects.toThrow('permission denied');await expect(read(a,undefined,scoped,false)).rejects.toThrow('PRIVACY_CONTEXT_REQUIRED');
 });
 it('a close transaction rollback leaves no eligible source or command residue',async()=>{
  const j=await journey();await expect(close(j,true)).rejects.toThrow('ABORT_CLOSE');expect((await read(j)).reason).toBe('NOT_CLOSED');expect((await admin.query('SELECT id FROM commands WHERE workspace_id=$1',[j.w])).rows).toHaveLength(0);
 });
 it('erased stubs are not re-admitted as live sources',async()=>{
  const j=await journey();await close(j);await edit(j,{privacy_erased:true});expect((await read(j)).reason).toBe('ALREADY_ERASED');
 });
 it('proof grants no ability to alter history or erase records',async()=>{
  const j=await journey();await close(j);await expect(withProfileTransaction(scoped,j.w,(db:ProfileExecutor)=>db.query("UPDATE record_versions SET body='{}' WHERE record_id=$1",[j.id]))).rejects.toThrow('permission denied');await expect(withProfileTransaction(scoped,j.w,db=>db.query('DELETE FROM records WHERE id=$1',[j.id]))).rejects.toThrow('permission denied');
 });
 it('captures only minimal verified closure metadata and exact replay is no effect',async()=>{
  const j=await journey();await close(j);const a=await read(j,undefined,scoped,true,true),b=await read(j,undefined,scoped,true,true);expect(a.receipt_status).toBe('CAPTURED');expect(b.receipt_status).toBe('NO_EFFECT');expect(b.closed_at).toBe(a.closed_at);
  const r=(await admin.query('SELECT * FROM privacy_closure_receipts WHERE journey_id=$1',[j.id])).rows[0];expect(Object.keys(r).sort()).toEqual(['workspace_id','environment','journey_id','journey_kind','closure_version','closed_at','closure_source_hash','closure_identity_hash','captured_at'].sort());expect(JSON.stringify(r)).not.toContain('SYNTHETIC_RESOLVED');expect(JSON.stringify(r)).not.toContain('synthetic-owner');
 });
 it('a retained receipt authenticates without reading the expiring event log',async()=>{
  const j=await journey();await close(j);const before=await read(j,undefined,scoped,true,true);
  // Remove only reader privilege in this isolated DB, not actual log rows or guards.
  await admin.query('REVOKE SELECT ON domain_events,commands FROM commerce_result_custody');
  try{const after=await read(j);expect(after.verified).toBe(true);expect(after.closed_at).toBe(before.closed_at);expect(after.due_at).toBe(before.due_at);}finally{await admin.query('GRANT SELECT ON domain_events,commands TO commerce_result_custody');}
 });
 it('a durable receipt cannot authenticate a reopened or edited closure episode',async()=>{
  const j=await journey();await close(j);await read(j,undefined,scoped,true,true);await edit(j,{closed_by:'different-owner'});expect((await read(j)).verified).toBe(false);await edit(j,{status:'OPEN'});await edit(j,{status:'CLOSED',closed_by:'synthetic-owner'});expect((await read(j)).verified).toBe(false);
 });
 it('unverified capture and ordinary-role insertion are rejected without a receipt',async()=>{
  const j=await journey({status:'CLOSED'});await expect(read(j,undefined,scoped,true,true)).rejects.toThrow('PRIVACY_CLOSURE_UNVERIFIED');expect((await admin.query('SELECT journey_id FROM privacy_closure_receipts WHERE journey_id=$1',[j.id])).rows).toHaveLength(0);
  await expect(withProfileTransaction(scoped,j.w,db=>db.query('INSERT INTO privacy_closure_receipts SELECT * FROM privacy_closure_receipts'))).rejects.toThrow('permission denied');await expect(read(j,undefined,apiScope,true,true)).rejects.toThrow('permission denied');
 });
 it('capture rollback preserves no receipt and a successful later retry captures once',async()=>{
  const j=await journey();await close(j);await expect(read(j,undefined,scoped,true,true,true)).rejects.toThrow('ABORT_CAPTURE');expect((await admin.query('SELECT journey_id FROM privacy_closure_receipts WHERE journey_id=$1',[j.id])).rows).toHaveLength(0);expect((await read(j,undefined,scoped,true,true)).receipt_status).toBe('CAPTURED');
 });
});
