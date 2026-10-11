import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,lstat,rename,unlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {CommerceApi} from './api.js';
export const MAX_ASSET_BYTES=500*1024**2;
export interface RemoteAsset{assetId:string;sha256:string;sizeBytes:number;contentType:string;}
export function safeId(id:string){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(id))throw Error('UNSAFE_IDENTIFIER');return id;}
export async function hashFile(file:string){const h=createHash('sha256');for await(const chunk of createReadStream(file))h.update(chunk);return h.digest('hex');}
export function validateAsset(a:RemoteAsset){safeId(a.assetId);if(!/^[a-f0-9]{64}$/.test(a.sha256)||!Number.isSafeInteger(a.sizeBytes)||a.sizeBytes<1||a.sizeBytes>MAX_ASSET_BYTES)throw Error('INVALID_ASSET');}
export function safeTransferUrl(raw:string){const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.hostname==='localhost'||u.hostname==='::1'||u.hostname.startsWith('[')||/^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname))throw Error('UNSAFE_TRANSFER_URL');return u;}
export async function materializeAsset(api:CommerceApi,root:string,a:RemoteAsset){
 validateAsset(a);const cache=path.join(root,'cache');await mkdir(cache,{recursive:true,mode:0o700});if(await realpath(cache)!==cache)throw Error('CACHE_SYMLINK');const target=path.join(cache,a.sha256);
 try{const s=await lstat(target);if(s.isSymbolicLink())throw Error('ASSET_SYMLINK');if(s.isFile()&&s.size===a.sizeBytes&&await hashFile(target)===a.sha256)return target;await unlink(target);}catch(e:any){if(e.code!=='ENOENT')throw e;}
 const signed=await api.call<any>(`/creative-device/v1/assets/${safeId(a.assetId)}/access`);const u=safeTransferUrl(signed.url);const r=await fetch(u,{redirect:'error',signal:AbortSignal.timeout(300000)});if(!r.ok||!r.body)throw Error(`ASSET_HTTP_${r.status}`);
 const length=r.headers.get('content-length');if(length&&Number(length)!==a.sizeBytes){await r.body.cancel();throw Error('ASSET_LENGTH_MISMATCH');}
 const tmp=target+'.partial';await unlink(tmp).catch(()=>{});const f=await open(tmp,'wx',0o600);let count=0;const h=createHash('sha256');try{for await(const chunk of r.body as any){count+=chunk.length;if(count>a.sizeBytes)throw Error('ASSET_TOO_LARGE');h.update(chunk);await f.write(chunk);}if(count!==a.sizeBytes||h.digest('hex')!==a.sha256)throw Error('ASSET_HASH_MISMATCH');await f.sync();await f.close();await rename(tmp,target);return target;}catch(e){await f.close().catch(()=>{});await unlink(tmp).catch(()=>{});throw e;}
}
export async function uploadArtifact(api:CommerceApi,attempt:{jobId:string;attemptId:string;fence:number},file:{kind:string;path:string;sha256:string;sizeBytes:number;contentType:string}){
 if(file.sizeBytes>MAX_ASSET_BYTES||await hashFile(file.path)!==file.sha256)throw Error('OUTPUT_HASH_MISMATCH');
 const session=await api.call<any>('/creative-device/v1/uploads',{...attempt,kind:file.kind,sha256:file.sha256,sizeBytes:file.sizeBytes,contentType:file.contentType},`${attempt.attemptId}:${file.kind}:${file.sha256}`);
 if(session.status==='READY')return session.assetId??session.asset_id;if(['VERIFYING','CLOSING'].includes(session.status)){const done=await api.call<any>(`/creative-device/v1/uploads/${safeId(session.uploadId)}/complete`,{...attempt},`${session.uploadId}:complete`);return done.assetId??done.asset_id;}const fd=await open(file.path,'r');const parts=[];try{const partSize=8*1024**2;for(let offset=0,n=1;offset<file.sizeBytes;offset+=partSize,n++){const bytes=Math.min(partSize,file.sizeBytes-offset);const b=Buffer.alloc(bytes);await fd.read(b,0,bytes,offset);const signed=await api.call<any>(`/creative-device/v1/uploads/${safeId(session.uploadId)}/parts/${n}`,{...attempt,sizeBytes:bytes},`${session.uploadId}:part:${n}`);const r=await fetch(safeTransferUrl(signed.url),{method:'PUT',body:b,headers:{'content-length':String(bytes)},redirect:'error',signal:AbortSignal.timeout(300000)});if(!r.ok)throw Error(`UPLOAD_HTTP_${r.status}`);const etag=r.headers.get('etag');if(!etag)throw Error('UPLOAD_ETAG_MISSING');parts.push({partNumber:n,etag});}}finally{await fd.close();}
 const completed=await api.call<any>(`/creative-device/v1/uploads/${safeId(session.uploadId)}/complete`,{...attempt,parts},`${session.uploadId}:complete`);return completed.assetId??completed.artifactId;
}
