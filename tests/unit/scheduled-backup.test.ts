import {afterEach,describe,it,expect} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function setup(enabled=true,badMetadata=false){
 const root=mkdtempSync(join(tmpdir(),'commerce-backup-fixture-'));roots.push(root);mkdirSync(join(root,'scripts'));mkdirSync(join(root,'bin'));
 const archive=join(root,'synthetic.backup.aes'),bytes=Buffer.from('encrypted synthetic fixture');writeFileSync(archive,bytes);
 writeFileSync(join(root,'scripts/maintenance.sh'),`#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({backup:archive,encrypted:true,format:2})}'\n`,{mode:0o700});
 const hash=createHash('sha256').update(bytes).digest('hex');
 writeFileSync(join(root,'bin/gcloud'),`#!/bin/sh\nif [ "$2" = "cp" ]; then exit 0; fi\nprintf '%s\\n' '${JSON.stringify({metadata:{sha256:badMetadata?'wrong':hash},size:String(bytes.length),generation:'fixture-only'})}'\n`,{mode:0o700});
 const config=join(root,'backup-schedule.json');writeFileSync(config,JSON.stringify({enabled,offsite_uri:'gs://owned-fixture/backup',release_env:'/private/fixture.env',rpo_hours:24}));
 return{root,config,bytes};
}
describe('approved backup scheduler with isolated fake tools',()=>{
 it('validates the actual archive size when B02 does not return a bytes property',()=>{
  const f=setup(),r=spawnSync(process.execPath,[resolve('scripts/scheduled-backup.mjs'),f.config],{cwd:f.root,env:{...process.env,PATH:join(f.root,'bin')+':'+process.env.PATH},encoding:'utf8'});
  expect(r.status,r.stderr).toBe(0);expect(JSON.parse(readFileSync(join(f.root,'backup-schedule-last.json'),'utf8'))).toMatchObject({status:'VERIFIED',bytes:f.bytes.length,offsite_verified:true,restore_verified:false});
 });
 it('fails on unverified remote metadata without claiming a successful restore',()=>{
  const f=setup(true,true),r=spawnSync(process.execPath,[resolve('scripts/scheduled-backup.mjs'),f.config],{cwd:f.root,env:{...process.env,PATH:join(f.root,'bin')+':'+process.env.PATH},encoding:'utf8'});
  expect(r.status).not.toBe(0);expect(JSON.parse(readFileSync(join(f.root,'backup-schedule-last.json'),'utf8'))).toMatchObject({status:'FAILED',offsite_verified:false,restore_verified:false});
 });
 it('refuses an unapproved schedule before running backup tools',()=>{
  const f=setup(false),r=spawnSync(process.execPath,[resolve('scripts/scheduled-backup.mjs'),f.config],{cwd:f.root,encoding:'utf8'});expect(r.status).not.toBe(0);expect(r.stderr).toContain('BACKUP_SCHEDULE_NOT_APPROVED');
 });
});
