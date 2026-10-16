import {constants} from 'node:fs';
import {open,lstat,realpath,readdir} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {privateFileDescriptorSchema,privateFileManifestSchema,type PrivateFileManifest} from '../../contracts/src/privacy-file-custody.js';
import {withPrivateNamespaceLock,assertPrivateNamespaceLease,type PrivateNamespaceLease} from './private-namespace-lock.js';
import {privateFileManifestHash} from './privacy-file-custody.js';

const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/),digits=z.string().regex(/^[1-9]\d{0,20}$/);
const requestSchema=z.strictObject({jobId:uuid,workspaceId:z.string().min(1).max(256).refine(v=>!v.includes('\0'))});
const candidateSchema=privateFileDescriptorSchema.extend({source_sha256:sha,history_sha256:sha,reference_sha256:sha}).superRefine((v,c)=>{
 if(v.storage_key!==v.asset_id&&!v.storage_key.startsWith(v.asset_id+'-'))c.addIssue({code:'custom',message:'PRIVATE_CAPTURE_ASSET_KEY'});
});
/** Only the native, authenticated restored-backup reader supplies these pins.
 * The filesystem reader never accepts a request containing an asset or path. */
export const privateFileCandidatesSchema=z.strictObject({schema_version:z.literal(1),job_id:uuid,workspace_id:z.string().min(1).max(256),
 plan_sha256:sha,inventory_sha256:sha,backup_fence_sha256:sha,backup_id:uuid,restore_sha256:sha,backup_snapshot_unix_ns:digits,
 candidate_sha256:sha,observed_at:z.iso.datetime({offset:true}),valid_until:z.iso.datetime({offset:true}),
 files:z.array(candidateSchema).max(1000),erasure_authorized:z.literal(false)
}).superRefine((v,c)=>{if(!privateFileManifestSchema.safeParse(manifestOf(v)).success)c.addIssue({code:'custom',message:'PRIVATE_CAPTURE_BOUND'});});
export type PrivateFileCaptureRequest=z.infer<typeof requestSchema>;
export interface PrivateFileCandidatePort{load(request:PrivateFileCaptureRequest):Promise<z.input<typeof privateFileCandidatesSchema>>}
type Candidates=z.infer<typeof privateFileCandidatesSchema>;
type Identity={dev:string;ino:string;bytes:string;mtime_ns:string;ctime_ns:string;sha256:string};
declare const captureBrand:unique symbol;
export interface CapturedPrivateFiles{readonly[captureBrand]:true}
type State={active:boolean;consumed:boolean;root:string;assetDirectory:{dev:bigint;ino:bigint};lease:PrivateNamespaceLease;request:PrivateFileCaptureRequest;authority:PrivateFileCandidatePort;candidate:Candidates;manifest:PrivateFileManifest;identities:Identity[]};
const states=new WeakMap<object,State>();
function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
function canonical(v:unknown):string{if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';}
function manifestOf(v:{job_id:string;workspace_id:string;plan_sha256:string;inventory_sha256:string;backup_fence_sha256:string;files:z.infer<typeof candidateSchema>[]}):PrivateFileManifest{
 return{schema_version:1,job_id:v.job_id,workspace_id:v.workspace_id,plan_sha256:v.plan_sha256,inventory_sha256:v.inventory_sha256,backup_fence_sha256:v.backup_fence_sha256,
 files:v.files.map(({asset_id,storage_key,ciphertext_sha256,ciphertext_bytes})=>({asset_id,storage_key,ciphertext_sha256,ciphertext_bytes}))};
}
function live(c:Candidates){const now=Date.now(),observed=Date.parse(c.observed_at);need(observed<=now&&now-observed<=120000&&Date.parse(c.valid_until)>now,'PRIVATE_CAPTURE_AUTHORITY_EXPIRED');need(BigInt(c.backup_snapshot_unix_ns)<=BigInt(now)*1000000n,'PRIVATE_CAPTURE_FUTURE_BACKUP');}
function binding(c:Candidates){const{observed_at:_,...rest}=c;return canonical(rest);}
async function authority(port:PrivateFileCandidatePort,request:PrivateFileCaptureRequest){const c=privateFileCandidatesSchema.parse(await port.load({...request}));need(c.job_id===request.jobId&&c.workspace_id===request.workspaceId,'PRIVATE_CAPTURE_BINDING');live(c);return c;}
async function directory(path:string){need(isAbsolute(path)&&resolve(path)===path&&await realpath(path)===path,'PRIVATE_CAPTURE_DIRECTORY');const d=await lstat(path,{bigint:true});need(d.isDirectory()&&!d.isSymbolicLink()&&(d.mode&0o777n)===0o700n&&d.uid===BigInt(process.getuid!()),'PRIVATE_CAPTURE_DIRECTORY');return{dev:d.dev,ino:d.ino};}
async function measure(root:string,key:string,expected?:{bytes:string;sha256:string;snapshotNs:string}):Promise<Identity>{
 const path=join(root,'assets',key+'.enc'),h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await h.stat({bigint:true});need(before.isFile()&&before.nlink===1n&&(before.mode&0o077n)===0n&&before.uid===BigInt(process.getuid!())&&before.size>0n&&before.size<=536870912n&&(!expected||before.size===BigInt(expected.bytes)),'PRIVATE_CAPTURE_FILE_IDENTITY');
  need(!expected||before.mtimeNs<=BigInt(expected.snapshotNs),'PRIVATE_CAPTURE_NEWER_THAN_BACKUP');
  const buffer=Buffer.alloc(1024*1024),digest=createHash('sha256');let count=0n;
  try{while(true){const max=before.size-count+1n,read=await h.read(buffer,0,Number(max<BigInt(buffer.length)?max:BigInt(buffer.length)),null);if(!read.bytesRead)break;count+=BigInt(read.bytesRead);need(count<=before.size,'PRIVATE_CAPTURE_FILE_CHANGED');digest.update(buffer.subarray(0,read.bytesRead));}}finally{buffer.fill(0);}
  const after=await h.stat({bigint:true}),named=await lstat(path,{bigint:true}),hash=digest.digest('hex');
  need(count===before.size&&(!expected||hash===expected.sha256)&&[after,named].every(s=>s.isFile()&&!s.isSymbolicLink()&&s.nlink===1n&&s.dev===before.dev&&s.ino===before.ino&&s.size===before.size&&s.mtimeNs===before.mtimeNs&&s.ctimeNs===before.ctimeNs&&s.mode===before.mode&&s.uid===before.uid),'PRIVATE_CAPTURE_FILE_CHANGED');
  return{dev:String(before.dev),ino:String(before.ino),bytes:String(before.size),mtime_ns:String(before.mtimeNs),ctime_ns:String(before.ctimeNs),sha256:hash};
 }finally{await h.close();}
}
async function revalidate(s:State){
 need(s.active,'PRIVATE_CAPTURE_EXPIRED');await assertPrivateNamespaceLease(s.lease,s.root,'EXCLUSIVE');live(s.candidate);
 const current=await authority(s.authority,s.request);need(binding(current)===binding(s.candidate),'PRIVATE_CAPTURE_SOURCE_CHANGED');
 const assets=await directory(join(s.root,'assets'));need(assets.dev===s.assetDirectory.dev&&assets.ino===s.assetDirectory.ino,'PRIVATE_CAPTURE_DIRECTORY_CHANGED');
 for(const[i,d]of s.candidate.files.entries()){
  const native=await lstat(join(s.root,'assets',d.storage_key+'.enc'),{bigint:true}),pin=s.identities[i]!;
  need(native.isFile()&&!native.isSymbolicLink()&&native.nlink===1n&&String(native.dev)===pin.dev&&String(native.ino)===pin.ino&&String(native.size)===pin.bytes&&String(native.mtimeNs)===pin.mtime_ns&&String(native.ctimeNs)===pin.ctime_ns&&(native.mode&0o077n)===0n&&native.uid===BigInt(process.getuid!()),'PRIVATE_CAPTURE_FILE_CHANGED');
 }
 await assertPrivateNamespaceLease(s.lease,s.root,'EXCLUSIVE');live(s.candidate);
}
/** One exclusive namespace interval spans capture and the final SQL callback.
 * The authority loads must each use a short native transaction; file I/O never
 * runs inside a SQL transaction. This function does not grant deletion access. */
