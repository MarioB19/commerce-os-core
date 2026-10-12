import {mkdtemp,mkdir,writeFile,readFile,rm,stat,symlink,chmod,realpath,open,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID,createHash,createCipheriv,createDecipheriv} from 'node:crypto';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createNumberLabMaterialCustody,createNumberLabMaterialReader,readNumberLabMaterial} from './number-lab-material-custody.js';
import {withPrivateNamespaceLock} from './private-namespace-lock.js';
import {sealLabValue} from './number-laboratory.js';
import {marketRecordVersionHash} from './market-variants.js';
import {compileNumberLabConfiguration,type LabPlanSource} from '../../domain/src/laboratory/configuration-plan.js';
import {labHash} from '../../domain/src/laboratory/number-lab.js';
import type {NumberLabSnapshot} from '../../contracts/src/number-laboratory.js';
import type {ProfilePool} from './profile-context.js';
const dirs:string[]=[];afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
function encrypted(bytes:Buffer,key:Buffer){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(bytes.toString('base64'),'utf8'),c.final()]);return['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),data.toString('base64')].join('.');}
function encryptedSecret(value:unknown,key:Buffer){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),data.toString('base64')].join('.');}
function plaintext(raw:string,key:Buffer){const[,iv,tag,data]=raw.split('.'),d=createDecipheriv('aes-256-gcm',key,Buffer.from(iv!,'base64'));d.setAuthTag(Buffer.from(tag!,'base64'));return Buffer.from(Buffer.concat([d.update(Buffer.from(data!,'base64')),d.final()]).toString('utf8'),'base64');}
async function fixture(kind:'file'|'link'|'access'='file',corruptAccess=false){const temp=await mkdtemp(join(await realpath(tmpdir()),'commerce-lab-custody-'));dirs.push(temp);const sourceRoot=join(temp,'source'),laboratoryRoot=join(temp,'laboratory');await mkdir(sourceRoot,{mode:0o700});await mkdir(join(sourceRoot,'assets'),{mode:0o700});await mkdir(laboratoryRoot,{mode:0o700});const bytes=Buffer.from('Synthetic local material'),sourceKey=randomBytes(32),laboratoryKey=randomBytes(32);
 const input={workspaceId:'original-profile',runId:randomUUID(),operationId:randomUUID()},key=randomBytes(32),records:LabPlanSource[]=[],ref=()=>({id:randomUUID(),revision:1,sha256:'a'.repeat(64)}),account=ref();
 const add=(kind:string,body:Record<string,any>)=>{const r={kind,ref:ref(),body};records.push(r);return r;};
 const product=add('product',{name:'Synthetic product'}),asset=add('asset',{name:'Synthetic file',kind:'file',status:'READY',sha256:'b'.repeat(64),size_bytes:7}),bank=add('bank_profile',{name:'Synthetic bank',bank:'Synthetic',currency:'MXN'}),agent=add('agent',{name:'Synthetic seller',provider:'workspace',product_id:product.ref.id}),flow=add('workflow',{name:'Synthetic flow',status:'PUBLISHED',nodes:[],entry_node_id:'end'}),offer=add('offer',{name:'Synthetic offer',status:'PUBLISHED',product_id:product.ref.id,workflow_version_id:flow.ref.id,agent_version_id:agent.ref.id,payment_profile_version_id:bank.ref.id,fulfillment:[{asset_id:asset.ref.id}],currency:'MXN',base_amount_minor:100}),binding=add('binding',{account_id:account.id,offer_version_id:offer.ref.id,workflow_version_id:flow.ref.id,agent_version_id:agent.ref.id});
 const candidate={account_id:account.id,binding:binding.ref,state:'ACTIVE' as const,release:{id:randomUUID(),variant_id:randomUUID(),family_id:product.ref.id,revision:1,scope:{workspace_id:input.workspaceId,environment:'REAL' as const},locale:{market:'MX',currency:'MXN',language:'es',timezone:'UTC'},amount_minor:100,configuration:{offer:offer.ref,flow:flow.ref,seller:agent.ref,collection:bank.ref,remarketing:offer.ref,materials:[asset.ref]}}};
 const sourceRow={record_id:asset.ref.id,workspace_id:input.workspaceId,environment:'REAL',kind:'asset',version:1,body:{...asset.body,sha256:hash(bytes),size_bytes:bytes.length,storage_key:randomUUID()}};
 if(kind!=='file'){asset.body.kind=kind;Object.assign(sourceRow.body,{kind});if(kind==='link')Object.assign(sourceRow.body,{url:'https://source.example.test/private'});else{const secret=encryptedSecret({adapter:'link',delivery_reference:JSON.stringify({url:'https://source.example.test/private',code:'SYNTHETIC-PRIVATE',instructions:'Private source instructions'})},sourceKey);Object.assign(sourceRow.body,{adapter:'link',delivery_ciphertext:corruptAccess?secret.slice(0,-5)+'AAAA=':secret});asset.body.adapter='link';}}
 asset.ref.sha256=marketRecordVersionHash(sourceRow);asset.body.sha256=hash(bytes);asset.body.size_bytes=bytes.length;
 const snapshot:NumberLabSnapshot={schema_version:1,workspace_id:input.workspaceId,source_environment:'REAL',account,captured_at:'2026-10-12T10:00:00.000Z',engine_sha256:'c'.repeat(64),configuration_sha256:labHash(records),ai_configuration_version:1,candidates:[candidate],sources:records.map(({kind,ref})=>({kind,ref})) as NumberLabSnapshot['sources'],tiers:[{variant_id:candidate.release.variant_id,tier_ids:['base']}]};

 const plan=compileNumberLabConfiguration({snapshot,records},input.runId),q={workspaceId:input.workspaceId,runId:input.runId,snapshotSha256:plan.snapshot_sha256,materials:plan.variants.flatMap(v=>v.materials)};
 const origin=join(sourceRoot,'assets',sourceRow.body.storage_key+'.enc'),copy=join(laboratoryRoot,'assets',q.materials[0]!.id+'-'+hash(bytes)+'.enc'),raw=encrypted(bytes,sourceKey);await writeFile(origin,raw,{mode:0o600,flag:'wx'});
 const flags={wrongControl:false,wrongSource:false,missingProfile:false,missingRun:false,late:false,sourceChanged:false,claimCommitLost:false};let controlReads=0,sourceReads=0;
 const run={snapshot_sha256:plan.snapshot_sha256,snapshot_ciphertext:sealLabValue({workspaceId:input.workspaceId,runId:input.runId,purpose:'snapshot'},{snapshot,records},key),state:'RUNNING',expires_at:new Date('2026-10-13T10:00:00Z'),now:new Date('2026-10-12T10:00:00Z')};
 const pool=(kind:'control'|'source'):ProfilePool=>({async connect(){return{async query(sql){let rows:any[]=[];if(sql.includes('current_user role'))rows=[{role:kind==='control'?(flags.wrongControl?'commerce_api':'commerce_number_lab'):(flags.wrongSource?'commerce_number_lab':'commerce_api')}];else if(sql.includes('FROM commerce_number_lab.runs')){controlReads++;rows=flags.missingRun?[]:[{...run,...(flags.late&&controlReads>1?{now:new Date('2026-10-14T10:00:00Z')}:{})}];}else if(sql.includes('FROM profiles'))rows=flags.missingProfile?[]:[{id:input.workspaceId}];else if(sql.includes('FROM record_versions')){sourceReads++;rows=[{...sourceRow,body:{...sourceRow.body,...(flags.sourceChanged&&sourceReads>1?{sha256:'f'.repeat(64)}:{})}}];}if(sql==='COMMIT'&&kind==='control'&&flags.claimCommitLost)throw Error('CONTROL_COMMIT_LOST');return{command:sql==='COMMIT'?'COMMIT':'SELECT',rowCount:rows.length,rows,fields:[],oid:0} as any;},release(){}};}});
 const options={controlPool:pool('control'),sourcePool:pool('source'),controlKey:key,sourceKey,laboratoryKey,sourceRoot,laboratoryRoot},factory=(patch:Partial<typeof options>={})=>createNumberLabMaterialCustody({...options,...patch});return{q,bytes,origin,copy,raw,options,factory,flags,sourceRow};
}
describe('laboratory material filesystem custody with explicit synthetic native transport',()=>{
 it.each(['link','access'] as const)('authenticates native %s and returns only a bound LAB descriptor',async kind=>{const f=await fixture(kind),r=await f.factory().copy(f.q);expect(r.files).toEqual([]);expect(r.virtual_materials).toHaveLength(1);expect(r.virtual_materials![0]).toMatchObject({delivery:'LAB_ONLY',kind,run_id:f.q.runId,snapshot_sha256:f.q.snapshotSha256,id:f.q.materials[0]!.id,source:f.q.materials[0]!.source});const text=JSON.stringify(r);for(const secret of ['source.example.test','SYNTHETIC-PRIVATE','Private source instructions','delivery_ciphertext'])expect(text).not.toContain(secret);await expect(stat(f.copy)).rejects.toMatchObject({code:'ENOENT'});expect(await readFile(f.origin,'utf8')).toBe(f.raw);});
 it('rejects an authenticated source row whose access ciphertext fails GCM',async()=>{const f=await fixture('access',true);await expect(f.factory().copy(f.q)).rejects.toThrow('LAB_MATERIAL_ACCESS_INVALID');await expect(stat(f.copy)).rejects.toMatchObject({code:'ENOENT'});});

 it('copies verified bytes using a distinct key and private file without touching original',async()=>{const f=await fixture(),r=await f.factory().copy(f.q);expect(r.files).toHaveLength(1);expect(await readFile(f.origin,'utf8')).toBe(f.raw);const copied=await readFile(f.copy,'utf8');expect(copied).not.toBe(f.raw);expect(plaintext(copied,f.options.laboratoryKey)).toEqual(f.bytes);expect(()=>plaintext(copied,f.options.sourceKey)).toThrow();expect((await stat(f.copy)).mode&0o777).toBe(0o600);expect(r.files[0]).toMatchObject({content_sha256:hash(f.bytes),size_bytes:f.bytes.length});});
 it('reuses only exact verified copies and never rewrites their ciphertext',async()=>{const f=await fixture(),b=f.factory();const a=await b.copy(f.q),before=await readFile(f.copy,'utf8');expect(await b.copy(f.q)).toEqual(a);expect(await readFile(f.copy,'utf8')).toBe(before);});
 it('preserves a changed existing copy and rejects it instead of overwriting',async()=>{const f=await fixture(),b=f.factory();await b.copy(f.q);await writeFile(f.copy,'partial');await expect(b.copy(f.q)).rejects.toThrow();expect(await readFile(f.copy,'utf8')).toBe('partial');});
 it('rejects ciphertext with a valid source key but wrong content hash',async()=>{const f=await fixture();await writeFile(f.origin,encrypted(Buffer.from('wrong'),f.options.sourceKey));await expect(f.factory().copy(f.q)).rejects.toThrow('LAB_MATERIAL_CONTENT_CHANGED');await expect(stat(f.copy)).rejects.toMatchObject({code:'ENOENT'});});
 it('rejects symlink source files',async()=>{const f=await fixture(),target=f.origin+'.real';await writeFile(target,f.raw);await rm(f.origin);await symlink(target,f.origin);await expect(f.factory().copy(f.q)).rejects.toThrow();await expect(stat(f.copy)).rejects.toMatchObject({code:'ENOENT'});});
 it('rejects symlink destination and preserves its target',async()=>{const f=await fixture();await mkdir(join(f.options.laboratoryRoot,'assets'),{mode:0o700});const outside=join(f.options.laboratoryRoot,'untouched');await writeFile(outside,'untouched');await symlink(outside,f.copy);await expect(f.factory().copy(f.q)).rejects.toThrow();expect(await readFile(outside,'utf8')).toBe('untouched');});
 it.each(['wrongControl','wrongSource','missingProfile','missingRun','claimCommitLost'] as const)('requires the native closed authority before producing a file: %s',async flag=>{const f=await fixture();f.flags[flag]=true;await expect(f.factory().copy(f.q)).rejects.toThrow();await expect(stat(f.copy)).rejects.toMatchObject({code:'ENOENT'});});
 it('rechecks control expiry after physical copy and preserves it without issuing a receipt',async()=>{const f=await fixture();f.flags.late=true;await expect(f.factory().copy(f.q)).rejects.toThrow('LAB_MATERIAL_CONTROL_REQUIRED');expect(plaintext(await readFile(f.copy,'utf8'),f.options.laboratoryKey)).toEqual(f.bytes);});
 it('preserves the copy and rejects its receipt if directory synchronization fails',async()=>{const f=await fixture(),handle=await open(f.origin,'r'),prototype=Object.getPrototypeOf(handle),native=prototype.sync;await handle.close();const spy=vi.spyOn(prototype,'sync').mockImplementation(async function(this:Awaited<ReturnType<typeof open>>){if((await this.stat()).isDirectory())throw Error('DIRECTORY_SYNC_FAILED');await native.call(this);});try{await expect(f.factory().copy(f.q)).rejects.toThrow('DIRECTORY_SYNC_FAILED');expect(plaintext(await readFile(f.copy,'utf8'),f.options.laboratoryKey)).toEqual(f.bytes);}finally{spy.mockRestore();}});
 it('rechecks exact source version after physical copy',async()=>{const f=await fixture();f.flags.sourceChanged=true;await expect(f.factory().copy(f.q)).rejects.toThrow('LAB_MATERIAL_SOURCE_CHANGED');});
 it('rejects substituted descriptors, duplicate IDs, non-file materials and caller paths',async()=>{const f=await fixture();for(const q of [{...f.q,materials:[{...f.q.materials[0],id:randomUUID()}]},{...f.q,materials:[f.q.materials[0],f.q.materials[0]]},{...f.q,materials:[{...f.q.materials[0],kind:'link'}]},{...f.q,sourceRoot:f.options.sourceRoot}])await expect(f.factory().copy(q as any)).rejects.toThrow();await expect(stat(f.copy)).rejects.toMatchObject({code:'ENOENT'});});
 it('rejects shared keys, nested roots and public lab directories',async()=>{const f=await fixture();expect(()=>f.factory({laboratoryKey:f.options.sourceKey})).toThrow('LAB_MATERIAL_KEY');expect(()=>f.factory({laboratoryRoot:join(f.options.sourceRoot,'nested')})).toThrow('LAB_MATERIAL_ROOT');await chmod(f.options.laboratoryRoot,0o755);await expect(f.factory().copy(f.q)).rejects.toThrow('LAB_MATERIAL_ROOT');});
});

