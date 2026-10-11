import {processChannelCommands} from '../../apps/channel-worker/src/lifecycle.js';
import {pool} from '../../packages/db/src/index.js';

let providerCalls=0,networkAttempts=0;
// A provider callback is an attempted boundary, but cannot perform a physical/network effect here.
globalThis.fetch=async()=>{networkAttempts++;throw new Error('SYNTHETIC_NETWORK_FORBIDDEN');};
const factory=async()=>({
 lifecycle:async()=>{providerCalls++;throw new Error('SYNTHETIC_LOST_RESPONSE');},
 health:async()=>[],send:async()=>{throw new Error('UNEXPECTED_SEND');},
} as any);
try{
 const role=(await pool.query('SELECT current_user role')).rows[0].role;
 if(role!=='commerce_channel')throw new Error('WORKER_ROLE_NOT_RESTRICTED');
 const processed=await processChannelCommands(20,factory,'cancel-race-synthetic-worker');
 console.log(JSON.stringify({processed,providerCalls,role,networkAttempts}));
}finally{await pool.end();}
