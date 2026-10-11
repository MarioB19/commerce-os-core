import pg from 'pg';import {spawn} from 'node:child_process';import {applyLocalEnv} from './local-env.mjs';
import {databaseBackingStorage} from './numbers-soak-storage.mjs';
applyLocalEnv();const storage=await databaseBackingStorage();console.log(JSON.stringify({postgres_backing_storage:storage}));if(storage.available_bytes<650*1024*1024)throw Error('ISOLATED_POSTGRES_DISK_HEADROOM_UNDER_650_MIB');
const name='commerce_numbers_soak_'+Date.now(),url=new URL(process.env.DATABASE_URL),admin=new pg.Client({connectionString:url.href});await admin.connect();await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);url.pathname='/'+name;
const env={...process.env,DATABASE_URL:url.href,LOG_LEVEL:'silent'};const run=file=>new Promise(resolve=>{const child=spawn(process.execPath,['--import','tsx',file],{env,stdio:'inherit'});child.on('exit',code=>resolve(code??1));});
let result;try{result=await run('packages/db/src/migrate.ts');if(!result)result=await run('scripts/numbers-soak.ts');console.log('Retained isolated capacity evidence database: '+name);}finally{await admin.end();}process.exit(Number(result));
