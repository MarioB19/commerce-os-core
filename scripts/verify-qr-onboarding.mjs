// Explicit integration rehearsal: disposable gateway + isolated database, no scan or send.
import {spawnSync,spawn} from 'node:child_process';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const image='devlikeapro/waha:gows-2026.8.2@sha256:4db10103027a0cb97a294241cb7902a5a1e4ec869581faa7de420d5a0b8b1dd0';
const name='commerce-qr-audit-'+process.pid,root=mkdtempSync(join(tmpdir(),'commerce-qr-audit-')),key=randomBytes(32).toString('hex');
const docker=(args,required=true)=>{const result=spawnSync('docker',args,{encoding:'utf8',timeout:120_000,maxBuffer:1024*1024});if(required&&result.status!==0)throw new Error('DOCKER_'+args[0].toUpperCase()+'_FAILED');return result.stdout??'';};
const file=join(root,'gateway.env');
writeFileSync(file,Object.entries({WAHA_API_KEY:'sha512:'+createHash('sha512').update(key).digest('hex'),WHATSAPP_DEFAULT_ENGINE:'GOWS',WAHA_PRINT_QR:'false',WAHA_DASHBOARD_ENABLED:'false',WHATSAPP_SWAGGER_ENABLED:'false',WHATSAPP_RESTART_ALL_SESSIONS:'false',WAHA_WORKER_RESTART_SESSIONS:'false',WHATSAPP_START_SESSION:'',WAHA_APPS_ENABLED:'false',WAHA_LOG_LEVEL:'silent',WAHA_HTTP_LOG_LEVEL:'silent',WHATSAPP_FILES_FOLDER:'/app/.media'}).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
let status;
try{
 docker(['image','inspect',image,'--format','{{.Id}}']); // Never resolve a mutable tag or pull implicitly.
 docker(['run','-d','--name',name,'--platform','linux/amd64','--init','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','768m','--cpus','1','--pids-limit','100','--publish','127.0.0.1::3000','--env-file',file,'--tmpfs','/app/.sessions:rw,size=64m','--tmpfs','/app/.media:rw,size=64m',image]);
 const port=docker(['port',name,'3000/tcp']).trim();if(!/^127\.0\.0\.1:\d+$/.test(port))throw new Error('LOOPBACK_PORT_REQUIRED');
 const base='http://'+port;
 let ready=false;for(let i=0;i<90;i++){try{const r=await fetch(base+'/api/sessions',{headers:{'X-Api-Key':key},signal:AbortSignal.timeout(1500)});if(r.ok){const list=await r.json();if(list.length!==0)throw new Error('FRESH_EMPTY_GATEWAY_REQUIRED');ready=true;break;}}catch{/* Startup can refuse connections before the private HTTP server is ready. */}await new Promise(resolve=>setTimeout(resolve,1000));}
 if(!ready)throw new Error('GATEWAY_NOT_READY');
 status=await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['scripts/test-isolated.mjs','tests/integration/channel-onboarding.test.ts'],{stdio:'inherit',env:{...process.env,QR_GATEWAY_URL:base,QR_GATEWAY_KEY:key}});child.on('error',reject);child.on('exit',code=>resolve(code??1));});
 const response=await fetch(base+'/api/sessions/default',{headers:{'X-Api-Key':key},signal:AbortSignal.timeout(10_000)});const session=await response.json();
 const raw=await (await fetch(base+'/api/default/auth/qr?format=raw',{headers:{'X-Api-Key':key,Accept:'application/json'},signal:AbortSignal.timeout(10_000)})).json();
 const logs=docker(['logs',name],false);const noSecrets=typeof raw.value==='string'&&!logs.includes(raw.value)&&!logs.includes(key)&&!logs.includes('data:image/png')&&!logs.includes('iVBORw0KGgo')&&!logs.includes('qrCode');
 const evidence={measured_at:new Date().toISOString(),mode:'local pinned real gateway; ephemeral session, no human scan',image,passed:status===0,api_worker_adapter_gateway_test:status===0?'passed':'failed',session_status:['SCAN_QR_CODE','STARTING','STOPPED','WORKING','FAILED'].includes(session.status)?session.status:'UNKNOWN',identity_connected:!!session.me?.id,real_messages_sent:0,production_modified:false,log_secret_scan_passed:noSecrets,log_bytes:logs.length,qr_persisted:false,cleanup:'Disposable container removed; session/media were tmpfs',limitations:['The QR is intentionally neither printed nor captured and is destroyed with the disposable session.','Scan, identity after scan, live webhooks and reconnect after human linking require authorized human intervention.','The local gateway runs Linux/amd64 under emulation; this is not production QR verification.']};
 if(evidence.identity_connected||!noSecrets)status=1;
 writeFileSync('docs/evidence/qr-real-gateway.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));
}finally{docker(['rm','-f',name],false);rmSync(root,{recursive:true,force:true});}
process.exit(status);