describe('protected laboratory material reader',()=>{
 async function ready(){const f=await fixture();await f.factory().copy(f.q);const m=f.q.materials[0]!,input={id:m.id,sha256:m.sha256!,size_bytes:m.size_bytes!};return{...f,input,reader:createNumberLabMaterialReader(f.options)};}
 it('reads only the copied ciphertext with its distinct LAB key and exact descriptor',async()=>{const f=await ready();expect(await readNumberLabMaterial(f.reader,f.input)).toEqual(f.bytes);expect(await readFile(f.origin,'utf8')).toBe(f.raw);});
 it('rejects fabricated capabilities and caller paths',async()=>{const f=await ready();await expect(readNumberLabMaterial({kind:'NUMBER_LAB_MATERIAL_READER'},f.input)).rejects.toThrow('LAB_MATERIAL_READER_REQUIRED');await expect(readNumberLabMaterial(f.reader,{...f.input,path:f.origin} as any)).rejects.toThrow();});
 it('rejects a wrong descriptor or key without rewriting either ciphertext',async()=>{const f=await ready(),before=await readFile(f.copy,'utf8');await expect(readNumberLabMaterial(f.reader,{...f.input,size_bytes:f.input.size_bytes+1})).rejects.toThrow('LAB_MATERIAL_CONTENT_CHANGED');await expect(readNumberLabMaterial(createNumberLabMaterialReader({...f.options,laboratoryKey:randomBytes(32)}),f.input)).rejects.toThrow();expect(await readFile(f.copy,'utf8')).toBe(before);});
 it.each(['symlink','hardlink','public'] as const)('rejects %s copies',async mode=>{const f=await ready();if(mode==='symlink'){await rm(f.copy);await symlink(f.origin,f.copy);}else if(mode==='hardlink')await link(f.copy,f.copy+'.alias');else await chmod(f.copy,0o644);await expect(readNumberLabMaterial(f.reader,f.input)).rejects.toThrow('LAB_FILE_CUSTODY');});
 it('rejects a public root before reading its file',async()=>{const f=await ready();await chmod(f.options.laboratoryRoot,0o755);await expect(readNumberLabMaterial(f.reader,f.input)).rejects.toThrow('LAB_MATERIAL_ROOT');});
});


