import {cp,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const folder=await mkdtemp(join(tmpdir(),'mcl-standalone-'));
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const core=randomBytes(20).toString('hex').toUpperCase(),kit=randomBytes(20).toString('hex').toUpperCase(),hash=s=>createHash('sha256').update(s).digest('hex');
let child, childOutput='';
try{
 await cp('.next/standalone',folder,{recursive:true});await cp('.next/static',join(folder,'.next/static'),{recursive:true});await cp('public',join(folder,'public'),{recursive:true});await cp('private/pdfs',join(folder,'private/pdfs'),{recursive:true});await mkdir(join(folder,'state'));
 const base='http://127.0.0.1:'+port;
 child=spawn(process.execPath,['--experimental-sqlite','server.js'],{cwd:folder,stdio:['ignore','pipe','pipe'],env:{...process.env,HOSTNAME:'127.0.0.1',PORT:String(port),MCL_SESSION_SECRET:randomBytes(32).toString('hex'),MCL_CORE_CODES_SHA256:hash(core),MCL_KIT_CODES_SHA256:hash(kit),MCL_ACCESS_DB:join(folder,'state/attempts.sqlite'),NEXT_PUBLIC_SITE_URL:base}});
 for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{childOutput=(childOutput+chunk).slice(-8000);});
 let ready=false;for(let i=0;i<150;i++){try{ready=(await fetch(base+'/api/version')).ok;}catch{}if(ready||child.exitCode!==null)break;await new Promise(r=>setTimeout(r,200));}assert(ready,'Standalone did not become ready: '+childOutput);
 const smoke=spawn(process.execPath,['scripts/smoke-http.mjs'],{stdio:'inherit',env:{...process.env,MCL_BASE_URL:base,MCL_CORE_CODE:core,MCL_KIT_CODE:kit}});assert.equal(await new Promise(r=>smoke.on('exit',r)),0);
 const logout=await fetch(base+'/api/salir',{method:'POST',redirect:'manual'});assert.equal(logout.status,200);assert.deepEqual(await logout.json(),{ok:true});assert.equal(logout.headers.get('location'),null);assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);assert.match(logout.headers.get('cache-control'),/no-store/);
 console.log('Standalone: Core/Kit, nine PDFs, private paths and JSON logout without internal-host redirect PASS.');
}finally{if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.on('exit',r));}await rm(folder,{recursive:true,force:true});}
