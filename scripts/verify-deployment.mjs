// Node 24 built-ins only. Reads credentials through Node's native protected env file:
// node --env-file=/private/commerce/admin.env scripts/verify-deployment.mjs
// No business writes: only sign-in, denied empty signup probe and sign-out.

const report={checked_at:new Date().toISOString(),passed:false,checks:{}};
const cookies=new Map();
const sessionCookieName=/(?:^|[._-])session_token(?:\.\d+)?$/;
let origin,stage='configuration',failure;
const cookieHeader=()=>[...cookies].map(([name,value])=>name+'='+value).join('; ');
const hasSession=()=>[...cookies.keys()].some(name=>sessionCookieName.test(name));
const check=(name,ok,details={})=>{
 report.checks[name]={ok,...details};
 if(!ok)throw new Error('CHECK_FAILED');
};

function collectCookies(headers){
 for(const header of headers.getSetCookie()){
  const pair=header.split(';',1)[0],separator=pair.indexOf('=');
  if(separator<1)continue;
  const name=pair.slice(0,separator),value=pair.slice(separator+1);
  if(!value||/;\s*max-age\s*=\s*0(?:;|$)/i.test(header))cookies.delete(name);
  else cookies.set(name,value);
 }
}

async function request(path,{method='GET',body,authenticated=false,cookieOverride}={}){
 const cookie=cookieOverride??(authenticated?cookieHeader():'');
 const response=await fetch(new URL(path,origin),{
  method,redirect:'manual',signal:AbortSignal.timeout(15000),
  headers:{Accept:'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},
  ...(body!==undefined?{body:JSON.stringify(body)}:{}),
 });
 // Store credentials only in memory, including before validating the login body.
 if(authenticated||path==='/api/auth/sign-in/email')collectCookies(response.headers);
 const reader=response.body?.getReader();
 const parts=[];let size=0;
 if(reader)while(true){
  const part=await reader.read();if(part.done)break;
  size+=part.value.byteLength;
  if(size>2*1024*1024){await reader.cancel();throw new Error('RESPONSE_TOO_LARGE');}
  parts.push(part.value);
 }
 let data=null;
 try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{/* Body is intentionally never logged. */}
 return{status:response.status,headers:response.headers,data};
}

function serviceSummary(data){
 const services=Array.isArray(data?.services)?data.services:[];
 return ['automation-worker','channel-worker'].map(service=>{
  const latest=services.filter(row=>row.service===service).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at))[0];
  const observed=Date.parse(latest?.observed_at),expires=Date.parse(latest?.expires_at);
  const age=Date.now()-observed;
  return{service,present:!!latest,status_ok:latest?.status==='OK',age_ms:Number.isFinite(age)?Math.round(age):null,
   fresh:!!latest&&latest.status==='OK'&&latest.stale!==true&&Number.isFinite(age)&&age>=-5000&&age<=60000&&Number.isFinite(expires)&&expires>Date.now()};
 });
}