describe('material custody participates in the private namespace fence',()=>{
 it.each(['sourceRoot','laboratoryRoot'] as const)('rejects existing EX on %s before authority or material I/O',async root=>{
  const f=await fixture(),connect=vi.spyOn(f.options.controlPool,'connect');
  await withPrivateNamespaceLock(f.options[root],'EXCLUSIVE',async()=>{
   await expect(f.factory().copy(f.q)).rejects.toThrow('PRIVATE_NAMESPACE_BUSY');
   expect(connect).not.toHaveBeenCalled();await expect(stat(f.copy)).rejects.toMatchObject({code:'ENOENT'});
  });
  expect((await f.factory().copy(f.q)).files).toHaveLength(1);expect(await readFile(f.origin,'utf8')).toBe(f.raw);
 });
 it('holds SH on both roots throughout the source read and releases after a successful copy',async()=>{
  const f=await fixture(),h=await open(f.origin,'r'),prototype=Object.getPrototypeOf(h),native=prototype.read,identity=await h.stat();await h.close();let checked=false;
  const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:Awaited<ReturnType<typeof open>>,...args:any[]){
   const s=await this.stat();if(!checked&&s.dev===identity.dev&&s.ino===identity.ino){checked=true;for(const root of [f.options.sourceRoot,f.options.laboratoryRoot])await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>{throw Error('UNEXPECTED_ERASER_ENTRY');})).rejects.toThrow('PRIVATE_NAMESPACE_BUSY');}
   return native.apply(this,args);
  });
  try{expect((await f.factory().copy(f.q)).files).toHaveLength(1);expect(checked).toBe(true);}finally{spy.mockRestore();}
  for(const root of [f.options.sourceRoot,f.options.laboratoryRoot])await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>{});
 });
 it('retains the LAB shared fence for delivery decryption and verification',async()=>{
  const f=await fixture();await f.factory().copy(f.q);const m=f.q.materials[0]!,reader=createNumberLabMaterialReader(f.options),h=await open(f.copy,'r'),prototype=Object.getPrototypeOf(h),native=prototype.read,identity=await h.stat();await h.close();let checked=false;
  const spy=vi.spyOn(prototype,'read').mockImplementation(async function(this:Awaited<ReturnType<typeof open>>,...args:any[]){const s=await this.stat();if(!checked&&s.dev===identity.dev&&s.ino===identity.ino){checked=true;await expect(withPrivateNamespaceLock(f.options.laboratoryRoot,'EXCLUSIVE',async()=>{throw Error('UNEXPECTED_ERASER_ENTRY');})).rejects.toThrow('PRIVATE_NAMESPACE_BUSY');}return native.apply(this,args);});
  try{expect(await readNumberLabMaterial(reader,{id:m.id,sha256:m.sha256!,size_bytes:m.size_bytes!})).toEqual(f.bytes);expect(checked).toBe(true);}finally{spy.mockRestore();}
  await withPrivateNamespaceLock(f.options.laboratoryRoot,'EXCLUSIVE',async()=>{});
 });
 it('does not enter file reading when LAB has an exclusive lease',async()=>{
  const f=await fixture();await f.factory().copy(f.q);const m=f.q.materials[0]!,reader=createNumberLabMaterialReader(f.options),h=await open(f.copy,'r'),prototype=Object.getPrototypeOf(h);await h.close();const spy=vi.spyOn(prototype,'read');
  try{await withPrivateNamespaceLock(f.options.laboratoryRoot,'EXCLUSIVE',async()=>{await expect(readNumberLabMaterial(reader,{id:m.id,sha256:m.sha256!,size_bytes:m.size_bytes!})).rejects.toThrow('PRIVATE_NAMESPACE_BUSY');expect(spy).not.toHaveBeenCalled();});}finally{spy.mockRestore();}
 });
 it('releases both leases after authentication failure without deleting the ciphertext',async()=>{
  const f=await fixture();await writeFile(f.origin,'v1.invalid');await expect(f.factory().copy(f.q)).rejects.toThrow('LAB_FILE_CIPHERTEXT');expect(await readFile(f.origin,'utf8')).toBe('v1.invalid');
  for(const root of [f.options.sourceRoot,f.options.laboratoryRoot])await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>{});
 });
});
