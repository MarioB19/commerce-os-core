// Maintenance after a local test diagnostic exposed a password. Never prints secrets.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import pg from 'pg';
import { localEnv, configDir } from './local-env.mjs';
const env=localEnv();
if(!['localhost','127.0.0.1'].includes(new URL(env.BETTER_AUTH_URL).hostname))throw new Error('LOCAL_ONLY');
if(!['localhost','127.0.0.1'].includes(new URL(env.DATABASE_URL).hostname))throw new Error('LOCAL_DATABASE_ONLY');
const oldPassword=env.BOOTSTRAP_PASSWORD;
const nextPassword=randomBytes(32).toString('base64url');
const files=['runtime.env','login.env'].map(name=>({path:join(configDir,name),field:name === 'runtime.env'?'BOOTSTRAP_PASSWORD':'COMMERCE_LOGIN_PASSWORD',original:readFileSync(join(configDir,name),'utf8')}));
if(files.some(file=>!new RegExp('^'+file.field+'=','m').test(file.original)))throw new Error('MISSING_LOCAL_PASSWORD_FIELD');
const db=new pg.Client({connectionString:env.DATABASE_URL});await db.connect();
try {
 await db.query('BEGIN');
 const user=(await db.query('SELECT id FROM "user" WHERE email=$1',[env.BOOTSTRAP_EMAIL])).rows[0];
 if(!user)throw new Error('LOCAL_USER_MISSING');
 const update=await db.query('UPDATE account SET password=$1 WHERE "userId"=$2 AND "providerId"=$3',[await hashPassword(nextPassword),user.id,'credential']);
 if(update.rowCount!==1)throw new Error('UNEXPECTED_LOCAL_CREDENTIAL_COUNT');
 await db.query('DELETE FROM session WHERE "userId"=$1',[user.id]);
 for(const file of files)writeFileSync(file.path,file.original.replace(new RegExp('^'+file.field+'=.*$','m'),file.field+'='+nextPassword),{mode:0o600});
 await db.query('COMMIT');
} catch {
 // Do not propagate driver errors: their message/cause can contain private connection data.
 await db.query('ROLLBACK');
 for(const file of files)writeFileSync(file.path,file.original,{mode:0o600});
 throw new Error('LOCAL_CREDENTIAL_ROTATION_FAILED');
} finally {await db.end();}
let sanitized=0;
function clean(folder){for(const entry of readdirSync(folder,{withFileTypes:true})){const path=join(folder,entry.name);if(entry.isDirectory())clean(path);else if(/\.(md|json|html|txt)$/.test(entry.name)){const body=readFileSync(path,'utf8');if(oldPassword && body.includes(oldPassword)){writeFileSync(path,body.split(oldPassword).join('[REDACTED_LOCAL_TEST_CREDENTIAL]'));sanitized++;}}}}
for(const folder of ['test-results','playwright-report'])clean(folder);
console.log(JSON.stringify({local_password_rotated:true,local_sessions_revoked:true,sanitized_artifacts:sanitized,production_modified:false}));
