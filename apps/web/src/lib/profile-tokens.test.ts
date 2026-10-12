import {afterEach,describe,expect,it,vi} from 'vitest';
import {loadProfileTokens,mutateProfileToken,readProfileTokenOperation,ProfileTokenRequestError} from './profile-tokens.js';
const id=(n=1)=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const fence={workspaceId:'profile-text',version:4};
const command={action:'create',operationId:id(),environment:'REAL',reason:'Prueba acotada',name:'Integración',allowedEnvironments:['REAL'],scopes:['products:read'],expiresAt:'2026-10-20T00:00:00Z'};
const operation={id:id(),action:'create',tokenId:id(2),tokenVersion:1,replacedTokenId:null,createdAt:'2026-10-12T00:00:00Z'};
const token='cos_pat_'+'x'.repeat(43);
const row={id:id(2),userId:'user-text',name:'Integración',allowedEnvironments:['REAL'],scopes:['products:read'],expiresAt:command.expiresAt,revokedAt:null,version:1,createdAt:operation.createdAt};
function mock(value:unknown,status=200){const mockedFetch=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(value),{status}));vi.stubGlobal('fetch',mockedFetch);return mockedFetch;}
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('profile token browser transport',()=>{
 it('uses one POST with fixed cookie identity/fence, a canonical command and a one-time secret',async()=>{
  const fetch=mock({data:{operation,token,secretDelivered:true}},201);const input={...command,allowedEnvironments:['SIMULATION','REAL'],scopes:['usage:read','products:read']};
  const result=await mutateProfileToken(fence,input);expect(result.token).toBe(token);expect(fetch).toHaveBeenCalledTimes(1);
  const [path,options]=fetch.mock.calls[0] as unknown as [string,RequestInit];expect(path).toBe('/v2/tokens/operations');expect(options).toMatchObject({method:'POST',credentials:'include',redirect:'error',cache:'no-store',headers:{'x-commerce-profile-id':'profile-text','x-commerce-profile-version':'4','Content-Type':'application/json'}});
  expect(JSON.parse(String(options.body))).toMatchObject({scopes:['products:read','usage:read'],allowedEnvironments:['REAL','SIMULATION']});expect(input.scopes).toEqual(['usage:read','products:read']);expect(options.headers).not.toHaveProperty('Authorization');
 });
 it('accepts metadata-only replay without claiming a second secret',async()=>{mock({data:{operation,token:null,secretDelivered:false}});expect((await mutateProfileToken(fence,command)).secretDelivered).toBe(false);});
 it('never repeats a POST after a transport failure',async()=>{const fetch=vi.fn().mockRejectedValue(Error('private transport'));vi.stubGlobal('fetch',fetch);await expect(mutateProfileToken(fence,command)).rejects.toMatchObject({knownRejected:false});expect(fetch).toHaveBeenCalledTimes(1);});
 it.each([408,500,502,504])('does not reclassify uncertain HTTP %s as a rejection',async status=>{const fetch=mock({error:{code:'PROFILE_TOKEN_VERSION_CONFLICT'}},status);await expect(mutateProfileToken(fence,command)).rejects.toMatchObject({knownRejected:false});expect(fetch).toHaveBeenCalledTimes(1);});
 it('allowlists a known rejection but requires its exact status/code',async()=>{mock({error:{code:'PROFILE_TOKEN_VERSION_CONFLICT'}},409);await expect(mutateProfileToken(fence,command)).rejects.toMatchObject({knownRejected:true});mock({error:{code:'PROFILE_TOKEN_VERSION_CONFLICT'}},403);await expect(mutateProfileToken(fence,command)).rejects.toMatchObject({knownRejected:false});});
 it('recognizes only the canonical legacy version conflict envelope',async()=>{mock({error:{code:'VERSION_CONFLICT',message:'PROFILE_TOKEN_VERSION_CONFLICT'}},409);await expect(mutateProfileToken(fence,command)).rejects.toMatchObject({knownRejected:true});mock({error:{code:'VERSION_CONFLICT',message:'other'}},409);await expect(mutateProfileToken(fence,command)).rejects.toMatchObject({knownRejected:false});});
 it.each([
  {operation:{...operation,id:id(9)},token,secretDelivered:true},
  {operation:{...operation,action:'rotate'},token,secretDelivered:true},
  {operation:{...operation,tokenVersion:2},token,secretDelivered:true},
  {operation:{...operation,replacedTokenId:id(9)},token,secretDelivered:true},
  {operation,token:null,secretDelivered:true},
 ])('rejects a mismatched operation or secret result after a single POST',async result=>{const fetch=mock({data:result});await expect(mutateProfileToken(fence,command)).rejects.toBeInstanceOf(ProfileTokenRequestError);expect(fetch).toHaveBeenCalledTimes(1);});
 it('binds rotation to the replaced token and revoke to its exact CAS result',async()=>{
  const rotated={...command,action:'rotate',tokenId:id(3),expectedVersion:2};mock({data:{operation:{...operation,action:'rotate',replacedTokenId:id(3)},token,secretDelivered:true}});expect((await mutateProfileToken(fence,rotated)).token).toBe(token);
  mock({data:{operation:{...operation,action:'rotate',replacedTokenId:id(4)},token,secretDelivered:true}});await expect(mutateProfileToken(fence,rotated)).rejects.toBeInstanceOf(ProfileTokenRequestError);
  const revoked={action:'revoke',operationId:id(),reason:command.reason,tokenId:id(3),expectedVersion:2};mock({data:{operation:{...operation,action:'revoke',tokenId:id(3),tokenVersion:3},token:null,secretDelivered:false}});expect((await mutateProfileToken(fence,revoked)).token).toBeNull();
  mock({data:{operation:{...operation,action:'revoke',tokenId:id(3),tokenVersion:2},token:null,secretDelivered:false}});await expect(mutateProfileToken(fence,revoked)).rejects.toBeInstanceOf(ProfileTokenRequestError);
 });
 it('operation lookup is exact and only its known 404 means absent',async()=>{let fetch=mock({data:operation});expect(await readProfileTokenOperation(fence,id().toUpperCase())).toEqual(operation);expect(fetch.mock.calls[0]?.[0]).toBe('/v2/tokens/operations/'+id());mock({data:{...operation,id:id(5)}});await expect(readProfileTokenOperation(fence,id())).rejects.toBeInstanceOf(ProfileTokenRequestError);mock({error:{code:'PROFILE_TOKEN_OPERATION_NOT_FOUND'}},404);expect(await readProfileTokenOperation(fence,id())).toBeNull();fetch=mock({error:{code:'NOT_FOUND'}},404);await expect(readProfileTokenOperation(fence,id())).rejects.toMatchObject({knownRejected:false});expect(fetch).toHaveBeenCalledTimes(1);});
 it('lists bounded metadata without accepting duplicates, excess rows or false pagination',async()=>{const fetch=mock({data:[row],meta:{limit:20,offset:20,hasMore:false}});expect((await loadProfileTokens(fence,20)).data).toEqual([row]);expect(fetch.mock.calls[0]?.[0]).toBe('/v2/tokens?limit=20&offset=20');for(const data of [[row,row],Array.from({length:21},(_,i)=>({...row,id:id(i+1)}))]){mock({data,meta:{limit:20,offset:0,hasMore:false}});await expect(loadProfileTokens(fence)).rejects.toBeInstanceOf(ProfileTokenRequestError);}mock({data:[row],meta:{limit:20,offset:0,hasMore:true}});await expect(loadProfileTokens(fence)).rejects.toBeInstanceOf(ProfileTokenRequestError);});
 it('does not expose an unexpected secret or server error in thrown text',async()=>{mock({data:{operation,token,secretDelivered:true,secret:'DO_NOT_ECHO'}});await expect(mutateProfileToken(fence,command)).rejects.toThrow('No se confirmó');mock({error:{code:'UNEXPECTED',message:'DO_NOT_ECHO'}},500);await expect(mutateProfileToken(fence,command)).rejects.not.toThrow('DO_NOT_ECHO');});
 it('caps the body and keeps a large success response uncertain',async()=>{const fetch=vi.fn(async()=>new Response('x'.repeat(1048577)));vi.stubGlobal('fetch',fetch);await expect(mutateProfileToken(fence,command)).rejects.toMatchObject({knownRejected:false});expect(fetch).toHaveBeenCalledTimes(1);});
 it('rejects caller selectors and absent profile before network',async()=>{const fetch=mock({});await expect(mutateProfileToken(fence,{...command,workspaceId:'other'})).rejects.toThrow();await expect(loadProfileTokens({workspaceId:'',version:0})).rejects.toThrow();await expect(loadProfileTokens(fence,10001)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();});
});
