export function validType(type:string,head:Buffer):boolean;
declare const worker:{fetch(request:Request,env:{VERIFIER_TOKEN:string;LIBRARY:{get(key:string):Promise<{size:number;httpMetadata:{contentType:string};body:ReadableStream<Uint8Array>;etag:string}|null>}}):Promise<Response>};
export default worker;
