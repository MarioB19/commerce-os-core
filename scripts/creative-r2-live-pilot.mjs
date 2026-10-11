import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {S3Client,CreateMultipartUploadCommand,UploadPartCommand,ListPartsCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand,HeadObjectCommand,CopyObjectCommand,DeleteObjectCommand,GetObjectCommand,GetBucketCorsCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {chromium,webkit} from '@playwright/test';
const origin='https://commerce-os.inovaris.online',endpoint='https://4f989c72e8e99294ecd574fae1a0dcce.r2.cloudflarestorage.com',bucket='commerce-os-creative-v1',verifier='https://commerce-library-verifier.brandonmuro-dev.workers.dev';
const root=join(homedir(),'.config/commerce-os-creative'),hash=b=>createHash('sha256').update(b).digest('hex');
const report={started_at:new Date().toISOString(),scope:'REAL_R2_ISOLATED_STORAGE_PILOT',application_authorization_test:false,checks:[],bytes_uploaded:0,objects_retained:0};
function check(code,details={}){report.checks.push({code,status:'PASS',...details});console.log(JSON.stringify({code,status:'PASS'}));}
async function secret(name){const p=join(root,name);assert.equal((await stat(p)).mode&0o077,0);return(await readFile(p,'utf8')).trim();}
if(!process.argv.includes('--execute-pilot')){console.log('Use --execute-pilot --source <approved MP4 preview>; bounded 20MiB input, one isolated multipart object, no paid text/voice calls.');process.exit(0);}
const browserTransport=!process.argv.includes('--node-transport');report.transport=browserTransport?'BROWSER':'NODE';
const browserName=process.argv.includes('--webkit')?'webkit':'chromium';report.browser=browserTransport?browserName:null;
const source=process.argv[process.argv.indexOf('--source')+1];assert.ok(source&&process.argv.includes('--source'));const sourceStat=await stat(source);assert.ok(sourceStat.size>1&&sourceStat.size<=20*1024*1024);const bytes=await readFile(source),sha=hash(bytes);assert.equal(bytes.subarray(4,8).toString(),'ftyp');
const client=new S3Client({region:'auto',endpoint,credentials:{accessKeyId:await secret('r2-access-key-id'),secretAccessKey:await secret('r2-secret-access-key')},maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'}),token=await secret('r2-verifier-token');
const prefix=`commerce/${hash('commerce-v1-isolated-r2-pilot')}/REAL`,staging=`${prefix}/staging/${randomUUID()}`,final=`${prefix}/objects/${randomUUID()}/${sha}`;let uploadId,browser,page,completed=false;
async function getEvidence(url,options={}){
 if(!browserTransport){const r=await fetch(url,{method:options.method??'GET',headers:options.range?{Range:options.range}:undefined});let data;if(options.sha||options.body)data=Buffer.from(await r.arrayBuffer());else await r.body?.cancel();return{status:r.status,length:Number(r.headers.get('content-length')),bodyLength:data?.length,sha256:options.sha?hash(data):undefined};}
 return page.evaluate(async({url,options})=>{const r=await fetch(url,{method:options.method??'GET',headers:options.range?{Range:options.range}:undefined});let data;if(options.sha||options.body)data=await r.arrayBuffer();else await r.body?.cancel();const digest=options.sha?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join(''):undefined;return{status:r.status,length:Number(r.headers.get('content-length')),bodyLength:data?.byteLength,sha256:digest};},{url,options});
}
const save=async()=>{report.finished_at=new Date().toISOString();await mkdir('docs/evidence/creative-v1',{recursive:true});await writeFile('docs/evidence/creative-v1/r2-live-pilot'+(browserTransport?(browserName==='webkit'?'-webkit':''):'-node')+'.json',JSON.stringify(report,null,2)+'\n');};
async function errorEvidence(url,options,expectedStatus){
 try{return {...await getEvidence(url,options),status_source:browserTransport?'BROWSER':'NODE'};}
 catch(error){
  if(!browserTransport)throw error;
  // R2 error responses can be opaque to browser JavaScript. Keep that denial
  // explicit; a separate request confirms HTTP status, never browser readability.
  const response=await fetch(url,{headers:options.range?{Range:options.range}:undefined});
  await response.body?.cancel();assert.equal(response.status,expectedStatus);
  return {status:null,http_confirmation_status:response.status,status_source:'NODE_CONFIRMATION_AFTER_BROWSER_NETWORK_DENIAL',browser_response_readable:false};
 }
}
try{
 const denied=await fetch(verifier,{method:'POST',body:'{}'});assert.equal(denied.status,401);check('VERIFIER_AUTH_REQUIRED');
 try{const cors=await client.send(new GetBucketCorsCommand({Bucket:bucket}));assert.deepEqual(cors.CORSRules?.[0]?.AllowedOrigins,[origin]);check('CORS_EXACT_ORIGIN');}catch(error){if(error.$metadata?.httpStatusCode!==403)throw error;report.checks.push({code:'CORS_ADMIN_READ',status:'DENIED_AS_EXPECTED',reason:'Object-only credential; independently configured through admin CLI'});}
 const unsigned=await fetch(`${endpoint}/${bucket}/unlisted-private-object`);assert.ok([400,401,403].includes(unsigned.status));await unsigned.body?.cancel();check('UNSIGNED_ACCESS_DENIED',{http_status:unsigned.status});
 uploadId=(await client.send(new CreateMultipartUploadCommand({Bucket:bucket,Key:staging,ContentType:'video/mp4'}))).UploadId;assert.ok(uploadId);
 const part=await getSignedUrl(client,new UploadPartCommand({Bucket:bucket,Key:staging,UploadId:uploadId,PartNumber:1,ContentLength:bytes.length}),{expiresIn:600,signableHeaders:new Set(['content-length'])});
 // A real browser sends its own Content-Length; JavaScript cannot set this forbidden header.
 if(browserTransport){browser=await (browserName==='webkit'?webkit:chromium).launch({headless:true});page=await browser.newPage();await page.goto(origin,{waitUntil:'domcontentloaded'});}
 const bad=browserTransport?await page.evaluate(async({url,data})=>{const b=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const response=await fetch(url,{method:'PUT',body:new Blob([b,new Uint8Array([0])])});await response.body?.cancel();return response.status;},{url:part,data:bytes.toString('base64')}).catch(()=>0):(await fetch(part,{method:'PUT',body:Buffer.concat([bytes,Buffer.from([0])])})).status;assert.ok([0,403].includes(bad));assert.equal((await client.send(new ListPartsCommand({Bucket:bucket,Key:staging,UploadId:uploadId}))).Parts?.length??0,0);check('OVERSIZE_SIGNED_LENGTH_REJECTED',{http_status:bad||null,browser_network_denial:bad===0});
 const put=browserTransport?await page.evaluate(async({url,data})=>{const b=Uint8Array.from(atob(data),c=>c.charCodeAt(0));const response=await fetch(url,{method:'PUT',body:new Blob([b])});await response.body?.cancel();return {status:response.status,etag:response.headers.get('etag')};},{url:part,data:bytes.toString('base64')}):await (async()=>{const r=await fetch(part,{method:'PUT',body:bytes});await r.body?.cancel();return{status:r.status,etag:r.headers.get('etag')};})();assert.equal(put.status,200);assert.ok(put.etag);report.bytes_uploaded=bytes.length;check(browserTransport?'BROWSER_UPLOAD_SIGNED_LENGTH_AND_CORS':'NODE_UPLOAD_SIGNED_LENGTH',{bytes:bytes.length});
 const listed=await client.send(new ListPartsCommand({Bucket:bucket,Key:staging,UploadId:uploadId}));assert.equal(listed.Parts?.length,1);assert.equal(listed.Parts[0].Size,bytes.length);
 await client.send(new CompleteMultipartUploadCommand({Bucket:bucket,Key:staging,UploadId:uploadId,MultipartUpload:{Parts:listed.Parts.map(x=>({PartNumber:x.PartNumber,ETag:x.ETag}))}}));completed=true;
 const verify=async key=>{const response=await fetch(verifier,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({key,expectedBytes:bytes.length,expectedSha256:sha,expectedType:'video/mp4'}),signal:AbortSignal.timeout(120000)});assert.equal(response.status,200);const receipt=await response.json();assert.equal(receipt.verified,true);assert.equal(receipt.sha256,sha);assert.equal(receipt.bytes,bytes.length);return receipt.verifierVersion;};
 check('REMOTE_STREAM_SHA_VERIFIED',{sha256:sha,verifier_version:await verify(staging)});
 const head=await client.send(new HeadObjectCommand({Bucket:bucket,Key:staging}));await client.send(new CopyObjectCommand({Bucket:bucket,Key:final,CopySource:`${bucket}/${staging}`,CopySourceIfMatch:head.ETag,MetadataDirective:'REPLACE',ContentType:'video/mp4'}));await verify(final);check('FINAL_SERVER_COPY_VERIFIED');
 const stale=await fetch(part,{method:'PUT',body:bytes});assert.equal(stale.status,404);await stale.body?.cancel();check('OLD_PART_URL_CANNOT_CHANGE_FINAL');
 const access=await getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:final}),{expiresIn:300}),headUrl=await getSignedUrl(client,new HeadObjectCommand({Bucket:bucket,Key:final}),{expiresIn:300});
 const hr=await getEvidence(headUrl,{method:'HEAD'});assert.equal(hr.status,200);assert.equal(hr.length,bytes.length);check('SIGNED_HEAD_SIZE');
 const range=await getEvidence(access,{range:'bytes=100-199',body:true});assert.equal(range.status,206);assert.equal(range.bodyLength,100);check('RANGE_206');
 const outside=await errorEvidence(access,{range:`bytes=${bytes.length+100}-`},416);assert.equal(outside.status??outside.http_confirmation_status,416);check('RANGE_416',outside);
 const download=await getEvidence(access,{sha:true});assert.equal(download.status,200);assert.equal(download.sha256,sha);check('DOWNLOAD_SHA_MATCH');
 if(browserTransport){const seek=await page.evaluate(async url=>{const v=document.createElement('video');v.muted=true;v.preload='metadata';document.body.append(v);try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('MEDIA_SEEK_TIMEOUT')),20000);v.onerror=()=>{clearTimeout(timer);reject(Error('MEDIA_DECODE_ERROR'));};v.onloadedmetadata=()=>{v.currentTime=Math.min(20,v.duration/2);};v.onseeked=()=>{clearTimeout(timer);resolve({duration:v.duration,currentTime:v.currentTime,videoWidth:v.videoWidth,videoHeight:v.videoHeight});};v.src=url;});}finally{v.pause();v.removeAttribute('src');v.load();v.remove();}},access);assert.ok(seek.currentTime>1&&seek.videoHeight===960);check('BROWSER_VIDEO_SEEK',seek);}
 if(browserTransport){const aborted=await page.evaluate(async url=>{const cancel=new AbortController(),r=await fetch(url,{signal:cancel.signal});cancel.abort();try{await r.arrayBuffer();return false;}catch(error){return error.name==='AbortError';}},access);assert.equal(aborted,true);}else{const cancel=new AbortController(),response=await fetch(access,{signal:cancel.signal});cancel.abort();await assert.rejects(()=>response.arrayBuffer());}check('DOWNLOAD_CANCELLATION');
 const expiring=await getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:final}),{expiresIn:1});await new Promise(resolve=>setTimeout(resolve,2200));const expired=await errorEvidence(expiring,{},403);assert.equal(expired.status??expired.http_confirmation_status,403);const renewed=await getEvidence(await getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:final}),{expiresIn:300}));assert.equal(renewed.status,200);check('EXPIRED_ACCESS_RENEWED',{expired,renewed:{status:renewed.status,status_source:browserTransport?'BROWSER':'NODE'}});
 report.status='PASS';
}catch(error){report.status='FAILED';report.error={name:error.name,code:error.code??null,message:String(error.message).replace(/https?:\/\/\S+/g,'[PRIVATE_URL]').slice(0,300)};console.error(JSON.stringify(report.error));process.exitCode=1;}
finally{await browser?.close();await cleanupPilot();await save();client.destroy();}
async function cleanupPilot(){try{if(uploadId&&!completed)await client.send(new AbortMultipartUploadCommand({Bucket:bucket,Key:staging,UploadId:uploadId}));for(const key of [staging,final]){await client.send(new DeleteObjectCommand({Bucket:bucket,Key:key}));try{await client.send(new HeadObjectCommand({Bucket:bucket,Key:key}));throw Error('PILOT_OBJECT_NOT_REMOVED');}catch(error){if(error.$metadata?.httpStatusCode!==404)throw error;}}check('OWN_PILOT_OBJECTS_CLEANED');}catch(error){report.cleanup_error={name:error.name,code:error.code??null};process.exitCode=1;report.status='FAILED';}}
