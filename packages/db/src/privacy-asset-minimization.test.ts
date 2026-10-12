import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {preparePrivacyAssetMinimization,applyPrivacyAssetMinimization} from './privacy-asset-minimization.js';
import {privateFileManifestHash} from './privacy-file-custody.js';
const job=randomUUID(),opaque=randomUUID(),lease=randomUUID(),reference=randomUUID(),workspace='asset_fixture',sha='a'.repeat(64);
const input={jobId:job,opaquePassId:opaque,profileLeaseId:lease,referenceLeaseId:reference};
function candidate(){return{schema_version:1,job_id:job,workspace_id:workspace,plan_sha256:sha,inventory_sha256:sha,backup_fence_sha256:sha,backup_id:randomUUID(),restore_sha256:sha,backup_snapshot_unix_ns:'1000000000',candidate_sha256:sha,observed_at:new Date().toISOString(),valid_until:new Date(Date.now()+60000).toISOString(),files:[],erasure_authorized:false};}
function done(){return{schema_version:1,status:'MINIMIZED',batch_id:job,job_id:job,workspace_id:workspace,environment:'REAL',journey_id:randomUUID(),manifest_sha256:sha,file_manifest_sha256:sha,assets:1,versions:2,files:1,erasure_authorized:false};}
const db=(value:unknown)=>({workspaceId:workspace,query:vi.fn().mockResolvedValue({rows:[{receipt:value}]})});
describe('038 closed native asset ports',()=>{
 it('passes only identity and both native leases',async()=>{const c=candidate(),d=db(c);expect(await preparePrivacyAssetMinimization(d,input)).toEqual(c);expect(d.query).toHaveBeenCalledExactlyOnceWith('SELECT prepare_privacy_asset_minimization($1,$2,$3,$4) receipt',[job,opaque,lease,reference]);});
 it.each(['assets','files','storage_key','source_sha256','classification','erasure_authorized'])('rejects caller %s before SQL',async key=>{const d=db(candidate());await expect(preparePrivacyAssetMinimization(d,{...input,[key]:true})).rejects.toThrow();expect(d.query).not.toHaveBeenCalled();});
 it.each(['workspace','job','extra','authority'])('rejects malformed candidate %s',async kind=>{const c:any=candidate();if(kind==='workspace')c.workspace_id='other';if(kind==='job')c.job_id=randomUUID();if(kind==='extra')c.path='/private';if(kind==='authority')c.erasure_authorized=true;await expect(preparePrivacyAssetMinimization(db(c),input)).rejects.toThrow();});
 it.each(['missing','multiple'])('requires one native receipt: %s',async kind=>{const d=db(candidate());d.query.mockResolvedValue({rows:kind==='missing'?[]:[{receipt:candidate()},{receipt:candidate()}]});await expect(preparePrivacyAssetMinimization(d,input)).rejects.toThrow('RECEIPT_REQUIRED');});
 it('propagates native denial without retry or side effect',async()=>{const d=db(null);d.query.mockRejectedValue(Error('PRIVACY_BACKUP_ROW_UNCOVERED'));await expect(preparePrivacyAssetMinimization(d,input)).rejects.toThrow('PRIVACY_BACKUP_ROW_UNCOVERED');expect(d.query).toHaveBeenCalledTimes(1);});
 it.each(['MINIMIZED','NO_EFFECT'])('returns bounded native %s with no filesystem effect',async status=>{const v={...done(),status},d=db(v);expect(await applyPrivacyAssetMinimization(d,{batchId:job,profileLeaseId:lease,referenceLeaseId:reference})).toEqual(v);expect(d.query).toHaveBeenCalledExactlyOnceWith('SELECT apply_privacy_asset_minimization($1,$2,$3) receipt',[job,lease,reference]);});
 it.each(['workspace','job','batch','files','versions','empty','extra','authority'])('rejects invalid completion %s',async kind=>{const v:any=done();if(kind==='workspace')v.workspace_id='other';if(kind==='job')v.job_id=randomUUID();if(kind==='batch')v.batch_id=randomUUID();if(kind==='files')v.files=2;if(kind==='versions')v.versions=0;if(kind==='empty'){v.assets=0;v.files=0;}if(kind==='extra')v.filename='pii';if(kind==='authority')v.erasure_authorized=true;await expect(applyPrivacyAssetMinimization(db(v),{batchId:job,profileLeaseId:lease,referenceLeaseId:reference})).rejects.toThrow();});
 it('rejects supplied minima or private admission before SQL',async()=>{const d=db(done());await expect(applyPrivacyAssetMinimization(d,{batchId:job,profileLeaseId:lease,referenceLeaseId:reference,...{admission:true}})).rejects.toThrow();expect(d.query).not.toHaveBeenCalled();});
});
describe('038 historical guard source custody',()=>{
 const sql=readFileSync(new URL('../profile-transition/components/038_private_asset_minimization.sql',import.meta.url),'utf8');
 const prior=readFileSync(new URL('../profile-transition/033_record_minimization.sql',import.meta.url),'utf8');
 it.each(['guard_record','snapshot_record','immutable_row','guard_retained_asset_references'])('pins and preserves exact prior %s source',name=>{
  const old=prior.match(new RegExp('CREATE OR REPLACE FUNCTION '+name+'\\(\\).*?AS \\$\\$(.*?)\\$\\$;','s'))![1]!;
  const next=sql.match(new RegExp('CREATE OR REPLACE FUNCTION '+name+'\\(\\).*?AS \\$\\$(.*?)\\$\\$;','s'))![1]!;
  expect(sql).toContain(createHash('sha256').update(old).digest('hex'));expect(next.replace(/BEGIN\n IF[^\n]*privacy_asset[^\n]*END IF;/,'BEGIN')).toBe(old);
 });
 it('does not grant an admission or erasure entry point to runtime',()=>{expect(sql).not.toMatch(/GRANT INSERT ON privacy_asset_apply_admissions/);expect(sql).not.toMatch(/GRANT EXECUTE ON FUNCTION (?:prepare|apply)_privacy_asset/);expect(sql).not.toMatch(/DISABLE TRIGGER|session_replication_role/);});
 it('has a compact manifest cross-language vector with Unicode and controls',()=>{
  const value={schema_version:1,job_id:job,workspace_id:'prueba ñ\n中/"',plan_sha256:sha,inventory_sha256:sha,backup_fence_sha256:sha,files:[]};
  const canonical='{"backup_fence_sha256":"'+sha+'","files":[],"inventory_sha256":"'+sha+'","job_id":"'+job+'","plan_sha256":"'+sha+'","schema_version":1,"workspace_id":'+JSON.stringify(value.workspace_id)+'}';
  expect(privateFileManifestHash(value)).toBe(createHash('sha256').update(canonical).digest('hex'));
 });
});