try{
 const email=process.env.BOOTSTRAP_EMAIL,password=process.env.BOOTSTRAP_PASSWORD;
 const url=new URL(process.env.BETTER_AUTH_URL??'');
 check('protected_configuration',!!email&&!!password&&url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');
 origin=url.origin;

 stage='https_readiness';
 const readiness=await request('/readyz');
 check('https_with_certificate_validation',readiness.status===200,{status:readiness.status});
 check('api_readiness',readiness.data?.status==='ready'&&readiness.data?.service==='api');

 stage='anonymous_access';
 const anonymous=await request('/v1/products');
 check('anonymous_products_denied',anonymous.status===401,{status:anonymous.status});

 stage='public_signup';
 // An empty request cannot provision a user even if the signup guard regresses.
 const signup=await request('/api/auth/sign-up/email',{method:'POST',body:{}});
 check('public_signup_disabled',signup.status===403,{status:signup.status});

 stage='owner_login';
 const login=await request('/api/auth/sign-in/email',{method:'POST',body:{email,password}});
 check('owner_login',login.status===200&&hasSession(),{status:login.status});
 const sessionHeaders=login.headers.getSetCookie().filter(header=>sessionCookieName.test(header.split('=',1)[0]));
 check('secure_httponly_session_cookie',sessionHeaders.length>0&&sessionHeaders.every(header=>/;\s*Secure(?:;|$)/i.test(header)&&/;\s*HttpOnly(?:;|$)/i.test(header)));

 stage='authenticated_access';
 const me=await request('/v1/me',{authenticated:true});
 check('owner_membership',me.status===200&&me.data?.data?.role==='owner'&&me.data?.data?.service===false,{status:me.status});
 const products=await request('/v1/products',{authenticated:true});
 check('authenticated_products_readable',products.status===200&&Array.isArray(products.data?.data),{status:products.status});

 stage='bootstrap_accounts';
 const simulated=await request('/v1/channel-accounts?environment=SIMULATION&limit=200',{authenticated:true});
 const real=await request('/v1/channel-accounts?environment=REAL&limit=200',{authenticated:true});
 const simulatedRows=simulated.data?.data,realRows=real.data?.data;
 check('ten_simulation_accounts',simulated.status===200&&simulated.data?.meta?.total===10&&Array.isArray(simulatedRows)&&simulatedRows.length===10&&simulatedRows.every(row=>row.environment==='SIMULATION'&&row.provider==='simulator'),{status:simulated.status,total:Number.isSafeInteger(simulated.data?.meta?.total)?simulated.data.meta.total:null});
 check('zero_real_accounts',real.status===200&&real.data?.meta?.total===0&&Array.isArray(realRows)&&realRows.length===0,{status:real.status,total:Number.isSafeInteger(real.data?.meta?.total)?real.data.meta.total:null});

 stage='service_heartbeats';
 const deadline=Date.now()+60000;let system,heartbeats=[];
 do{
  system=await request('/v1/system/status?environment=SIMULATION',{authenticated:true});
  heartbeats=serviceSummary(system.data?.data);
  if(system.status!==200||heartbeats.every(item=>item.fresh)||Date.now()>=deadline)break;
  await new Promise(resolve=>setTimeout(resolve,3000));
 }while(Date.now()<deadline);
 check('system_database_ready',system.status===200&&system.data?.data?.database==='READY',{status:system.status});
 check('api_service_ready',Array.isArray(system.data?.data?.services)&&system.data.data.services.some(item=>item.name==='api'&&item.status==='READY'));
 check('fresh_worker_heartbeats',heartbeats.length===2&&heartbeats.every(item=>item.fresh),{services:heartbeats});
 check('deployment_reported',system.data?.data?.deployment?.status==='DEPLOYED'&&system.data.data.deployment.production_modified===true);
 check('real_dispatch_frozen',system.data?.data?.dispatch_frozen===true&&system.data.data.dispatch_frozen_sources?.process_flag===true);
 if(process.env.EXPECTED_EXTERNAL_MONITOR_STATUS){
  const monitor=system.data?.data?.integrations?.external_monitor;
  check('external_monitor_installation_reported',monitor?.status===process.env.EXPECTED_EXTERNAL_MONITOR_STATUS,{status:monitor?.status??'UNKNOWN',current_health:monitor?.current_health??'NOT_OBSERVED'});
 }
 // Ingress is checked by its container /readyz; it does not publish a business-table heartbeat.
}catch(error){
 failure={stage,code:error?.message==='CHECK_FAILED'?'CHECK_FAILED':error?.message==='RESPONSE_TOO_LARGE'?'RESPONSE_TOO_LARGE':'REQUEST_OR_CONFIGURATION_FAILED'};
}finally{
 if(origin&&hasSession()){
  const previousCookie=cookieHeader();
  try{
   const logout=await request('/api/auth/sign-out',{method:'POST',body:{},authenticated:true});
   report.checks.logout={ok:logout.status===200,status:logout.status};
   const revoked=await request('/v1/me',{cookieOverride:previousCookie});
   report.checks.session_revoked={ok:revoked.status===401,status:revoked.status};
   if(logout.status!==200||revoked.status!==401)failure??={stage:'logout',code:'CHECK_FAILED'};
  }catch{
   report.checks.logout={ok:false};failure??={stage:'logout',code:'REQUEST_FAILED'};
  }
 }else report.checks.logout={ok:true,required:false};
 cookies.clear();
 report.passed=!failure&&Object.values(report.checks).every(item=>item.ok);
 if(failure)report.failure=failure;
 process.stdout.write(JSON.stringify(report)+'\n');
 process.exitCode=report.passed?0:1;
}
