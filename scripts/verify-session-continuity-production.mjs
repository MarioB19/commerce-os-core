// Read-only authenticated smoke. Credentials are read privately; output contains no credential bytes.
import {readFileSync,writeFileSync} from 'node:fs';
const [tokenFile,output,phase='after',baselineFile]=process.argv.slice(2);
if(!tokenFile||!output)throw Error('TOKEN_FILE_AND_OUTPUT_REQUIRED');
const token=readFileSync(tokenFile,'utf8').trim(),origin='https://commerce-os.inovaris.online';
const report={at:new Date().toISOString(),phase,checks:[],accounts:[],commercial_mutations:0,provider_mutations:0};
async function get(path){const r=await fetch(origin+path,{headers:{authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(30000)});report.checks.push({path:path.replace(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/g,'{account}'),status:r.status});if(!r.ok)throw Error('READ_FAILED_'+r.status);return r.json();}
try{
 const me=(await get('/v1/me')).data;report.service_identity=me.service===true;
 const list=(await get('/v1/channel-accounts?environment=REAL')).data;
 for(const a of list){const account={id:a.id,provider:a.provider,registered_status:a.status,sending_enabled:a.sending_enabled===true};
  const h=(await get(`/v1/channel-accounts/${a.id}/health?environment=REAL`)).data;account.health={state:h.state,reason:h.reason,computed_at:h.computed_at};
  if(phase!=='before'){const s=(await get(`/v1/channel-accounts/${a.id}/session?environment=REAL`)).data;account.session={desired_state:s.desired_state,observed_state:s.observed_state,auth_state:s.auth_state,recovery_enabled:s.recovery_enabled,operational_pause:s.operational_pause,primary_usage_source:s.primary_usage_source,maintenance:s.maintenance.status,backup_status:s.backup_status,backup_verified_at:s.backup_verified_at,credential_generation:s.credential_generation,alerts:s.alerts.map(v=>({kind:v.kind,status:v.status,acknowledged:!!v.acknowledged_at}))};}
  report.accounts.push(account);
 }
 if(phase!=='before'){const spec=await get('/v1/openapi.json');report.openapi_routes=['/v1/channel-accounts/{id}/session','/v1/channel-accounts/{id}/primary-usage','/v1/channel-accounts/{id}/session/recovery'].map(path=>({path,present:!!spec.paths[path]}));if(report.openapi_routes.some(r=>!r.present))throw Error('CONTRACT_ROUTE_MISSING');}
 if(baselineFile){const before=JSON.parse(readFileSync(baselineFile,'utf8'));if(JSON.stringify(before.accounts.map(a=>a.id).sort())!==JSON.stringify(report.accounts.map(a=>a.id).sort()))throw Error('ACCOUNT_INVENTORY_CHANGED');for(const a of report.accounts){const old=before.accounts.find(v=>v.id===a.id);if(a.sending_enabled!==old.sending_enabled)throw Error('SENDING_CONFIGURATION_CHANGED');if(a.session.recovery_enabled||!a.session.operational_pause||a.session.desired_state!=='STOPPED')throw Error('UNEXPECTED_SESSION_ACTIVATION');}report.baseline_preserved=true;}
 report.status='VERIFIED_READ_ONLY';
}catch(e){report.status='FAILED';report.error=/^[A-Z_0-9]+$/.test(e.message)?e.message:'CHECK_FAILED';process.exitCode=1;}
writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
