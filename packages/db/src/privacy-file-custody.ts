import {constants} from 'node:fs';
import {open,mkdir,lstat,realpath,readdir,link,unlink} from 'node:fs/promises';
import type {FileHandle} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {withPrivateNamespaceLock,assertPrivateNamespaceLease} from './private-namespace-lock.js';
import {privateFileRequestSchema,privateFileAuthoritySchema,privateFileManifestSchema,type PrivateFileAuthorityPort,type PrivateFileManifest,type PrivateFileRequest} from '../../contracts/src/privacy-file-custody.js';

const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
function canonical(v:unknown):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';}
export const privateFileManifestHash=(v:unknown)=>hash(canonical(privateFileManifestSchema.parse(v)));
const stages=['PINNED','LINK_INTENT','SOURCE_UNLINK_INTENT','QUARANTINED','ERASE_INTENT','ERASED'] as const;
type Stage=typeof stages[number];type Descriptor=PrivateFileManifest['files'][number];
const digits=z.string().regex(/^(0|[1-9]\d*)$/),sha=z.string().regex(/^[a-f0-9]{64}$/);
const identitySchema=z.object({dev:digits,ino:digits,bytes:digits,mtime_ns:digits,sha256:sha}).strict();type Identity=z.infer<typeof identitySchema>;
const directorySchema=z.object({dev:digits,ino:digits}).strict();type Directory=z.infer<typeof directorySchema>;
const headerSchema=z.object({schema_version:z.literal(1),job_id:z.uuid(),manifest_sha256:sha,root:directorySchema,source:directorySchema,quarantine:directorySchema}).strict();
const eventSchema=z.object({schema_version:z.literal(1),job_id:z.uuid(),manifest_sha256:sha,descriptor_sha256:sha,stage:z.enum(stages),identity:identitySchema,authorization_id:z.uuid()}).strict();type Event=z.infer<typeof eventSchema>;
const activeRoots=new Set<string>();
function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
async function absent(path:string){try{await lstat(path);return false;}catch(e:any){if(e.code==='ENOENT')return true;throw e;}}
async function directory(path:string):Promise<Directory>{
 need(isAbsolute(path)&&resolve(path)===path&&await realpath(path)===path,'PRIVATE_FILE_ROOT');const s=await lstat(path,{bigint:true});
 need(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o777n)===0o700n&&typeof process.getuid==='function'&&s.uid===BigInt(process.getuid()),'PRIVATE_FILE_ROOT');return{dev:String(s.dev),ino:String(s.ino)};
}
async function syncDirectory(path:string){const h=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await h.sync();}finally{await h.close();}}
async function privateDirectory(path:string,parent:string){try{await mkdir(path,{mode:0o700});}catch(e:any){if(e.code!=='EEXIST')throw e;}const id=await directory(path);await syncDirectory(parent);return id;}
async function file(path:string,descriptor:Descriptor,nlink:number,expected?:Identity){
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
  const before=await h.stat({bigint:true});need(before.isFile()&&before.nlink===BigInt(nlink)&&before.size===BigInt(descriptor.ciphertext_bytes),'PRIVATE_FILE_IDENTITY');
  const digest=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let offset=0n;
  try{while(true){const r=await h.read(buffer,0,Number(BigInt(buffer.length)<before.size-offset+1n?BigInt(buffer.length):before.size-offset+1n),null);if(!r.bytesRead)break;offset+=BigInt(r.bytesRead);need(offset<=before.size,'PRIVATE_FILE_CHANGED');digest.update(buffer.subarray(0,r.bytesRead));}}finally{buffer.fill(0);}
  const after=await h.stat({bigint:true}),identity={dev:String(before.dev),ino:String(before.ino),bytes:String(before.size),mtime_ns:String(before.mtimeNs),sha256:digest.digest('hex')};
  need(offset===before.size&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.nlink===after.nlink&&before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs&&identity.sha256===descriptor.ciphertext_sha256&&(!expected||same(identity,expected)),'PRIVATE_FILE_CHANGED');return{h,identity};
 }catch(e){await h.close();throw e;}
}
async function current(path:string,h:FileHandle,identity:Identity,nlink:number){const a=await h.stat({bigint:true}),b=await lstat(path,{bigint:true});need(a.isFile()&&b.isFile()&&!b.isSymbolicLink()&&a.nlink===BigInt(nlink)&&b.nlink===BigInt(nlink)&&String(a.dev)===identity.dev&&String(a.ino)===identity.ino&&a.dev===b.dev&&a.ino===b.ino&&String(a.size)===identity.bytes&&a.size===b.size&&String(a.mtimeNs)===identity.mtime_ns&&a.mtimeNs===b.mtimeNs,'PRIVATE_FILE_REPLACED');}
async function jsonFile(path:string,nlink=1){const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=await h.stat();need(s.isFile()&&s.nlink===nlink&&(s.mode&0o077)===0&&s.size>0&&s.size<=8192,'PRIVATE_FILE_JOURNAL');const bytes=Buffer.alloc(s.size+1);const{bytesRead}=await h.read(bytes,0,bytes.length,0);need(bytesRead===s.size,'PRIVATE_FILE_JOURNAL');return JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,bytesRead)));}finally{await h.close();}}
async function recoverPublication(path:string,dir:string){const pending=path+'.pending';if(await absent(path)||await absent(pending))return;const a=await lstat(path,{bigint:true}),b=await lstat(pending,{bigint:true});need(a.isFile()&&b.isFile()&&!a.isSymbolicLink()&&!b.isSymbolicLink()&&a.dev===b.dev&&a.ino===b.ino&&a.nlink===2n&&same(await jsonFile(path,2),await jsonFile(pending,2)),'PRIVATE_FILE_JOURNAL_CHANGED');await syncDirectory(dir);await unlink(pending);await syncDirectory(dir);}
/** Every journal record is immutable. A complete .pending file can finish its
 * publication after a crash; a partial or inconsistent file is preserved. */
