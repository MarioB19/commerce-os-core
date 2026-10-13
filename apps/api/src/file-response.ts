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
