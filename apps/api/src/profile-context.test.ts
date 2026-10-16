import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {FastifyRequest} from 'fastify';
import type {Principal} from '../../../packages/domain/src/core/permissions.js';
const state=vi.hoisted(()=>({current:undefined as string|undefined,calls:[] as {sql:string;values?:unknown[];profile?:string}[],release:vi.fn(),connect:vi.fn(),query:vi.fn(),record:undefined as Record<string,unknown>|undefined,cached:undefined as Record<string,unknown>|undefined}));
vi.mock('./auth.js',()=>({auth:{},trustedOrigins:['http://localhost:3001']}));
vi.mock('../../../packages/db/src/index.js',async importOriginal=>({
 ...await importOriginal<object>(),pool:{connect:state.connect,query:vi.fn(()=>{throw new Error('UNSCOPED_POOL_QUERY');})},
}));
import {mutate,principalMap,scopedRecord} from './context.js';
const id='00000000-0000-4000-8000-000000000001';
function request(workspace='one'){
 const req={method:'POST',headers:{'idempotency-key':'scoped-replay-1','x-workspace-id':'forged'},body:{environment:'SIMULATION',workspace_id:'forged'},query:{},params:{},id:'request-one'} as unknown as FastifyRequest;
 principalMap.set(req,{user:{id:'user-one',name:'Test',email:''},workspace_id:workspace,role:'owner',permissions:['*'],service:false,authentication_method:'session',scopes:[]} as Principal);
 return req;
}
beforeEach(()=>{
 state.current=undefined;state.calls=[];state.record=undefined;state.cached=undefined;state.release.mockClear();state.connect.mockReset();state.query.mockReset();
 state.query.mockImplementation(async(sql:string,values?:unknown[])=>{
  state.calls.push({sql,values,profile:state.current});
  if(sql.includes("set_config('app.workspace_id'"))state.current=values?.[0] as string;
  else if(sql==='COMMIT'||sql==='ROLLBACK')state.current=undefined;
  else if(sql!=='BEGIN'&&!sql.startsWith('SET LOCAL')&&!state.current)throw new Error('MISSING_PROFILE_CONTEXT');
  const rows=sql.startsWith('SELECT * FROM idempotency')?(state.cached?[state.cached]:[]):sql.startsWith('SELECT * FROM records')?(state.record?[state.record]:[]):[];
  return{rows,rowCount:rows.length,command:sql==='COMMIT'?'COMMIT':'SELECT',fields:[],oid:0};
 });
 state.connect.mockResolvedValue({query:state.query,release:state.release});
});
describe('API profile transaction consumers',()=>{
 it('uses the authenticated profile for authority, replay and business SQL despite forged selectors',async()=>{
  const req=request();
  await expect(mutate(req,'catalog.update',async c=>{
   expect(c.workspaceId).toBe('one');expect(Object.keys(c).sort()).toEqual(['query','workspaceId']);
   await c.query('UPDATE business SET value=$1',['sample']);return{data:{saved:true}};
  })).resolves.toEqual({data:{saved:true}});
  const business=state.calls.filter(x=>/idempotency|advisory|UPDATE business/.test(x.sql));
  expect(business.length).toBeGreaterThan(2);expect(business.every(x=>x.profile==='one')).toBe(true);
  expect(state.calls.find(x=>x.sql.startsWith('INSERT INTO idempotency'))?.values?.slice(0,4)).toEqual(['one','user-one','catalog.update','scoped-replay-1']);
  expect(state.current).toBeUndefined();expect(state.release).toHaveBeenCalledOnce();
 });
 it('rolls back the complete mutation and never records success after business failure',async()=>{
  await expect(mutate(request(),'catalog.update',async c=>{await c.query('UPDATE business SET value=$1',['sample']);throw new Error('fail business');})).rejects.toThrow('fail business');
  expect(state.calls.at(-1)?.sql).toBe('ROLLBACK');expect(state.calls.some(x=>x.sql.startsWith('INSERT INTO idempotency'))).toBe(false);
  expect(state.current).toBeUndefined();
 });
 it('preserves the idempotency conflict before calling business code',async()=>{
  state.cached={request_hash:'different',response:{saved:true},status_code:200};const work=vi.fn();
  await expect(mutate(request(),'catalog.update',work)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect(work).not.toHaveBeenCalled();expect(state.calls.at(-1)?.sql).toBe('ROLLBACK');
 });
 it('scopes a standalone record read and preserves a supplied transaction',async()=>{
  const req=request();state.record={id,workspace_id:'one',kind:'product',environment:'SIMULATION',body:{},version:1,created_at:'2026-10-11',updated_at:'2026-10-11'};
  expect((await scopedRecord(req,'product',id)).id).toBe(id);
  expect(state.calls.find(x=>x.sql.startsWith('SELECT * FROM records'))?.profile).toBe('one');expect(state.connect).toHaveBeenCalledOnce();
  await mutate(req,'catalog.update',async c=>({data:await scopedRecord(req,'product',id,c)}));
  expect(state.connect).toHaveBeenCalledTimes(2);expect(state.calls.filter(x=>x.sql==='BEGIN')).toHaveLength(2);
 });
 it('keeps record environment and absence guards inside the profile transaction',async()=>{
  const req=request();state.record={id,workspace_id:'one',kind:'product',environment:'REAL',body:{}};
  await expect(scopedRecord(req,'product',id)).rejects.toMatchObject({code:'NOT_FOUND'});
  expect(state.calls.at(-1)?.sql).toBe('ROLLBACK');
 });
});
