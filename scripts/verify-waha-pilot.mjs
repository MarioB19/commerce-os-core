// Smoke a real, pinned gateway image on an internal Docker network. No sessions or sends.
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';

const root=process.argv[2]??join(homedir(),'.config','commerce-os-pilot-review');
const production=process.argv[3]??join(homedir(),'.config','commerce-os-production-review');
const envFile=path=>Object.fromEntries(readFileSync(path,'utf8').split('\n').filter(line=>line&&!line.startsWith('#')).map(line=>{const i=line.indexOf('=');return[line.slice(0,i),line.slice(i+1)];}));
const channel=envFile(join(root,'channel-pilot.env'));
const privateTemp=mkdtempSync(join(root,'smoke-'));
const anonymous=join(privateTemp,'docker-client');mkdirSync(anonymous,{mode:0o700});writeFileSync(join(anonymous,'config.json'),JSON.stringify({cliPluginsExtraDirs:[join(homedir(),'.docker','cli-plugins')]})+'\n',{mode:0o600});
const host=process.env.DOCKER_HOST??spawnSync('docker',['context','inspect','--format','{{.Endpoints.docker.Host}}'],{encoding:'utf8'}).stdout.trim();
assert.match(host,/^unix:\/\//,'Local Docker endpoint required');
const base=['--config',anonymous,'--host',host];
const run=(args,input,required=true)=>{
 const result=spawnSync('docker',[...base,...args],{encoding:'utf8',input,timeout:900000,maxBuffer:32*1024*1024});
 if(required&&result.status!==0)throw new Error('DOCKER_'+args[0].toUpperCase()+'_FAILED');
 return result.stdout??'';
};
const model=JSON.parse(run(['compose','--env-file',join(production,'release.env'),'--env-file',join(root,'pilot-release.env'),'-f','infra/compose/production.yaml','-f','infra/compose/pilot.yaml','--profile','waha-pilot','config','--format','json']));
const gateway=model.services['waha-01'];
assert.match(gateway.image,/^devlikeapro\/waha:gows-2026\.8\.2@sha256:[a-f0-9]{64}$/);
assert.equal(gateway.environment.WAHA_API_KEY,'sha512:'+createHash('sha512').update(channel.WAHA_01_API_KEY).digest('hex'));
const merged=join(privateTemp,'gateway.env');writeFileSync(merged,Object.entries(gateway.environment).map(([key,value])=>key+'='+value).join('\n')+'\n',{mode:0o600});
const name='commerce-waha-smoke-'+process.pid;
let evidence;
try{
 run(['pull','--platform','linux/amd64',gateway.image]);
 const image=JSON.parse(run(['image','inspect',gateway.image]))[0];
 assert.equal(image.Architecture,'amd64');assert.equal(image.Os,'linux');
 run(['network','create','--internal',name]);
 run(['volume','create',name+'-sessions']);run(['volume','create',name+'-media']);
 run(['run','-d','--name',name,'--platform','linux/amd64','--init','--network',name,'--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory',String(gateway.mem_limit),'--cpus',String(gateway.cpus),'--pids-limit',String(gateway.pids_limit),'--env-file',merged,'--volume',name+'-sessions:/app/.sessions','--volume',name+'-media:/app/.media',gateway.image]);
 const check=String.raw`
  const input=JSON.parse(require('node:fs').readFileSync(0,'utf8'));
  (async()=>{
   const deadline=Date.now()+120000;let ready=false;
   while(Date.now()<deadline){try{const r=await fetch('http://127.0.0.1:3000/api/sessions',{signal:AbortSignal.timeout(2000)});if(r.status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,1000));}
   if(!ready)throw Error('GATEWAY_NOT_READY');
   const get=async(path,key)=>{const r=await fetch('http://127.0.0.1:3000'+path,{headers:key?{'X-Api-Key':key}:{},signal:AbortSignal.timeout(10000)});return{status:r.status,body:await r.text()};};
   const absent=await get('/api/sessions'),wrong=await get('/api/sessions','invalid-smoke-key'),sessions=await get('/api/sessions?all=true',input.key),version=await get('/api/server/version',input.key),dashboard=await get('/dashboard'),swagger=await get('/');
   if(sessions.status!==200||JSON.parse(sessions.body).length!==0)throw Error('EMPTY_SESSION_LIST_REQUIRED');
   console.log(JSON.stringify({unauthenticated:absent.status,wrong_key:wrong.status,sessions_status:sessions.status,sessions:JSON.parse(sessions.body),version_status:version.status,version:JSON.parse(version.body),dashboard_status:dashboard.status,swagger_status:swagger.status}));
  })().catch(e=>{console.error(e.message);process.exit(1);});
 `;
 const result=JSON.parse(run(['exec','-i',name,'node','-e',check],JSON.stringify({key:channel.WAHA_01_API_KEY})));
 assert.equal(result.unauthenticated,401);assert.equal(result.wrong_key,401);assert.equal(result.version_status,200);
 assert.equal(result.version.engine,'GOWS');assert.equal(result.version.version,'2026.8.2');
 assert.equal(result.dashboard_status,404);assert.equal(result.swagger_status,404);
 const state=JSON.parse(run(['inspect',name]))[0];
 const stats=run(['stats','--no-stream','--format','{{json .}}',name]).trim();
 evidence={measured_at:new Date().toISOString(),image:gateway.image,image_id:image.Id,architecture:image.Architecture,os:image.Os,docker_reported_image_size_bytes:image.Size,network:'isolated Docker internal network; no published ports',checks:result,container_state:{running:state.State.Running,oom_killed:state.State.OOMKilled,published_ports:state.HostConfig.PortBindings,cap_drop:state.HostConfig.CapDrop,security_opt:state.HostConfig.SecurityOpt,memory_limit_bytes:state.HostConfig.Memory,nano_cpus:state.HostConfig.NanoCpus},idle_sample:JSON.parse(stats),sessions_created:0,whatsapp_accounts_linked:0,real_messages_sent:0,limitations:['Linux/amd64 ran under local Docker emulation, not on the VPS.','Read-only API and empty-session smoke does not validate pairing, provider messaging, incoming webhooks, media or real account quality.','One idle gateway does not measure ten active sessions.']};
 mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/waha-gows-smoke.json',JSON.stringify(evidence,null,2)+'\n');
 console.log(JSON.stringify({passed:true,image:gateway.image,checks:result,sessions_created:0,real_messages_sent:0}));
}finally{
 run(['rm','-f',name],undefined,false);
 for(const suffix of ['-sessions','-media'])run(['volume','rm',name+suffix],undefined,false);
 run(['network','rm',name],undefined,false);
 rmSync(privateTemp,{recursive:true,force:true});
}
