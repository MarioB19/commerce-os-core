import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {captureDirectory,sealBundle,openBundle,restoreBundle,backupGateway} from '../waha-session-backup.mjs';
test('WAHA encrypted cold archive restores offline, rejects tampering, traversal and existing targets',()=>{
 const root=mkdtempSync(join(tmpdir(),'waha-archive-')),key=randomBytes(32);try{mkdirSync(join(root,'source'));mkdirSync(join(root,'source','default'));writeFileSync(join(root,'source','default','store.sqlite'),'synthetic-session');const bundle=captureDirectory(join(root,'source'),{image:'synthetic'}),encrypted=sealBundle(bundle,key);assert.equal(encrypted.includes(Buffer.from('synthetic-session')),false);const decoded=openBundle(encrypted,key);assert.equal(restoreBundle(decoded,join(root,'restore')).authentication_verified,false);assert.equal(readFileSync(join(root,'restore','default','store.sqlite'),'utf8'),'synthetic-session');assert.throws(()=>restoreBundle(decoded,join(root,'restore')),/EXISTS/);const broken=Buffer.from(encrypted);broken[25]^=1;assert.throws(()=>openBundle(broken,key));decoded.files[0].path='../escape';assert.throws(()=>openBundle(sealBundle(decoded,key),key),/UNSAFE/);symlinkSync('/tmp',join(root,'source','link'));assert.throws(()=>captureDirectory(join(root,'source'),{}),/UNSAFE/);}finally{rmSync(root,{recursive:true,force:true});}
});
test('running gateway is never paused or copied',async()=>{const calls=[];await assert.rejects(()=>backupGateway('id','unused','unused',args=>{calls.push(args);return[{Config:{Labels:{'com.docker.compose.project':'commerce-os','com.docker.compose.service':'waha-01'}},State:{Running:true}}];}),/STOPPED_GATEWAY/);assert.deepEqual(calls,[['inspect','id']]);});

test('stopped exclusive gateway produces verified encrypted evidence and rejects a second consumer',async()=>{
 const root=mkdtempSync(join(tmpdir(),'waha-cold-')),previous={...process.env};try{
  process.env.WAHA_BACKUP_VOLUME='fixture-volume';process.env.BACKUP_ENCRYPTION_KEY=randomBytes(32).toString('hex');process.env.HOSTNAME='helper';
  const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'db'),'synthetic');
  const gateway={Id:'gateway-id',Image:'sha256:fixture',Config:{Labels:{'com.docker.compose.project':'commerce-os','com.docker.compose.service':'waha-01'},Env:['WHATSAPP_DEFAULT_ENGINE=GOWS']},State:{Running:false,StartedAt:'unchanged'},Mounts:[{Destination:'/app/.sessions',Type:'volume',Name:'fixture-volume'}]};
  const helper={Id:'helper-id',Config:{Labels:{'commerce.waha-backup':'true'}},HostConfig:{NetworkMode:'none'},Mounts:[{Name:'fixture-volume',RW:false}]};
  const run=args=>args[0]==='ps'?[{ID:'gateway'},{ID:'helper'}]:[args[1]==='helper'?helper:gateway];
  const output=join(root,'encrypted');const result=await backupGateway('gateway-id',output,source,run);assert.equal(result.status,'VERIFIED_COLD_BACKUP');assert.equal(result.authentication_verified,false);assert.equal(openBundle(readFileSync(output),Buffer.from(process.env.BACKUP_ENCRYPTION_KEY,'hex')).metadata.engine,'GOWS');
  helper.HostConfig.NetworkMode='bridge';await assert.rejects(()=>backupGateway('gateway-id',join(root,'bad'),source,run),/SHARED_WITH_ANOTHER/);
 }finally{for(const k of ['WAHA_BACKUP_VOLUME','BACKUP_ENCRYPTION_KEY','HOSTNAME']){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}rmSync(root,{recursive:true,force:true});}
});
