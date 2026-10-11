import {AsyncLocalStorage} from 'node:async_hooks';
import type pg from 'pg';
/** Test-only checkout wrapper. Every query uses the production role, including transactions. */
export function roleExecutor(pool:pg.Pool){
 const context=new AsyncLocalStorage<string>();
 const connect=pool.connect.bind(pool);
 const checkout=async()=>{const client=await connect();try{const role=context.getStore();await client.query(role?'SET ROLE '+role:'RESET ROLE');return client;}catch(error){client.release();throw error;}};
 pool.connect=((callback?:any)=>{if(callback){void checkout().then(c=>callback(null,c,c.release.bind(c)),e=>callback(e));return;}return checkout();}) as typeof pool.connect;
 return <T>(role:'commerce_api'|'commerce_channel'|'commerce_automation',run:()=>T)=>context.run(role,run);
}
