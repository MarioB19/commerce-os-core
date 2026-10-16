/** Native database proof using the canonical close command. No erasure performed. */
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {requireMigratedProfileSchema,fixtureProfileRow} from '../support/migrated-database.js';
import {recognizeReceipt} from '../../packages/db/src/receipt-sales.js';
import type {Body} from '../../packages/contracts/src/index.js';
import {applyCommand} from '../../apps/automation-worker/src/commands.js';
import {withProfileTransaction,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
// V7 F2: an installation admits three profiles and 20 numbers; each fresh
// fixture profile is sealed and the oldest are disposed to make room.
const createdProfiles:string[]=[];
const suffix=randomBytes(8).toString('hex'),login='commercial_closure_'+suffix,apiLogin='commercial_api_'+suffix,automationLogin='commercial_worker_'+suffix;
let admin:pg.Pool,worker:pg.Pool,api:pg.Pool,scoped:ProfilePool,automation:pg.Pool,automationScope:ProfilePool;
async function journey(body:Record<string,unknown>={},environment='REAL'){
 const w='privacy_'+randomUUID(),id=randomUUID();
 await fixtureProfileRow(admin,createdProfiles,w,{businessName:'Synthetic privacy',timezone:'UTC',numbers:1,products:5,daily:100});
 await admin.query('INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,$3,$4,$5)',[id,w,environment,'conversation',{status:'OPEN',...body}]);return{w,id,environment};
}
type Journey=Awaited<ReturnType<typeof journey>>;
async function close(j:Journey,abort=false){
 const cmd=(await admin.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'conversation_command',$3,'synthetic-owner',$4,$5) RETURNING *",[j.w,j.environment,j.id,{type:'close_conversation',reason:'SYNTHETIC_RESOLVED'},randomUUID()])).rows[0];
 return withProfileTransaction(automationScope,j.w,async c=>{await c.query("SELECT set_config('app.environment',$1,true)",[j.environment]);const result=await applyCommand(c,cmd);await c.query("UPDATE commands SET status='APPLIED',result=$2,updated_at=now() WHERE id=$1",[cmd.id,result]);const clock=(await c.query('SELECT now()::text at')).rows[0].at;if(abort)throw Error('ABORT_CLOSE');return{id:cmd.id,at:clock,result};});
}
async function read(j:Journey,version?:number,pool=scoped,isolation=true,capture=false,abort=false){
 const n=version??(await admin.query('SELECT version FROM records WHERE id=$1',[j.id])).rows[0].version;
 const p:ProfilePool={async connect(){const c=await pool.connect();return{query:(sql,values)=>c.query(sql==='BEGIN'&&isolation?'BEGIN ISOLATION LEVEL REPEATABLE READ':sql,values),release:c.release.bind(c)};}};
 return withProfileTransaction(p,j.w,async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[j.environment]);const result=(await db.query(capture?'SELECT capture_privacy_closure($1,$2) proof':'SELECT privacy_closure_proof($1,$2) proof',[j.id,n])).rows[0].proof;if(abort)throw Error('ABORT_CAPTURE');return result;});
}
async function record(j:Journey,kind:string,body:Body){return(await admin.query('INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,$3,$4) RETURNING *',[j.w,j.environment,kind,body])).rows[0];}
async function update(id:string,patch:Body){await admin.query('UPDATE records SET body=body||$2,version=version+1,updated_at=now() WHERE id=$1',[id,patch]);}
async function order(j:Journey,options:{paid?:number;delivery?:string;access?:boolean;reconcile?:boolean;uncommitted?:boolean;test?:boolean}={}){
 const asset=await record(j,'asset',{kind:options.access?'access':'file',adapter:options.access?'webhook':'file',status:'READY',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex')});
 const o=await record(j,'order',{conversation_id:j.id,currency:'MXN',amount_minor:100,offer_snapshot:{base_amount_minor:100,currency:'MXN',fulfillment:[{asset_id:asset.id,release_on:'receipt_approved'}]},...(options.uncommitted?{}:{committed_at:new Date().toISOString()}),...(options.test?{commercial_classification:'TEST'}:{})});
 let receipt:Body|undefined,contribution:Body|undefined;
 if(!options.uncommitted&&!options.reconcile){const evidence=await record(j,'asset',{kind:'file',status:'READY',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex')});receipt=await record(j,'receipt',{order_id:o.id,conversation_id:j.id,asset_id:evidence.id,status:'APPROVED',extraction:{amount_minor:options.paid??100,currency:'MXN'}});
  await withProfileTransaction(automationScope,j.w,async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[j.environment]);const r=await recognizeReceipt(db,receipt as any,{actor:'synthetic-reviewer',cause:randomUUID()});contribution=r.contribution;});
 }
 let fulfillment:Body|undefined,effect:Body|undefined,grant:Body|undefined;
 if(options.delivery){fulfillment=await record(j,'fulfillment',{order_id:o.id,conversation_id:j.id,asset_id:asset.id,release_on:'receipt_approved',status:options.delivery});
  if(options.access)grant=await effectRow(j,{kind:'grant',asset_id:asset.id,grant_id:fulfillment!.id},'SENT',{access_ciphertext:'synthetic-protected-access'});
  effect=await effectRow(j,{kind:'document',fulfillment_id:fulfillment!.id,...(grant?{grant_effect_id:grant.id}:{asset_id:asset.id})},options.delivery);await update(fulfillment!.id,{effect_id:effect!.id,...(grant?{grant_effect_id:grant.id}:{})});
 }
 return{o,asset,receipt,contribution,fulfillment,effect,grant};
}
async function effectRow(j:Journey,payload:Body,status:string,result:Body={}){const e=(await admin.query("INSERT INTO outbox(workspace_id,environment,account_id,contact_id,conversation_id,logical_key,payload,status,config_hash,provider_message_id,result) VALUES($1,$2,'synthetic-account','synthetic-contact',$3,$4,$5,$6,'synthetic-config',$7,$8) RETURNING *",[j.w,j.environment,j.id,randomUUID(),payload,status,['SENT','DELIVERED','READ'].includes(status)?randomUUID():null,result])).rows[0];if(e.provider_message_id)await admin.query("INSERT INTO effect_attempts(effect_id,claim_id,status,result,finished_at) VALUES($1,$2,'SENT',$3,now())",[e.id,randomUUID(),{provider_message_id:e.provider_message_id}]);return e;}
async function reconcile(j:Journey,o:Body,amount=100){
 const asset=await record(j,'asset',{kind:'file',status:'READY',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex')});
 const cmd=(await admin.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,idempotency_key) VALUES($1,$2,'order_reconcile',$3,'synthetic-owner',$4,$5) RETURNING *",[j.w,j.environment,o.id,{amount_minor:amount,currency:'MXN',reason:'SYNTHETIC_BANK_RECONCILIATION',evidence_asset_id:asset.id},randomUUID()])).rows[0];
 // Canonical reconciliation remains the source; an already supplied delivery is
 // reused and no real channel/provider exists in this fixture.
 await withProfileTransaction(automationScope,j.w,async db=>{await db.query("SELECT set_config('app.environment',$1,true)",[j.environment]);const result=await applyCommand(db,cmd);await db.query("UPDATE commands SET status='APPLIED',result=$2,updated_at=now() WHERE id=$1",[cmd.id,result]);});return cmd;
}
async function status(j:Journey){return(await admin.query('SELECT body FROM records WHERE id=$1',[j.id])).rows[0].body.status;}
describe('explicit human commercial closure native ledger and delivery',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_TEST_DATABASE_REQUIRED');admin=new pg.Pool({connectionString:url.toString(),max:4});await requireMigratedProfileSchema(admin);
  
  for(const[name,role]of [[login,'commerce_results'],[apiLogin,'commerce_api'],[automationLogin,'commerce_automation']]){
   const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const native=new URL(url);native.username=name;native.password=secret;const pool=new pg.Pool({connectionString:native.toString(),max:3});
   const p:ProfilePool={async connect(){const c=await pool.connect();await c.query(`SET ROLE ${role}`);return{query:c.query.bind(c),release:()=>c.release()};}};if(role==='commerce_results'){worker=pool;scoped=p;}else if(role==='commerce_api'){api=pool;}else{automation=pool;automationScope=p;}
  }
 },60000);
 afterAll(async()=>{await worker?.end();await api?.end();await automation?.end();if(admin){try{await admin.query(`DROP ROLE IF EXISTS "${login}","${apiLogin}","${automationLogin}"`);}finally{await admin.end();}}});
 it('closes a paid delivered order using ledger/event/attempt evidence and025 DB clock',async()=>{const j=await journey(),f=await order(j,{delivery:'DELIVERED'}),c=await close(j);expect(c.result.commercial_resolution.orders[0]).toMatchObject({order_id:f.o.id,classification:'RESOLVED',paid_minor:'100'});const proof=await read(j);expect(proof.verified).toBe(true);expect(Date.parse(proof.closed_at)).toBe(Date.parse(c.at));});
 it('checks every order instead of accepting the first resolved one',async()=>{const j=await journey();await order(j,{delivery:'DELIVERED'});await order(j,{paid:50,delivery:'DELIVERED'});await expect(close(j)).rejects.toThrow('COMMERCIAL_COMMITMENT_REQUIRES_HUMAN_RESOLUTION');expect(await status(j)).toBe('OPEN');});
 it('rejects partial despite body claiming payment and delivery complete',async()=>{const j=await journey(),f=await order(j,{paid:50,delivery:'DELIVERED'});await update(f.o.id,{sale_status:'RECOGNIZED',sale_amount_minor:100,reconciliation_status:'RECONCILED',fulfillment_status:'DELIVERED'});await expect(close(j)).rejects.toThrow('COMMERCIAL_COMMITMENT_REQUIRES_HUMAN_RESOLUTION');});
 it('rejects current FALSE or TEST receipts while preserving the contribution',async()=>{for(const classification of ['FALSE','TEST']){const j=await journey(),f=await order(j,{delivery:'DELIVERED'});await update(f.receipt!.id,{commercial_classification:classification});await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_PAYMENT_UNVERIFIED');expect((await admin.query('SELECT id FROM payment_contributions WHERE id=$1',[f.contribution!.id])).rowCount).toBe(1);}});
 it('rejects changed evidence, duplicate or pending review after recognition',async()=>{for(const delta of [{status:'HUMAN_REVIEW'},{duplicate_of:randomUUID()},{extraction:{amount_minor:101,currency:'MXN'}}]){const j=await journey(),f=await order(j,{delivery:'DELIVERED'});await update(f.receipt!.id,delta);await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_PAYMENT_UNVERIFIED');}});
 it('does not trust a ledger row with no matching canonical recognition event',async()=>{const j=await journey(),f=await order(j,{delivery:'DELIVERED'});await admin.query("UPDATE payment_contributions SET provenance='{}' WHERE id=$1",[f.contribution!.id]);await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_PAYMENT_UNVERIFIED');});
 it('rejects changed original order terms',async()=>{const j=await journey(),f=await order(j,{delivery:'DELIVERED'});await update(f.o.id,{amount_minor:1});await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_TERMS_CHANGED');});
 it('rejects missing promised material and a merely SENT message',async()=>{for(const delivery of [undefined,'SENT']){const j=await journey();await order(j,{delivery});await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_DELIVERY_UNVERIFIED');}});
 it('requires acceptance history, not only a mutable outbox/body DELIVERED label',async()=>{const j=await journey(),f=await order(j,{delivery:'DELIVERED'});await admin.query("UPDATE effect_attempts SET status='UNKNOWN' WHERE effect_id=$1",[f.effect!.id]);await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_DELIVERY_UNVERIFIED');});
 it('accepts confirmed grants but rejects grant status drift or missing access',async()=>{const j=await journey();await order(j,{delivery:'READ',access:true});expect((await close(j)).result.status).toBe('CLOSED');const b=await journey(),f=await order(b,{delivery:'DELIVERED',access:true});await admin.query("UPDATE outbox SET result='{}' WHERE id=$1",[f.grant!.id]);await expect(close(b)).rejects.toThrow('COMMERCIAL_CLOSURE_GRANT_UNVERIFIED');});
 it('keeps UNKNOWN/SENDING effects without cancellation or closure',async()=>{for(const state of ['UNKNOWN','SENDING']){const j=await journey();await order(j,{delivery:'DELIVERED'});const e=await effectRow(j,{kind:'text'},state);await expect(close(j)).rejects.toThrow('CONVERSATION_HAS_IN_FLIGHT_EFFECTS');expect((await admin.query('SELECT status FROM outbox WHERE id=$1',[e.id])).rows[0].status).toBe(state);}});
 it('does not cancel a pending grant to manufacture resolution',async()=>{const j=await journey();await order(j,{delivery:'DELIVERED'});await effectRow(j,{kind:'grant'},'BLOCKED');await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_PENDING_DELIVERY');});
 it('requires matching classification and preserves explicit legitimate TEST',async()=>{const j=await journey();await order(j,{test:true,delivery:'DELIVERED'});await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_TEST_MISMATCH');const t=await journey({commercial_classification:'TEST'});await order(t,{uncommitted:true,test:true});expect((await close(t)).result.commercial_resolution.classification).toBe('TEST');});
 it('uses canonical applied reconciliation instead of a body status claim',async()=>{const j=await journey(),f=await order(j,{reconcile:true,delivery:'DELIVERED'});await reconcile(j,f.o);expect((await close(j)).result.commercial_resolution.orders[0].reconciled_minor).toBe('100');});
 it('rejects a failed or partial reconciliation without consuming another payment',async()=>{const j=await journey(),f=await order(j,{reconcile:true,delivery:'DELIVERED'}),cmd=await reconcile(j,f.o);await admin.query("UPDATE commands SET status='FAILED' WHERE id=$1",[cmd.id]);await expect(close(j)).rejects.toThrow('COMMERCIAL_CLOSURE_RECONCILIATION_UNVERIFIED');const k=await journey(),g=await order(k,{reconcile:true,delivery:'DELIVERED'});await reconcile(k,g.o,50);await expect(close(k)).rejects.toThrow('COMMERCIAL_COMMITMENT_REQUIRES_HUMAN_RESOLUTION');});
 it('rollback preserves open source and no close event/result, then one retry closes',async()=>{const j=await journey();await order(j,{delivery:'DELIVERED'});await expect(close(j,true)).rejects.toThrow('ABORT_CLOSE');expect(await status(j)).toBe('OPEN');expect((await admin.query("SELECT id FROM domain_events WHERE aggregate_id=$1 AND event_type='conversation.closed'",[j.id])).rows).toHaveLength(0);expect((await close(j)).result.status).toBe('CLOSED');});
 it('uncommitted offers may close and FINISHED alone never creates closure proof',async()=>{const j=await journey({flow_state:{status:'FINISHED'}});await order(j,{uncommitted:true});expect((await read(j)).verified).toBe(false);expect((await close(j)).result.status).toBe('CLOSED');});
 it('profile and environment cannot borrow another financial or delivery source',async()=>{const a=await journey(),b=await journey();await order(a,{delivery:'DELIVERED'});await order(b,{paid:1,delivery:'DELIVERED'});await expect(close(b)).rejects.toThrow('COMMERCIAL_COMMITMENT_REQUIRES_HUMAN_RESOLUTION');await expect(close({...a,environment:'SIMULATION'})).rejects.toThrow('RESOURCE_NOT_FOUND');});

});
