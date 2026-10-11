import {readFileSync,createReadStream,writeFileSync,renameSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {basename,dirname,join} from 'node:path';
const path=process.argv[2];if(!path)throw Error('APPROVED_SCHEDULE_CONFIG_REQUIRED');
const config=JSON.parse(readFileSync(path,'utf8'));if(config.enabled!==true)throw Error('BACKUP_SCHEDULE_NOT_APPROVED');
if(!/^gs:\/\/[a-z0-9][a-z0-9._-]{2,62}\/[a-zA-Z0-9/_-]+$/.test(config.offsite_uri))throw Error('OFFSITE_DESTINATION_INVALID');
const run=(cmd,args)=>new Promise((resolve,reject)=>{const child=spawn(cmd,args,{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>{output+=d;if(output.length>1000000)child.kill();});child.stderr.resume();child.once('error',()=>reject(Error('BACKUP_TOOL_UNAVAILABLE')));child.once('exit',code=>code===0?resolve(output):reject(Error('BACKUP_STEP_FAILED')));});
const started=new Date().toISOString(),report={started_at:started,status:'FAILED',offsite_verified:false,restore_verified:false};
try{
 const output=await run('sh',['scripts/maintenance.sh','backup',config.release_env]);
 const result=output.trim().split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).find(item=>item?.backup);
 if(!result?.backup||!result.backup.endsWith('.backup.aes'))throw Error('B02_RESULT_REQUIRED');
 const bytes=statSync(result.backup).size,digest=createHash('sha256');for await(const chunk of createReadStream(result.backup))digest.update(chunk);const sha256=digest.digest('hex');
 const target=config.offsite_uri.replace(/\/$/,'')+'/'+basename(result.backup);
 await run('gcloud',['storage','cp',result.backup,target,'--custom-metadata','sha256='+sha256,'--quiet']);
 const object=JSON.parse(await run('gcloud',['storage','objects','describe',target,'--format=json']));
 if(object.metadata?.sha256!==sha256||Number(object.size)!==bytes)throw Error('OFFSITE_VERIFICATION_FAILED');
 Object.assign(report,{status:'VERIFIED',offsite_verified:true,bytes,sha256,object_generation:object.generation,finished_at:new Date().toISOString(),rpo_hours:config.rpo_hours});
}finally{const target=join(dirname(path),'backup-schedule-last.json'),temp=target+'.tmp';writeFileSync(temp,JSON.stringify(report,null,2)+'\n',{mode:0o600});renameSync(temp,target);console.log(JSON.stringify(report));}
