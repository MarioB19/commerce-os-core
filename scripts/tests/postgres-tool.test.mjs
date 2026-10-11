import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {postgresTool} from '../postgres-tool.mjs';

function credentialUrl(base,password,user='fixture'){
 const url=new URL(base);url.username=encodeURIComponent(user);url.password=encodeURIComponent(password);return url.href;
}

test('Docker remains the default with the existing container, user and dump options',()=>{
 const password=randomBytes(24).toString('hex');
 const env={DATABASE_URL:credentialUrl('postgresql://postgres/source',password),PG_CONTAINER:'fixture-postgres',POSTGRES_USER:'fixture'};
 const dump=postgresTool('pg_dump',{env,args:['--format=custom','--no-owner','--snapshot=fixture-snapshot']});
 assert.deepEqual(dump,{command:'docker',args:['exec','fixture-postgres','pg_dump','--format=custom','--no-owner','--snapshot=fixture-snapshot','-U','fixture','-d','source'],env});
 assert.equal(JSON.stringify(dump.args).includes(password),false);
 const defaults=postgresTool('pg_dump',{env:{DATABASE_URL:'postgresql://fixture@localhost/source'}});
 assert.deepEqual(defaults.args,['exec','commerce-os-local-postgres-1','pg_dump','-U','commerce','-d','source']);
});

test('Docker restore remains interactive and selects the new target rather than the source database',()=>{
 const restore=postgresTool('pg_restore',{env:{DATABASE_URL:'postgresql://fixture@localhost/source'},database:'commerce_restore_fixture',args:['--exit-on-error','--no-owner','--no-acl']});
 assert.deepEqual(restore.args,['exec','-i','commerce-os-local-postgres-1','pg_restore','--exit-on-error','--no-owner','--no-acl','-U','commerce','-d','commerce_restore_fixture']);
 const appName='deploy-'+randomBytes(16).toString('hex');
 const tracked=postgresTool('pg_dump',{env:{DATABASE_URL:'postgresql://fixture@localhost/source',PGAPPNAME:appName}});
 assert.deepEqual(tracked.args,['exec','--env','PGAPPNAME='+appName,'commerce-os-local-postgres-1','pg_dump','-U','commerce','-d','source']);
 assert.throws(()=>postgresTool('pg_dump',{env:{DATABASE_URL:'postgresql://fixture@localhost/source',PGAPPNAME:'invalid name'}}),/POSTGRES_APPLICATION_NAME_INVALID/);
});

test('native opt-in uses the supplied binary and keeps decoded connection values out of argv',()=>{
 const password=randomBytes(24).toString('hex')+':@$';
 const env={DATABASE_URL:credentialUrl('postgresql://127.0.0.1:55447/source%20db?sslmode=require',password,'fixture user'),POSTGRES_TOOLS_MODE:'native',POSTGRES_BIN_DIR:'/fixture/pg17/bin',PGDATABASE:'stale'};
 const dump=postgresTool('pg_dump',{env,args:['--format=custom','--snapshot=fixture-snapshot']});
 assert.equal(dump.command,'/fixture/pg17/bin/pg_dump');
 assert.deepEqual(dump.args,['--format=custom','--snapshot=fixture-snapshot','-d','source db']);
 assert.equal(dump.env.PGHOST,'127.0.0.1');assert.equal(dump.env.PGPORT,'55447');
 assert.equal(dump.env.PGUSER,'fixture user');assert.equal(dump.env.PGPASSWORD,password);
 assert.equal(dump.env.PGDATABASE,'source db');assert.equal(dump.env.PGSSLMODE,'require');
 assert.equal(env.PGDATABASE,'stale');
 assert.equal(JSON.stringify(dump.args).includes(password),false);
 assert.equal(JSON.stringify(dump.args).includes(encodeURIComponent(password)),false);
 const restore=postgresTool('pg_restore',{env,database:'commerce_restore_fixture',args:['--exit-on-error']});
 assert.equal(restore.env.PGDATABASE,'commerce_restore_fixture');assert.deepEqual(restore.args,['--exit-on-error','-d','commerce_restore_fixture']);
});

test('native connection overrides use the resolved host and support IPv6 without URL brackets',()=>{
 const invocation=postgresTool('pg_dump',{env:{DATABASE_URL:'postgresql://unused@postgres/source',POSTGRES_TOOLS_MODE:'native'},databaseUrl:'postgresql://fixture@[::1]:55447/actual'});
 assert.equal(invocation.command,'pg_dump');assert.equal(invocation.env.PGHOST,'::1');
 assert.equal(invocation.env.PGDATABASE,'actual');assert.equal(invocation.env.PGUSER,'fixture');
});

test('rejects unsupported tools, modes and malformed URLs without exposing their contents',()=>{
 assert.throws(()=>postgresTool('psql'),/POSTGRES_TOOL_INVALID/);
 assert.throws(()=>postgresTool('pg_dump',{env:{DATABASE_URL:'postgresql://fixture@localhost/db',POSTGRES_TOOLS_MODE:'automatic'}}),/POSTGRES_TOOLS_MODE_INVALID/);
 const privateValue=randomBytes(24).toString('hex'),malformed=new URL('postgresql://fixture@localhost/db');malformed.password='%ZZ';
 for(const databaseUrl of [privateValue,credentialUrl('https://example.invalid/db',privateValue),malformed.href]){
  assert.throws(()=>postgresTool('pg_dump',{databaseUrl,env:{POSTGRES_TOOLS_MODE:'native'}}),error=>error.message==='POSTGRES_DATABASE_URL_INVALID'&&!JSON.stringify(error).includes(privateValue));
 }
 assert.throws(()=>postgresTool('pg_dump',{env:{DATABASE_URL:'postgresql://fixture@localhost'}}),/POSTGRES_DATABASE_REQUIRED/);
});
