import {afterEach,describe,expect,it,vi} from 'vitest';
import {registerInvitationIdentity} from './invitation-registration.js';
const input={token:'cos_inv_'+'A'.repeat(43),email:'recipient@example.invalid',name:'Recipient',password:'synthetic-password123'};
const rejected=(code:string,status:number)=>new Response(JSON.stringify({statusCode:status,code,error:status===409?'Conflict':'Forbidden',message:code}),{status});
afterEach(()=>vi.unstubAllGlobals());
describe('invitation registration client',()=>{
 it('sends exactly one same-origin bounded body and accepts only committed201 contract',async()=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({data:{registered:true,loginRequired:true}}),{status:201}));vi.stubGlobal('fetch',fetch);
  expect(await registerInvitationIdentity(input)).toEqual({registered:true,loginRequired:true});expect(fetch).toHaveBeenCalledOnce();
  expect(fetch).toHaveBeenCalledWith('/v2/invitation-registration',expect.objectContaining({method:'POST',credentials:'include',cache:'no-store',referrerPolicy:'no-referrer',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}));
 });
 it.each(['INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED','INVITATION_EXISTING_SESSION_USE_ACCEPTANCE'])('native409 %s directs to login without retry',async code=>{
  const fetch=vi.fn(async()=>rejected(code,409));vi.stubGlobal('fetch',fetch);await expect(registerInvitationIdentity(input)).rejects.toMatchObject({code:'INVITATION_REGISTRATION_LOGIN_REQUIRED'});expect(fetch).toHaveBeenCalledOnce();
 });
 it('recognizes an exact precommit refusal and hides diagnostics',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>rejected('INVITATION_RECIPIENT_MISMATCH',403)));
  await expect(registerInvitationIdentity(input)).rejects.toMatchObject({code:'INVITATION_REGISTRATION_REJECTED'});
 });
 it.each([
  {status:503,value:{statusCode:503,code:'INVITATION_REGISTRATION_OUTCOME_UNCONFIRMED',error:'Unavailable',message:'INVITATION_REGISTRATION_OUTCOME_UNCONFIRMED'}},
  {status:409,value:{statusCode:409,code:'INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED',error:'Conflict',message:input.token}},
  {status:403,value:{statusCode:403,code:'INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED',error:'Forbidden',message:'INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED'}},
  {status:200,value:{data:{registered:true,loginRequired:true}}},
  {status:201,value:{data:{registered:true,loginRequired:true,token:input.token}}},
 ])('unknown or mismatched receipt never authorizes another POST %#',async({status,value})=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify(value),{status}));vi.stubGlobal('fetch',fetch);
  try{await registerInvitationIdentity(input);expect.fail('must reject');}catch(error){expect(error).toMatchObject({code:'INVITATION_REGISTRATION_UNKNOWN'});expect(String(error)).not.toContain(input.token);expect(String(error)).not.toContain(input.password);}
  expect(fetch).toHaveBeenCalledOnce();
 });
 it.each([
  ['INVITATION_EXISTING_IDENTITY_LOGIN_REQUIRED',409,'INVITATION_REGISTRATION_LOGIN_REQUIRED'],
  ['INVITATION_RECIPIENT_MISMATCH',403,'INVITATION_REGISTRATION_REJECTED'],
  ['INVITATION_PROFILE_SUSPENDED',403,'INVITATION_REGISTRATION_REJECTED'],
 ])('canonical application envelope %s retains the exact safe classification',async(code,status,expected)=>{
  const fetch=vi.fn(async()=>new Response(JSON.stringify({error:{code,message:code}}),{status:status as number}));vi.stubGlobal('fetch',fetch);
  await expect(registerInvitationIdentity(input)).rejects.toMatchObject({code:expected});expect(fetch).toHaveBeenCalledOnce();
 });
 it.each([
  {code:'INVITATION_REGISTRATION_OUTCOME_UNCONFIRMED',message:'No se pudo completar la operación.'},
  {code:'INVITATION_RECIPIENT_MISMATCH',message:'INVITATION_RECIPIENT_MISMATCH',details:input.token},
  {code:'INVITATION_RECIPIENT_MISMATCH',message:input.token},
 ])('untrusted canonical error never grants retry %#',async error=>{
  vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify({error}),{status:403})));
  await expect(registerInvitationIdentity(input)).rejects.toMatchObject({code:'INVITATION_REGISTRATION_UNKNOWN'});
 });
 it('connection loss does not retry or echo secrets',async()=>{
  const fetch=vi.fn(async()=>{throw Error(input.password+input.token);});vi.stubGlobal('fetch',fetch);
  await expect(registerInvitationIdentity(input)).rejects.toMatchObject({code:'INVITATION_REGISTRATION_UNKNOWN'});expect(fetch).toHaveBeenCalledOnce();
 });
 it('rejects oversized response without retry',async()=>{
  const fetch=vi.fn(async()=>new Response(' '.repeat(4097)));vi.stubGlobal('fetch',fetch);
  await expect(registerInvitationIdentity(input)).rejects.toMatchObject({code:'INVITATION_REGISTRATION_UNKNOWN'});expect(fetch).toHaveBeenCalledOnce();
 });
 it('invalid input fails before HTTP',async()=>{const fetch=vi.fn();vi.stubGlobal('fetch',fetch);await expect(registerInvitationIdentity({...input,password:'short'})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
});
