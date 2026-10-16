import {describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import type {ProfileExecutor,ProfileQuery} from './profile-context.js';
import {mutateProfileToken} from './profile-token-management.js';
import type {ProfileAuthority} from '../../domain/src/core/profile-authorization.js';
function fixture(){
 const at=new Date('2026-10-12T01:00:00Z'),input={action:'create',operationId:randomUUID(),name:'Synthetic',allowedEnvironments:['REAL'],scopes:['products:read'],expiresAt:new Date(at.getTime()+60000).toISOString(),reason:'Synthetic operation'},id=randomUUID();
 const authority:ProfileAuthority={profile:{id:'one',state:'ACTIVE'},membership:{userId:'user',workspaceId:'one',role:'owner',active:true,version:1},credential:{kind:'session',userId:'user',workspaceId:'one',revoked:false,expiresAt:'2026-10-12T02:00:00Z',membershipVersion:1,scopes:[]}};
 let row:any,op:any,clock=at,advance=0,drift=false;
 const query=vi.fn(async(sql:string,v:any[]=[])=>{
  let rows:any[]=[];
  if(sql==='SELECT clock_timestamp() AS observed_at')rows=[{observed_at:clock}];
  else if(sql.startsWith('SELECT * FROM profile_token_operations'))rows=op?[op]:[];
  else if(sql.startsWith('INSERT INTO personal_access_tokens')){row={id:v[0],user_id:v[2],name:v[3],token_hash:v[4],allowed_environments:JSON.parse(v[5]),profile_scopes:drift?['tokens:write']:JSON.parse(v[6]),expires_at:v[7],revoked_at:null,version:1,created_at:at};rows=[row];}
  else if(sql.startsWith('INSERT INTO profile_token_operations')){op={operation_id:v[1],actor_id:v[2],action:v[3],request_sha256:v[4],token_id:v[5],token_version:v[7],replaced_token_id:v[8],created_at:at};rows=[op];}
  else if(sql.startsWith('INSERT INTO domain_events'))clock=new Date(at.getTime()+advance);
  else throw Error('Unexpected synthetic SQL');
  return{rows,rowCount:rows.length,command:'SELECT',fields:[],oid:0};
 });
 const db:ProfileExecutor={workspaceId:'one',query:query as ProfileQuery};return{db,query,input,authority,id,advance:(ms:number)=>{advance=ms;},drift:()=>{drift=true;},row:()=>row,op:()=>op};
}
describe('profile PAT issuance repository barriers',()=>{
 it('keeps plaintext only in first returned value; persisted token is hash and operation/audit contain no bearer',async()=>{const f=fixture(),result=await mutateProfileToken(f.db,f.authority,f.input);expect(result.token).toMatch(/^cos_pat_[A-Za-z0-9_-]{43}$/);expect(f.row().token_hash).toBe(createHash('sha256').update(result.token!).digest('hex'));expect(JSON.stringify(f.query.mock.calls)).not.toContain(result.token);const replay=await mutateProfileToken(f.db,f.authority,f.input);expect(replay).toEqual({operation:result.operation,token:null,secretDelivered:false});expect(f.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO personal_access_tokens'))).toHaveLength(1);});
 it('rejects final native clock expiry after audit and never returns secret',async()=>{const f=fixture();f.advance(60000);await expect(mutateProfileToken(f.db,f.authority,f.input)).rejects.toMatchObject({code:'PROFILE_TOKEN_EXPIRY_INVALID'});expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO domain_events'))).toBe(true);});
 it('rejects final issuer expiry independently of the grant',async()=>{const f=fixture();f.authority.credential.expiresAt='2026-10-12T01:00:30Z';f.advance(31000);await expect(mutateProfileToken(f.db,f.authority,f.input)).rejects.toMatchObject({code:'PROFILE_CREDENTIAL_INVALID'});});
 it('rejects token metadata drift before operation/audit insertion',async()=>{const f=fixture();f.drift();await expect(mutateProfileToken(f.db,f.authority,f.input)).rejects.toMatchObject({code:'PROFILE_TOKEN_CREATE_UNCONFIRMED'});expect(f.op()).toBeUndefined();});
 it('rejects changed request and changed issuer on operation reuse',async()=>{const f=fixture();await mutateProfileToken(f.db,f.authority,f.input);await expect(mutateProfileToken(f.db,f.authority,{...f.input,name:'Changed'})).rejects.toMatchObject({code:'PROFILE_TOKEN_OPERATION_CONFLICT'});f.authority.membership.userId=f.authority.credential.userId='other';await expect(mutateProfileToken(f.db,f.authority,f.input)).rejects.toMatchObject({code:'PROFILE_TOKEN_OPERATION_CONFLICT'});});
 it('requires PAT native credential identity before mutation',async()=>{const f=fixture();f.authority.credential.kind='personal_token';f.authority.credential.scopes=['tokens:write'];await expect(mutateProfileToken(f.db,f.authority,{action:'revoke',operationId:randomUUID(),tokenId:randomUUID(),expectedVersion:1,reason:'Explicit revocation'})).rejects.toMatchObject({code:'PROFILE_TOKEN_CREDENTIAL_ID_REQUIRED'});expect(f.query.mock.calls).toHaveLength(1);});
});
