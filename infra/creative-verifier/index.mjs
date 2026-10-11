import {createHash,timingSafeEqual} from 'node:crypto';
const digest=v=>createHash('sha256').update(v).digest();
export function validType(type,head){
 if(type==='video/mp4'||type==='audio/mp4')return head.subarray(4,8).toString()==='ftyp';
 if(type==='image/png')return head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 if(type==='image/jpeg')return head[0]===255&&head[1]===216&&head[2]===255;
 if(type==='image/webp')return head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WEBP';
 if(type==='audio/wav')return head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WAVE';
 if(type==='audio/mpeg')return head.subarray(0,3).toString()==='ID3'||head[0]===255&&(head[1]&224)===224;
 if(type==='font/woff2')return head.subarray(0,4).toString()==='wOF2';
 if(['text/plain','application/x-subrip','application/json'].includes(type))return !head.includes(0);
 return false;
}
async function readBounded(stream,max){if(!stream)throw new Error('MISSING_BODY');const reader=stream.getReader(),parts=[];let count=0;for(;;){const {done,value}=await reader.read();if(done)break;count+=value.length;if(count>max){await reader.cancel();throw new Error('INPUT_LIMIT');}parts.push(value);}return Buffer.concat(parts).toString('utf8');}
export default {async fetch(request,env){
 const deny=(code,status=400)=>Response.json({error:code},{status,headers:{'Cache-Control':'no-store'}});
 if(request.method!=='POST'||!env.VERIFIER_TOKEN||!timingSafeEqual(digest(request.headers.get('authorization')??''),digest(`Bearer ${env.VERIFIER_TOKEN}`)))return deny('UNAUTHORIZED',401);
 if(Number(request.headers.get('content-length'))>2048)return deny('INPUT_LIMIT',413);
 let b;try{b=JSON.parse(await readBounded(request.body,2048));}catch(error){return deny(error.message==='INPUT_LIMIT'?'INPUT_LIMIT':'INVALID_JSON',error.message==='INPUT_LIMIT'?413:400);}
 if(!b||typeof b!=='object'||!/^commerce\/[a-f0-9]{64}\/(REAL|SIMULATION)\/(staging\/[a-f0-9-]{36}|objects\/[a-f0-9-]{36}\/[a-f0-9]{64})$/.test(b.key)||!Number.isSafeInteger(b.expectedBytes)||b.expectedBytes<1||b.expectedBytes>500*1024*1024||!/^[a-f0-9]{64}$/.test(b.expectedSha256))return deny('INVALID_OBJECT');
 const isText=['text/plain','application/x-subrip','application/json'].includes(b.expectedType);
 // Text artifacts are small; enforce a real bound before collecting text for JSON/UTF-8 validation.
 if(isText&&b.expectedBytes>1024*1024)return deny('TEXT_LIMIT',413);
 const object=await env.LIBRARY.get(b.key);if(!object)return deny('NOT_FOUND',404);
 if(object.size!==b.expectedBytes||object.httpMetadata?.contentType!==b.expectedType){await object.body?.cancel();return deny('OBJECT_METADATA_MISMATCH',409);}
 const sha=createHash('sha256'),reader=object.body.getReader();let bytes=0,head=Buffer.alloc(0),text='';const decoder=isText?new TextDecoder('utf-8',{fatal:true}):null;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>b.expectedBytes){await reader.cancel();return deny('OVERSIZED',413);}sha.update(value);if(head.length<4096)head=Buffer.concat([head,Buffer.from(value).subarray(0,4096-head.length)]);if(decoder)text+=decoder.decode(value,{stream:true});}if(decoder){text+=decoder.decode();if(text.includes('\0'))return deny('INVALID_TEXT',409);if(b.expectedType==='application/json')JSON.parse(text);}}
 catch{await reader.cancel().catch(()=>{});return deny('INVALID_OBJECT_STREAM',409);}
 const hash=sha.digest('hex');if(bytes!==b.expectedBytes||hash!==b.expectedSha256||!validType(b.expectedType,head))return deny('OBJECT_BYTES_MISMATCH',409);
 return Response.json({verified:true,key:b.key,bytes,sha256:hash,contentType:b.expectedType,etag:object.etag,checkedAt:new Date().toISOString(),verifierVersion:'1.0.1'},{headers:{'Cache-Control':'no-store'}});
}};
