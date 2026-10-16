import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {preparePrivacyRecordMinimization as prepare,applyPrivacyRecordMinimization as apply} from './privacy-record-minimization.js';
function fixture(status='PREPARED'){
 const request={jobId:randomUUID(),retentionId:randomUUID(),leaseId:randomUUID()};
 const receipt={schema_version:1,status,batch_id:request.jobId,job_id:request.jobId,workspace_id:'fixture',environment:'REAL',journey_id:randomUUID(),manifest_sha256:'a'.repeat(64),records:2,versions:3,erasure_authorized:false};
 const query=vi.fn().mockResolvedValue({rows:[{receipt}]}),db={workspaceId:'fixture',query};return{request,receipt,query,db};
}
describe('closed native record minimization port',()=>{
 it('passes only authenticated identifiers to one native preparation',async()=>{const f=fixture();expect(await prepare(f.db,f.request)).toEqual(f.receipt);expect(f.query).toHaveBeenCalledExactlyOnceWith('SELECT prepare_privacy_record_minimization($1,$2,$3) receipt',Object.values(f.request));});
 it.each(['MINIMIZED','NO_EFFECT'])('returns %s without claiming complete erasure',async status=>{const f=fixture(status);expect(await apply(f.db,{batchId:f.request.jobId,leaseId:f.request.leaseId})).toEqual(f.receipt);expect(f.query).toHaveBeenCalledExactlyOnceWith('SELECT apply_privacy_record_minimization($1,$2) receipt',[f.request.jobId,f.request.leaseId]);});
 it.each(['workspace_id','batch_id','job_id','environment'])('rejects wrong native %s',async field=>{const f=fixture();Object.assign(f.receipt,{[field]:field.endsWith('_id')&&field!=='workspace_id'?randomUUID():'other'});await expect(prepare(f.db,f.request)).rejects.toThrow();});
 it('rejects false cardinality and a claim of erasure authority',async()=>{for(const patch of[{versions:1},{records:0},{versions:10001},{erasure_authorized:true},{status:'APPLIED'},{unknown:'PRIVATE'}]){const f=fixture();Object.assign(f.receipt,patch);await expect(prepare(f.db,f.request)).rejects.toThrow();}});
 it('validates closed input before SQL and accepts no caller minimum or proof',async()=>{for(const patch of[{jobId:'bad'},{leaseId:''},{body:{}},{authority:true},{manifest_sha256:'a'.repeat(64)}]){const f=fixture();await expect(prepare(f.db,{...f.request,...patch})).rejects.toThrow();expect(f.query).not.toHaveBeenCalled();}});
 it('rejects missing/duplicate native output',async()=>{for(const rows of[[],[{}],[{receipt:{}},{receipt:{}}]]){const f=fixture();f.query.mockResolvedValue({rows});await expect(prepare(f.db,f.request)).rejects.toThrow();}});
 it('does not replay on missing acknowledgement or native rollback',async()=>{const f=fixture();f.query.mockRejectedValue(Error('UNCERTAIN'));await expect(apply(f.db,{batchId:f.request.jobId,leaseId:f.request.leaseId})).rejects.toThrow('UNCERTAIN');expect(f.query).toHaveBeenCalledTimes(1);});
});

describe('legacy trigger extension source custody',()=>{
 const sql=readFileSync(new URL('../profile-transition/033_record_minimization.sql',import.meta.url),'utf8');
 const originals=[['guard_record','../migrations/0036_commercial_lifecycle.sql'],['snapshot_record','../migrations/0001_core.sql'],['immutable_row','../migrations/0009_retention.sql'],['guard_retained_asset_references','../profile-transition/032_financial_retention_custody.sql']];
 it.each(originals)('pins and preserves the entire prior %s body outside its prefix',function(name,path){
  const old=readFileSync(new URL(path,import.meta.url),'utf8').match(new RegExp('CREATE (?:OR REPLACE )?FUNCTION '+name+'\\(\\).*? AS \\$\\$([\\s\\S]*?)\\$\\$;'))![1];
  expect(sql).toContain(createHash('sha256').update(old).digest('hex'));
  const current=sql.match(new RegExp('CREATE OR REPLACE FUNCTION '+name+'\\(\\).*? AS \\$\\$([\\s\\S]*?)\\$\\$;'))![1];
  const split=current.indexOf('BEGIN')+5,tail=current.slice(split),end=tail.indexOf('\n',tail.indexOf('\n')+1);
  expect(current.slice(0,split)+tail.slice(end+1)).toBe(old);
 });
});
