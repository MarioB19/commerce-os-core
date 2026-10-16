import {describe,it,expect} from 'vitest';
import {createProfileWorkerRuntime,currentWorkerProfile,withWorkerProfilePhase} from './profile-worker-scope.js';
import {currentProfileExecutor,profileRoutedPool} from './profile-query-routing.js';
import {withProfileTransaction,type ProfilePool,type ProfileQuery} from './profile-context.js';
import {withTransaction} from './index.js';

function fixture(){
 const log:{id:number;sql:string;values?:unknown[]}[]=[],releases:(Error|boolean|undefined)[]=[];
 let connections=0;let role='commerce_automation';let rows=[{id:'one',state:'ACTIVE',version:1},{id:'two',state:'ACTIVE',version:2}];
 let blocked:Promise<void>|undefined;let fail:string|undefined;let onSlow:(()=>void)|undefined;
 const pool:ProfilePool={async connect(){const id=++connections;return{
  query:(async(sql:string,values?:unknown[])=>{
   log.push({id,sql,values});if(sql===fail)throw Error('SYNTHETIC_QUERY_FAILED');if(sql==='SLOW'){onSlow?.();await blocked;}
   let result:unknown[]=[];
   if(sql==='SELECT current_user AS role')result=[{role}];
   if(sql==='SELECT * FROM discover_worker_profiles()')result=rows.map(row=>({...row}));
   if(sql==='SELECT id,state,version FROM read_locked_continuous_worker_profile()'){
    const workspace=log.find(row=>row.id===id&&row.sql.includes("set_config('app.workspace_id'"))?.values?.[0];
    result=rows.filter(row=>row.id===workspace).map(row=>({...row}));
   }
   return{rows:result,rowCount:result.length,command:sql==='COMMIT'?'COMMIT':'SELECT',oid:0,fields:[]};
  })as ProfileQuery,
  release(error){releases.push(error);},
 };}};
 const raw={connect:pool.connect.bind(pool),query:async(_sql:string,_values?:unknown[])=>{throw Error('GLOBAL_FALLBACK');},end:async()=>{throw Error('GLOBAL_ADMIN');}};
 const routed=profileRoutedPool(raw);
 const runtime=createProfileWorkerRuntime(pool,'commerce_automation','REAL');
 return{pool,routed,runtime,log,releases,setRole:(value:string)=>{role=value;},setRows:(value:typeof rows)=>{rows=value;},block:(value:Promise<void>,started?:()=>void)=>{blocked=value;onSlow=started;},fail:(value:string)=>{fail=value;}};
}
describe('native worker profile boundaries without a transaction around external IO',()=>{
 it('requires native role and a closed discovery shape',async()=>{
  const f=fixture();f.setRole('postgres');await expect(f.runtime.discover()).rejects.toThrow('WORKER_NATIVE_ROLE_REQUIRED');
  expect(f.log.some(x=>x.sql==='ROLLBACK')).toBe(true);f.setRole('commerce_automation');f.setRows([{id:'one',state:'ACTIVE',version:1},{id:'one',state:'ACTIVE',version:1}]);
  await expect(f.runtime.discover()).rejects.toThrow('WORKER_DISCOVERY_INVALID');
 });
 it('rejects fabricated, foreign and already consumed selections',async()=>{
  const f=fixture(),g=fixture(),[one]=await f.runtime.discover();
  await expect(f.runtime.run({...one!},async()=>{})).rejects.toThrow('WORKER_SELECTION_REQUIRED');
  await expect(g.runtime.run(one!,async()=>{})).rejects.toThrow('WORKER_SELECTION_REQUIRED');
  await f.runtime.run(one!,async()=>{});await expect(f.runtime.run(one!,async()=>{})).rejects.toThrow('WORKER_SELECTION_REQUIRED');
 });
 it('does not activate a suspended profile',async()=>{
  const f=fixture();f.setRows([{id:'one',state:'SUSPENDED',version:1}]);const[one]=await f.runtime.discover();
  await expect(f.runtime.run(one!,async()=>{})).rejects.toThrow('WORKER_PROFILE_INACTIVE');
 });
 it('commits PREPARE before external work and opens RECONCILE separately',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();f.log.length=0;
  await f.runtime.run(one!,async()=>{
   expect(currentWorkerProfile()?.environment).toBe('REAL');expect(currentProfileExecutor()).toBeUndefined();
   await withTransaction(async db=>{expect(currentProfileExecutor()?.workspaceId).toBe('one');await db.query('PREPARE');});
   expect(f.log.at(-1)?.sql).toBe('COMMIT');expect(currentProfileExecutor()).toBeUndefined();
   f.log.push({id:0,sql:'EXTERNAL_IO'});
   await withTransaction(db=>db.query('RECONCILE'));
  });
  expect(f.log.filter(x=>['PREPARE','COMMIT','EXTERNAL_IO','RECONCILE'].includes(x.sql)).map(x=>x.sql)).toEqual(['PREPARE','COMMIT','EXTERNAL_IO','RECONCILE','COMMIT']);
  expect(new Set(f.log.filter(x=>x.sql==='BEGIN').map(x=>x.id)).size).toBe(2);
 });
 it('routes standalone pool queries into separate short native phases',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();f.log.length=0;
  await f.runtime.run(one!,async()=>{await f.routed.query('READ',[]);await f.routed.query('SINGLE_WRITE',[]);});
  expect(f.log.filter(x=>x.sql==='COMMIT')).toHaveLength(2);
  expect(f.log.filter(x=>x.sql.includes("set_config('app.environment'")).every(x=>x.values?.[0]==='REAL')).toBe(true);
 });
 it('joins nested helpers within a phase without adding a COMMIT',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();f.log.length=0;
  await f.runtime.run(one!,()=>withTransaction(async()=>{await withTransaction(db=>db.query('NESTED'));await f.routed.query('IN_PHASE',[]);}));
  expect(f.log.filter(x=>x.sql==='BEGIN')).toHaveLength(1);expect(f.log.filter(x=>x.sql==='COMMIT')).toHaveLength(1);
 });
 it('revalidates profile authority between phases and preserves prior commit',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();f.log.length=0;
  await expect(f.runtime.run(one!,async()=>{
   await withTransaction(db=>db.query('PREPARE'));f.setRows([{id:'one',state:'SUSPENDED',version:2}]);
   await withTransaction(db=>db.query('FORBIDDEN'));
  })).rejects.toThrow('WORKER_PROFILE_AUTHORITY_CHANGED');
  expect(f.log.filter(x=>x.sql==='COMMIT')).toHaveLength(1);expect(f.log.some(x=>x.sql==='FORBIDDEN')).toBe(false);expect(f.log.at(-1)?.sql).toBe('ROLLBACK');
 });
 it('revalidates after work before COMMIT',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();f.log.length=0;
  await expect(f.runtime.run(one!,()=>withTransaction(async db=>{await db.query('WRITE');f.setRows([{id:'one',state:'ACTIVE',version:2}]);}))).rejects.toThrow('WORKER_PROFILE_AUTHORITY_CHANGED');
  expect(f.log.some(x=>x.sql==='COMMIT')).toBe(false);expect(f.log.at(-1)?.sql).toBe('ROLLBACK');
 });
 it('denies raw connections even if the caller catches the exception',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();
  await expect(f.runtime.run(one!,async()=>{await expect(f.routed.connect()).rejects.toThrow('WORKER_RAW_CONNECTION_FORBIDDEN');})).rejects.toThrow('WORKER_PROFILE_REJECTED');
 });
 it('denies pool administration and cross-profile transactions',async()=>{
  for(const mode of ['admin','profile']){
   const f=fixture(),[one]=await f.runtime.discover();
   await expect(f.runtime.run(one!,async()=>{if(mode==='admin')await f.routed.end();else await withProfileTransaction(f.pool,'two',async()=>{});})).rejects.toThrow(mode==='admin'?'WORKER_POOL_ACCESS_FORBIDDEN':'WORKER_PROFILE_MISMATCH');
  }
 });
 it('refuses nested discovery and worker runs',async()=>{
  const f=fixture(),[one,two]=await f.runtime.discover();
  await f.runtime.run(one!,async()=>{await expect(f.runtime.discover()).rejects.toThrow('WORKER_DISCOVERY_OUTSIDE_PROFILE_REQUIRED');await expect(f.runtime.run(two!,async()=>{})).rejects.toThrow('WORKER_PROFILE_NESTING_FORBIDDEN');});
 });
 it('drains an unawaited phase and rolls it back instead of committing late',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();let release!:()=>void,started!:()=>void;const ready=new Promise<void>(resolve=>{started=resolve;});f.block(new Promise<void>(resolve=>{release=resolve;}),started);f.log.length=0;
  let pending:Promise<unknown>|undefined;
  const outer=f.runtime.run(one!,async()=>{pending=withWorkerProfilePhase(db=>db.query('SLOW'));void pending.catch(()=>{});await ready;});
  const rejected=expect(outer).rejects.toThrow('WORKER_PHASE_NOT_AWAITED');
  await new Promise(resolve=>setTimeout(resolve,0));release();await rejected;
  expect(f.log.some(x=>x.sql==='COMMIT')).toBe(false);expect(f.log.at(-1)?.sql).toBe('ROLLBACK');
 });
 it('rejects callbacks inherited after the cycle closes',async()=>{
  const f=fixture(),[one]=await f.runtime.discover();let resume!:()=>void;let late:Promise<unknown>|undefined;
  await f.runtime.run(one!,async()=>{late=new Promise<void>(resolve=>{resume=resolve;}).then(()=>f.routed.query('LATE',[]));});
  resume();await expect(late).rejects.toThrow('WORKER_PROFILE_CLOSED');expect(f.log.some(x=>x.sql==='LATE')).toBe(false);
 });
 it('keeps concurrent profile cycles isolated',async()=>{
  const f=fixture(),[one,two]=await f.runtime.discover();
  await Promise.all([one!,two!].map(selection=>f.runtime.run(selection,()=>withTransaction(async()=>{await Promise.resolve();expect(currentProfileExecutor()?.workspaceId).toBe(selection.workspaceId);}))))
 });
});
