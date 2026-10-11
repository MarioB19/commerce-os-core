// Generates protected review configuration locally. Never connects to the VPS or starts gateways.
import {mkdirSync,existsSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
const [directory=join(homedir(),'.config','commerce-os-production-review'),origin='https://commerce.example.invalid',proxy='REPLACE_WITH_INSPECTED_CADDY_NETWORK']=process.argv.slice(2);
const target=resolve(directory),url=new URL(origin);
if(!/^[a-zA-Z0-9_./ -]+$/.test(target)||!/^[-a-zA-Z0-9_.]+$/.test(proxy))throw Error('Use plain private paths and Docker network names');
if(target.startsWith(resolve('.')+'/')||target===resolve('.'))throw Error('Secrets must live outside the repository');
if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw Error('HTTPS origin required');
if(existsSync(join(target,'release.env')))throw Error('Configuration exists; refusing to rotate or overwrite secrets');
mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);
const secret=()=>randomBytes(32).toString('hex');
const write=(file,obj)=>writeFileSync(join(target,file),Object.entries(obj).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
const ownerPassword=secret(),dataKey=secret(),authSecret=secret(),internalToken=secret(),simToken=secret();
const database=(user,password)=>`postgresql://${user}:${password}@postgres:5432/commerce`;
const common={NODE_ENV:'production',WORKSPACE_ID:'commerce',DATA_ENCRYPTION_KEY:dataKey,ENCRYPTION_KEY:dataKey,ASSET_STORAGE_DIR:'/data/private',PRIVATE_STORAGE_DIR:'/data/private',DISPATCH_FROZEN:'true',REAL_SENDS_ENABLED:'false',ALLOW_REAL_OPERATIONS:'false',ALLOW_CHANNEL_ONBOARDING:'false',LOG_LEVEL:'warn'};
write('postgres.env',{POSTGRES_USER:'commerce_owner',POSTGRES_PASSWORD:ownerPassword,POSTGRES_DB:'commerce'});
write('admin.env',{...common,DATABASE_URL:database('commerce_owner',ownerPassword),BETTER_AUTH_SECRET:authSecret,BETTER_AUTH_URL:url.origin,BOOTSTRAP_EMAIL:'REPLACE_WITH_OWNER_EMAIL',BOOTSTRAP_NAME:'Brandon',BOOTSTRAP_PASSWORD:secret()});
const roles=[];
for(const [service,profile]of [['api','api'],['ingress','ingress'],['automation','automation'],['channel','channel']]){
 const role=`commerce_${profile}_login`,password=secret();
 roles.push(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}' IN ROLE commerce_${profile};`);
 if(['automation','channel'].includes(profile))roles.push(`CREATE SCHEMA pgboss_${profile} AUTHORIZATION ${role};`);
 const cfg={...common,DATABASE_URL:database(role,password)};
 if(service==='api')Object.assign(cfg,{BETTER_AUTH_SECRET:authSecret,BETTER_AUTH_URL:url.origin,PUBLIC_WEB_ORIGIN:url.origin,SMTP_ALLOWED_TARGETS:'[]',TRUSTED_ORIGINS:url.origin,CHANNEL_INTERNAL_URL:'http://channel-worker:3004',INTERNAL_SERVICE_TOKEN:internalToken,COMMERCE_DEPLOYMENT_STATUS:'PREPARED',COMMERCE_EXTERNAL_MONITOR_STATUS:'NOT_INSTALLED'});
 if(service==='ingress')Object.assign(cfg,{SIMULATOR_INGRESS_TOKEN:simToken});
 if(service==='channel')Object.assign(cfg,{JOB_SCHEMA:'pgboss_channel',INTERNAL_SERVICE_TOKEN:internalToken,INTERNAL_INGRESS_URL:'http://ingress:3002'});
 if(service==='automation')Object.assign(cfg,{JOB_SCHEMA:'pgboss_automation'});
 write(service+'.env',cfg);
}
writeFileSync(join(target,'runtime-roles.sql'),'BEGIN;\n'+roles.join('\n')+'\nCOMMIT;\n',{mode:0o600,flag:'wx'});
write('backup.env',{BACKUP_ENCRYPTION_KEY:secret(),PG_CONTAINER:'commerce-os-postgres-1',PG_NETWORK:'commerce-os_core',POSTGRES_USER:'commerce_owner',POSTGRES_DB:'commerce',DATABASE_URL:database('commerce_owner',ownerPassword),COMMERCE_CONFIG_DIR:target,PRIVATE_STORAGE_DIR:join(target,'assets'),BACKUP_DIR:join(target,'backups'),RESTORE_ASSET_UID:'1000',RESTORE_ASSET_GID:'1000',DISPATCH_FROZEN:'true'});
write('release.env',{COMMERCE_IMAGE:'REPLACE_WITH_REGISTRY_IMAGE_AT_SHA256',COMMERCE_WEB_IMAGE:'REPLACE_WITH_REGISTRY_WEB_AT_SHA256',COMMERCE_SECRETS_DIR:target,COMMERCE_PRIVATE_ASSETS_DIR:join(target,'assets'),COMMERCE_PROXY_NETWORK:proxy,COMMERCE_ORIGIN:url.origin});
mkdirSync(join(target,'assets'),{mode:0o700});
console.log(JSON.stringify({prepared:true,directory:target,remote_actions:0,dispatch_frozen:true,needs:['verified image digests','approved domain and existing proxy network','real owner email','target paths and UID1000 asset permissions','explicit deployment authorization']}));
