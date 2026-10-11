import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,readdirSync,lstatSync,mkdirSync,chmodSync,chownSync,existsSync,renameSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const hash=b=>createHash('sha256').update(b).digest('hex');
const check=(v,code)=>{if(!v)throw Error(code);};
const safe=name=>typeof name==='string'&&name.length<1024&&!name.startsWith('/')&&!name.includes('\\')&&name.split('/').every(s=>s&&s!=='.'&&s!=='..');
const maxBytes=512*1024*1024;
export function captureDirectory(root,metadata){
 let size=0;const files=[],directories=[];
 function walk(dir,relative=''){
  for(const name of readdirSync(dir).sort()){
   const path=join(dir,name),file=relative?relative+'/'+name:name,s=lstatSync(path);check(safe(file)&&!s.isSymbolicLink(),'UNSAFE_SESSION_ENTRY');
   const info={path:file,mode:s.mode&0o777,uid:s.uid,gid:s.gid};
   if(s.isDirectory()){directories.push(info);walk(path,file);}
   else{check(s.isFile(),'UNSUPPORTED_SESSION_ENTRY');size+=s.size;check(size<=maxBytes,'SESSION_BACKUP_TOO_LARGE');const bytes=readFileSync(path);files.push({...info,size:bytes.length,sha256:hash(bytes),data:bytes.toString('base64')});}
  }
 }
 walk(root);const rootStat=lstatSync(root);return{root_permissions:{mode:rootStat.mode&0o777,uid:rootStat.uid,gid:rootStat.gid},format:'COMOSW01',created_at:new Date().toISOString(),method:'STOPPED_GATEWAY',authentication_verified:false,metadata,directories,files,total_bytes:size};
}
export function sealBundle(bundle,key){check(key.length===32,'BACKUP_KEY_REQUIRED');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),bytes=Buffer.from(JSON.stringify(bundle));return Buffer.concat([Buffer.from('COMOSW01'),iv,cipher.update(bytes),cipher.final(),cipher.getAuthTag()]);}
export function openBundle(bytes,key){
 check(key.length===32&&bytes.length>=36&&bytes.length<=maxBytes*1.5&&bytes.subarray(0,8).toString()==='COMOSW01','INVALID_WAHA_BACKUP');
 const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));decipher.setAuthTag(bytes.subarray(-16));
 const bundle=JSON.parse(Buffer.concat([decipher.update(bytes.subarray(20,-16)),decipher.final()]).toString());check(bundle.format==='COMOSW01'&&bundle.method==='STOPPED_GATEWAY'&&Array.isArray(bundle.files)&&Array.isArray(bundle.directories),'INVALID_WAHA_MANIFEST');
 const permissions=bundle.root_permissions;check(permissions&&Number.isInteger(permissions.mode)&&permissions.mode>=0&&permissions.mode<=511&&Number.isInteger(permissions.uid)&&permissions.uid>=0&&Number.isInteger(permissions.gid)&&permissions.gid>=0,'UNSAFE_ROOT_PERMISSIONS');
 const seen=new Set();let total=0;
 for(const f of [...bundle.directories,...bundle.files]){check(safe(f.path)&&!seen.has(f.path)&&Number.isInteger(f.mode)&&f.mode>=0&&f.mode<=511&&Number.isInteger(f.uid)&&f.uid>=0&&Number.isInteger(f.gid)&&f.gid>=0,'UNSAFE_SESSION_MANIFEST');seen.add(f.path);}
 for(const f of bundle.files){const data=Buffer.from(f.data,'base64');total+=data.length;check(data.length===f.size&&hash(data)===f.sha256&&total<=maxBytes,'WAHA_BACKUP_HASH_MISMATCH');}
 return bundle;
}
export function restoreBundle(bundle,target){
 check(!existsSync(target),'RESTORE_TARGET_EXISTS');
 // All bytes/path/hash validation precedes filesystem writes. Root directory is never an existing volume.
 for(const f of bundle.files){check(safe(f.path)&&hash(Buffer.from(f.data,'base64'))===f.sha256,'INVALID_RESTORE_FILE');}
 mkdirSync(target,{mode:0o700});
 const permissions=(p,f)=>{chmodSync(p,f.mode);if(process.getuid?.()===0)chownSync(p,f.uid,f.gid);};
 for(const d of bundle.directories){const p=join(target,d.path);mkdirSync(p,{recursive:true,mode:0o700});}
 for(const f of bundle.files){const p=join(target,f.path);mkdirSync(dirname(p),{recursive:true,mode:0o700});writeFileSync(p,Buffer.from(f.data,'base64'),{flag:'wx',mode:0o600});permissions(p,f);}
 for(const d of [...bundle.directories].reverse())permissions(join(target,d.path),d);
 if(bundle.root_permissions)permissions(target,bundle.root_permissions);
 return{status:'RESTORED_OFFLINE',files:bundle.files.length,total_bytes:bundle.total_bytes,authentication_verified:false,network_connections:0};
}
export async function backupGateway(container,output,root='/session-source',run=(args)=>JSON.parse(execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}))){
 const records=run(['inspect',container]);check(records.length===1,'GATEWAY_NOT_FOUND');const item=records[0],labels=item.Config.Labels??{},service=labels['com.docker.compose.service'];
 check(labels['com.docker.compose.project']==='commerce-os'&&/^waha-\d{2}$/.test(service),'GATEWAY_NOT_ALLOWED');
 check(!item.State.Running&&!item.State.Restarting&&!item.State.Paused,'CONSISTENT_BACKUP_REQUIRES_STOPPED_GATEWAY');
 const mount=item.Mounts.find(m=>m.Destination==='/app/.sessions');check(mount?.Type==='volume'&&mount.Name===process.env.WAHA_BACKUP_VOLUME,'EXCLUSIVE_VOLUME_REQUIRED');
 const consumers=run(['ps','-a','--filter','volume='+mount.Name,'--format','json']);
 check(Array.isArray(consumers),'VOLUME_CONSUMERS_UNCONFIRMED');
 for(const consumer of consumers){if(item.Id.startsWith(consumer.ID))continue;
  const helper=run(['inspect',consumer.ID])[0];
  check(helper.Config?.Labels?.['commerce.waha-backup']==='true'&&helper.HostConfig?.NetworkMode==='none'&&helper.Id.startsWith(process.env.HOSTNAME??'INVALID')&&helper.Mounts.some(m=>m.Name===mount.Name&&m.RW===false),'VOLUME_SHARED_WITH_ANOTHER_CONTAINER');
 }
 const engine=item.Config.Env?.find(v=>v.startsWith('WHATSAPP_DEFAULT_ENGINE='))?.split('=')[1];check(engine==='GOWS','ENGINE_REQUIRES_VALIDATED_BACKUP_ADAPTER');
 const bundle=captureDirectory(root,{container_id:item.Id,image:item.Image,service,volume:mount.Name,engine,configuration:item.Config.Env,credential_generation:Number(process.env.WAHA_CREDENTIAL_GENERATION??1)});
 const key=Buffer.from(process.env.BACKUP_ENCRYPTION_KEY??'','hex'),encrypted=sealBundle(bundle,key);openBundle(encrypted,key);
 check(!existsSync(output),'BACKUP_TARGET_EXISTS');mkdirSync(dirname(output),{recursive:true,mode:0o700});writeFileSync(output+'.partial',encrypted,{mode:0o600,flag:'wx'});
 const after=run(['inspect',container])[0];check(after.Id===item.Id&&!after.State.Running&&after.State.StartedAt===item.State.StartedAt,'GATEWAY_CHANGED_DURING_BACKUP');renameSync(output+'.partial',output);
 return{status:'VERIFIED_COLD_BACKUP',backup_ref:hash(encrypted),created_at:bundle.created_at,files:bundle.files.length,total_bytes:bundle.total_bytes,volume:mount.Name,service,authentication_verified:false,external_copy_verified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [action,arg,target]=process.argv.slice(2);
 try{
  if(action==='backup'){
   const run=args=>{const out=execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();return args[0]==='ps'?out.split('\n').filter(Boolean).map(s=>JSON.parse(s)):JSON.parse(out);};
   console.log(JSON.stringify(await backupGateway(arg,target,process.env.WAHA_BACKUP_SOURCE??'/session-source',run)));
  }else if(action==='restore'||action==='verify'){
   const bundle=openBundle(readFileSync(arg),Buffer.from(process.env.BACKUP_ENCRYPTION_KEY??'','hex'));
   console.log(JSON.stringify(action==='restore'?restoreBundle(bundle,target):{status:'VERIFIED',files:bundle.files.length,authentication_verified:false}));
  }else throw Error('USE_BACKUP_RESTORE_OR_VERIFY');
 }catch(e){if(target&&existsSync(target+'.partial'))rmSync(target+'.partial');console.error(JSON.stringify({status:'FAILED',code:/^[A-Z_]+$/.test(e.message)?e.message:'WAHA_BACKUP_VALIDATION_FAILED'}));process.exitCode=1;}
}