async function publish(path:string,value:unknown,dir:string,parse:(v:unknown)=>unknown){
 const pending=path+'.pending',matches=(v:unknown)=>same(parse(v),value);
 await recoverPublication(path,dir);
 if(!await absent(path)){need(matches(await jsonFile(path)),'PRIVATE_FILE_JOURNAL_CHANGED');if(!await absent(pending)){need(matches(await jsonFile(pending)),'PRIVATE_FILE_JOURNAL_CHANGED');await unlink(pending);await syncDirectory(dir);}return;}
 if(await absent(pending)){const h=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await h.writeFile(canonical(value)+'\n');await h.sync();}finally{await h.close();}}
 need(matches(await jsonFile(pending)),'PRIVATE_FILE_JOURNAL_CHANGED');
 try{await link(pending,path);}catch(e:any){if(e.code!=='EEXIST')throw e;}
 // Journal publication uses one known temporary hardlink, then removes it.
 const p=await lstat(pending,{bigint:true}),f=await lstat(path,{bigint:true});need(p.isFile()&&f.isFile()&&p.dev===f.dev&&p.ino===f.ino&&p.nlink===2n,'PRIVATE_FILE_JOURNAL_CHANGED');await syncDirectory(dir);await unlink(pending);await syncDirectory(dir);need(matches(await jsonFile(path)),'PRIVATE_FILE_JOURNAL_CHANGED');
}

/** The host authority must hold the exclusive private-directory writer lease.
 * Node has no portable conditional unlink-by-inode. Private0700 roots, that
 * lease, native fd/name checks and this process fence jointly bound the race. */
