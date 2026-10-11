// Node built-ins only. Reuses the protected login and checks from verify-deployment.mjs.
// Reads application state; only sign-in/sign-out create/revoke an authentication session.
// No QR endpoint, lifecycle command, Meta sync, catalog write, service token or delivery.
const expectedMetaMode=process.env.EXPECTED_META_MODE??'unconfigured';
const report={checked_at:new Date().toISOString(),profile:'audit-r4',passed:false,checks:{},qr_requests:0,business_writes:0,external_provider_requests:0};
const cookies=new Map(),sessionName=/(?:^|[._-])session_token(?:\.\d+)?$/;
let origin,stage='configuration',failure;
const cookieHeader=()=>[...cookies].map(([name,value])=>name+'='+value).join('; ');
const hasSession=()=>[...cookies.keys()].some(name=>sessionName.test(name));
const check=(name,ok,details={})=>{report.checks[name]={ok,...details};if(!ok)throw new Error('CHECK_FAILED');};
function collect(headers){for(const header of headers.getSetCookie()){const pair=header.split(';',1)[0],separator=pair.indexOf('=');if(separator<1)continue;const name=pair.slice(0,separator),value=pair.slice(separator+1);if(!value||/;\s*max-age\s*=\s*0(?:;|$)/i.test(header))cookies.delete(name);else cookies.set(name,value);}}
async function request(path,{method='GET',body,authenticated=false,cookieOverride}={}){
 const cookie=cookieOverride??(authenticated?cookieHeader():'');
 const response=await fetch(new URL(path,origin),{method,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
 if(authenticated||path==='/api/auth/sign-in/email')collect(response.headers);
 const reader=response.body?.getReader(),parts=[];let size=0;
 if(reader)while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2*1024*1024){await reader.cancel();throw new Error('RESPONSE_TOO_LARGE');}parts.push(part.value);}
 let data=null;try{data=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{/* Never log raw bodies. */}
 return{status:response.status,headers:response.headers,data};
}
function heartbeats(data){return ['automation-worker','channel-worker'].map(service=>{const latest=(data?.services??[]).filter(row=>row.service===service).sort((a,b)=>Date.parse(b.observed_at)-Date.parse(a.observed_at))[0];const age=Date.now()-Date.parse(latest?.observed_at);return{service,fresh:!!latest&&latest.status==='OK'&&latest.stale!==true&&Number.isFinite(age)&&age>=-5000&&age<=60000&&Date.parse(latest.expires_at)>Date.now()};});}
try{
 const url=new URL(process.env.BETTER_AUTH_URL??'');origin=url.origin;
 check('protected_configuration',origin==='https://commerce-os.inovaris.online'&&!url.username&&!url.password&&!url.search&&!url.hash&&!!process.env.BOOTSTRAP_EMAIL&&!!process.env.BOOTSTRAP_PASSWORD&&process.env.NODE_TLS_REJECT_UNAUTHORIZED!=='0');
 check('expected_meta_mode',['unconfigured','configured','synced'].includes(expectedMetaMode));
 stage='readiness';const ready=await request('/readyz');check('https_api_ready',ready.status===200&&ready.data?.status==='ready'&&ready.data?.service==='api',{status:ready.status});
 stage='anonymous';const denied=await request('/v1/products?environment=REAL&limit=1');check('anonymous_denied',denied.status===401,{status:denied.status});
 stage='contracts';const schema=await request('/v1/openapi.json');check('openapi_available',schema.status===200&&String(schema.data?.openapi).startsWith('3.'),{status:schema.status});
 const paths=schema.data.paths??{};
 const required=[['/v1/products','post','products:write'],['/v1/offers','get','offers:read'],['/v1/products/{id}/offers','post','offers:write'],['/v1/workflows/{id}/versions','post','workflows:draft'],['/v1/workflows/{id}/publish','post','workflows:publish'],['/v1/products/{id}/versions','get','products:read']];
 check('catalog_r4_scopes',required.every(([path,method,scope])=>paths[path]?.[method]?.['x-required-service-scopes']?.includes(scope)),{operations:required.length});
 check('versioned_mutation_contracts',['/v1/offers/{id}/versions','/v1/workflows/{id}/versions','/v1/receipts/{id}/review'].every(path=>paths[path]?.post?.requestBody?.content?.['application/json']?.schema?.required?.includes('expected_version')));
 check('meta_and_qr_routes_documented',!!paths['/v1/meta/status']?.get&&!!paths['/v1/meta/portfolios/{portfolioId}/assets']?.get&&!!paths['/v1/channel-accounts/{id}/qr']?.get);
 stage='login';const login=await request('/api/auth/sign-in/email',{method:'POST',body:{email:process.env.BOOTSTRAP_EMAIL,password:process.env.BOOTSTRAP_PASSWORD}});check('owner_login',login.status===200&&hasSession(),{status:login.status});
 const sessionCookies=login.headers.getSetCookie().filter(header=>sessionName.test(header.split('=',1)[0]));check('secure_httponly_cookie',sessionCookies.length>0&&sessionCookies.every(header=>/;\s*Secure(?:;|$)/i.test(header)&&/;\s*HttpOnly(?:;|$)/i.test(header)));
 const me=await request('/v1/me',{authenticated:true});check('owner_membership',me.status===200&&me.data?.data?.role==='owner'&&me.data.data.service===false&&me.data.data.public_signup===false,{status:me.status});
 stage='catalog_reads';for(const name of ['products','offers','workflows']){const result=await request('/v1/'+name+'?environment=REAL&limit=1',{authenticated:true});check(name+'_real_read_contract',result.status===200&&Array.isArray(result.data?.data)&&result.data.data.every(row=>row.environment==='REAL'),{status:result.status});}
 stage='accounts';const accounts=await request('/v1/channel-accounts?environment=REAL&limit=200',{authenticated:true});const rows=accounts.data?.data;
 check('real_pilot_preserved',accounts.status===200&&Array.isArray(rows)&&rows.some(row=>row.provider==='waha')&&rows.every(row=>row.environment==='REAL'&&row.sending_enabled!==true),{status:accounts.status,count:Array.isArray(rows)?rows.length:null});
 stage='meta';const meta=await request('/v1/meta/status?environment=REAL',{authenticated:true});const m=meta.data?.data;
 const metaStatus=['NOT_CONFIGURED','NOT_SYNCED','SYNCED','PARTIAL','UNAVAILABLE','STALE'].includes(m?.status)?m.status:'UNKNOWN';
 const validCredentials=Array.isArray(m?.credentials)?m.credentials.filter(item=>item.valid===true&&(!item.expires_at||Date.parse(item.expires_at)>Date.now())&&(!item.data_access_expires_at||Date.parse(item.data_access_expires_at)>Date.now())).length:0;
 const freshSnapshot=meta.status===200&&m?.configured===true&&['SYNCED','PARTIAL'].includes(metaStatus)&&m.source==='META_API'&&Date.parse(m.valid_until)>Date.now()&&validCredentials>0;
 const unconfigured=meta.status===200&&metaStatus==='NOT_CONFIGURED'&&m.configured===false&&m.source==='UNVERIFIED'&&Array.isArray(m.portfolios)&&m.portfolios.length===0;
 const configured=meta.status===200&&m?.configured===true&&(metaStatus==='NOT_SYNCED'||freshSnapshot);
 check('meta_expected_state',expectedMetaMode==='unconfigured'?unconfigured:expectedMetaMode==='configured'?configured:freshSnapshot,{status:meta.status,expected:expectedMetaMode,meta_status:metaStatus,valid_credentials_in_snapshot:validCredentials,portfolios:Array.isArray(m?.portfolios)?m.portfolios.length:0});
 stage='system';const deadline=Date.now()+45000;let system,workers=[];
 do{system=await request('/v1/system/status?environment=SIMULATION',{authenticated:true});workers=heartbeats(system.data?.data);if(system.status!==200||workers.every(item=>item.fresh)||Date.now()>=deadline)break;await new Promise(resolve=>setTimeout(resolve,3000));}while(Date.now()<deadline);
 const s=system.data?.data;check('database_ready',system.status===200&&s?.database==='READY',{status:system.status});check('workers_fresh',workers.every(item=>item.fresh),{workers});
 check('deployment_reported',s.deployment?.status==='DEPLOYED'&&s.deployment.production_modified===true);check('real_dispatch_frozen',s.dispatch_frozen===true&&s.dispatch_frozen_sources?.process_flag===true);
 const effects=await request('/v1/outbox?environment=REAL&limit=200',{authenticated:true});check('no_observed_real_inflight',effects.status===200&&Array.isArray(effects.data?.data)&&effects.data.data.every(item=>!['SENDING','UNKNOWN'].includes(item.status)),{status:effects.status,scope:'latest 200; global count requires VPS inventory'});
 report.limitations=['16 migrations and onboarding runtime flag require the separate VPS inventory; HTTP does not expose them.','Schema checks and GETs verify installed read contracts; mutation and service-token behavior are covered by the isolated suite, not exercised remotely.','Meta configured/NOT_SYNCED proves configuration binding only; synced requires a fresh stored snapshot and at least one valid credential. This verifier never calls Meta or triggers a sync.','No QR was requested or generated by this verification.'];
}catch(error){failure={stage,code:['CHECK_FAILED','RESPONSE_TOO_LARGE'].includes(error?.message)?error.message:'REQUEST_OR_CONFIGURATION_FAILED'};}
finally{
 if(origin&&hasSession()){const previous=cookieHeader();try{const logout=await request('/api/auth/sign-out',{method:'POST',body:{},authenticated:true});report.checks.logout={ok:logout.status===200,status:logout.status};const revoked=await request('/v1/me',{cookieOverride:previous});report.checks.session_revoked={ok:revoked.status===401,status:revoked.status};if(logout.status!==200||revoked.status!==401)failure??={stage:'logout',code:'CHECK_FAILED'};}catch{report.checks.logout={ok:false};failure??={stage:'logout',code:'REQUEST_FAILED'};}}
 else report.checks.logout={ok:true,required:false};cookies.clear();report.passed=!failure&&Object.values(report.checks).every(item=>item.ok);if(failure)report.failure=failure;console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
}
