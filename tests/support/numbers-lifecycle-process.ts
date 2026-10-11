import {pool} from '../../packages/db/src/index.js';
import {ownerId} from '../../apps/channel-worker/src/dispatch.js';
import {processChannelCommands,heartbeatOwnership,discoverSessionOwnership} from '../../apps/channel-worker/src/lifecycle.js';
process.on('message',async(message:{id:string;action:string})=>{
 try{let result:unknown;
  if(message.action==='commands')result=await processChannelCommands(100);
  else if(message.action==='discover')result=await discoverSessionOwnership();
  else if(message.action==='heartbeat')result=await heartbeatOwnership();
  else throw new Error('TEST_ACTION_DENIED');
  process.send?.({id:message.id,result:result??null});
 }catch(e){process.send?.({id:message.id,error:e instanceof Error?e.message:'TEST_CHILD_FAILED'});}
});
process.on('SIGTERM',()=>{void pool.end().finally(()=>process.exit(0));});
process.send?.({ready:true,owner_id:ownerId,pid:process.pid});
