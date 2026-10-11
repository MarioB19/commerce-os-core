import pg from 'pg';
import {it,expect,afterAll} from 'vitest';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pool,putRecord,getRecord} from '../../packages/db/src/index.js';
const schema='v5_migration_'+randomUUID().replaceAll('-','');
afterAll(async()=>pool.end());
it('migrates populated legacy packages and exact pinned journeys without losing original snapshots or authorizations history',async()=>{
 const url=new URL(process.env.DATABASE_URL!);url.pathname='/'+schema;await pool.query(`CREATE DATABASE ${schema} TEMPLATE template0`);const c=new pg.Client({connectionString:url.toString()});await c.connect();
 try{
  const files=(await readdir('packages/db/migrations')).filter(name=>Number(name.slice(0,4))<=36).sort();for(const file of files)await c.query(await readFile('packages/db/migrations/'+file,'utf8'));
  const base={workspaceId:'migration-fixture',environment:'SIMULATION' as const};
  const product=await putRecord(c,{...base,kind:'product',body:{name:'Existing product'}}),offer=await putRecord(c,{...base,kind:'offer',body:{product_id:product.id,name:'Existing offer',base_amount_minor:9700,currency:'MXN'}}),account=await putRecord(c,{...base,kind:'channel_account',body:{name:'Existing account without binding',provider:'simulator',offer_version_id:offer.id}}),contact=await putRecord(c,{...base,kind:'contact',body:{name:'Existing contact',identity:'opaque:fixture'}}),conversation=await putRecord(c,{...base,kind:'conversation',body:{account_id:account.id,contact_id:contact.id,offer_version_id:offer.id,product_id:product.id,started_at:'2026-09-01T00:00:00Z'}});
  const authorization=(await c.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES('migration-fixture','SIMULATION','existing-owner',$1,'fixture',now()+interval '1 hour') RETURNING id",[{mode:'channel_setup',account_ids:[account.id]}])).rows[0];
  await c.query(await readFile('packages/db/migrations/0040_product_assignments.sql','utf8'));
  const relationships=(await c.query('SELECT * FROM commercial_assignments')).rows;expect(relationships).toHaveLength(1);expect(relationships[0]).toMatchObject({account_id:account.id,product_id:product.id,authorization_id:null});
  const current=(await getRecord(c,'migration-fixture','conversation',conversation.id))!;expect(current.body.offer_version_id).toBe(offer.id);expect(current.body.assignment_id).toBe(relationships[0].id);expect(current.version).toBe(2);
  const old=(await c.query('SELECT body FROM record_versions WHERE record_id=$1 AND version=1',[conversation.id])).rows[0];expect(old.body).toEqual(conversation.body);expect((await c.query('SELECT revoked_at FROM operation_authorizations WHERE id=$1',[authorization.id])).rows[0].revoked_at).toBeTruthy();expect((await c.query('SELECT * FROM physical_chats')).rows).toHaveLength(1);
 }finally{await c.end();await pool.query(`DROP DATABASE IF EXISTS ${schema}`);}
});
