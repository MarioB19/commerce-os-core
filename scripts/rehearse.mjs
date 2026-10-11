// Local Docker fixture only. No VPS, external gateway, notification or real message.
import {spawnSync} from 'node:child_process';
import {mkdirSync,existsSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import https from 'node:https';
import {randomUUID} from 'node:crypto';
const privateDir=resolve(process.env.REHEARSAL_PRIVATE_DIR??join(homedir(),'.config','commerce-review-20260905'));
const origin='https://localhost:18443';
const readEnv=file=>Object.fromEntries(readFileSync(file,'utf8').trim().split('\n').map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
function run(command,args,options={}){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:10*1024*1024,...options});if(r.status!==0)throw Error(`${command} ${args.slice(0,3).join(' ')} failed: ${(r.stderr||r.stdout||'').slice(-3500)}`);return r.stdout.trim();}
if(!existsSync(join(privateDir,'release.env')))run(process.execPath,['scripts/prepare-production.mjs',privateDir,origin,'commerce-review-proxy']);
const release=readEnv(join(privateDir,'release.env'));
if(release.COMMERCE_ORIGIN!==origin||release.COMMERCE_SECRETS_DIR!==privateDir)throw Error('Refusing a configuration that is not this localhost rehearsal');
for(const file of ['admin','api','ingress','automation','channel']){const cfg=readEnv(join(privateDir,file+'.env'));const url=new URL(cfg.DATABASE_URL);if(url.hostname!=='postgres'||url.pathname!=='/commerce'||url.port!=='5432')throw Error('Rehearsal databases must target only the isolated postgres service');}
Object.assign(release,{COMMERCE_IMAGE:'commerce-os:local-review',COMMERCE_WEB_IMAGE:'commerce-os-web:local-review',COMMERCE_MAINTENANCE_IMAGE:'commerce-os-maintenance:local-review',COMMERCE_PROXY_NETWORK:'commerce-review-proxy',COMMERCE_ORIGIN:origin});
for(const key of ['COMMERCE_IMAGE','COMMERCE_WEB_IMAGE','COMMERCE_MAINTENANCE_IMAGE'])release[key]=JSON.parse(run('docker',['image','inspect',release[key]]))[0].Id;
const env={...process.env,...release};
const composeArgs=['compose','--project-name','commerce-review','--env-file',join(privateDir,'release.env'),'-f','infra/compose/production.yaml','-f','infra/compose/rehearsal.yaml'];
const compose=(args,options)=>run('docker',[...composeArgs,...args],{env,...options});
const checks=[];
const assert=(condition,label)=>{if(!condition)throw Error(label);checks.push(label);};
const admin=readEnv(join(privateDir,'admin.env'));
admin.BOOTSTRAP_EMAIL='review-owner@example.invalid';
writeFileSync(join(privateDir,'admin.env'),Object.entries(admin).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
const caddy=readFileSync('infra/caddy/commerce.Caddyfile.example','utf8').replace('commerce.example.com {','https://localhost {\n  tls internal');
writeFileSync(join(privateDir,'rehearsal.Caddyfile'),caddy,{mode:0o600});
const result={fixture:'local_docker_production_configuration',at:new Date().toISOString(),real_messages:0,remote_actions:0,checks};
let started=false;
try {
 const network=spawnSync('docker',['network','inspect','commerce-review-proxy'],{stdio:'ignore'});
 if(network.status!==0)run('docker',['network','create','--label','commerce.fixture=production-rehearsal','commerce-review-proxy']);
 compose(['config','--quiet']);
 compose(['up','-d','--wait','postgres']);started=true;
 const containerEnv=['--env-file',join(privateDir,'admin.env')];
 const adminRun=args=>run('docker',['run','--rm','--network','commerce-review_core',...containerEnv,release.COMMERCE_IMAGE,...args]);
 adminRun(['node','--import','tsx','packages/db/src/migrate.ts']);
 const rolesExists=compose(['exec','-T','postgres','psql','-U','commerce_owner','-d','commerce','-Atc',"SELECT count(*) FROM pg_roles WHERE rolname='commerce_api_login'"]);
 if(rolesExists==='0')compose(['exec','-T','postgres','psql','-v','ON_ERROR_STOP=1','-U','commerce_owner','-d','commerce'],{input:readFileSync(join(privateDir,'runtime-roles.sql'),'utf8')});
 adminRun(['node','--import','tsx','scripts/bootstrap.ts']);
 // A disposable local helper sets the bind ownership expected on Linux; no remote chmod.
 run('docker',['run','--rm','--network','none','--user','0:0','-v',`${release.COMMERCE_PRIVATE_ASSETS_DIR}:/data/private`,release.COMMERCE_IMAGE,'chown','1000:1000','/data/private']);
 compose(['up','-d','--wait','--wait-timeout','120','api','ingress','automation-worker','channel-worker','web','edge']);
 for(const service of ['api','ingress','automation-worker','channel-worker']){
  const id=compose(['ps','-q',service]);const inspect=JSON.parse(run('docker',['inspect',id]))[0];
  assert(inspect.HostConfig.ReadonlyRootfs===true,`${service}: readonly root`);
  const db=JSON.parse(compose(['exec','-T',service,'node','--input-type=module','-e',"import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query('SELECT current_user username,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');console.log(JSON.stringify(r.rows[0]));await c.end();"]));
  assert(db.username.endsWith('_login')&&!db.rolsuper&&!db.rolcreatedb&&!db.rolcreaterole,`${service}: restricted distinct login ${db.username}`);
  const forbiddenKind=service==='automation-worker'?'product':'contact';
  const denied=compose(['exec','-T',service,'node','--input-type=module','-e',`import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();await c.query('BEGIN');let denied=false;try{await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES('fixture','SIMULATION','${forbiddenKind}','{}')");}catch{denied=true}await c.query('ROLLBACK');await c.end();console.log(denied);`]);
  assert(denied==='true',`${service}: wrong domain writes denied`);
  assert(inspect.Config.Env.includes('DISPATCH_FROZEN=true')&&inspect.Config.Env.includes('REAL_SENDS_ENABLED=false'),`${service}: real dispatch frozen`);
 }
 const schemas=compose(['exec','-T','postgres','psql','-U','commerce_owner','-d','commerce','-Atc',"SELECT nspname||':'||pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname LIKE 'pgboss%' ORDER BY nspname"]);
 assert(schemas==='pgboss_automation:commerce_automation_login\npgboss_channel:commerce_channel_login','separate owned pg-boss schemas');
 for(const [service,expected] of [['api',true],['automation-worker',false],['channel-worker',true]]){
  const probe=compose(['exec','-T',service,'node','-e',"const f=require('node:fs'),p='/data/private/.mount-probe-'+process.pid;try{f.writeFileSync(p,'synthetic');f.unlinkSync(p);console.log('rw')}catch{console.log('ro')}"]);
  assert((probe==='rw')===expected,`${service}: private asset mount ${expected?'rw':'ro'}`);
 }
 const edge=compose(['ps','-q','edge']);
 run('docker',['cp',`${edge}:/data/caddy/pki/authorities/local/root.crt`,join(privateDir,'rehearsal-root.crt')]);
 const ca=readFileSync(join(privateDir,'rehearsal-root.crt'));
 let cookies='';
 async function request(path,method='GET',body){return await new Promise((resolve,reject)=>{const req=https.request(origin+path,{ca,method,headers:{Origin:origin,...(cookies?{Cookie:cookies}:{}),...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID()}: {})}},res=>{const parts=[];res.on('data',part=>parts.push(part));res.on('end',()=>{if(res.headers['set-cookie'])cookies=res.headers['set-cookie'].map(value=>value.split(';')[0]).join('; ');const text=Buffer.concat(parts).toString();let data;try{data=JSON.parse(text)}catch{data=text}resolve({status:res.statusCode,headers:res.headers,data});});});req.on('error',reject);if(body)req.write(JSON.stringify(body));req.end();});}
 assert((await request('/')).status===200,'HTTPS web through local Caddy');
 const readiness=await request('/readyz');
 assert(readiness.status===200&&readiness.data.status==='ready'&&readiness.data.service==='api','HTTPS readiness proxies to API');
 assert((await request('/v1/me')).status===401,'anonymous API request denied');
 const auth=await request('/api/auth/sign-in/email','POST',{email:admin.BOOTSTRAP_EMAIL,password:admin.BOOTSTRAP_PASSWORD});
 assert(auth.status===200&&cookies.includes('session_token'),'login through HTTPS proxy sets session cookie');
 assert(auth.headers['set-cookie'].every(value=>value.includes('Secure')&&value.includes('HttpOnly')),'session cookies are Secure and HttpOnly');
 assert((await request('/v1/me')).data.data.role==='owner','session authorizes private API');
 const product=await request('/v1/products','POST',{environment:'SIMULATION',name:'Docker rehearsal synthetic',initial_offer:{currency:'MXN',base_amount_minor:100,fulfillment:[]}});
 assert(product.status===201,'restricted API persists product and offer');
 const asset=await request('/v1/assets','POST',{environment:'SIMULATION',name:'Docker evidence',kind:'file',mime_type:'text/plain',size_bytes:9});
 assert(asset.status===201,'asset metadata created');
 assert((await request(`/v1/assets/${asset.data.data.id}/content`,'PUT',{base64:Buffer.from('synthetic').toString('base64')})).status===200,'encrypted asset upload on writable mount');
 assert((await request(`/v1/assets/${asset.data.data.id}/complete`,'POST',{})).status===200,'asset sealed by restricted API');
 const accounts=(await request('/v1/channel-accounts?environment=SIMULATION')).data.data;
 const inbound=JSON.parse(compose(['exec','-T','ingress','node','--input-type=module','-e',`const body=JSON.stringify({id:'docker-fixture-'+Date.now(),identity:'opaque:docker-fixture',kind:'text',text:'Synthetic durable ingress'});const url='http://127.0.0.1:3002/webhooks/simulator/commerce/${accounts[0].id}';const send=()=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.SIMULATOR_INGRESS_TOKEN},body}).then(r=>r.json());console.log(JSON.stringify([await send(),await send()]));`]));
 assert(inbound[0].ok&&inbound[0].duplicate===false&&inbound[1].duplicate===true,'restricted ingress commits and deduplicates envelope');
 const sim=await request('/v1/simulations','POST',{account_id:accounts[0].id,offer_version_id:product.data.data.initial_offer.id,contact_name:'Docker fixture'});
 assert(sim.status===202,'simulation durable command accepted');
 let conversation;
 for(let i=0;i<40;i++){const row=(await request(`/v1/simulations/${sim.data.data.id}`)).data.data;if(row.conversation_id){conversation=row.conversation_id;break;}await new Promise(resolve=>setTimeout(resolve,250));}
 assert(!!conversation,'restricted automation consumes simulation command');
 const command=await request(`/v1/channel-accounts/${accounts[0].id}/commands`,'POST',{type:'check_health'});
 let applied=false;
 for(let i=0;i<40;i++){const row=(await request(`/v1/commands/${command.data.data.id}`)).data.data;if(row.status==='APPLIED'){applied=true;break;}await new Promise(resolve=>setTimeout(resolve,250));}
 assert(applied,'restricted channel consumes health command');
 const monitorState=join(privateDir,'external-monitor.json');
 const monitorEnv={...process.env,MONITOR_URL:origin+'/readyz',MONITOR_STATE_FILE:monitorState,NODE_EXTRA_CA_CERTS:join(privateDir,'rehearsal-root.crt')};
 run(process.execPath,['scripts/external-monitor.mjs'],{env:monitorEnv});
 assert(JSON.parse(readFileSync(monitorState,'utf8')).state==='UP','external monitor accepts local HTTPS readiness');
 const failureEnv={...monitorEnv,MONITOR_URL:'https://localhost:18444/readyz'};
 const first=spawnSync(process.execPath,['scripts/external-monitor.mjs'],{env:failureEnv});
 const second=spawnSync(process.execPath,['scripts/external-monitor.mjs'],{env:failureEnv});
 assert(first.status===0&&second.status===2,'external monitor fails after two unavailable probes');
 run(process.execPath,['scripts/external-monitor.mjs'],{env:monitorEnv});
 assert(JSON.parse(readFileSync(monitorState,'utf8')).state==='UP','external monitor records recovery without notifications');
 const backupEnv=readEnv(join(privateDir,'backup.env'));
 Object.assign(backupEnv,{PG_CONTAINER:'commerce-review-postgres-1',PG_NETWORK:'commerce-review_core',COMMERCE_CONFIG_DIR:privateDir,PRIVATE_STORAGE_DIR:release.COMMERCE_PRIVATE_ASSETS_DIR,BACKUP_DIR:join(privateDir,'backups'),RESTORE_ASSET_UID:'1000',RESTORE_ASSET_GID:'1000'});
 writeFileSync(join(privateDir,'backup.env'),Object.entries(backupEnv).map(([key,value])=>`${key}=${value}`).join('\n')+'\n',{mode:0o600});
 const maintenance=args=>run('docker',['run','--rm','--network','commerce-review_core','--user','0:0','--env-file',join(privateDir,'backup.env'),'-v','/var/run/docker.sock:/var/run/docker.sock','-v',`${privateDir}:${privateDir}`,'-v',`${release.COMMERCE_PRIVATE_ASSETS_DIR}:${release.COMMERCE_PRIVATE_ASSETS_DIR}`,release.COMMERCE_MAINTENANCE_IMAGE,...args]);
 const cli=maintenance(['docker','version','--format','{{.Client.Version}}']);
 assert(cli==='29.8.0','maintenance Docker CLI operates through explicit temporary socket mount');
 const backup=JSON.parse(maintenance(['node','scripts/backup.mjs']));
 assert(backup.encrypted&&backup.snapshot_consistent&&backup.private_assets>=1,'maintenance encrypted snapshot includes private assets');
 const restored=JSON.parse(maintenance(['node','scripts/restore.mjs',backup.backup,'commerce_restore_docker_'+Date.now()]));
 assert(restored.restored&&restored.dispatch_frozen&&restored.private_assets_restored===backup.private_assets,'maintenance restore creates independent frozen database and restores assets');
 const readable=run('docker',['run','--rm','--network','none','--read-only','--user','1000:1000','-v',`${restored.private_storage_dir}:/data/private:ro`,release.COMMERCE_IMAGE,'node','-e',"const fs=require('node:fs');const files=fs.readdirSync('/data/private/assets');console.log(files.length>0&&files.every(file=>fs.readFileSync('/data/private/assets/'+file).length>0))"]);
 assert(readable==='true','restored private files are readable by runtime UID1000 on their exact mount');
 result.maintenance={private_assets:backup.private_assets,restored_frozen:restored.dispatch_frozen,database:restored.database};
 result.images=Object.fromEntries(['COMMERCE_IMAGE','COMMERCE_WEB_IMAGE','COMMERCE_MAINTENANCE_IMAGE'].map(k=>[k,release[k]]));
 result.passed=true;
}catch(error){result.passed=false;result.error=error.message;process.exitCode=1;}
finally{
 if(started&&!process.env.KEEP_REHEARSAL){compose(['down','--volumes','--remove-orphans']);run('docker',['network','rm','commerce-review-proxy']);result.cleaned_up=true;}
 mkdirSync('docs/evidence',{recursive:true});writeFileSync('docs/evidence/production-rehearsal.json',JSON.stringify(result,null,2)+'\n');
 chmodSync(privateDir,0o700);console.log(JSON.stringify(result,null,2));
}
