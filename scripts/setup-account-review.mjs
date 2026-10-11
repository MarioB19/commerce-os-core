import pg from 'pg';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {localEnv} from './local-env.mjs';
const directory=process.argv[2]??join(homedir(),'.config','commerce-os-account-review');
if(existsSync(join(directory,'runtime.env')))throw new Error('Review configuration exists. Reuse it; no credential rotation.');
const connection=new URL(localEnv().DATABASE_URL);
if(!['127.0.0.1','localhost'].includes(connection.hostname))throw new Error('LOCAL_POSTGRES_REQUIRED');
const database='commerce_account_review_'+Date.now(),admin=new pg.Client({connectionString:connection.toString()});
await admin.connect();await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);await admin.end();connection.pathname='/'+database;
mkdirSync(directory,{recursive:true,mode:0o700});const assets=join(directory,'assets');mkdirSync(assets,{mode:0o700});
const key=()=>randomBytes(32).toString('hex');
const env={NODE_ENV:'development',DATABASE_URL:connection.toString(),WORKSPACE_ID:'account-review',PRIVATE_STORAGE_DIR:assets,ASSET_STORAGE_DIR:assets,BOOTSTRAP_EMAIL:'review@commerce.test',BOOTSTRAP_NAME:'Revisión local',BOOTSTRAP_PASSWORD:randomBytes(24).toString('base64url'),DISPATCH_FROZEN:'true',REAL_SENDS_ENABLED:'false',ALLOW_REAL_OPERATIONS:'false',ALLOW_CHANNEL_ONBOARDING:'false',COMMERCE_CONFIG_DIR:directory,BETTER_AUTH_SECRET:key(),DATA_ENCRYPTION_KEY:key(),BACKUP_ENCRYPTION_KEY:key(),INTERNAL_SERVICE_TOKEN:key(),CHANNEL_INTERNAL_TOKEN:key(),SIMULATOR_INGRESS_TOKEN:key(),INTERNAL_API_TOKEN:key(),BETTER_AUTH_URL:'http://127.0.0.1:5473',PUBLIC_WEB_ORIGIN:'http://127.0.0.1:5473',TRUSTED_ORIGINS:'http://127.0.0.1:5473,http://localhost:5473',API_PORT:'3301',INGRESS_PORT:'3302',AUTOMATION_PORT:'3303',CHANNEL_PORT:'3304',WEB_PORT:'5473',API_PROXY_TARGET:'http://127.0.0.1:3301',E2E_BASE_URL:'http://127.0.0.1:5473',CHANNEL_INTERNAL_URL:'http://127.0.0.1:3304',SMTP_ALLOWED_TARGETS:JSON.stringify([{host:'localhost',port:2527,addresses:['127.0.0.1'],mode:'local'}]),LOG_LEVEL:'silent'};
writeFileSync(join(directory,'runtime.env'),Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
for(const script of ['packages/db/src/migrate.ts','scripts/bootstrap.ts']){
 const result=await new Promise(resolve=>{const child=spawn(process.execPath,['--import','tsx',script],{stdio:'inherit',env:{...process.env,...env}});child.on('exit',resolve);});if(result!==0)process.exit(Number(result)||1);
}
console.log('Independent account review database ready; synthetic owner credential in protected runtime.env.');