export function createPrivateFileEraser(options:{root:string;authority:PrivateFileAuthorityPort}){
 const root=options.root;need(isAbsolute(root)&&resolve(root)===root,'PRIVATE_FILE_ROOT');
 return Object.freeze({async erase(raw:PrivateFileRequest){
  const request=privateFileRequestSchema.parse(raw);need(!activeRoots.has(root),'PRIVATE_FILE_WRITER_BUSY');activeRoots.add(root);
  try{await directory(root);return await withPrivateNamespaceLock(root,'EXCLUSIVE',async lease=>{
   const deadlines=new Map<string,number>();
   const live=(id:string)=>need((deadlines.get(id)??0)>Date.now(),'PRIVATE_FILE_AUTHORITY_EXPIRED');
   async function authorize(phase:'QUARANTINE'|'UNLINK'){
    await assertPrivateNamespaceLease(lease,root,'EXCLUSIVE');
    const a=privateFileAuthoritySchema.parse(await options.authority.load({...request,phase})),now=Date.now(),observed=Date.parse(a.observed_at);
    need(a.manifest.job_id===request.jobId&&privateFileManifestHash(a.manifest)===request.manifestSha256&&observed<=now&&now-observed<=120000&&Date.parse(a.valid_until)>now,'PRIVATE_FILE_AUTHORITY');deadlines.set(a.authorization_id,Date.parse(a.valid_until));return a;
   }
   const initial=await authorize('QUARANTINE'),manifest=initial.manifest,rootId=await directory(root),assets=join(root,'assets'),sourceId=await directory(assets),quarantineRoot=join(root,'.privacy-erasure');
   const qRootId=await privateDirectory(quarantineRoot,root),job=join(quarantineRoot,request.jobId),jobId=await privateDirectory(job,quarantineRoot);need([sourceId,qRootId,jobId].every(v=>v.dev===rootId.dev),'PRIVATE_FILE_FILESYSTEM');
   const header={schema_version:1 as const,job_id:request.jobId,manifest_sha256:request.manifestSha256,root:rootId,source:sourceId,quarantine:jobId};
   const allowed=new Set(['header.json','header.json.pending']);for(const descriptor of manifest.files){const id=hash(canonical(descriptor));allowed.add(id+'.enc');for(const stage of stages){allowed.add(id+'.'+stage+'.json');allowed.add(id+'.'+stage+'.json.pending');}}
   async function fence(phase:'QUARANTINE'|'UNLINK'){
    const a=await authorize(phase);need(same(await directory(root),rootId)&&same(await directory(assets),sourceId)&&same(await directory(quarantineRoot),qRootId)&&same(await directory(job),jobId),'PRIVATE_FILE_ROOT_CHANGED');need((await readdir(job)).every(n=>allowed.has(n)),'PRIVATE_FILE_INTRUDER');return a.authorization_id;
   }
   await fence('QUARANTINE');await publish(join(job,'header.json'),header,job,v=>headerSchema.parse(v));
   for(const descriptor of manifest.files){
    const id=hash(canonical(descriptor)),source=join(assets,descriptor.storage_key+'.enc'),target=join(job,id+'.enc');let identity:Identity|undefined;
    const events=new Map<Stage,Event>();let missing=false;
    for(const stage of stages){const path=join(job,id+'.'+stage+'.json');await recoverPublication(path,job);if(await absent(path)){if(!await absent(path+'.pending'))need(!missing,'PRIVATE_FILE_JOURNAL_ORDER');missing=true;continue;}need(!missing,'PRIVATE_FILE_JOURNAL_ORDER');const e=eventSchema.parse(await jsonFile(path));need(e.job_id===request.jobId&&e.manifest_sha256===request.manifestSha256&&e.descriptor_sha256===id&&e.stage===stage&&(!identity||same(e.identity,identity)),'PRIVATE_FILE_JOURNAL_CHANGED');identity=e.identity;events.set(stage,e);}
    async function mark(stage:Stage,authorizationId:string){need(identity,'PRIVATE_FILE_IDENTITY');const value={schema_version:1 as const,job_id:request.jobId,manifest_sha256:request.manifestSha256,descriptor_sha256:id,stage,identity,authorization_id:authorizationId};const path=join(job,id+'.'+stage+'.json');let event=value;
     if(!await absent(path+'.pending')){const prior=eventSchema.parse(await jsonFile(path+'.pending'));need(same({...prior,authorization_id:authorizationId},value),'PRIVATE_FILE_JOURNAL_CHANGED');event=prior;}
     await publish(path,event,job,v=>eventSchema.parse(v));events.set(stage,event);
    }
    async function sourceAbsent(){need(await absent(source),'PRIVATE_FILE_SOURCE_REAPPEARED');}
    if(!events.has('PINNED')){need(await absent(target),'PRIVATE_FILE_INTRUDER');const f=await file(source,descriptor,1);try{identity=f.identity;await mark('PINNED',await fence('QUARANTINE'));}finally{await f.h.close();}}
    if(events.has('ERASED')){await sourceAbsent();need(await absent(target),'PRIVATE_FILE_INTRUDER');continue;}
    if(!events.has('LINK_INTENT'))await mark('LINK_INTENT',await fence('QUARANTINE'));
    if(!events.has('SOURCE_UNLINK_INTENT')){
     if(await absent(target)){const auth=await fence('QUARANTINE'),f=await file(source,descriptor,1,identity);try{await current(source,f.h,identity!,1);live(auth);await link(source,target);await syncDirectory(job);await current(source,f.h,identity!,2);}finally{await f.h.close();}await mark('SOURCE_UNLINK_INTENT',auth);}
     else{const a=await file(source,descriptor,2,identity);try{const b=await file(target,descriptor,2,identity);try{await current(source,a.h,identity!,2);await current(target,b.h,identity!,2);await syncDirectory(job);await mark('SOURCE_UNLINK_INTENT',await fence('QUARANTINE'));}finally{await b.h.close();}}finally{await a.h.close();}}
    }
    if(!events.has('QUARANTINED')){
     if(!await absent(source)){const auth=await fence('QUARANTINE'),a=await file(source,descriptor,2,identity);try{const b=await file(target,descriptor,2,identity);try{await current(source,a.h,identity!,2);await current(target,b.h,identity!,2);live(auth);await unlink(source);await syncDirectory(assets);await sourceAbsent();await current(target,b.h,identity!,1);}finally{await b.h.close();}}finally{await a.h.close();}}
     else{const f=await file(target,descriptor,1,identity);await f.h.close();await syncDirectory(assets);}
     await mark('QUARANTINED',await fence('QUARANTINE'));
    }
    await sourceAbsent();
    if(!events.has('ERASE_INTENT')){const auth=await fence('UNLINK'),f=await file(target,descriptor,1,identity);await f.h.close();await mark('ERASE_INTENT',auth);}
    const auth=await fence('UNLINK');await sourceAbsent();
    if(!await absent(target)){const f=await file(target,descriptor,1,identity);try{await current(target,f.h,identity!,1);live(auth);await unlink(target);await syncDirectory(job);need(await absent(target),'PRIVATE_FILE_INTRUDER');}finally{await f.h.close();}}
    else await syncDirectory(job);
    await mark('ERASED',auth);
   }
   await fence('UNLINK');for(const d of manifest.files)need(await absent(join(assets,d.storage_key+'.enc'))&&await absent(join(job,hash(canonical(d))+'.enc')),'PRIVATE_FILE_ABSENCE');
   return Object.freeze({schema_version:1 as const,job_id:request.jobId,manifest_sha256:request.manifestSha256,state:'FILES_ABSENT' as const,files:manifest.files.length,journal_sha256:hash(canonical(await Promise.all(manifest.files.map(d=>jsonFile(join(job,hash(canonical(d))+'.ERASED.json'))))))});
  });}finally{activeRoots.delete(root);}
 }});
}
