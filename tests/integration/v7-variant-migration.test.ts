import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {pool,withTransaction,encrypt} from '../../packages/db/src/index.js';
import {planVariantMigration,applyVariantMigration,variantMigrationDigest} from '../../packages/db/src/variant-migration.js';
import {planContinuityAdoption,applyContinuityAdoption,adoptionPlanDigest} from '../../packages/db/src/continuity-adoption.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {roleExecutor} from '../support/database-role.js';

// V7 F4 DR-MIG-02/03 (RF-05.e, RF-08.d): one existing product → one parent with
// one Mexico variant whose first release pins exactly the records it sells with
// today. Counts, UUID map and checksums are reported; history is not rewritten;
// the authorized assignment follows the variant with the same revision, so its
// permanent continuity is still adopted afterwards. Nothing is sent.
const P='variant-migration-'+randomUUID();
const withRole=roleExecutor(pool);
beforeAll(()=>fixtureProfiles({id:P,numbers:5}));
afterAll(async()=>{await pool.end();});
async function inProfile<T>(work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function owner<T>(work:(c:import('pg').PoolClient)=>Promise<T>,commit=true){
 const c=await pool.connect();try{await c.query('BEGIN');const r=await work(c);await c.query(commit?'COMMIT':'ROLLBACK');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}

it('maps each product to a Mexico variant pinned to what it sells, without rewriting history',async()=>{
 const ids=await inProfile(async c=>{
  const rec=async(kind:string,body:object)=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL',$2,$3) RETURNING id",[P,kind,body])).rows[0].id as string;
  const product=await rec('product',{name:'Producto histórico',status:'PUBLISHED'}),empty=await rec('product',{name:'Producto sin oferta',status:'DRAFT'});
  const asset=await rec('asset',{name:'Material histórico',kind:'link',url:'https://example.com/m',status:'READY'});
  const flow=await rec('workflow',{name:'Flujo histórico',product_id:product,entry_node_id:'offer',max_steps:20,status:'PUBLISHED',nodes:[{id:'offer',type:'message',config:{text:'Oferta'},next:'end'},{id:'end',type:'end',config:{}}]});
  const agent=await rec('agent',{name:'Asesora histórica',product_id:product,provider:'workspace',model:null,max_cost_minor:0,instructions:'Instrucciones históricas',knowledge:'Conocimiento'});
  const bank=await rec('bank_profile',{name:'Cuenta histórica',bank:'Banco sintético',currency:'MXN',last4:'1234',secret_ciphertext:encrypt({holder:'Titular sintético',account_number:'000000001234',instructions:''})});
  const offer=await rec('offer',{name:'Oferta histórica',product_id:product,currency:'MXN',base_amount_minor:9700,payment_method:'bank_transfer_receipt',payment_profile_version_id:bank,workflow_version_id:flow,agent_version_id:agent,
   fulfillment:[{asset_id:asset,release_on:'receipt_approved'}],billing_delay_seconds:1800,positive_payment_unlocks_all:false,status:'PUBLISHED',entry_aliases:['producto histórico']});
  const account=await rec('channel_account',{name:'Número histórico',provider:'simulator',status:'WORKING'});
  const binding=await rec('binding',{account_id:account,product_id:product,offer_version_id:offer,workflow_version_id:flow,agent_version_id:agent,valid_from:'2026-01-01T00:00:00Z'});
  const assignment=(await c.query("INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id) VALUES($1,'REAL',$2,$3,$4) RETURNING id",[P,account,product,binding])).rows[0].id;
  const auth=(await c.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'REAL','owner-human',$2,'synthetic',now()+interval '1 day') RETURNING id",[P,{mode:'product_assignment',assignment_id:assignment,assignment_revision:1,binding_id:binding,product_id:product,account_ids:[account]}])).rows[0].id;
  await c.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[assignment,auth]);
  const contact=await rec('contact',{name:'Cliente sintético',status:'ACTIVE',identity:'opaque:historico'});
  const old=await rec('conversation',{account_id:account,contact_id:contact,status:'OPEN',offer_version_id:offer,product_id:product,assignment_id:assignment,assignment_revision:1,binding_id:binding});
  return{product,empty,asset,flow,agent,bank,offer,account,assignment,old};
 });
 const before=await inProfile(async c=>(await c.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND kind IN('offer','workflow','agent','bank_profile','conversation','binding') ORDER BY id",[P])).rows);
 const plan=await owner(planVariantMigration,false);
 const mine=plan.candidates.filter(c=>c.workspaceId===P);
 expect(mine.map(c=>c.productId).sort()).toEqual([ids.product,ids.empty].sort());
 const exact=mine.find(c=>c.productId===ids.product)!;
 expect(exact).toMatchObject({offerId:ids.offer,flowId:ids.flow,sellerId:ids.agent,collectionId:ids.bank,currency:'MXN',assignments:[ids.assignment],exceptions:[]});
 expect(Object.keys(exact.checksums).sort()).toEqual(['asset:'+ids.asset,'collection','flow','offer','seller'].sort());
 expect(mine.find(c=>c.productId===ids.empty)!.exceptions).toEqual(['NO_PUBLISHED_OFFER']);
 await expect(owner(c=>applyVariantMigration(c,'0'.repeat(64)))).rejects.toThrow('VARIANT_MIGRATION_PLAN_CHANGED');
 const result=await owner(c=>applyVariantMigration(c,variantMigrationDigest(plan)));
 const map=result.uuid_map.filter(r=>r.workspace_id===P);
 expect(map).toHaveLength(2);
 const variant=map.find(r=>r.product_id===ids.product)!;expect(variant.release_id).not.toBeNull();
 expect(map.find(r=>r.product_id===ids.empty)).toMatchObject({release_id:null,exceptions:['NO_PUBLISHED_OFFER']});
 // The release pins exactly the existing records; nothing historical changed.
 const state=await inProfile(async c=>({
  release:(await c.query('SELECT body FROM market_releases WHERE id=$1',[variant.release_id])).rows[0].body,
  v:(await c.query('SELECT document,current_release_id,published_document_sha256 FROM market_variants WHERE id=$1',[variant.variant_id])).rows[0],
  a:(await c.query('SELECT revision,variant_id FROM commercial_assignments WHERE id=$1',[ids.assignment])).rows[0],
  after:(await c.query("SELECT id,version,body FROM records WHERE workspace_id=$1 AND kind IN('offer','workflow','agent','bank_profile','conversation','binding') ORDER BY id",[P])).rows,
 }));
 expect(state.release.configuration).toMatchObject({offer:{id:ids.offer},flow:{id:ids.flow},seller:{id:ids.agent},collection:{id:ids.bank},materials:[{id:ids.asset}]});
 expect(state.release.locale).toEqual({market:'México',currency:'MXN',language:'es-MX',timezone:expect.any(String)});
 expect(state.v.document).toMatchObject({name:'México',sale:{base:'existing',existing_workflow_id:ids.flow,aliases:['producto histórico'],seller:{name:'Asesora histórica'}},offer:{price_minor:9700},collection:{legacy_profile_id:ids.bank,spei:null}});
 expect(state.a).toEqual({revision:1,variant_id:variant.variant_id});
 expect(state.after).toEqual(before);
 // Idempotent: a second plan has nothing left for this profile.
 expect((await owner(planVariantMigration,false)).candidates.filter(c=>c.workspaceId===P)).toEqual([]);
 // The authorized assignment keeps its revision, so continuity is still adopted.
 const adoption=await owner(planContinuityAdoption,false);
 expect(adoption.candidates.filter(c=>c.workspaceId===P).map(c=>c.assignmentId)).toEqual([ids.assignment]);
 await owner(c=>applyContinuityAdoption(c,adoptionPlanDigest(adoption)));
 // A new conversation follows the variant's release: the same offer as before.
 const number=await inProfile(async c=>(await c.query('SELECT * FROM records WHERE id=$1',[ids.account])).rows[0]);
 const chat=(await withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity:'opaque:nuevo',kind:'text',text:'Hola',payload:{}},randomUUID()))))!;
 expect(chat.body).toMatchObject({variant_id:variant.variant_id,release_id:variant.release_id,offer_version_id:ids.offer,workflow_version_id:ids.flow,agent_version_id:ids.agent});
},120000);
