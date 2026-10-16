import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {pool} from '../../packages/db/src/index.js';
import {planContinuityAdoption,applyContinuityAdoption,adoptionPlanDigest} from '../../packages/db/src/continuity-adoption.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 cutover (ADR-V7-03, prompt §2 "REAL continuo"): only assignments a human
// had already authorized become permanent grants; nothing is sent or resumed.
const workspace='adoption-'+randomUUID(),suspended='adoption-suspended-'+randomUUID();
beforeAll(()=>fixtureProfiles(workspace,suspended));
afterAll(async()=>{await pool.end();});
async function inProfile<T>(scope:string,work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[scope]);const result=await work(c);await c.query('COMMIT');return result;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function authorized(scope:string,options:{revoked?:boolean;state?:string;revisionDrift?:boolean;expired?:boolean;bindingEnded?:boolean;noAuthorization?:boolean}={}){
 return inProfile(scope,async c=>{
  const record=async(kind:string,body:object)=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL',$2,$3) RETURNING id",[scope,kind,body])).rows[0].id as string;
  const account=await record('channel_account',{name:'Synthetic adoption',provider:'waha',status:'STOPPED',sending_enabled:true}),product=await record('product',{name:'Synthetic product'});
  const binding=await record('binding',{account_id:account,product_id:product,valid_from:'2026-01-01T00:00:00Z',...(options.bindingEnded?{valid_to:'2026-02-01T00:00:00Z'}:{})});
  const assignment=(await c.query("INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id,state) VALUES($1,'REAL',$2,$3,$4,$5) RETURNING id",[scope,account,product,binding,options.state??'ACTIVE'])).rows[0].id as string;
  if(!options.noAuthorization){
   const scopeJson={mode:'product_assignment',assignment_id:assignment,assignment_revision:options.revisionDrift?2:1,binding_id:binding,product_id:product,account_ids:[account]};
   const auth=(await c.query(`INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,revoked_at) VALUES($1,'REAL','owner-human',$2,'synthetic',$3,$4) RETURNING id`,
    [scope,scopeJson,options.expired?new Date(Date.now()-86400000):new Date(Date.now()+86400000),options.revoked?new Date():null])).rows[0].id;
   await c.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[assignment,auth]);
  }
  return{account,assignment};
 });
}
async function txPlan(){const c=await pool.connect();try{await c.query('BEGIN');const plan=await planContinuityAdoption(c);await c.query('ROLLBACK');return plan;}finally{c.release();}}
async function txApply(digest:string){const c=await pool.connect();try{await c.query('BEGIN');const result=await applyContinuityAdoption(c,digest);await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}

it('adopts only already-authorized, current assignments, idempotently and without effects',async()=>{
 const good=await authorized(workspace),expired=await authorized(workspace,{expired:true});
 const revoked=await authorized(workspace,{revoked:true}),draft=await authorized(workspace,{state:'DRAFT'}),drift=await authorized(workspace,{revisionDrift:true});
 const ended=await authorized(workspace,{bindingEnded:true}),never=await authorized(workspace,{noAuthorization:true}),inactive=await authorized(suspended);
 await inProfile(suspended,c=>c.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[suspended]));
 const plan=await txPlan(),mine=(list:{assignmentId:string}[])=>list.map(x=>x.assignmentId);
 expect(mine(plan.candidates).sort()).toEqual([good.assignment,expired.assignment].sort());
 const reasons=Object.fromEntries(plan.excluded.map(x=>[x.assignmentId,x.reason]));
 expect(reasons[revoked.assignment]).toBe('AUTHORIZATION_REVOKED');
 expect(reasons[draft.assignment]).toBe('ASSIGNMENT_NOT_ACTIVE');
 expect(reasons[drift.assignment]).toBe('AUTHORIZATION_SCOPE_CHANGED');
 expect(reasons[ended.assignment]).toBe('BINDING_NOT_CURRENT');
 expect(reasons[inactive.assignment]).toBe('PROFILE_NOT_ACTIVE');
 expect(mine([...plan.candidates,...plan.excluded])).not.toContain(never.assignment);
 await expect(txApply('0'.repeat(64))).rejects.toThrow('ADOPTION_PLAN_CHANGED');
 const outboxBefore=(await pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n,ownershipBefore=(await pool.query('SELECT count(*)::int n FROM session_ownership WHERE NOT frozen')).rows[0].n;
 const result=await txApply(adoptionPlanDigest(plan));
 expect(result).toMatchObject({adopted:2,external_effects:0});
 const rows=await inProfile(workspace,c=>c.query("SELECT state FROM continuous_authorizations WHERE workspace_id=$1 ORDER BY assignment_id",[workspace]));
 expect(rows.rows.map(r=>r.state.source.assignmentId).sort()).toEqual([good.assignment,expired.assignment].sort());
 for(const r of rows.rows)expect(r.state).toMatchObject({createdBy:'owner-human',humanPaused:false,revokedAt:null,protections:[],version:1});
 const events=await inProfile(workspace,c=>c.query("SELECT event FROM continuous_authorization_events WHERE workspace_id=$1",[workspace]));
 expect(events.rows.every(e=>e.event.type==='CREATED'&&e.event.adoption.kind==='V7_AUTHORIZED_ASSIGNMENT')).toBe(true);
 expect((await pool.query('SELECT count(*)::int n FROM outbox')).rows[0].n).toBe(outboxBefore);
 expect((await pool.query('SELECT count(*)::int n FROM session_ownership WHERE NOT frozen')).rows[0].n).toBe(ownershipBefore);
 // Replay: the same origins are reported as adopted and never rewritten.
 const again=await txPlan();expect(again.candidates).toEqual([]);expect(again.already_adopted).toBe(2);
 expect((await txApply(adoptionPlanDigest(again))).adopted).toBe(0);
});
it('refuses to run outside the migration owner',async()=>{
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query('SET LOCAL ROLE commerce_api');await expect(planContinuityAdoption(c)).rejects.toThrow('ADOPTION_MIGRATION_OWNER_REQUIRED');}
 finally{await c.query('ROLLBACK');c.release();}
});
