// Authenticated read-only inventory. Never prints authentication or customer/account bodies.
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
const config=Object.fromEntries(readFileSync(join(homedir(),'.config','commerce-os-production','login.env'),'utf8').split('\n').filter(x=>x&&!x.startsWith('#')).map(x=>{const i=x.indexOf('=');return[x.slice(0,i),x.slice(i+1)];}));
const origin=new URL(config.BETTER_AUTH_URL).origin;
if(origin!=='https://commerce-os.inovaris.online')throw new Error('EXPECTED_PRODUCTION_ORIGIN_REQUIRED');
const login=await fetch(origin+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email:config.BOOTSTRAP_EMAIL,password:config.BOOTSTRAP_PASSWORD}),signal:AbortSignal.timeout(15_000)});
if(!login.ok)throw new Error('PRODUCTION_LOGIN_HTTP_'+login.status);
const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
try {
 const get=async(path)=>{const r=await fetch(origin+path,{headers:{cookie},signal:AbortSignal.timeout(15_000)});if(!r.ok)throw new Error('READ_HTTP_'+r.status);return r.json();};
 const [accounts,commands,system]=await Promise.all([get('/v1/channel-accounts?environment=REAL'),get('/v1/commands?environment=REAL'),get('/v1/system/status')]);
 const qrRouteChecks=[];for(const account of accounts.data.filter(a=>a.provider==='waha').slice(0,1)){for(const explicit of [false,true]){const response=await fetch(origin+`/v1/channel-accounts/${account.id}/qr`+(explicit?'?environment=REAL':''),{headers:{cookie},signal:AbortSignal.timeout(15_000)});const body=await response.json();qrRouteChecks.push({environment_parameter:explicit?'REAL':'omitted',http_status:response.status,error_code:typeof body.error?.code==='string'&&/^[A-Z_]+$/.test(body.error.code)?body.error.code:null,qr_returned:!!body.data?.data});}}
 const evidence={measured_at:new Date().toISOString(),environment:'production read-only',real_accounts:accounts.data.length,accounts:accounts.data.map((a,index)=>({label:'Cuenta '+(index+1),provider:a.provider,status:a.status??'UNKNOWN',sending_enabled:a.sending_enabled===true,health_status:a.health_status??'UNKNOWN'})),channel_commands:commands.data.filter(x=>x.kind==='channel_command').map(x=>({operation:x.payload?.type,status:x.status,error:typeof x.result?.error==='string'&&/^[A-Z0-9_]+$/.test(x.result.error)?x.result.error:null,attempted_at:x.created_at})),dispatch_frozen:system.data?.dispatch_frozen??system.dispatch_frozen??null,real_messages_sent:0,mutations_performed:0,limitations:['No original historical request headers or proxy/worker logs were available through this read-only API inventory.','No gateway session was created or read through its QR endpoint in production.']};
 evidence.qr_route_checks=qrRouteChecks;
 evidence.limitations=['No original historical request headers or proxy/worker logs were available through this read-only API inventory.','Only authenticated GET requests checked QR routes; no lifecycle command or gateway session was created.'];
 writeFileSync('docs/evidence/qr-production-readonly.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
} finally {await fetch(origin+'/api/auth/sign-out',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10_000)}).catch(()=>undefined);}
