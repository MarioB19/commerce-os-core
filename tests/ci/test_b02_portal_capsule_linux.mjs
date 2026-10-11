/** Mandatory FULL-CI Linux proof. Own synthetic fixture only; never pulls images. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
const HELPER=fileURLToPath(new URL('../../scripts/b02-portal-capsule.mjs',import.meta.url));
const IMAGE='postgres:17.11-bookworm', sha=b=>createHash('sha256').update(b).digest('hex');
const program=String.raw`
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
import {PDF_NAMES} from '/helper.mjs';
const root='/fixture', sha=b=>createHash('sha256').update(b).digest('hex');
const ref=p=>{const b=fs.readFileSync(p);return {path:p,bytes:b.length,sha256:sha(b)}};
const write=(p,b)=>{fs.writeFileSync(p,b,{flag:'wx',mode:0o600});fs.chmodSync(p,0o600)};
const json=(p,o)=>write(p,Buffer.from(JSON.stringify(o)));
const identity={source_sha:'a'.repeat(40),run_id:'77-1',image:'sha256:'+'b'.repeat(64),proxy_network:'commerce-os_proxy'};
const base=()=>({schema_version:1,run_id:'123-1',deadline_epoch_ms:Date.now()+60000,custody_root:root,scratch_parent:root+'/scratch'});
const restore=()=>({...base(),plan_sha256:'c'.repeat(64),ciphertext_ref:ref(root+'/output/portal.backup.aes'),expected_portal:identity,destination:root+'/scratch/portal-restore-123-1'});
const actions={
 setup(){
  assert.equal(process.getuid(),0);fs.chownSync(root,0,0);fs.chmodSync(root,0o700);
  for(const n of ['profiles','pdfs','state','scratch','output','controls'])fs.mkdirSync(root+'/'+n,{mode:0o700});
  fs.chownSync(root+'/state',1000,1000);
  const pdfs={};for(const n of PDF_NAMES){write(root+'/pdfs/'+n,Buffer.from('%PDF-1.4 SYNTHETIC LINUX ONLY '+n+'\n%%EOF'));pdfs[n]=ref(root+'/pdfs/'+n).sha256}
  const manifest=root+'/profiles/portal-manifest.json';json(manifest,{source_sha:identity.source_sha,origin:'https://ciclo.inovaris.online',pdfs});
  const report=root+'/profiles/current.json';json(report,{...identity,container:'mcl-portal-77-1',status:'ORIGIN_READY',other_containers_preserved:true,private_pdfs_verified:10,portal_manifest_sha256:ref(manifest).sha256,proxy:{status:'UPDATED',other_sites_preserved:true,rollback_available:true}});
  const env={MCL_ACCESS_DB:'/data/access-attempts.sqlite',MCL_RELEASE_SHA:identity.source_sha,MCL_SESSION_SECRET:randomBytes(32).toString('hex'),MCL_CORE_CODES_SHA256:sha('SYNTHETIC CORE'),MCL_KIT_CODES_SHA256:sha('SYNTHETIC KIT'),NEXT_PUBLIC_SITE_URL:'https://ciclo.inovaris.online'};
  write(root+'/profiles/runtime.env',Buffer.from(Object.keys(env).sort().map(k=>k+'='+env[k]+'\n').join('')));
  json(root+'/controls/create.json',{...base(),plan_sha256:'c'.repeat(64),output_parent:root+'/output',portal:{...identity,report_ref:ref(report),runtime_env_ref:ref(root+'/profiles/runtime.env'),manifest_ref:ref(manifest)},pdf_directory:root+'/pdfs',state_directory:root+'/state',state_uid:1000});
  return {setup:true};
 },
 source(){
  const dir=root+'/state', names=fs.readdirSync(dir).sort();assert.deepEqual(names,['access-attempts.sqlite','access-attempts.sqlite-shm','access-attempts.sqlite-wal']);
  const s=fs.lstatSync(dir);assert.equal(s.uid,1000);assert.equal(s.mode&0o777,0o700);const files={};
  for(const name of names){const p=dir+'/'+name,i=fs.lstatSync(p);assert.ok(i.isFile());assert.equal(i.uid,1000);assert.equal(i.mode&0o777,0o600);assert.equal(i.nlink,1);assert.ok(i.size<=1024*1024);files[name]={bytes:i.size,sha256:sha(fs.readFileSync(p)),dev:i.dev,ino:i.ino,uid:i.uid,mode:i.mode}}
  assert.ok(files['access-attempts.sqlite-wal'].bytes>0);return {uid:s.uid,mode:s.mode,files};
 },
 mainOnly(){
  const p=root+'/profiles/main-only.sqlite';write(p,fs.readFileSync(root+'/state/access-attempts.sqlite'));
  // Normalize only this isolated synthetic main-file copy; readonly WAL opens otherwise leave sidecars.
  const normalized=new DatabaseSync(p,{allowExtension:false,defensive:true});try{assert.equal(normalized.prepare('PRAGMA journal_mode=DELETE').get().journal_mode,'delete')}finally{normalized.close()}
  const db=new DatabaseSync(p,{readOnly:true});assert.equal(db.prepare('SELECT count(*) n FROM attempts').get().n,0);db.close();return {main_only_rows:0};
 },
 controls(){const c=restore();json(root+'/controls/verify.json',c);json(root+'/controls/restore.json',c);return {prepared:true}},
 restored(){
  const dest=restore().destination;const db=new DatabaseSync(dest+'/portal/access-attempts.sqlite',{readOnly:true});
  assert.equal(db.prepare('SELECT count FROM attempts').get().count,4);assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');db.close();
  for(const n of ['runtime.env','current.json','portal-manifest.json'])assert.equal(sha(fs.readFileSync(dest+'/portal/'+n)),sha(fs.readFileSync(root+'/profiles/'+n)));
  for(const n of PDF_NAMES)assert.equal(sha(fs.readFileSync(dest+'/portal/pdfs/'+n)),sha(fs.readFileSync(root+'/pdfs/'+n)));
  const receipt=dest+'.cleanup.private.json';assert.equal(fs.statSync(receipt).uid,0);assert.equal(fs.statSync(receipt).mode&0o777,0o600);
  json(root+'/controls/cleanup.json',{...base(),cleanup_record_ref:ref(receipt)});return {wal_row_restored:true,standalone_delete_snapshot:true,private_files_restored:14};
 },
 cleaned(){assert.deepEqual(fs.readdirSync(root+'/scratch'),[]);assert.equal(fs.readFileSync(root+'/output/portal.backup.aes').subarray(0,8).toString(),'COMOSP01');return {owned_plaintext_removed:true,ciphertext_retained:true}},
 capture(){
  const allowed=new Set(['profiles','pdfs','state','scratch','output','controls',...['runtime.env','current.json','portal-manifest.json','main-only.sqlite'].map(x=>'profiles/'+x),...PDF_NAMES.map(x=>'pdfs/'+x),...['access-attempts.sqlite','access-attempts.sqlite-shm','access-attempts.sqlite-wal'].map(x=>'state/'+x),...['create.json','verify.json','restore.json','cleanup.json'].map(x=>'controls/'+x),'output/portal.backup.aes']);
  const entries=[];let total=0;const walk=p=>{for(const n of fs.readdirSync(p).sort()){const f=path.join(p,n),r=path.relative(root,f),s=fs.lstatSync(f);assert.ok(allowed.has(r),'UNKNOWN_FIXTURE_PRESERVE');assert.ok(s.isFile()||s.isDirectory(),'LINK_FIXTURE_PRESERVE');assert.ok(s.uid===(r==='state'||r.startsWith('state/')?1000:0));assert.equal(s.mode&0o777,s.isFile()?0o600:0o700);if(s.isFile()){assert.equal(s.nlink,1);total+=s.size;assert.ok(s.size<=1024*1024)}entries.push({path:r,type:s.isFile()?'file':'directory',dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode,nlink:s.nlink,bytes:s.size,sha256:s.isFile()?sha(fs.readFileSync(f)):null});if(s.isDirectory())walk(f)}};walk(root);assert.ok(entries.length<=40&&total<=1024*1024);assert.deepEqual(fs.readdirSync(root+'/scratch'),[]);
  const s=fs.lstatSync(root);return {root:{dev:s.dev,ino:s.ino,uid:s.uid,mode:s.mode},entries,total};
 },
 cleanup(){
  const input=fs.readFileSync(0);assert.ok(input.length<=65536);const {recipe,host_uid,host_gid}=JSON.parse(input);assert.ok(Number.isSafeInteger(host_uid)&&Number.isSafeInteger(host_gid));
  const observed=actions.capture();assert.deepEqual(observed,recipe,'FIXTURE_DRIFT_PRESERVE');
  for(const e of recipe.entries.filter(e=>e.type==='file')){const p=root+'/'+e.path,s=fs.lstatSync(p);assert.equal(s.ino,e.ino);assert.equal(s.dev,e.dev);assert.equal(s.uid,e.uid);assert.equal(s.mode,e.mode);assert.equal(s.nlink,e.nlink);assert.equal(s.size,e.bytes);assert.equal(sha(fs.readFileSync(p)),e.sha256);fs.unlinkSync(p)}
  for(const e of recipe.entries.filter(e=>e.type==='directory').sort((a,b)=>b.path.length-a.path.length)){const p=root+'/'+e.path,s=fs.lstatSync(p);assert.equal(s.ino,e.ino);assert.equal(s.dev,e.dev);assert.equal(s.uid,e.uid);assert.equal(s.mode,e.mode);assert.ok(s.isDirectory());fs.rmdirSync(p)}
  assert.deepEqual(fs.readdirSync(root),[]);fs.chownSync(root,host_uid,host_gid);return {fixture_cleanup:true};
 }
};
try{assert.ok(Object.hasOwn(actions,process.argv[2]));console.log(JSON.stringify(actions[process.argv[2]]()))}catch{console.error('SYNTHETIC_LINUX_FIXTURE_FAILED_PRESERVE');process.exitCode=1}
`;
const writer=String.raw`
import fs from 'node:fs';import {createHash} from 'node:crypto';import {DatabaseSync} from 'node:sqlite';
if(process.getuid()!==1000)throw new Error('WRITER_UID');const p='/data/access-attempts.sqlite',db=new DatabaseSync(p);
db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;CREATE TABLE attempts(client TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL) STRICT;PRAGMA wal_checkpoint(TRUNCATE)');
db.prepare('INSERT INTO attempts VALUES(?,?,?)').run(createHash('sha256').update('SYNTHETIC WAL CLIENT').digest('hex'),4,Date.now()+900000);
for(const suffix of ['', '-wal','-shm'])fs.chmodSync(p+suffix,0o600);console.log('SYNTHETIC_WAL_READY');
const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>{clearInterval(timer);db.close();process.exit(0)});
`;
function hostFile(dir,name,bytes){const p=path.join(dir,name);fs.writeFileSync(p,bytes,{mode:0o444,flag:'wx'});fs.chmodSync(p,0o444);const s=fs.lstatSync(p);return {path:p,dev:s.dev,ino:s.ino,bytes:Buffer.byteLength(bytes),sha256:sha(bytes)};}
function removeHostFile(ref){const s=fs.lstatSync(ref.path);assert.ok(s.isFile()&&s.nlink===1);assert.equal(s.dev,ref.dev);assert.equal(s.ino,ref.ino);assert.equal(s.size,ref.bytes);assert.equal(sha(fs.readFileSync(ref.path)),ref.sha256);fs.unlinkSync(ref.path);}

test('Linux UID0 DAC_READ_SEARCH only reads UID1000 RO WAL and restores complete capsule', {timeout:150000}, async()=>{
 assert.equal(process.platform,'linux','Mandatory proof requires Linux; no macOS claim or skip');
 assert.match(process.version,/^v24\./);const deadline=Date.now()+135000;const key=randomBytes(32),minimum=Buffer.from('BACKUP_ENCRYPTION_KEY='+key.toString('hex')+'\n');assert.equal(minimum.length,87);
 const containers=[],owner='b02-capsule-'+randomUUID(),tmp=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),owner+'-')),fixture=path.join(tmp,'fixture'),tools=path.join(tmp,'tools');fs.mkdirSync(fixture,{mode:0o700});fs.mkdirSync(tools,{mode:0o700});
 const fixtureIdentity=fs.statSync(fixture),tmpIdentity=fs.statSync(tmp),toolsIdentity=fs.statSync(tools),publicFiles=[hostFile(tools,'fixture.mjs',program),hostFile(tools,'writer.mjs',writer)];
 let success=false,cleaned=false,image,node,writerName;const logs=[];
 const run=(args,{input='',allowFailure=false,timeout=20000}={})=>{
  assert.ok(Date.now()<deadline,'SYNTHETIC_LINUX_DEADLINE_PRESERVE');const r=spawnSync('docker',args,{input,encoding:'utf8',timeout:Math.min(timeout,deadline-Date.now()),maxBuffer:131072});
  const output=(r.stdout??'')+(r.stderr??'');assert.equal(output.includes(key.toString('hex')),false,'Key must never reach Docker logs');logs.push(output);
  if(!allowFailure)assert.equal(r.status,0,'Docker synthetic phase failed; fixture preserved. '+String(r.stderr??'').slice(0,1500));return r;
 };
 const mount=(src,dst,ro=false)=>['--mount',`type=bind,src=${src},dst=${dst}${ro?',readonly':''}`];
 const base=(name,user,caps)=>['--name',name,'--label','commerce.synthetic.owner='+owner,'--network','none','--read-only','--user',user,'--cap-drop','ALL',...caps.flatMap(c=>['--cap-add',c]),'--security-opt','no-new-privileges:true','--pids-limit','32','--memory','256m','--pull','never','--entrypoint','/node',...mount(node,'/node',true),...mount(HELPER,'/helper.mjs',true)];
 const create=(args,argv)=>{const name=owner+'-'+containers.length;run(['create','-i',...base(name,args.user??'0:0',args.caps??['DAC_READ_SEARCH']),...mount(fixture,'/fixture'),...mount(publicFiles[0].path,'/fixture-tools/fixture.mjs',true),...(args.mounts??[]),image,'--disable-warning=ExperimentalWarning',...argv]);containers.push(name);return name;};
 const execute=(action,{caps=['DAC_READ_SEARCH'],input='',allowFailure=false}={})=>{const name=create({caps,mounts:mount(path.join(fixture,'state'),'/fixture/state',true)},['/fixture-tools/fixture.mjs',action]);return run(['start','-a','-i',name],{input,allowFailure});};
 const inspect=name=>{const rows=JSON.parse(run(['inspect',name]).stdout);assert.equal(rows.length,1);assert.equal(rows[0].Config.Labels['commerce.synthetic.owner'],owner);return rows[0];};
 const helper=action=>{
  const mounts=[...mount(path.join(fixture,'state'),'/fixture/state',true),...['current.json','runtime.env','portal-manifest.json'].flatMap(n=>mount(path.join(fixture,'profiles',n),'/fixture/profiles/'+n,true))];
  const name=create({mounts},['/helper.mjs',action,'/fixture/controls/'+action+'.json']),row=inspect(name);
  assert.equal(row.Config.User,'0:0');assert.equal(row.Config.Env.some(v=>v.startsWith('BACKUP_ENCRYPTION_KEY=')),false);assert.equal(row.HostConfig.NetworkMode,'none');assert.equal(row.HostConfig.ReadonlyRootfs,true);assert.deepEqual(row.HostConfig.CapDrop,['ALL']);assert.deepEqual(row.HostConfig.CapAdd,['CAP_DAC_READ_SEARCH']);assert.ok(row.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
  for(const p of ['/node','/helper.mjs','/fixture/state',...['current.json','runtime.env','portal-manifest.json'].map(n=>'/fixture/profiles/'+n)])assert.equal(row.Mounts.find(m=>m.Destination===p)?.RW,false);
  return JSON.parse(run(['start','-a','-i',name],{input:action==='cleanup'?'':minimum}).stdout);
 };
 try{
  run(['info','--format','{{.OSType}}']);const images=JSON.parse(run(['image','inspect',IMAGE]).stdout);assert.equal(images.length,1);assert.equal(images[0].Os,'linux');assert.equal(images[0].Architecture,process.arch==='x64'?'amd64':process.arch);assert.match(images[0].Id,/^sha256:[a-f0-9]{64}$/);image=images[0].Id;
  node=fs.realpathSync(process.execPath);assert.ok(fs.statSync(node).isFile());
  const setup=create({caps:['CHOWN','DAC_OVERRIDE','FOWNER']},['/fixture-tools/fixture.mjs','setup']);run(['start','-a',setup]);
  writerName=create({user:'1000:1000',caps:[],mounts:[...mount(path.join(fixture,'state'),'/data'),...mount(publicFiles[1].path,'/writer.mjs',true)]},['/writer.mjs']);run(['start',writerName]);
  for(let i=0;i<50;i++){if(run(['logs',writerName]).stdout.includes('SYNTHETIC_WAL_READY'))break;assert.equal(inspect(writerName).State.Running,true);await new Promise(r=>setTimeout(r,100));}
  assert.match(run(['logs',writerName]).stdout,/SYNTHETIC_WAL_READY/);
  assert.deepEqual(JSON.parse(execute('mainOnly').stdout),{main_only_rows:0});const before=JSON.parse(execute('source').stdout);
  // UID0 alone lacks permission to traverse the UID1000/0700 state directory.
  const negative=create({caps:[],mounts:mount(path.join(fixture,'state'),'/fixture/state',true)},['/helper.mjs','create','/fixture/controls/create.json']);const failed=run(['start','-a','-i',negative],{input:minimum,allowFailure:true});assert.notEqual(failed.status,0);assert.match(failed.stderr,/PORTAL_CAPSULE_FAILED|PORTAL_.*CUSTODY/);
  const created=helper('create');assert.equal(created.status,'PORTAL_CAPSULE_CREATED');assert.equal(created.private_files,14);assert.equal(created.portal_credentials_archived_encrypted,true);
  execute('controls');const verified=helper('verify');assert.equal(verified.authenticated_before_extraction,true);assert.equal(verified.sqlite_snapshot_consistent,true);
  const restored=helper('restore');assert.equal(restored.authenticated_before_extraction,true);assert.equal(restored.private_files,14);assert.equal(JSON.parse(execute('restored').stdout).wal_row_restored,true);
  assert.equal(helper('cleanup').owned_plaintext_removed,true);assert.equal(JSON.parse(execute('cleaned').stdout).ciphertext_retained,true);
  assert.deepEqual(JSON.parse(execute('source').stdout),before,'Source DB/WAL/SHM bytes and custody must remain unchanged while writer lives');assert.equal(inspect(writerName).State.Running,true);
  run(['stop','--time','5',writerName]);assert.equal(inspect(writerName).State.Running,false);
  const recipe=JSON.parse(execute('capture').stdout);assert.equal(recipe.root.dev,fixtureIdentity.dev);assert.equal(recipe.root.ino,fixtureIdentity.ino);
  const name=create({caps:['CHOWN','DAC_OVERRIDE','FOWNER']},['/fixture-tools/fixture.mjs','cleanup']);assert.equal(JSON.parse(run(['start','-a','-i',name],{input:JSON.stringify({recipe,host_uid:process.getuid(),host_gid:process.getgid()})}).stdout).fixture_cleanup,true);cleaned=true;success=true;
  console.log(JSON.stringify({status:'LINUX_PORTAL_CAPSULE_VERIFIED',image_id:image,node_version:process.version,helper_sha256:sha(fs.readFileSync(HELPER)),helper_uid:0,state_uid:1000,state_mode:'0700',network:'none',capabilities:['DAC_READ_SEARCH'],state_mount_readonly:true,wal_only_row_verified:true,source_bytes_unchanged:true,authenticated_restore:true,private_files:14,owned_cleanup_verified:true}));
 }finally{
  key.fill(0);minimum.fill(0);
  // Only explicitly created containers with their owner label may be removed.
  for(const name of [...containers].reverse()){const row=inspect(name);if(row.State.Running)run(['stop','--time','5',name]);run(['rm',name]);}
  if(cleaned){const parent=fs.lstatSync(tmp);assert.equal(parent.dev,tmpIdentity.dev);assert.equal(parent.ino,tmpIdentity.ino);assert.equal(parent.uid,process.getuid());const scripts=fs.lstatSync(tools);assert.equal(scripts.dev,toolsIdentity.dev);assert.equal(scripts.ino,toolsIdentity.ino);assert.equal(scripts.uid,process.getuid());const s=fs.lstatSync(fixture);assert.equal(s.dev,fixtureIdentity.dev);assert.equal(s.ino,fixtureIdentity.ino);assert.equal(s.uid,process.getuid());assert.deepEqual(fs.readdirSync(fixture),[]);fs.rmdirSync(fixture);for(const ref of publicFiles)removeHostFile(ref);fs.rmdirSync(tools);const top=fs.lstatSync(tmp);assert.equal(top.dev,tmpIdentity.dev);assert.equal(top.ino,tmpIdentity.ino);assert.deepEqual(fs.readdirSync(tmp),[]);fs.rmdirSync(tmp)}
  if(!success)console.error('SYNTHETIC_LINUX_FIXTURE_PRESERVED '+tmp);
 }
});
