import {createHash} from 'node:crypto';

const fail=code=>Object.assign(new Error(code),{code});
const sha=value=>createHash('sha256').update(value).digest('hex');
export function sessionCookies(origin,cookie){
 const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||typeof cookie!=='string'||!cookie)throw fail('BROWSER_SESSION_REQUIRED');
 return cookie.split(';').map(part=>{const index=part.indexOf('='),name=part.slice(0,index).trim(),value=part.slice(index+1).trim();if(index<1||!name||!value||/[\s;,]/.test(name)||/[\r\n]/.test(value))throw fail('BROWSER_SESSION_INVALID');return{name,value,url:origin,secure:true,httpOnly:true,sameSite:'Lax'};});
}

// This browser loads the published page and uses its actual CSP/CORS/TLS policies.
// No route interception, page.setContent, disabled web security, CSP bypass or persisted browser profile.
export async function createBrowserUploadTransport(options,auth){
 const {chromium}=await import('@playwright/test');
 const cookies=sessionCookies(options.origin,auth.Cookie),browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({ignoreHTTPSErrors:false,bypassCSP:false});await context.addCookies(cookies);
  const page=await context.newPage(),response=await page.goto(options.origin+'/studio',{waitUntil:'domcontentloaded',timeout:60000});
  if(!response?.ok()||new URL(page.url()).origin!==options.origin)throw fail('BROWSER_PUBLISHED_PAGE_REQUIRED');
  const policy=response.headers()['content-security-policy'];if(!policy)throw fail('BROWSER_PUBLISHED_CSP_REQUIRED');
  const identity=await page.evaluate(async()=>{const response=await fetch('/v1/me?environment=REAL',{credentials:'same-origin',redirect:'error',signal:AbortSignal.timeout(30000)});if(!response.ok)return null;const body=await response.json();return{user_id:body.data?.user?.id,workspace_id:body.data?.workspace_id};});
  if(!identity?.user_id||identity.user_id!==options.identity.user_id||identity.workspace_id!==options.identity.workspace_id)throw fail('BROWSER_IDENTITY_MISMATCH');
  const evidence={transport:'BROWSER_CHROMIUM',origin:options.origin,browser_version:browser.version(),csp_sha256:sha(policy),tls_verification:true,csp_bypass:false};
  return{kind:'BROWSER_CHROMIUM',evidence,close:()=>browser.close(),async put(url,bytes){
   if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>16*1024*1024)throw fail('BROWSER_PART_SIZE_INVALID');
   // The URL is ephemeral and stays in memory. A Blob lets Chromium set its exact Content-Length.
   let result;try{result=await page.evaluate(async({origin,url,base64,expectedHash})=>{
    if(location.origin!==origin)throw new Error('BROWSER_ORIGIN_CHANGED');
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('');
    if(hash!==expectedHash)throw new Error('BROWSER_PART_HASH_MISMATCH');
    const response=await fetch(url,{method:'PUT',body:new Blob([bytes]),mode:'cors',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(120000)});
    await response.body?.cancel();return{ok:response.ok,status:response.status,sha256:hash,bytes:bytes.length};
   },{origin:options.origin,url,base64:bytes.toString('base64'),expectedHash:sha(bytes)});}catch{throw fail('BROWSER_R2_TRANSPORT_OR_POLICY_UNKNOWN');}
   return{...result,body:null};
  }};
 }catch(error){await browser.close();if(/^[A-Z0-9_]+$/.test(error.code??''))throw error;throw fail('BROWSER_PUBLISHED_CONTEXT_FAILED');}
}
