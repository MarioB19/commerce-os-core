// Creates private files for one gateway; never starts a container or a session.
import {mkdirSync,existsSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {randomBytes,createHash} from 'node:crypto';
const target=resolve(process.argv[2]??join(homedir(),'.config','commerce-os-pilot-review'));
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!relative(repo,target).startsWith('..')||target.includes('/Second Brain/'))throw Error('PRIVATE_CONFIGURATION_MUST_BE_OUTSIDE_VAULT_AND_REPOSITORY');
if(existsSync(target))throw Error('Configuration exists; refusing to overwrite or rotate keys');
mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);
const write=(name,data)=>writeFileSync(join(target,name),Object.entries(data).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
const key=randomBytes(32).toString('hex'),webhook=randomBytes(32).toString('hex');
write('waha-01.env',{WAHA_API_KEY:'sha512:'+createHash('sha512').update(key).digest('hex')});
write('channel-pilot.env',{WAHA_01_URL:'http://waha-01:3000',WAHA_01_API_KEY:key,WAHA_01_WEBHOOK_SECRET:webhook,DISPATCH_FROZEN:'true',REAL_SENDS_ENABLED:'false',ALLOW_REAL_OPERATIONS:'false'});
write('ingress-pilot.env',{WAHA_01_WEBHOOK_SECRET:webhook});
write('pilot-release.env',{COMMERCE_GATEWAY_CONFIG_DIR:target});
console.log(JSON.stringify({prepared:true,directory:target,slots:1,image:'devlikeapro/waha:gows-2026.8.2@sha256:4db10103027a0cb97a294241cb7902a5a1e4ec869581faa7de420d5a0b8b1dd0',profiles_selected:[],containers_started:0,sessions_created:0}));
