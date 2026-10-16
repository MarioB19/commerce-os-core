import type {FastifyReply,FastifyRequest} from 'fastify';
/** File download helpers shared by the V7 material and receipt routes: a safe
 * attachment name with its extension and a single HTTP byte range. */
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
/** A private file shown inline under a locked-down CSP, with one byte range
 * (audio/video seeking). Used by materials and the number-test chat preview. */
export function sendPrivateFile(req:FastifyRequest,reply:FastifyReply,file:{bytes:Buffer;mime:string;name:string}){
 reply.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'").header('X-Content-Type-Options','nosniff');
 const filename=assetFilename(file.name,file.mime);
 reply.header('Content-Disposition',`inline; filename="material"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g,'%27')}`).header('Accept-Ranges','bytes').type(file.mime);
 let range;try{range=byteRange(req.headers.range,file.bytes.length);}catch{return reply.code(416).header('Content-Range',`bytes */${file.bytes.length}`).send();}
 if(range){reply.code(206).header('Content-Range',`bytes ${range.start}-${range.end}/${file.bytes.length}`).header('Content-Length',range.end-range.start+1);return reply.send(file.bytes.subarray(range.start,range.end+1));}
 return reply.header('Content-Length',file.bytes.length).send(file.bytes);
}
