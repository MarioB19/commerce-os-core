// Generates local private review files only; never pulls images, starts or pairs gateways.
import {mkdirSync,existsSync,writeFileSync,chmodSync} from 'node:fs';
import {join,resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
const target=resolve(process.argv[2]??join(homedir(),'.config','commerce-os-gateways-review'));
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(!relative(repo,target).startsWith('..')||target.includes('/Second Brain/'))throw Error('PRIVATE_CONFIGURATION_MUST_BE_OUTSIDE_VAULT_AND_REPOSITORY');
if(existsSync(target))throw Error('Configuration exists; refusing to overwrite or rotate keys');
mkdirSync(target,{recursive:true,mode:0o700});chmodSync(target,0o700);
const write=(name,data)=>writeFileSync(join(target,name),Object.entries(data).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
const channel={DISPATCH_FROZEN:'true',REAL_SENDS_ENABLED:'false',ALLOW_REAL_OPERATIONS:'false'},ingress={};
for(const slot of [...Array.from({length:10},(_,i)=>String(i+1).padStart(2,'0')),'noweb-comparator']){
 const ref=slot==='noweb-comparator'?'WAHA_NOWEB_COMPARATOR':`WAHA_${slot}`;
 const apiKey=randomBytes(32).toString('hex'),webhookKey=randomBytes(32).toString('hex');
 write(`waha-${slot}.env`,{WAHA_API_KEY:apiKey});
 Object.assign(channel,{[`${ref}_URL`]:`http://waha-${slot}:3000`,[`${ref}_API_KEY`]:apiKey,[`${ref}_WEBHOOK_SECRET`]:webhookKey});
 Object.assign(ingress,{[`${ref}_WEBHOOK_SECRET`]:webhookKey});
}
write('channel-gateways.env',channel);write('ingress-gateways.env',ingress);
write('gateway-release.env',{COMMERCE_GATEWAY_CONFIG_DIR:target,WAHA_GOWS_DIGEST:'',WAHA_NOWEB_DIGEST:''});
console.log(JSON.stringify({prepared:true,directory:target,gows_slots:10,noweb_comparator_slots:1,profiles_selected:[],gateways_started:0,remote_actions:0,digests_required:true}));
