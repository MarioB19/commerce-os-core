import type {FastifyInstance,FastifyRequest} from 'fastify';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {decrypt,hash} from '@commerce/db';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {parseStaticAccessReference} from '../../../packages/fulfillment/src/index.js';
import {principal,scopedRecord,fail} from './context.js';

const extensions:Record<string,string>={'audio/wav':'.wav','image/webp':'.webp','audio/mpeg':'.mp3','audio/ogg':'.ogg','audio/mp4':'.m4a','image/png':'.png','image/jpeg':'.jpg','application/pdf':'.pdf','video/mp4':'.mp4','text/plain':'.txt'};
export function assetFilename(name:unknown,mime:string){
 const clean=Array.from(String(name??'material'),c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127||['"','\\','/'].includes(c)?'_':c).join('').trim().slice(0,150)||'material';
 const extension=extensions[mime];return extension&&!clean.toLowerCase().endsWith(extension)?clean+extension:clean;
}
export function byteRange(header:string|undefined,size:number):{start:number;end:number}|undefined{
 if(!header)return;
 const match=/^bytes=(\d*)-(\d*)$/.exec(header);if(!match||!match[1]&&!match[2])throw new Error('INVALID_RANGE');
 const start=match[1]?Number(match[1]):Math.max(0,size-Number(match[2]));
 const end=match[1]&&match[2]?Math.min(Number(match[2]),size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=size||end<start)throw new Error('INVALID_RANGE');
 return{start,end};
}
async function readable(req:FastifyRequest){
 const p=principal(req);if(p.service)assertPermission(p,'assets:read');else if(!['owner','operator','reconciler'].includes(p.role))throw fail(403,'FORBIDDEN');
 const asset=await scopedRecord(req,'asset',(req.params as {id:string}).id);
 if(asset.body.status!=='READY')throw fail(409,'ASSET_NOT_READY');
 if(asset.body.lab_material_placeholder)throw fail(409,'LAB_MATERIAL_PLACEHOLDER','El laboratorio no contiene el archivo operativo.');
 return asset;
}
export async function assetPreviewRoutes(app:FastifyInstance,storageDir:string){
 app.get('/v1/assets/:id/preview',async(req,reply)=>{
  reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
  const asset=await readable(req),body=asset.body;
  const common={kind:body.kind,name:body.name,mime_type:body.mime_type,size_bytes:body.size_bytes};
  if(body.kind==='file')return{data:{...common,content_url:`/v1/assets/${asset.id}/content?environment=${asset.environment}&disposition=inline`,download_url:`/v1/assets/${asset.id}/content?environment=${asset.environment}&disposition=attachment`}};
  if(body.kind==='link')return{data:{...common,url:body.url}};
  if(body.kind==='access'&&body.adapter==='link'&&body.delivery_ciphertext){
   const secret=JSON.parse(decrypt(body.delivery_ciphertext)),access=parseStaticAccessReference(secret.delivery_reference);
   return{data:{...common,url:access.url,code:access.code,instructions:access.instructions}};
  }
  throw fail(409,'PREVIEW_UNAVAILABLE','Este recurso requiere su integración de entrega.');
 });
 app.get('/v1/assets/:id/content',async(req,reply)=>{
  reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');
  const asset=await readable(req);if(asset.body.kind!=='file')throw fail(400,'NOT_FILE');
  const mime=String(asset.body.mime_type??'application/octet-stream').split(';')[0]!.trim();
  const requested=(req.query as {disposition?:string}).disposition;
  if(requested&&!['inline','attachment'].includes(requested))throw fail(400,'INVALID_DISPOSITION');
  reply.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
  const disposition=requested==='inline'&&extensions[mime]?'inline':'attachment';
  // V7 F8: the external R2 library was retired; its records keep history but no content.
  if(asset.body.storage_provider==='r2')throw fail(410,'ASSET_LIBRARY_RETIRED','La biblioteca externa se retiró; este material ya no se abre desde la aplicación.');
  const key=asset.body.storage_key??asset.id;if(!/^[a-f0-9-]{36}(?:-[a-f0-9]{64})?$/.test(key))throw fail(409,'ASSET_STORAGE_INVALID');
  const bytes=Buffer.from(decrypt(await readFile(join(storageDir,'assets',key+'.enc'),'utf8')),'base64');
  if(bytes.length!==asset.body.size_bytes||hash(bytes)!==asset.body.sha256)throw fail(409,'ASSET_INTEGRITY_FAILED');
  const filename=assetFilename(asset.body.name,mime);
  reply.header('Content-Disposition',`${disposition}; filename="material${extensions[mime]??''}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g,'%27')}`).header('Accept-Ranges','bytes').type(mime);
  let range;try{range=byteRange(req.headers.range,bytes.length);}catch{return reply.code(416).header('Content-Range',`bytes */${bytes.length}`).send();}
  if(range){reply.code(206).header('Content-Range',`bytes ${range.start}-${range.end}/${bytes.length}`).header('Content-Length',range.end-range.start+1);return reply.send(bytes.subarray(range.start,range.end+1));}
  return reply.header('Content-Length',bytes.length).send(bytes);
 });
}
