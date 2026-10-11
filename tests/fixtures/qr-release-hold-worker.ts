// Public synthetic route fixture; no actual provider, network, credentials or QR.
import {pool} from '../../packages/db/src/index.js';
import {buildChannelServer} from '../../apps/channel-worker/src/server.js';
const fixture=JSON.parse(process.env.COPY_QR_FIXTURE!);let qrCalls=0;
const factory=async()=>({qr:async()=>{qrCalls++;return{mimeType:'image/png',data:'PUBLIC_SYNTHETIC_QR_FIXTURE',expiresAt:new Date(Date.now()+60000).toISOString()};}} as any);
try{
 if((await pool.query('SELECT current_user role')).rows[0].role!=='commerce_channel')throw Error('RESTRICTED_WORKER_REQUIRED');
 const app=await buildChannelServer(factory);const response=await app.inject({method:'GET',url:'/accounts/'+fixture.account+'/qr',headers:{authorization:'Bearer '+process.env.INTERNAL_SERVICE_TOKEN,'x-workspace-id':fixture.workspace}});
 process.stdout.write(JSON.stringify({status:response.statusCode,body:response.json(),qrCalls,role:'commerce_channel'}));await app.close();
}finally{await pool.end();}
