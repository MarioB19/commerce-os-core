// Authenticated metadata inventory only. No QR, lifecycle, provider calls, message bodies or secret output.
import {readFileSync,writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
const loginFile=process.env.COMMERCE_INVENTORY_LOGIN_FILE??join(homedir(),'.config','commerce-os-production','login.env');
const config=Object.fromEntries(readFileSync(loginFile,'utf8').split('\n').filter(x=>x&&!x.startsWith('#')).map(x=>{const i=x.indexOf('=')>=0?x.indexOf('='):x.indexOf(':');return i<0?[]:[x.slice(0,i).trim(),x.slice(i+1).trim()];}).filter(x=>x.length===2));
const origin=new URL(config.BETTER_AUTH_URL??config.URL).origin;
if(origin!=='https://commerce-os.inovaris.online')throw Error('EXPECTED_PRODUCTION_ORIGIN_REQUIRED');
const email=config.BOOTSTRAP_EMAIL??config.Correo,password=config.BOOTSTRAP_PASSWORD??config['Contraseña inicial'];
if(!email||!password)throw Error('PRIVATE_LOGIN_CONFIGURATION_REQUIRED');
const login=await fetch(origin+'/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({email,password}),signal:AbortSignal.timeout(15000)});
if(!login.ok)throw Error('INVENTORY_LOGIN_HTTP_'+login.status);
const cookie=login.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
try{
 const report={measured_at:new Date().toISOString(),scope:'authenticated workspace metadata only',environment:'REAL',business_mutations:0,external_messages:0,checks:{},limitations:['Gateway image/digest/edition and host backup schedule require a separate host inventory.','Configuration present is not provider acceptance or recipient receipt.']};
 const sources={accounts:'/v1/channel-accounts',products:'/v1/products',offers:'/v1/offers',assets:'/v1/assets',workflows:'/v1/workflows',system:'/v1/system/status',permissions:'/v1/me',tokens:'/v1/service-tokens',operations:'/v1/settings/operations',integrations:'/v1/settings/integrations'};
 for(const [name,path]of Object.entries(sources)){
  const response=await fetch(origin+path+'?environment=REAL',{headers:{cookie},signal:AbortSignal.timeout(15000)});if(!response.ok){report.checks[name]={http_status:response.status};continue;}
  const {data}=await response.json();let summary;
  if(name==='accounts')summary=data.map((a,i)=>({label:`Cuenta ${i+1}`,id:a.id,version:a.version,provider:a.provider,status:a.status,identity_verified:a.identity_verified===true,sending_enabled:a.sending_enabled===true,health_status:a.health_status,engine_declared:a.engine,first_working_at:a.first_working_at??null}));
  else if(['products','offers','workflows','assets'].includes(name))summary=data.map(a=>({id:a.id,version:a.version,name:a.name??a.title,status:a.status,kind:a.kind,mime_type:a.mime_type,size_bytes:a.size_bytes,sha256:a.sha256,product_id:a.product_id,offer_version_id:a.offer_version_id,base_amount_minor:a.base_amount_minor,currency:a.currency}));
  else if(name==='system')summary={dispatch_frozen:data.dispatch_frozen,configuration_version:data.configuration_version,services:data.services,pending_commands:data.pending_commands,pending_ingress:data.pending_ingress,unknown_effects:data.unknown_effects,deployment:data.deployment,external_monitor:data.integrations?.external_monitor};
  else if(name==='permissions')summary={workspace_id:data.workspace_id,role:data.role,permissions:data.permissions,operation_mode:data.operation_mode,environment:data.environment};
  else if(name==='tokens')summary=data.map(t=>({scopes:t.scopes,expires_at:t.expires_at,revoked:t.revoked_at!==null}));
  else if(name==='operations')summary={version:data.version,dispatch_frozen:data.dispatch_frozen??data.config?.dispatch_frozen??data.body?.dispatch_frozen,real_sends_enabled:data.real_sends_enabled??data.config?.real_sends_enabled??data.body?.real_sends_enabled};
  else summary=Array.isArray(data)?data.map(i=>({kind:i.kind,key:i.key,enabled:i.enabled,version:i.version,status:i.status})): {available:true};
  report.checks[name]={http_status:response.status,data:summary};
 }
 writeFileSync('docs/evidence/closure-production-inventory.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({measured_at:report.measured_at,report:'docs/evidence/closure-production-inventory.json',checks:Object.fromEntries(Object.entries(report.checks).map(([k,v])=>[k,v.http_status])),business_mutations:0,external_messages:0}));
}finally{await fetch(origin+'/api/auth/sign-out',{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)}).catch(()=>undefined);}