export async function withPrivateFileCapture<T>(options:{root:string;authority:PrivateFileCandidatePort},raw:PrivateFileCaptureRequest,work:(capture:CapturedPrivateFiles)=>Promise<T>):Promise<T>{
 const request=requestSchema.parse(raw);
 return withPrivateNamespaceLock(options.root,'EXCLUSIVE',async lease=>{
  const assets=join(options.root,'assets'),first=await directory(assets),candidate=await authority(options.authority,request),identities:Identity[]=[];
  for(const file of candidate.files){live(candidate);await assertPrivateNamespaceLease(lease,options.root,'EXCLUSIVE');identities.push(await measure(options.root,file.storage_key,{bytes:file.ciphertext_bytes,sha256:file.ciphertext_sha256,snapshotNs:candidate.backup_snapshot_unix_ns}));}
  const last=await directory(assets);need(first.dev===last.dev&&first.ino===last.ino,'PRIVATE_CAPTURE_DIRECTORY_CHANGED');
  const token=Object.freeze({}) as CapturedPrivateFiles,state:State={active:true,consumed:false,root:options.root,assetDirectory:first,lease,request,authority:options.authority,candidate,manifest:privateFileManifestSchema.parse(manifestOf(candidate)),identities};states.set(token,state);
  try{await revalidate(state);return await work(token);}finally{state.active=false;}
 });
}
/** Private assembler only. Identity is a live WeakMap capability, not JSON or
 * an input flag; consume before entering final SQL and pass its immutable pins.
 * Native SQL must independently recheck candidate hash and restored attestation. */
