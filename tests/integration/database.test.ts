import { describe,it,expect,afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { pool,putRecord,withTransaction,encrypt,decrypt,stableJson } from '../../packages/db/src/index.js';
const workspace='db-'+randomUUID();
afterAll(async()=>pool.end());
describe('PostgreSQL durable domain invariants',()=>{
 it('rejects cross-workspace and cross-environment offer references at database boundary',async()=>{
  const product=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'A'}});
  await expect(putRecord(pool,{workspaceId:'different',environment:'SIMULATION',kind:'offer',body:{product_id:product.id,currency:'MXN',base_amount_minor:100}})).rejects.toThrow('INVALID_SCOPED_REFERENCE');
  await expect(putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'offer',body:{product_id:product.id,currency:'MXN',base_amount_minor:100}})).rejects.toThrow('INVALID_SCOPED_REFERENCE');
 });
 it('preserves immutable offer snapshots and protects historical revisions',async()=>{
  const p=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Original'}});
  const offer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{product_id:p.id,currency:'MXN',base_amount_minor:9900}});
  await putRecord(pool,{id:p.id,version:1,workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Changed'}});
  const versions=(await pool.query('SELECT body FROM record_versions WHERE record_id=$1 ORDER BY version',[p.id])).rows;
  expect(versions.map(v=>v.body.name)).toEqual(['Original','Changed']);
  await expect(putRecord(pool,{id:offer.id,version:1,workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{...offer.body,base_amount_minor:1}})).rejects.toThrow('IMMUTABLE_VERSION');
  await expect(pool.query("UPDATE record_versions SET body='{}' WHERE record_id=$1",[p.id])).rejects.toThrow('IMMUTABLE_EVIDENCE');
 });
 it('allows exactly one of two concurrent edits and rolls back partial business transitions',async()=>{
  const p=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Conflict'}});
  const results=await Promise.allSettled(['one','two'].map(name=>putRecord(pool,{id:p.id,version:1,workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name}})));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  const id=randomUUID();
  await expect(withTransaction(async c=>{await putRecord(c,{id,workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Rollback'}});throw new Error('Injected failure before commit');})).rejects.toThrow('Injected failure');
  expect((await pool.query('SELECT id FROM records WHERE id=$1',[id])).rowCount).toBe(0);
 });
 it('canonicalizes optional values identically before and after JSONB storage',async()=>{
  const payload={kind:'text',optional:undefined,nested:{b:2,a:1},values:[undefined,3]};
  const stored=(await pool.query('SELECT $1::jsonb AS payload',[JSON.stringify(payload)])).rows[0].payload;
  expect(stableJson(payload)).toBe(stableJson(stored));
 });
 it('authenticates encrypted envelopes and never stores cleartext in ciphertext',()=>{
  const input='synthetic evidence '+randomUUID(),a=encrypt(input),b=encrypt(input);
  expect(a).not.toContain(input);expect(a).not.toBe(b);expect(decrypt(a)).toBe(input);
  const parts=a.split('.');parts[2]=Buffer.alloc(16).toString('base64');expect(()=>decrypt(parts.join('.'))).toThrow();
 });
});
