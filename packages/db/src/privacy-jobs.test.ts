import {describe,it,expect,vi} from 'vitest';
import {preparePrivacyJob} from './privacy-jobs.js';
const id='10000000-0000-4000-8000-000000000001',journey='20000000-0000-4000-8000-000000000002',backup='30000000-0000-4000-8000-000000000003';
const request={workspaceId:'privacy-test',jobId:id,journeyId:journey,sourceVersion:2,backupId:backup};
function fixture(result:unknown={status:'INVENTORIED',job_id:id,manifest_sha256:'a'.repeat(64),erasure_authorized:false}){
 const calls:string[]=[];const query=vi.fn(async(sql:string)=>{calls.push(sql);return{command:sql==='COMMIT'?'COMMIT':undefined,rows:sql.includes('fence_acquire')?[{receipt:{lease_id:id}}]:sql.includes('prepare_privacy_job')?[{receipt:result}]:[]};});
 const release=vi.fn(),connect=vi.fn(async()=>({query,release}));return{calls,query,release,connect,pool:{connect}as any};
}
describe('D18 preparation port never accepts erasure authority',()=>{
 it('pins job identity and passes only UUIDs/version to SQL after dedicated fence',async()=>{const f=fixture(),r=await preparePrivacyJob(f.pool,request);expect(r.status).toBe('INVENTORIED');expect(f.query).toHaveBeenCalledWith('SELECT prepare_privacy_job($1,$2,$3,$4,$5) receipt',[id,journey,2,backup,id]);expect(f.calls.indexOf('SET LOCAL ROLE commerce_privacy_job_worker')).toBeGreaterThan(f.calls.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ'));expect(f.release).toHaveBeenCalledExactlyOnceWith(true);});
 it('rejects caller-provided proof booleans before acquiring a connection',async()=>{const f=fixture();await expect(preparePrivacyJob(f.pool,{...request,restore_verified:true}as any)).rejects.toThrow();expect(f.connect).not.toHaveBeenCalled();});
 it('rejects malformed UUID/version before a database operation',async()=>{for(const patch of[{jobId:'invalid'},{journeyId:'invalid'},{sourceVersion:0},{sourceVersion:2.1},{backupId:'invalid'}]){const f=fixture();await expect(preparePrivacyJob(f.pool,{...request,...patch})).rejects.toThrow();expect(f.connect).not.toHaveBeenCalled();}});
 it('treats an erasure-authorized receipt as invalid, rolls back and destroys session',async()=>{const f=fixture({status:'INVENTORIED',job_id:id,manifest_sha256:'a'.repeat(64),erasure_authorized:true});await expect(preparePrivacyJob(f.pool,request)).rejects.toThrow();expect(f.calls.at(-1)).toBe('ROLLBACK');expect(f.calls.some(s=>s.includes('fence_advance'))).toBe(false);expect(f.release).toHaveBeenCalledExactlyOnceWith(true);});
 it('rejects a receipt for another job without committing',async()=>{const f=fixture({status:'INVENTORIED',job_id:journey,manifest_sha256:'a'.repeat(64),erasure_authorized:false});await expect(preparePrivacyJob(f.pool,request)).rejects.toThrow('RECEIPT_IDENTITY');expect(f.calls).not.toContain('COMMIT');});
 it('preserves no-effect and never treats it as erasure complete',async()=>{const f=fixture({status:'NO_EFFECT',job_id:id,manifest_sha256:'a'.repeat(64),erasure_authorized:false});expect((await preparePrivacyJob(f.pool,request)).status).toBe('NO_EFFECT');expect(f.calls.filter(s=>s.includes('prepare_privacy_job'))).toHaveLength(1);});
 it('rejects extra payload returned by a drifted database port',async()=>{const f=fixture({status:'INVENTORIED',job_id:id,manifest_sha256:'a'.repeat(64),erasure_authorized:false,content:'PRIVATE'});await expect(preparePrivacyJob(f.pool,request)).rejects.toThrow();expect(f.calls.at(-1)).toBe('ROLLBACK');});
});
