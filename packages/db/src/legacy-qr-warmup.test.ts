import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {bindLegacyWarmupEffectOrigins,type LegacyQrAuthority} from './legacy-qr-warmup.js';
import type {QueryExecutor} from './index.js';
function fixture(){
 const first=randomUUID(),second=randomUUID(),effectId=randomUUID(),grant=randomUUID(),adoption=randomUUID(),legacy=randomUUID();
 const values:unknown[][]=[];
 const db={query:async(_sql:string,args:unknown[])=>{values.push(args);return{rows:[]};}} as unknown as QueryExecutor;
 const scope={workspaceId:'own-profile',environment:'REAL' as const,effectId,accountIds:[first,second]};
 // This port copies fixed identifiers only; the authenticated reader is tested in PostgreSQL.
 const adopted={kind:'ADOPTED',adoptionId:adoption,grant:{id:grant},contentIds:[],snapshot:{}} as unknown as LegacyQrAuthority;
 return{first,second,effectId,grant,adoption,legacy,values,db,scope,adopted};
}
describe('immutable participant source binding port',()=>{
 it('keeps adopted and temporal origins distinct in a mixed conversation',async()=>{
  const f=fixture();await bindLegacyWarmupEffectOrigins(f.db,f.scope,new Map([[f.first,f.adopted],[f.second,{kind:'LEGACY'}]]),f.legacy);
  expect(f.values).toHaveLength(2);expect(f.values.find(x=>x[3]===f.first)).toEqual([f.effectId,'own-profile','REAL',f.first,f.adoption,f.grant,null]);
  expect(f.values.find(x=>x[3]===f.second)).toEqual([f.effectId,'own-profile','REAL',f.second,null,null,f.legacy]);
 });
 it('does not attach a later adoption to an entirely temporal conversation',async()=>{
  const f=fixture();await bindLegacyWarmupEffectOrigins(f.db,f.scope,new Map([[f.first,{kind:'LEGACY'}],[f.second,{kind:'LEGACY'}]]),f.legacy);expect(f.values).toEqual([]);
 });
 it('does not let an adopted participant supply the missing temporal permission of its peer',async()=>{
  const f=fixture();await expect(bindLegacyWarmupEffectOrigins(f.db,f.scope,new Map([[f.first,f.adopted],[f.second,{kind:'LEGACY'}]]),null)).rejects.toThrow('QR_EFFECT_PARTICIPANT_AUTHORITY_REQUIRED');
 });
 it('rejects a blocked peer even when a temporal permission remains available',async()=>{
  const f=fixture();await expect(bindLegacyWarmupEffectOrigins(f.db,f.scope,new Map([[f.first,f.adopted],[f.second,{kind:'BLOCKED',reason:'REVOKED'}]]),f.legacy)).rejects.toThrow('QR_EFFECT_PARTICIPANT_BLOCKED');
 });
 it('rejects duplicate or oversized participant lists rather than seal partial membership',async()=>{
  const f=fixture();for(const ids of [[f.first,f.first],Array.from({length:21},(_,i)=>i?randomUUID():f.first)])await expect(bindLegacyWarmupEffectOrigins(f.db,{...f.scope,accountIds:ids},new Map([[f.first,f.adopted]]),f.legacy)).rejects.toThrow('QR_EFFECT_PARTICIPANTS_REQUIRED');expect(f.values).toEqual([]);
 });
});
