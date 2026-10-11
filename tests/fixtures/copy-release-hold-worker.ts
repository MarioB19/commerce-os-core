// Public synthetic IPC fixture. No provider network, QR bytes or credentials.
import {getRecord,pool} from '../../packages/db/src/index.js';
import {processChannelCommands,recordHealth} from '../../apps/channel-worker/src/lifecycle.js';
import {buildChannelServer} from '../../apps/channel-worker/src/server.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {downloadInboundMedia} from '../../apps/channel-worker/src/media.js';
const f=JSON.parse(process.env.COPY_HOLD_FIXTURE!);
let factoryCalls=0,lifecycleCalls=0,healthCalls=0,qrCalls=0,profileCalls=0,groupCalls=0,mediaCalls=0,networkAttempts=0;
globalThis.fetch=async()=>{networkAttempts++;throw new Error('SYNTHETIC_NETWORK_FORBIDDEN');};
const factory=async()=>{
 factoryCalls++;
 return {
  lifecycle:async()=>{
   lifecycleCalls++;
   if(f.mode==='inflight'){
    process.send?.({kind:'REMOTE_ENTERED',lifecycleCalls});
    await new Promise<void>(resolve=>{process.once('message',message=>{if((message as any)?.kind!=='RELEASE_SYNTHETIC_SDK')throw new Error('IPC_CONTRACT');resolve();});});
   }
   return{status:'STOPPED'};
  },
  health:async()=>{healthCalls++;return[];},
  qr:async()=>{qrCalls++;throw new Error('UNEXPECTED_QR');},
  profile:async()=>{profileCalls++;throw new Error('UNEXPECTED_IDENTITY_READ');},
  listGroups:async()=>{groupCalls++;throw new Error('UNEXPECTED_GROUP_READ');},
  group:async()=>{groupCalls++;throw new Error('UNEXPECTED_GROUP_READ');},
  media:async()=>{mediaCalls++;if(f.mode==='media-inflight'){process.send?.({kind:'REMOTE_ENTERED',mediaCalls});await new Promise<void>(resolve=>{process.once('message',message=>{if((message as any)?.kind!=='RELEASE_SYNTHETIC_SDK')throw new Error('IPC_CONTRACT');resolve();});});throw new Error('SYNTHETIC_MEDIA_FAILED');}throw new Error('UNEXPECTED_MEDIA_READ');},
  send:async()=>{throw new Error('UNEXPECTED_SEND');},
 } as any;
};
try{
 const role=(await pool.query('SELECT current_user role')).rows[0].role;
 if(role!=='commerce_channel')throw new Error('WORKER_ROLE_NOT_RESTRICTED');
 const processed=f.mode==='media-inflight'?(await downloadInboundMedia(20,factory),0):await processChannelCommands(20,factory,'copy-hold-synthetic-worker');
 const numberProcessed=f.jobs?await processNumberOperations('copy-hold-synthetic-number-worker',factory):undefined;
 let signals:number|undefined,qrStatus:number|undefined,qrCode:string|undefined;
 if(f.mode==='held'){
  await downloadInboundMedia(20,factory);
  const account=(await getRecord(pool,f.workspace,'channel_account',f.account))!;
  signals=(await recordHealth(account,factory)).length;
  const app=await buildChannelServer(factory);
  const qr=await app.inject({method:'GET',url:'/accounts/'+f.account+'/qr',headers:{authorization:'Bearer '+process.env.INTERNAL_SERVICE_TOKEN,'x-workspace-id':f.workspace}});
  qrStatus=qr.statusCode;qrCode=qr.json().error?.code;await app.close();
 }
 console.log(JSON.stringify({role,processed,numberProcessed,factoryCalls,lifecycleCalls,healthCalls,qrCalls,profileCalls,groupCalls,mediaCalls,networkAttempts,signals,qrStatus,qrCode}));
}finally{await pool.end();}