export async function consumePrivateFileCapture(token:CapturedPrivateFiles,raw:PrivateFileCaptureRequest){
 const request=requestSchema.parse(raw),s=states.get(token);need(s?.active&&!s.consumed&&canonical(request)===canonical(s.request),'PRIVATE_CAPTURE_CAPABILITY');
 s.consumed=true;await revalidate(s);live(s.candidate);
 return freeze({schema_version:1 as const,job_id:s.request.jobId,workspace_id:s.request.workspaceId,candidate_sha256:s.candidate.candidate_sha256,backup_id:s.candidate.backup_id,
 restore_sha256:s.candidate.restore_sha256,manifest:structuredClone(s.manifest),manifest_sha256:privateFileManifestHash(s.manifest)});
}

/** Read-only native backup operator. A complete directory scan, never caller
 * descriptors or selected filenames. Ciphertext is streamed, never decrypted.
 * The backup verifier authenticates this result's custody and before/after/
 * restore equality; this measurement by itself grants no import or erasure. */
export async function capturePrivateBackupFileInventory(root:string){
 return withPrivateNamespaceLock(root,'EXCLUSIVE',async lease=>{
  const started=new Date().toISOString(),assets=join(root,'assets'),first=await directory(assets),names=(await readdir(assets)).sort();
  need(names.length<=10000,'PRIVATE_BACKUP_FILE_BOUND');const files=[];const seen=new Set<string>();
  for(const name of names){
   const parsed=/^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:-[a-f0-9]{64})?\.enc$/.exec(name);
   need(parsed&&!seen.has(parsed[1]!),'PRIVATE_BACKUP_FILE_NAME');seen.add(parsed[1]!);await assertPrivateNamespaceLease(lease,root,'EXCLUSIVE');
   const key=name.slice(0,-4),identity=await measure(root,key);
   files.push({asset_id:parsed[1]!,storage_key:key,ciphertext_sha256:identity.sha256,ciphertext_bytes:identity.bytes,mtime_ns:identity.mtime_ns});
  }
  const last=await directory(assets);need(first.dev===last.dev&&first.ino===last.ino&&canonical(names)===canonical((await readdir(assets)).sort()),'PRIVATE_CAPTURE_DIRECTORY_CHANGED');
  await assertPrivateNamespaceLease(lease,root,'EXCLUSIVE');
  return freeze({schema_version:1 as const,kind:'PRIVATE_CIPHERTEXT_INVENTORY' as const,started_at:started,finished_at:new Date().toISOString(),files});
 });
}
