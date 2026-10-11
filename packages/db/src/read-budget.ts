import type pg from 'pg';
import type {QueryExecutor} from './index.js';

/** Bound a sequential read projection at PostgreSQL, including locks. A JS
 * Promise.race alone would leave the slow query occupying a pooled connection.
 * The transaction cannot mutate data and its local settings never escape it.
 */
export async function withReadBudget<T>(pool:pg.Pool,milliseconds:number,read:(c:QueryExecutor)=>Promise<T>):Promise<T>{
 if(!Number.isFinite(milliseconds)||milliseconds<=0)throw new Error('READ_BUDGET_INVALID');
 const deadline=Date.now()+milliseconds;
 const client=await new Promise<pg.PoolClient>((resolve,reject)=>{
  let expired=false;
  const timer=setTimeout(()=>{expired=true;reject(new Error('READ_BUDGET_EXCEEDED'));},milliseconds);
  // pg cannot cancel an acquisition. If it finishes after our deadline, return
  // that client immediately, without beginning a transaction or leaking it.
  void pool.connect().then(connection=>{clearTimeout(timer);if(expired)connection.release();else resolve(connection);},error=>{clearTimeout(timer);reject(error);});
 });
 let failed=true;
 const execute=(text:string,values?:unknown[])=>{
  const remaining=deadline-Date.now();
  if(remaining<=0)throw new Error('READ_BUDGET_EXCEEDED');
  const config:pg.QueryConfig & {query_timeout:number}={text,values,query_timeout:remaining};
  return client.query(config);
 };
 try{
  await execute('BEGIN READ ONLY');
  const query=async(sql:string,values?:unknown[])=>{
   const remaining=deadline-Date.now();
   if(remaining<=0)throw new Error('READ_BUDGET_EXCEEDED');
   await execute("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",[String(remaining),String(Math.min(remaining,1000))]);
   return execute(sql,values);
  };
  const result=await read({query:query as QueryExecutor['query']});
  await execute('COMMIT');failed=false;
  return result;
 }finally{
  // On a network/client timeout even ROLLBACK could wait indefinitely. Closing
  // this read-only connection cancels its query/transaction on the server.
  client.release(failed);
 }
}
