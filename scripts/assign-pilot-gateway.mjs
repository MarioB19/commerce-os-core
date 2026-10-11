// Explicitly authorized internal correction of the existing disconnected pilot.
// No lifecycle, QR, messages, Meta requests, new accounts, or automatic retries.
const report={measured_at:new Date().toISOString(),passed:false,patch_attempted:false,patch_outcome:'NOT_ATTEMPTED',qr_requests:0,lifecycle_commands:0};
let origin,cookie='',stage='configuration',failure;
const check=ok=>{if(!ok)throw new Error('PRECONDITION_FAILED');};
async function request(path,options={}){
 const response=await fetch(origin+path,{method:options.method??'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Origin:origin,Accept:'application/json',...(cookie?{Cookie:cookie}:{}),...(options.body?{'Content-Type':'application/json'}:{}),...(options.key?{'Idempotency-Key':options.key}:{})},...(options.body?{body:JSON.stringify(options.body)}:{})});
 if(path==='/api/auth/sign-in/email')cookie=response.headers.getSetCookie().map(item=>item.split(';')[0]).join('; ');
 const data=await response.json().catch(()=>null);
 if(!response.ok){const known=['VERSION_CONFLICT','CHANNEL_GATEWAY_ALREADY_ASSIGNED','NOT_FOUND','FORBIDDEN','VALIDATION_ERROR'];throw Object.assign(new Error(known.includes(data?.error?.code)?data.error.code:'HTTP_REQUEST_FAILED'),{httpStatus:response.status});}
 return data;
}
async function counts(){const [commands,effects]=await Promise.all([request('/v1/commands?environment=REAL&limit=200'),request('/v1/outbox?environment=REAL&limit=200')]);check(Array.isArray(commands?.data)&&Array.isArray(effects?.data));return{real_commands:commands.data.length,real_effects:effects.data.length};}
try{
 check(process.argv.length===5&&process.argv[2]==='--apply'&&process.argv[3]==='--expected-version');const expectedVersion=Number(process.argv[4]);check(Number.isSafeInteger(expectedVersion)&&expectedVersion>0);const url=new URL(process.env.BETTER_AUTH_URL??'');origin=url.origin;
 check(origin==='https://commerce-os.inovaris.online'&&!url.username&&!url.password&&!url.search&&!url.hash&&!!process.env.BOOTSTRAP_EMAIL&&!!process.env.BOOTSTRAP_PASSWORD&&process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');
 stage='r4_contract';const spec=await request('/v1/openapi.json');check(spec.paths?.['/v1/products/{id}/offers']?.post?.['x-required-service-scopes']?.includes('offers:write')&&!!spec.paths?.['/v1/meta/status']?.get);
 stage='login';await request('/api/auth/sign-in/email',{method:'POST',body:{email:process.env.BOOTSTRAP_EMAIL,password:process.env.BOOTSTRAP_PASSWORD}});check(!!cookie);
 const me=await request('/v1/me');check(me.data?.role==='owner'&&me.data?.service===false);
 stage='pilot_preconditions';const list=await request('/v1/channel-accounts?environment=REAL&limit=200');check(list.meta?.total===1&&list.data?.length===1);
 const id=list.data[0].id;const fresh=await request('/v1/channel-accounts/'+encodeURIComponent(id)+'?environment=REAL');const account=fresh.data;
 check(account?.id===id&&account.environment==='REAL'&&account.provider==='waha'&&account.status==='DISCONNECTED'&&account.sending_enabled===false&&account.identity_verified!==true&&account.version===expectedVersion);
 const before=await counts();check(before.real_commands===0&&before.real_effects===0);
 const system=await request('/v1/system/status?environment=REAL');check(system.data?.dispatch_frozen===true&&system.data.dispatch_frozen_sources?.process_flag===true);
 // gateway_ref is deliberately omitted by the API sanitizer. Its previous and
 // final values must be checked through the sanitized SSH inventory, never
 // inferred from absence in this response. The explicit version prevents a blind rerun.
 report.before={...before,version:account.version,status:'DISCONNECTED',sending_enabled:false,gateway_ref_projection:'OMITTED_BY_API'};
 stage='patch_gateway_reference';report.patch_attempted=true;report.patch_outcome='UNKNOWN';
 const updated=await request('/v1/channel-accounts/'+encodeURIComponent(id)+'?environment=REAL',{method:'PATCH',body:{expected_version:expectedVersion,gateway_ref:'WAHA_01'},key:crypto.randomUUID()});
 check(updated.data?.id===id&&updated.data?.version===expectedVersion+1&&updated.data?.sending_enabled===false&&updated.data?.status==='DISCONNECTED');report.patch_outcome='APPLIED';
 stage='readback';const current=(await request('/v1/channel-accounts/'+encodeURIComponent(id)+'?environment=REAL')).data;const after=await counts();
 check(current?.id===id&&current.version===expectedVersion+1&&current.environment==='REAL'&&current.provider==='waha'&&current.status==='DISCONNECTED'&&current.sending_enabled===false&&after.real_commands===0&&after.real_effects===0);
 report.after={...after,version:current.version,status:'DISCONNECTED',sending_enabled:false,same_account:true};report.gateway_reference_verification='REQUIRES_SSH_INVENTORY';
}catch(error){failure={stage,code:['PRECONDITION_FAILED','VERSION_CONFLICT','CHANNEL_GATEWAY_ALREADY_ASSIGNED','NOT_FOUND','FORBIDDEN','VALIDATION_ERROR','HTTP_REQUEST_FAILED'].includes(error?.message)?error.message:'REQUEST_OR_CONFIGURATION_FAILED',...(Number.isInteger(error?.httpStatus)?{http_status:error.httpStatus}:{})};if(stage==='patch_gateway_reference'&&report.patch_outcome==='UNKNOWN'&&error?.httpStatus>=400&&error.httpStatus<500)report.patch_outcome='REJECTED';}
finally{
 if(cookie){try{await request('/api/auth/sign-out',{method:'POST',body:{}});report.logout=true;}catch{report.logout=false;failure??={stage:'logout',code:'REQUEST_FAILED'};}}cookie='';report.passed=!failure;if(failure)report.failure=failure;if(report.patch_outcome==='UNKNOWN')report.action='READ_CURRENT_ACCOUNT_BEFORE_RETRY_NO_AUTOMATIC_RETRY';console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
}
