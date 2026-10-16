import {constants} from 'node:fs';
import {lstat,realpath,open,mkdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash,createCipheriv,createDecipheriv,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {withProfileTransaction,type ProfilePool} from './profile-context.js';
import {currentProfileExecutor} from './profile-query-routing.js';
import {currentWorkerProfile} from './profile-worker-scope.js';
import {withPrivateNamespaceLock,assertPrivateNamespaceLease} from './private-namespace-lock.js';
import {openLabValue} from './number-laboratory.js';
import {marketRecordVersionHash} from './market-variants.js';
import {compileNumberLabConfiguration,type LabPlanSource} from '../../domain/src/laboratory/configuration-plan.js';
import {numberLabVirtualMaterial} from '../../domain/src/laboratory/virtual-material.js';
import {parseStaticAccessReference} from '../../fulfillment/src/index.js';
import {labCanonical,labHash} from '../../domain/src/laboratory/number-lab.js';
import type {NumberLabMaterialPort} from './number-lab-materialization.js';
const MAX_FILE=20*1024*1024,MAX_TOTAL=128*1024*1024,MAX_CIPHER=Math.ceil(Math.ceil(MAX_FILE/3)*4/3)*4+128;
const uuid=z.string().uuid().transform(v=>v.toLowerCase()),sha=z.string().regex(/^[a-f0-9]{64}$/);
const ref=z.object({id:uuid,revision:z.number().int().positive(),sha256:sha}).strict();
const material=z.object({id:uuid,source:ref,kind:z.enum(['file','link','access']),sha256:sha.nullable(),size_bytes:z.number().int().min(0).max(MAX_FILE).nullable(),broker_required:z.literal(true)}).strict().refine(m=>m.kind!=='file'||m.sha256!==null&&m.size_bytes!==null);
const request=z.object({workspaceId:z.string().min(1).max(256).refine(v=>!v.includes('\0')),runId:uuid,snapshotSha256:sha,materials:z.array(material).max(6000)}).strict();
function need(v:unknown,c:string):asserts v{if(!v)throw Error(c);}
function hash(v:Uint8Array){return createHash('sha256').update(v).digest('hex');}
function canonicalBase64(s:string,length?:number){const b=Buffer.from(s,'base64');need(b.toString('base64')===s&&(length===undefined||b.length===length),'LAB_FILE_CIPHERTEXT');return b;}
function decryptFile(raw:string,key:Uint8Array){
 const parts=raw.split('.');need(parts.length===4&&parts[0]==='v1','LAB_FILE_CIPHERTEXT');
 const d=createDecipheriv('aes-256-gcm',key,canonicalBase64(parts[1]!,12));d.setAuthTag(canonicalBase64(parts[2]!,16));
 const bytes=Buffer.concat([d.update(canonicalBase64(parts[3]!)),d.final()]);try{return canonicalBase64(new TextDecoder('utf8',{fatal:true}).decode(bytes));}finally{bytes.fill(0);}
}
function encryptFile(bytes:Uint8Array,key:Uint8Array){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),plain=Buffer.from(Buffer.from(bytes).toString('base64'));try{const ciphertext=Buffer.concat([c.update(plain),c.final()]);return ['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),ciphertext.toString('base64')].join('.');}finally{plain.fill(0);}}
function validateAccess(raw:unknown,key:Uint8Array,adapter:unknown){
 let first:Buffer|undefined,plain:Buffer|undefined;
 try{need(typeof raw==='string'&&raw.length<=131072,'LAB_MATERIAL_ACCESS_INVALID');const parts=raw.split('.');need(parts.length===4&&parts[0]==='v1','LAB_MATERIAL_ACCESS_INVALID');
  const decipher=createDecipheriv('aes-256-gcm',key,canonicalBase64(parts[1]!,12));decipher.setAuthTag(canonicalBase64(parts[2]!,16));first=decipher.update(canonicalBase64(parts[3]!));plain=Buffer.concat([first,decipher.final()]);
  const secret=z.object({adapter:z.enum(['link','webhook']),delivery_reference:z.string().min(1).max(65536)}).strict().parse(JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(plain)));need(secret.adapter===adapter,'LAB_MATERIAL_ACCESS_INVALID');if(secret.adapter==='link')parseStaticAccessReference(secret.delivery_reference);
 }catch{throw Error('LAB_MATERIAL_ACCESS_INVALID');}finally{first?.fill(0);plain?.fill(0);}
}
async function directory(path:string,privateMode:boolean){need(isAbsolute(path)&&resolve(path)===path,'LAB_MATERIAL_ROOT');const real=await realpath(path),s=await lstat(path);need(real===path&&s.isDirectory()&&!s.isSymbolicLink()&&(!privateMode||(s.mode&0o077)===0),'LAB_MATERIAL_ROOT');return{dev:s.dev,ino:s.ino};}
async function syncDirectory(path:string){const h=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{need((await h.stat()).isDirectory(),'LAB_MATERIAL_ROOT');await h.sync();}finally{await h.close();}}
async function boundedFile(path:string,expected?:{dev:number;ino:number}){
 const h=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const before=await h.stat();need(!expected||before.dev===expected.dev&&before.ino===expected.ino,'LAB_FILE_CHANGED');need(before.isFile()&&before.size>0&&before.size<=MAX_CIPHER,'LAB_FILE_BOUND');const bytes=Buffer.alloc(before.size+1);let offset=0;try{while(offset<bytes.length){const r=await h.read(bytes,offset,bytes.length-offset,null);if(r.bytesRead===0)break;offset+=r.bytesRead;}const after=await h.stat();need(offset===before.size&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs,'LAB_FILE_CHANGED');return new TextDecoder('utf8',{fatal:true}).decode(bytes.subarray(0,offset));}finally{bytes.fill(0);}}finally{await h.close();}
}
/** Server-owned roots, credentials and pools only. Callers may not override any
 * of these through the materialization request. No network or source writes. */
export function createNumberLabMaterialCustody(options:{controlPool:ProfilePool;sourcePool:ProfilePool;controlKey:Uint8Array;sourceKey:Uint8Array;laboratoryKey:Uint8Array;sourceRoot:string;laboratoryRoot:string}):NumberLabMaterialPort{
 const controlKey=Buffer.from(options.controlKey),sourceKey=Buffer.from(options.sourceKey),labKey=Buffer.from(options.laboratoryKey);
 need([controlKey,sourceKey,labKey].every(k=>k.length===32)&&!timingSafeEqual(sourceKey,labKey),'LAB_MATERIAL_KEY');
 const roots={source:resolve(options.sourceRoot),lab:resolve(options.laboratoryRoot)};
 need(isAbsolute(options.sourceRoot)&&isAbsolute(options.laboratoryRoot)&&roots.source===options.sourceRoot&&roots.lab===options.laboratoryRoot,'LAB_MATERIAL_ROOT');
 const contains=(a:string,b:string)=>{const r=relative(a,b);return !r||(!r.startsWith('..')&&!isAbsolute(r));};need(!contains(roots.source,roots.lab)&&!contains(roots.lab,roots.source),'LAB_MATERIAL_ROOT');
 async function authority(q:z.infer<typeof request>){return withProfileTransaction(options.controlPool,q.workspaceId,async db=>{
  need((await db.query('SELECT current_user role')).rows[0]?.role==='commerce_number_lab','LAB_MATERIAL_CONTROL_ROLE');
  const r=(await db.query(`SELECT r.snapshot_sha256,r.snapshot_ciphertext,r.state,r.expires_at,clock_timestamp() now FROM commerce_number_lab.runs r WHERE r.workspace_id=$1 AND r.id=$2 AND r.state IN('READY','RUNNING','PARTIAL') AND EXISTS(SELECT 1 FROM commerce_number_lab.operations o WHERE o.workspace_id=r.workspace_id AND o.run_id=r.id AND o.state='INTENT') FOR SHARE`,[q.workspaceId,q.runId])).rows[0];
  need(r&&r.snapshot_sha256===q.snapshotSha256&&new Date(r.expires_at).getTime()>new Date(r.now).getTime(),'LAB_MATERIAL_CONTROL_REQUIRED');
  const captured=openLabValue({workspaceId:q.workspaceId,runId:q.runId,purpose:'snapshot'},r.snapshot_ciphertext,controlKey) as {snapshot:unknown;records:LabPlanSource[]};
  const plan=compileNumberLabConfiguration(captured,q.runId);need(plan.snapshot_sha256===q.snapshotSha256&&labCanonical(plan.variants.flatMap(v=>v.materials))===labCanonical(q.materials),'LAB_MATERIAL_CAPTURE_CHANGED');return plan;
 });}
 async function source(q:z.infer<typeof request>,m:z.infer<typeof material>){return withProfileTransaction(options.sourcePool,q.workspaceId,async db=>{
  await db.query("SELECT set_config('app.environment','REAL',true)");need((await db.query('SELECT current_user role')).rows[0]?.role==='commerce_api','LAB_MATERIAL_SOURCE_ROLE');
  need((await db.query("SELECT id FROM profiles WHERE id=$1 AND state='ACTIVE' FOR SHARE",[q.workspaceId])).rows.length===1,'LAB_MATERIAL_PROFILE_INACTIVE');
  const row=(await db.query(`SELECT v.record_id,v.workspace_id,v.environment,v.kind,v.version,v.body FROM record_versions v JOIN records r ON r.id=v.record_id AND r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.kind=v.kind WHERE v.workspace_id=$1 AND v.environment='REAL' AND v.kind='asset' AND v.record_id=$2 AND v.version=$3 AND r.body->>'status'='READY' FOR SHARE OF r`,[q.workspaceId,m.source.id,m.source.revision])).rows[0];
  need(row&&marketRecordVersionHash(row)===m.source.sha256&&row.body.kind===m.kind&&row.body.status==='READY','LAB_MATERIAL_SOURCE_CHANGED');
  if(m.kind==='file'){need(row.body.sha256===m.sha256&&row.body.size_bytes===m.size_bytes&&/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(row.body.storage_key),'LAB_MATERIAL_SOURCE_CHANGED');return row.body.storage_key as string;}
  if(m.kind==='link')need(typeof row.body.url==='string'&&row.body.url.length<=8192&&z.url().safeParse(row.body.url).success&&row.body.url.startsWith('https://'),'LAB_MATERIAL_SOURCE_CHANGED');
  else validateAccess(row.body.delivery_ciphertext,sourceKey,row.body.adapter);
  return null;
 });}
 return Object.freeze({async copy(raw:Parameters<NumberLabMaterialPort['copy']>[0]){
  need(!currentProfileExecutor()&&!currentWorkerProfile(),'LAB_MATERIAL_OUTER_SCOPE');const q=request.parse(raw);need(new Set(q.materials.map(m=>m.id)).size===q.materials.length&&q.materials.reduce((n,m)=>n+(m.size_bytes??0),0)<=MAX_TOTAL,'LAB_MATERIAL_LIMIT');
  await directory(roots.source,true);await directory(roots.lab,true);
  return withPrivateNamespaceLock(roots.source,'SHARED',sourceLease=>withPrivateNamespaceLock(roots.lab,'SHARED',async labLease=>{
  const checkNamespace=async()=>{await assertPrivateNamespaceLease(sourceLease,roots.source,'SHARED');await assertPrivateNamespaceLease(labLease,roots.lab,'SHARED');};
  const plan=await authority(q);const sourceAssets=join(roots.source,'assets'),labAssets=join(roots.lab,'assets');
  await directory(roots.source,false);const origin=await directory(sourceAssets,false);await directory(roots.lab,true);await mkdir(labAssets,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});const target=await directory(labAssets,true),files=[],virtual=[];
  for(const m of q.materials){
   await checkNamespace();const key=await source(q,m);
   if(m.kind!=='file'){const variant=plan.variants.find(v=>v.materials.some(item=>item.id===m.id));need(variant,'LAB_MATERIAL_CAPTURE_CHANGED');await source(q,m);virtual.push(numberLabVirtualMaterial({run_id:q.runId,snapshot_sha256:q.snapshotSha256,variant_id:variant.variant_id,id:m.id,kind:m.kind,source:m.source}));continue;}
   need(typeof key==='string','LAB_MATERIAL_SOURCE_CHANGED');const bytes=decryptFile(await boundedFile(join(sourceAssets,key+'.enc')),sourceKey);
   try{need(bytes.length===m.size_bytes&&hash(bytes)===m.sha256,'LAB_MATERIAL_CONTENT_CHANGED');const storageKey=m.id+'-'+m.sha256,path=join(labAssets,storageKey+'.enc');let output;
    try{output=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e:any){if(e.code!=='EEXIST')throw e;}
    if(output){try{await output.writeFile(encryptFile(bytes,labKey));await output.sync();}finally{await output.close();}}
    const verified=decryptFile(await boundedFile(path),labKey);try{need(verified.length===bytes.length&&hash(verified)===m.sha256,'LAB_MATERIAL_COPY_CHANGED');}finally{verified.fill(0);}
    need(await source(q,m)===key,'LAB_MATERIAL_SOURCE_CHANGED');files.push({id:m.id,source_sha256:m.source.sha256,content_sha256:m.sha256,size_bytes:m.size_bytes,storage_key:storageKey});
   }finally{bytes.fill(0);}
  }
  // A synced file alone does not make its directory entry durable. Include the
  // parent publication of assets/ before accepting any descriptor or READY.
  await syncDirectory(labAssets);await syncDirectory(roots.lab);
  await authority(q);need(labHash(await directory(sourceAssets,false))===labHash(origin)&&labHash(await directory(labAssets,true))===labHash(target),'LAB_MATERIAL_ROOT_CHANGED');
  await checkNamespace();return{run_id:q.runId,snapshot_sha256:q.snapshotSha256,files,...(virtual.length?{virtual_materials:virtual}:{})};
  }));
 }});
}

