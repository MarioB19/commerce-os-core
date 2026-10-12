import type pg from 'pg';
import {afterAll,describe,expect,it,vi} from 'vitest';
import {currentProfileExecutor,profileRoutedPool,withProfileQueryRouting} from './profile-query-routing.js';
import {withProfileTransaction,type ProfileExecutor} from './profile-context.js';
import {pool as applicationPool,withTransaction} from './index.js';

const rows=(value:string):pg.QueryResult=>({rows:[{value}],command:'SELECT',rowCount:1,oid:0,fields:[]});
function fixture(id='one'){
 const db:ProfileExecutor=Object.freeze({workspaceId:id,query:vi.fn(async(_sql:string,_values?:unknown[])=>rows(id))});
 const raw={query:vi.fn(async(_sql:string,_values?:unknown[])=>rows('global')),connect:vi.fn(async()=>({query:vi.fn(),release:vi.fn()})),end:vi.fn()};
 return{db,raw,pool:profileRoutedPool(raw)};
}
afterAll(async()=>applicationPool.end());

describe('explicit profile query routing',()=>{
 it('preserves ordinary pool calls outside a profile boundary',async()=>{
  const f=fixture();expect(currentProfileExecutor()).toBeUndefined();
  await f.pool.query('SELECT 1');await f.pool.connect();f.pool.end();
  expect(f.raw.query).toHaveBeenCalledOnce();expect(f.raw.connect).toHaveBeenCalledOnce();expect(f.raw.end).toHaveBeenCalledOnce();
 });
 it('routes a pool query captured before the boundary through its current executor',async()=>{
  const f=fixture(),query=f.pool.query;
  await withProfileQueryRouting(f.db,async()=>{expect((await query('SELECT $1',[1])).rows[0].value).toBe('one');});
  expect(f.raw.query).not.toHaveBeenCalled();expect(f.db.query).toHaveBeenCalledWith('SELECT $1',[1]);
 });
 it('does not mix interleaved requests on the same pool',async()=>{
  const f=fixture(),other=fixture('two');let release!:()=>void;const barrier=new Promise<void>(r=>{release=r;});
  const one=withProfileQueryRouting(f.db,async()=>{await barrier;return(await f.pool.query('SELECT 1')).rows[0].value;});
  const two=withProfileQueryRouting(other.db,async()=>{const value=(await f.pool.query('SELECT 1')).rows[0].value;release();return value;});
  expect(await Promise.all([one,two])).toEqual(['one','two']);expect(f.raw.query).not.toHaveBeenCalled();
 });
 it('refuses a second connection even when the caller catches the refusal',async()=>{
  const f=fixture();await expect(withProfileQueryRouting(f.db,async()=>{await expect(f.pool.connect()).rejects.toThrow('PROFILE_RAW_CONNECTION_FORBIDDEN');return true;})).rejects.toThrow('PROFILE_QUERY_CONTEXT_REJECTED');
  expect(f.raw.connect).not.toHaveBeenCalled();
 });
 it('refuses pool administration and properties in the boundary',async()=>{
  for(const work of [(f:ReturnType<typeof fixture>)=>f.pool.end(),(f:ReturnType<typeof fixture>)=>Object.assign(f.pool,{connect:vi.fn()})]){
   const f=fixture();await expect(withProfileQueryRouting(f.db,async()=>work(f))).rejects.toThrow('PROFILE_POOL_ACCESS_FORBIDDEN');expect(f.raw.end).not.toHaveBeenCalled();
  }
 });
 it('rejects config/callback query forms rather than falling back to raw pg',async()=>{
  for(const args of [[{text:'SELECT 1'}],['SELECT 1',()=>{}],['SELECT 1',[],()=>{}]]){
   const f=fixture();await expect(withProfileQueryRouting(f.db,async()=>Reflect.apply(f.pool.query,undefined,args))).rejects.toThrow('PROFILE_QUERY_SHAPE_REQUIRED');expect(f.raw.query).not.toHaveBeenCalled();expect(f.db.query).not.toHaveBeenCalled();
  }
 });
 it('same executor can nest but another executor of the same profile cannot replace it',async()=>{
  const f=fixture();await withProfileQueryRouting(f.db,async()=>{await withProfileQueryRouting(f.db,async()=>f.pool.query('SELECT 1'));});
  await expect(withProfileQueryRouting(f.db,async()=>withProfileQueryRouting(fixture().db,async()=>1))).rejects.toThrow('PROFILE_QUERY_EXECUTOR_MISMATCH');
 });
 it('rejects any nested profile change without acquiring another connection',async()=>{
  const f=fixture();await expect(withProfileQueryRouting(f.db,async()=>withProfileTransaction(f.pool,'two',async()=>true))).rejects.toThrow('PROFILE_QUERY_CONTEXT_MISMATCH');expect(f.raw.connect).not.toHaveBeenCalled();
 });
 it('joins both transaction helpers without BEGIN, COMMIT or another connection',async()=>{
  const f=fixture();await withProfileQueryRouting(f.db,async()=>{
   await withProfileTransaction(f.pool,'one',async db=>db.query('SELECT 1'));
   await withTransaction(async db=>{expect(Object.keys(db).sort()).toEqual(['query','workspaceId']);await db.query('SELECT 2');});
  });
  expect(vi.mocked(f.db.query).mock.calls.map(x=>x[0])).toEqual(['SELECT 1','SELECT 2']);expect(f.raw.connect).not.toHaveBeenCalled();
 });
 it('does not expose raw client operations through the legacy transaction signature',async()=>{
  const f=fixture();await expect(withProfileQueryRouting(f.db,async()=>{await withTransaction(async client=>{try{client.release();}catch{/* cannot authorize commit */}});})).rejects.toThrow('PROFILE_QUERY_CONTEXT_REJECTED');expect(f.raw.connect).not.toHaveBeenCalled();
 });
 it.each(['legacy','profile','routing'])('a caught business failure in joined %s work cannot commit partial writes',async(kind)=>{
  const f=fixture();await expect(withProfileQueryRouting(f.db,async()=>{
   const work=async(db:{query:ProfileExecutor['query']}=currentProfileExecutor()!)=>{await db.query('UPDATE synthetic');throw new Error('business rejected');};
   try{if(kind==='legacy')await withTransaction(work);else if(kind==='profile')await withProfileTransaction(f.pool,'one',work);else await withProfileQueryRouting(f.db,work);}catch(error){expect((error as Error).message).toBe('business rejected');}
   return 'claimed success';
  })).rejects.toThrow('PROFILE_QUERY_CONTEXT_REJECTED');
  expect(vi.mocked(f.db.query).mock.calls.map(x=>x[0])).toEqual(['UPDATE synthetic']);expect(f.raw.connect).not.toHaveBeenCalled();
 });
 it('invalidates the borrowed executor after success and failure',async()=>{
  for(const failure of [false,true]){
   const f=fixture();let escaped!:ProfileExecutor;
   const run=withProfileQueryRouting(f.db,async()=>{escaped=currentProfileExecutor()!;if(failure)throw new Error('original');});
   if(failure)await expect(run).rejects.toThrow('original');else await run;
   await expect(escaped.query('SELECT late')).rejects.toThrow('PROFILE_QUERY_CONTEXT_CLOSED');expect(f.db.query).not.toHaveBeenCalled();
  }
 });
 it('retains a closed marker in detached continuations and never falls back to global',async()=>{
  const f=fixture();let go!:()=>void;const barrier=new Promise<void>(r=>{go=r;});let delayed!:Promise<unknown>;
  await withProfileQueryRouting(f.db,async()=>{delayed=barrier.then(()=>f.pool.query('SELECT late'));});
  const denied=expect(delayed).rejects.toThrow('PROFILE_QUERY_CONTEXT_CLOSED');go();await denied;expect(f.raw.query).not.toHaveBeenCalled();expect(f.db.query).not.toHaveBeenCalled();
 });
 it('denies using a borrowed executor in an unrelated async chain while still active',async()=>{
  const f=fixture();let ready!:()=>void,go!:()=>void,escaped!:ProfileExecutor;
  const obtained=new Promise<void>(r=>{ready=r;}),barrier=new Promise<void>(r=>{go=r;});
  const run=withProfileQueryRouting(f.db,async()=>{escaped=currentProfileExecutor()!;ready();await barrier;});
  await obtained;await expect(escaped.query('SELECT foreign')).rejects.toThrow('PROFILE_QUERY_EXECUTION_MISMATCH');go();await expect(run).rejects.toThrow('PROFILE_QUERY_CONTEXT_REJECTED');expect(f.db.query).not.toHaveBeenCalled();
 });
 it('never turns a caught SQL error into successful work',async()=>{
  const f=fixture();vi.mocked(f.db.query).mockRejectedValueOnce(new Error('query failed'));
  await expect(withProfileQueryRouting(f.db,async()=>{try{await f.pool.query('SELECT failed');}catch{/* not authority to commit */}return true;})).rejects.toThrow('PROFILE_QUERY_CONTEXT_REJECTED');
 });
 it('holds the native transaction until local work ends and preserves rollback on scope error',async()=>{
  const calls:string[]=[];const connection={query:vi.fn(async(sql:string)=>{calls.push(sql);return{...rows('one'),command:sql==='COMMIT'?'COMMIT':'SELECT'};}),release:vi.fn()};
  const raw={query:vi.fn(),connect:vi.fn(async()=>connection)};const pool=profileRoutedPool(raw);
  await withProfileTransaction(pool,'one',db=>withProfileQueryRouting(db,async()=>{await pool.query('SELECT scoped');expect(calls).not.toContain('COMMIT');}));
  expect(calls.at(-1)).toBe('COMMIT');expect(raw.connect).toHaveBeenCalledOnce();expect(raw.query).not.toHaveBeenCalled();
  calls.length=0;await expect(withProfileTransaction(pool,'one',db=>withProfileQueryRouting(db,async()=>{await pool.connect();}))).rejects.toThrow('PROFILE_RAW_CONNECTION_FORBIDDEN');
  expect(calls.at(-1)).toBe('ROLLBACK');expect(calls).not.toContain('COMMIT');
 });
});
