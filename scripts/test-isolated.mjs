import pg from 'pg';
import { spawn } from 'node:child_process';
import {randomUUID} from 'node:crypto';
import { applyLocalEnv } from './local-env.mjs';
applyLocalEnv();
const database=`commerce_test_${Date.now()}_${randomUUID().slice(0,8)}`;
const connection=new URL(process.env.DATABASE_URL);const admin=new pg.Client({connectionString:connection.toString()});await admin.connect();
await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);connection.pathname='/'+database;
const env={...process.env,DATABASE_URL:connection.toString(),LOG_LEVEL:'silent'};
const run=(cmd,args)=>new Promise((resolve,reject)=>{const child=spawn(cmd,args,{stdio:'inherit',env});child.on('error',reject);child.on('exit',code=>resolve(code??1));});
let code;
try {
 code=await run(process.execPath,['--import','tsx','packages/db/src/migrate.ts']);
 if(code===0)code=await run('pnpm',['exec','vitest','run','--config','vitest.integration.config.ts',...process.argv.slice(2)]);
 if(code===0)await admin.query(`DROP DATABASE "${database}"`);
 else console.log(`Retained failed verification database: ${database}. No live data or gateway sessions are used.`);
}finally{await admin.end();}
process.exit(Number(code));