/** A delivery capability is bound to one protected laboratory root/key. It
 * cannot read source custody, caller paths or environment credentials. */
export interface NumberLabMaterialReader {readonly kind:'NUMBER_LAB_MATERIAL_READER'}
const readers=new WeakMap<object,{root:string;key:Buffer}>();
export function createNumberLabMaterialReader(options:{laboratoryRoot:string;laboratoryKey:Uint8Array}):NumberLabMaterialReader{
 need(isAbsolute(options.laboratoryRoot)&&resolve(options.laboratoryRoot)===options.laboratoryRoot&&options.laboratoryKey.length===32,'LAB_MATERIAL_ROOT');
 const h=Object.freeze({kind:'NUMBER_LAB_MATERIAL_READER' as const});readers.set(h,{root:options.laboratoryRoot,key:Buffer.from(options.laboratoryKey)});return h;
}
export async function readNumberLabMaterial(handle:NumberLabMaterialReader,raw:{id:string;sha256:string;size_bytes:number}):Promise<Buffer>{
 need(!currentProfileExecutor()&&!currentWorkerProfile(),'LAB_MATERIAL_OUTER_SCOPE');const o=handle&&readers.get(handle);need(o,'LAB_MATERIAL_READER_REQUIRED');
 const q=z.object({id:uuid,sha256:sha,size_bytes:z.number().int().min(0).max(MAX_FILE)}).strict().parse(raw),assets=join(o.root,'assets');
 await directory(o.root,true);let bytes:Buffer|undefined;
 try{return await withPrivateNamespaceLock(o.root,'SHARED',async lease=>{
 const root=await directory(o.root,true),dir=await directory(assets,true),path=join(assets,q.id+'-'+q.sha256+'.enc');
 const before=await lstat(path);need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&(before.mode&0o077)===0,'LAB_FILE_CUSTODY');
 bytes=decryptFile(await boundedFile(path,before),o.key);const after=await lstat(path);
  need(before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&after.nlink===1&&labHash(await directory(o.root,true))===labHash(root)&&labHash(await directory(assets,true))===labHash(dir),'LAB_FILE_CHANGED');
  need(bytes.length===q.size_bytes&&hash(bytes)===q.sha256,'LAB_MATERIAL_CONTENT_CHANGED');await assertPrivateNamespaceLease(lease,o.root,'SHARED');return bytes;
 });}catch(error){bytes?.fill(0);throw error;}
}
/** V7 RF-19.d: the laboratory copy of an example receipt, written by the
 * laboratory worker into its protected root under the files key, with the
 * same layout as captured materials, so the canonical engine reads it like any
 * private asset. Idempotent by content; never source custody or a caller path. */
