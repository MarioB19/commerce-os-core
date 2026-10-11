import pg from 'pg';
import {existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {localEnv} from './local-env.mjs';
const directory=process.argv[2]??join(homedir(),'.config','commerce-os-campaign-review');
if(existsSync(join(directory,'runtime.env')))throw new Error('Review configuration exists; reuse it. No secrets rotated.');
const original=localEnv(),connection=new URL(original.DATABASE_URL);
if(!['127.0.0.1','localhost'].includes(connection.hostname))throw new Error('LOCAL_POSTGRES_REQUIRED');
const database='commerce_campaign_review_'+Date.now(),admin=new pg.Client({connectionString:connection.toString()});await admin.connect();await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);await admin.end();connection.pathname='/'+database;
mkdirSync(directory,{recursive:true,mode:0o700});const assets=join(directory,'assets');mkdirSync(assets,{mode:0o700});
const env={...original,DATABASE_URL:connection.toString(),WORKSPACE_ID:'campaign-review',PRIVATE_STORAGE_DIR:assets,ASSET_STORAGE_DIR:assets,BOOTSTRAP_EMAIL:'review@commerce.test',BOOTSTRAP_NAME:'Revisión local',BOOTSTRAP_PASSWORD:randomBytes(24).toString('base64url'),DISPATCH_FROZEN:'true',REAL_SENDS_ENABLED:'false',ALLOW_REAL_OPERATIONS:'false',ALLOW_CHANNEL_ONBOARDING:'false',COMMERCE_CONFIG_DIR:directory};
writeFileSync(join(directory,'runtime.env'),Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
for(const script of ['packages/db/src/migrate.ts','scripts/bootstrap.ts','scripts/seed-campaign-review.ts']){
 const result=await new Promise(resolve=>{const child=spawn(process.execPath,['--import','tsx',script],{stdio:'inherit',env:{...process.env,...env}});child.on('exit',resolve);});if(result!==0)process.exit(Number(result)||1);
}
console.log('Independent local review database prepared. No production or real messaging changes.');
