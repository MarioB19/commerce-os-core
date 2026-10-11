import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
/** Run on an independent host. Read-only probe; notification delivery belongs to an authorized receiver. */
export async function probeSessionHost(origin,request=fetch){
 const url=new URL('/readyz',origin);if(url.protocol!=='https:')throw Error('HTTPS_REQUIRED');
 const start=performance.now();let status,http_status=null;
 try{const response=await request(url,{redirect:'error',signal:AbortSignal.timeout(10000)});http_status=response.status;const body=await response.json();status=response.ok&&body.status==='ready'?'AVAILABLE':'UNAVAILABLE';}catch{status='UNREACHABLE';}
 return{at:new Date().toISOString(),origin:url.origin,status,http_status,elapsed_ms:Math.round(performance.now()-start),session_authentication:'NOT_OBSERVED',notification_delivery:'NOT_CONFIGURED'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){const receipt=await probeSessionHost(process.argv[2]??'https://commerce-os.inovaris.online');console.log(JSON.stringify(receipt));process.exitCode=receipt.status==='AVAILABLE'?0:1;}