export interface NumberLabReceiptCustody {readonly kind:'NUMBER_LAB_RECEIPT_CUSTODY'}
const receiptCustodies=new WeakMap<object,{root:string;key:Buffer}>();
export function createNumberLabReceiptCustody(options:{laboratoryRoot:string;laboratoryKey:Uint8Array}):NumberLabReceiptCustody{
 need(isAbsolute(options.laboratoryRoot)&&resolve(options.laboratoryRoot)===options.laboratoryRoot&&options.laboratoryKey.length===32,'LAB_MATERIAL_ROOT');
 const h=Object.freeze({kind:'NUMBER_LAB_RECEIPT_CUSTODY' as const});receiptCustodies.set(h,{root:options.laboratoryRoot,key:Buffer.from(options.laboratoryKey)});return h;
}
export async function storeNumberLabReceipt(handle:NumberLabReceiptCustody,raw:{id:string;sha256:string;bytes:Uint8Array}):Promise<{storage_key:string}>{
 need(!currentProfileExecutor()&&!currentWorkerProfile(),'LAB_MATERIAL_OUTER_SCOPE');const o=handle&&receiptCustodies.get(handle);need(o,'LAB_RECEIPT_CUSTODY_REQUIRED');
 const id=uuid.parse(raw.id),digest=sha.parse(raw.sha256);need(raw.bytes.byteLength>0&&raw.bytes.byteLength<=4*1024*1024&&hash(raw.bytes)===digest,'LAB_RECEIPT_CONTENT');
 await directory(o.root,true);
 return withPrivateNamespaceLock(o.root,'SHARED',async lease=>{
  const assets=join(o.root,'assets');await mkdir(assets,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});await directory(assets,true);
  const storageKey=id+'-'+digest,path=join(assets,storageKey+'.enc');let output;
  try{output=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e:any){if(e.code!=='EEXIST')throw e;}
  if(output){try{await output.writeFile(encryptFile(raw.bytes,o.key));await output.sync();}finally{await output.close();}await syncDirectory(assets);}
  const verified=decryptFile(await boundedFile(path),o.key);try{need(verified.length===raw.bytes.byteLength&&hash(verified)===digest,'LAB_RECEIPT_COPY_CHANGED');}finally{verified.fill(0);}
  await assertPrivateNamespaceLease(lease,o.root,'SHARED');return{storage_key:storageKey};
 });
}
