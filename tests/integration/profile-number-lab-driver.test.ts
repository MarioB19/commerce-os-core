import {PostgresAiPorts,storeAiCredential} from '../../packages/ai-providers/src/persistence.js';
import {configureAiGrant,configureAiBudget} from '../../packages/ai-providers/src/configuration.js';
import {credentialVerificationIdentity} from '../../packages/ai-providers/src/verification.js';
import {quote} from '../../packages/ai-providers/src/catalog.js';
import {bindNumberLabReleases} from '../../packages/ai-providers/src/number-laboratory.js';
import {marketReleaseHash} from '../../packages/domain/src/catalog/market-variants.js';
/** Native driver uses canonical commands/workflows and dedicated control + engine roles. Material descriptors are explicitly synthetic in this fixture. */
import {createNumberLabDriver} from '../../apps/automation-worker/src/number-lab-driver.js';
import type {NumberLabAction} from '../../packages/contracts/src/number-laboratory.js';
import {readFile,readdir,mkdtemp,mkdir,writeFile,realpath,rm} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash,createCipheriv} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import pg from 'pg';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {localInventoryTarget} from '../../scripts/profile-inventory.js';
import {createNumberLabEngineRuntime,withNumberLabEngine} from '../../packages/db/src/number-lab-engine-runtime.js';
import {createNumberLabMaterializer,type NumberLabMaterialPort} from '../../packages/db/src/number-lab-materialization.js';
import {createNumberLabMaterialCustody,createNumberLabMaterialReader} from '../../packages/db/src/number-lab-material-custody.js';
import {marketRecordVersionHash} from '../../packages/db/src/market-variants.js';
import {withProfileTransaction,type ProfilePool} from '../../packages/db/src/profile-context.js';
import {putRecord} from '../../packages/db/src/index.js';
import {openLabValue,startNumberLab,enqueueNumberLab} from '../../packages/db/src/number-laboratory.js';
import {compileNumberLabConfiguration,type LabPlanSource} from '../../packages/domain/src/laboratory/configuration-plan.js';
import {estimateNumberLab,labHash} from '../../packages/domain/src/laboratory/number-lab.js';
import type {NumberLabSnapshot} from '../../packages/contracts/src/number-laboratory.js';
import type {ProfileAuthority} from '../../packages/domain/src/core/profile-authorization.js';
import type {Model,ProfileConfiguration} from '../../packages/ai-providers/src/contracts.js';
const suffix=randomBytes(6).toString('hex'),database='commerce_lab_engine_'+suffix,login='lab_engine_'+suffix,seedLogin='lab_seed_'+suffix,apiLogin='lab_api_'+suffix,controlLogin='lab_control_'+suffix,aiLogin='lab_ai_'+suffix;
const identity={database,installationId:randomUUID(),engineSha256:'c'.repeat(64)},key=randomBytes(32);
let parent:pg.Pool,admin:pg.Pool,worker:pg.Pool,seedWorker:pg.Pool,apiNative:pg.Pool,controlNative:pg.Pool,scoped:ProfilePool,seed:ProfilePool,api:ProfilePool,control:ProfilePool;
let aiNative:pg.Pool,aiPool:ProfilePool,nativeModel:Model;
let runtime:ReturnType<typeof createNumberLabEngineRuntime>;
let setupComplete=false,engineDatabaseOid:string,roleBaseline:unknown[],ownedRoles:unknown[],memberships:unknown[];
const allRoleNames=[login,seedLogin,'commerce_lab_engine','commerce_lab_engine_seed','commerce_lab_engine_owner'];
const privateDirectories:string[]=[];
const fileHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
function encryptSourceSecret(value:unknown,fileKey:Buffer){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',fileKey,iv),data=Buffer.concat([c.update(JSON.stringify(value),'utf8'),c.final()]);return ['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),data.toString('base64')].join('.');}
function encryptMaterial(bytes:Buffer,fileKey:Buffer){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',fileKey,iv),data=Buffer.concat([c.update(bytes.toString('base64'),'utf8'),c.final()]);return ['v1',iv.toString('base64'),c.getAuthTag().toString('base64'),data.toString('base64')].join('.');}
const rolesSql=`SELECT oid::text,rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconnlimit,rolvaliduntil,rolconfig FROM pg_roles ORDER BY rolname`;
const membersSql=`SELECT roleid::text,member::text,grantor::text,admin_option,inherit_option,set_option FROM pg_auth_members ORDER BY roleid,member,grantor`;
async function applyCanonical(pool:pg.Pool){
 const migrations=new URL('../../packages/db/migrations/',import.meta.url),files=(await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort();expect(files).toHaveLength(68);
 const c=await pool.connect();try{for(const name of files){await c.query('BEGIN');await c.query(await readFile(new URL(name,migrations),'utf8'));await c.query('COMMIT');}
 for(const name of ['001_profile_identity.sql','010_continuous_authorization.sql','012_continuous_effects.sql']){await c.query('BEGIN');await c.query(await readFile(new URL('../../packages/db/profile-transition/'+name,import.meta.url),'utf8'));await c.query('COMMIT');}}finally{c.release();}
}
function rolePool(pool:pg.Pool,role:'commerce_lab_engine'|'commerce_lab_engine_seed'|'commerce_api'|'commerce_number_lab'|'commerce_ai'):ProfilePool{return{async connect(){const c=await pool.connect();try{await c.query('SET ROLE '+role);return{query:c.query.bind(c),release:c.release.bind(c)};}catch(e){c.release();throw e;}}};}
const authority=(workspaceId:string):ProfileAuthority=>({profile:{id:workspaceId,state:'ACTIVE'},membership:{userId:'synthetic-owner',workspaceId,role:'owner',active:true,version:1},credential:{kind:'session',userId:'synthetic-owner',workspaceId,revoked:false,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:[],membershipVersion:1}});
async function fixture(action:NumberLabAction={type:'message',text:'Synthetic'},multiple=false,useSeller=false,delivery:'text'|'file'|'sequence'|'link'|'access'|undefined=undefined){
 const nativeMaterial=['file','link','access'].includes(delivery??'');
 const workspaceId='lab-source-'+randomUUID(),records:LabPlanSource[]=[],ref=()=>({id:randomUUID(),revision:1,sha256:'a'.repeat(64)}),account=ref();
 await parent.query("INSERT INTO profiles(id,business_name,timezone,number_limit,product_limit,daily_conversation_limit) VALUES($1,'Synthetic source','UTC',1,10,10)",[workspaceId]);
 const now=new Date((await parent.query('SELECT clock_timestamp() now')).rows[0].now).getTime();
 const add=(kind:string,body:Record<string,any>)=>{const r={kind,ref:ref(),body};records.push(r);return r;};
 const product=add('product',{name:'Synthetic product'}),asset=add('asset',{name:'Synthetic file',kind:'file',status:'READY',sha256:'b'.repeat(64),size_bytes:7}),bank=add('bank_profile',{name:'Synthetic bank',bank:'Synthetic',currency:'MXN'}),agent=add('agent',{name:'Synthetic seller',provider:'workspace',product_id:product.ref.id}),flow=add('workflow',{name:'Synthetic flow',status:'PUBLISHED',product_id:product.ref.id,nodes:[{id:'end',type:'end',config:{}}],entry_node_id:'end'}),offer=add('offer',{name:'Synthetic offer',status:'PUBLISHED',product_id:product.ref.id,workflow_version_id:flow.ref.id,agent_version_id:agent.ref.id,payment_profile_version_id:bank.ref.id,fulfillment:[{asset_id:asset.ref.id}],currency:'MXN',base_amount_minor:100}),binding=add('binding',{account_id:account.id,offer_version_id:offer.ref.id,workflow_version_id:flow.ref.id,agent_version_id:agent.ref.id,valid_from:new Date(now-1000).toISOString()});
 if(delivery){flow.body.entry_node_id='send';flow.body.nodes=[{id:'send',type:'message',config:{kind:delivery==='file'?'document':'text',text:'Synthetic transport reply',...(['file','link'].includes(delivery??'')?{asset_id:asset.ref.id}:{})},next:'end'},{id:'end',type:'end',config:{}}];}
 if(delivery==='sequence'){flow.body.nodes[0].next='send2';flow.body.nodes.splice(1,0,{id:'send2',type:'message',config:{kind:'text',text:'Second reply'},next:'end'});}
 if(delivery==='access'){flow.body.entry_node_id='commit';flow.body.nodes=[{id:'commit',type:'commitment',config:{},next:'fulfill'},{id:'fulfill',type:'fulfillment',config:{release_on:'commitment_accepted'},next:'end'},{id:'end',type:'end',config:{}}];offer.body.fulfillment=[{asset_id:asset.ref.id,release_on:'commitment_accepted'}];}
 if(useSeller){flow.body.entry_node_id='ai';flow.body.nodes=[{id:'ai',type:'ai',config:{},next:'end'},{id:'end',type:'end',config:{}}];}
 let physical:{sourceRoot:string;laboratoryRoot:string;sourceKey:Buffer;laboratoryKey:Buffer;bytes:Buffer;origin:string;raw:string;sourceVersion:unknown}|undefined;
 if(nativeMaterial){
  const directory=await mkdtemp(join(await realpath(tmpdir()),'commerce-lab-native-material-'));privateDirectories.push(directory);const sourceRoot=join(directory,'source'),laboratoryRoot=join(directory,'laboratory');await mkdir(sourceRoot,{mode:0o700});await mkdir(join(sourceRoot,'assets'),{mode:0o700});await mkdir(laboratoryRoot,{mode:0o700});
  const bytes=Buffer.from('Synthetic file copied through native roles'),sourceKey=randomBytes(32),laboratoryKey=randomBytes(32),storage_key=randomUUID();asset.body.kind=delivery;asset.body.sha256=fileHash(bytes);asset.body.size_bytes=bytes.length;asset.body.mime_type='application/octet-stream';if(delivery!=='file'){delete asset.body.sha256;delete asset.body.size_bytes;delete asset.body.mime_type;}if(delivery==='access')asset.body.adapter='link';
  const secret=delivery==='access'?{delivery_ciphertext:encryptSourceSecret({adapter:'link',delivery_reference:JSON.stringify({url:'https://source.example.test/native-access',code:'PRIVATE-SOURCE-CODE',instructions:'Private source instructions'})},sourceKey)}:delivery==='link'?{url:'https://source.example.test/native-link'}:{storage_key};
  const sourceVersion=await withProfileTransaction(api,workspaceId,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");await putRecord(db,{id:asset.ref.id,workspaceId,environment:'REAL',kind:'asset',body:{...asset.body,...secret}});return(await db.query('SELECT record_id,workspace_id,environment,kind,version,body FROM record_versions WHERE record_id=$1 AND version=1',[asset.ref.id])).rows[0];});
  asset.ref.sha256=marketRecordVersionHash(sourceVersion);const origin=join(sourceRoot,'assets',storage_key+'.enc'),raw=encryptMaterial(bytes,sourceKey);await writeFile(origin,raw,{mode:0o600,flag:'wx'});physical={sourceRoot,laboratoryRoot,sourceKey,laboratoryKey,bytes,origin,raw,sourceVersion};
 }
 const candidate={account_id:account.id,binding:binding.ref,state:'ACTIVE' as const,release:{id:randomUUID(),variant_id:randomUUID(),family_id:product.ref.id,revision:1,scope:{workspace_id:workspaceId,environment:'REAL' as const},locale:{market:'MX',currency:'MXN',language:'es',timezone:'UTC'},amount_minor:100,configuration:{offer:offer.ref,flow:flow.ref,seller:agent.ref,collection:bank.ref,remarketing:offer.ref,materials:[asset.ref]}}};
 const other=multiple?{...candidate,binding:add('binding',{...binding.body}).ref,release:{...candidate.release,id:randomUUID(),variant_id:randomUUID()}}:undefined;
 const candidates=other?[candidate,other]:[candidate];
 const snapshot:NumberLabSnapshot={schema_version:1,workspace_id:workspaceId,source_environment:'REAL',account,captured_at:new Date(now).toISOString(),engine_sha256:identity.engineSha256,configuration_sha256:labHash(records),ai_configuration_version:1,candidates,sources:records.map(({kind,ref})=>({kind,ref})) as NumberLabSnapshot['sources'],tiers:candidates.map(c=>({variant_id:c.release.variant_id,tier_ids:['base']}))};
 const model:Model=useSeller?nativeModel:{provider:'openai',model:'synthetic',revision:'v1',transport:'responses',capabilities:['chat'],responseModels:['synthetic'],inputTokenCeiling:100,outputTokenCeiling:10,price:{version:'price1',currency:'USD',input:1000000,output:2000000,cacheRead:0,cacheWrite:0,audioInput:0,validFrom:new Date(now-1000).toISOString(),validUntil:new Date(now+3600000).toISOString()}};
 const profile:ProfileConfiguration={profileId:workspaceId,version:1,configuredProviders:['openai'],default:{provider:'openai',model:'synthetic'},variants:{},capabilityFallbacks:[]},estimate=estimateNumberLab(snapshot,'CHAT',profile,[model],now);
 let sellerConfiguration:Omit<NonNullable<Parameters<typeof createNumberLabDriver>[0]['seller']>,'fetcher'>|undefined;
 if(useSeller){
  await parent.query("INSERT INTO memberships(user_id,workspace_id,role) VALUES('synthetic-owner',$1,'owner')",[workspaceId]);
  const credential=await withProfileTransaction(api,workspaceId,db=>storeAiCredential(db,authority(workspaceId),{operationId:randomUUID(),environment:'REAL',provider:'openai',expectedRevision:0,key:'SYNTHETIC-SELLER-KEY'},key));
  await withProfileTransaction(api,workspaceId,db=>configureAiBudget(db,authority(workspaceId),{periodId:randomUUID(),environment:'REAL',startsAt:new Date(now-86400000).toISOString(),endsAt:new Date(now+86400000).toISOString(),profileLimitMicrousd:10000,keyLimits:[{credentialId:credential.credentialId,limitMicrousd:10000}]}));
  const testGrant=randomUUID();await withProfileTransaction(api,workspaceId,db=>configureAiGrant(db,authority(workspaceId),{grantId:testGrant,environment:'REAL',credentialId:credential.credentialId,variantId:null,task:'credential.verify',isTest:true,provider:model.provider,model:model.model,modelRevision:model.revision,priceVersion:model.price.version,expiresAt:new Date(now+3600000).toISOString()}));
  const testScope={workspaceId,profileId:workspaceId,variantId:'credential-verification',attemptId:credential.verificationAttemptId,task:'credential.verify',environment:'REAL' as const},ports=new PostgresAiPorts(aiPool,testGrant,key),q=quote(workspaceId,model,1000,now),request=credentialVerificationIdentity(model);
  await ports.reserve(testScope,q,request);await ports.beforeSend(testScope,q,testScope.attemptId,{request,credentialVersion:1});await ports.record(testScope,testScope.attemptId,{state:'SUCCEEDED',priceVersion:model.price.version,usage:{input:3,output:1,cacheRead:0,cacheWrite:0,audioInput:0},costMicrousd:5});
  await parent.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'REAL','product',$3)",[product.ref.id,workspaceId,product.body]);
  await parent.query("INSERT INTO market_families(id,workspace_id,environment) VALUES($1,$2,'REAL')",[product.ref.id,workspaceId]);const grants:Record<string,string>={};
  for(const c of candidates){await parent.query("INSERT INTO market_variants(id,workspace_id,environment,family_id,draft) VALUES($1,$2,'REAL',$3,'{}')",[c.release.variant_id,workspaceId,product.ref.id]);await parent.query("INSERT INTO market_releases(id,workspace_id,environment,variant_id,revision,body,sha256) VALUES($1,$2,'REAL',$3,1,$4,$5)",[c.release.id,workspaceId,c.release.variant_id,c.release,marketReleaseHash(c.release)]);
   const grantId=randomUUID();await withProfileTransaction(api,workspaceId,db=>configureAiGrant(db,authority(workspaceId),{grantId,environment:'REAL',credentialId:credential.credentialId,variantId:c.release.variant_id,task:'laboratory.chat',isTest:false,provider:model.provider,model:model.model,modelRevision:model.revision,priceVersion:model.price.version,expiresAt:new Date(now+3600000).toISOString()}));grants[c.release.variant_id]=grantId;
  }
  sellerConfiguration={workspaceId,enterprisePool:aiPool,custodyKey:key,grants,maximumMicrousd:1000,timeoutMs:5000};
 }
 const run=await withProfileTransaction(api,workspaceId,async db=>{const run=await startNumberLab(db,authority(workspaceId),{operation_id:randomUUID(),account_id:account.id,snapshot_sha256:labHash(snapshot),estimate_sha256:estimate.sha256,mode:'CHAT'},{snapshot,records},estimate,key);if(useSeller)await bindNumberLabReleases(db,run.run_id,snapshot,estimate);return run;});
 const operation=await withProfileTransaction(api,workspaceId,db=>enqueueNumberLab(db,authority(workspaceId),run.run_id,{operation_id:randomUUID(),expected_version:1,action},key));
 const input={workspaceId,runId:run.run_id,operationId:operation.operation_id},plan=compileNumberLabConfiguration({snapshot,records},run.run_id);let copies=0;
 const materials:NumberLabMaterialPort={async copy(q){expect((await parent.query("SELECT state FROM commerce_number_lab.operations WHERE run_id=$1 AND state='INTENT'",[input.runId])).rows).toEqual([{state:'INTENT'}]);copies++;return{run_id:q.runId,snapshot_sha256:q.snapshotSha256,files:q.materials.map(m=>({id:m.id,source_sha256:m.source.sha256,content_sha256:m.sha256!,size_bytes:m.size_bytes!,storage_key:m.id+'-'+m.sha256}))};}};
 const factory=(patch:Partial<Parameters<typeof createNumberLabMaterializer>[0]>={})=>createNumberLabMaterializer({controlPool:control,seedPool:seed,identity,key,materials,...patch});
 const physicalPort=(sourcePool=api)=>{if(!physical)throw Error('PHYSICAL_FIXTURE_REQUIRED');return createNumberLabMaterialCustody({controlPool:control,sourcePool,controlKey:key,...physical});};
 const physicalPath=physical?join(physical.laboratoryRoot,'assets',plan.variants[0]!.materials[0]!.id+'-'+fileHash(physical.bytes)+'.enc'):undefined;
 const driver=(patch:Partial<Parameters<typeof createNumberLabDriver>[0]>={})=>createNumberLabDriver({controlPool:control,seedPool:seed,enginePool:scoped,identity,key,materials,...patch});
 return{input,run,plan,factory,driver,candidates,sellerConfiguration,physical,physicalPort,physicalPath,get copies(){return copies;},binding:{runId:run.run_id,operationId:operation.operation_id,snapshotSha256:run.snapshot_sha256}};
}
async function count(workspace:string){return(await admin.query('SELECT count(*)::int n FROM records WHERE workspace_id=$1',[workspace])).rows[0].n;}
describe('native number laboratory driver',()=>{
 beforeAll(async()=>{
  const url=new URL(localInventoryTarget(process.env.DATABASE_URL));if(!/^\/commerce_test_[a-zA-Z0-9_]+$/.test(url.pathname))throw Error('ISOLATED_DATABASE_REQUIRED');
  parent=new pg.Pool({connectionString:url.toString(),max:3});
  for(const n of ['001_profile_identity.sql','003_profile_settings.sql','008_market_variants.sql','019_ai_admission.sql','021_number_laboratory.sql','components/021_number_lab_ai_bridge.sql','components/021_number_lab_cached_ai.sql'])await parent.query(await readFile(new URL('../../packages/db/profile-transition/'+n,import.meta.url),'utf8'));
  await parent.query(await readFile(new URL('../../packages/db/profile-transition/components/021_number_lab_driver_control.sql',import.meta.url),'utf8'));
  for(const[name,role]of [[apiLogin,'commerce_api'],[controlLogin,'commerce_number_lab'],[aiLogin,'commerce_ai']] as const){const secret=randomBytes(32).toString('hex');await parent.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const u=new URL(url);u.username=name;u.password=secret;const native=new pg.Pool({connectionString:u.toString(),max:3});if(role==='commerce_api'){apiNative=native;api=rolePool(native,role);}else if(role==='commerce_number_lab'){controlNative=native;control=rolePool(native,role);}else{aiNative=native;aiPool=rolePool(native,role);}}
  const now=new Date((await parent.query('SELECT clock_timestamp() now')).rows[0].now).getTime();
  await parent.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES('synthetic-owner','Synthetic','seller@example.test',true,now(),now())`);
  nativeModel={provider:'openai',model:'synthetic',revision:'v1',transport:'responses',capabilities:['chat'],responseModels:['synthetic'],inputTokenCeiling:100,outputTokenCeiling:10,price:{version:'price1',currency:'USD',input:1000000,output:2000000,cacheRead:0,cacheWrite:0,audioInput:0,validFrom:new Date(now-86400000).toISOString(),validUntil:new Date(now+86400000).toISOString()}};
  await parent.query('INSERT INTO ai_model_prices(provider,model,model_revision,price_version,valid_from,valid_until,input_ceiling,output_ceiling,input_rate,output_rate,cache_read_rate,cache_write_rate,audio_input_rate,model_document) VALUES($1,$2,$3,$4,$5,$6,100,10,1000000,2000000,0,0,0,$7)',[nativeModel.provider,nativeModel.model,nativeModel.revision,nativeModel.price.version,nativeModel.price.validFrom,nativeModel.price.validUntil,nativeModel]);
  roleBaseline=(await parent.query(rolesSql)).rows;await parent.query('CREATE DATABASE "'+database+'"');engineDatabaseOid=(await parent.query('SELECT oid::text FROM pg_database WHERE datname=$1',[database])).rows[0]?.oid;expect(typeof engineDatabaseOid).toBe('string');const engineUrl=new URL(url);engineUrl.pathname='/'+database;admin=new pg.Pool({connectionString:engineUrl.toString(),max:5});
  // Execute exact canonical migration sources in the new empty database. No
  // copied production rows, synthetic engine columns or schema bypasses.
  await applyCanonical(admin);await admin.query(await readFile(new URL('../../packages/db/profile-transition/components/021_number_lab_engine.sql',import.meta.url),'utf8'));
  await admin.query(await readFile(new URL('../../packages/db/profile-transition/components/021_number_lab_materialization.sql',import.meta.url),'utf8'));
  await admin.query(await readFile(new URL('../../packages/db/profile-transition/components/021_number_lab_driver.sql',import.meta.url),'utf8'));
  await admin.query(await readFile(new URL('../../packages/db/profile-transition/components/021_number_lab_transport.sql',import.meta.url),'utf8'));
  await admin.query('INSERT INTO commerce_number_lab_engine.installation(installation_id,database_name,engine_sha256) VALUES($1,$2,$3)',[identity.installationId,database,identity.engineSha256]);
  for(const[name,role]of [[login,'commerce_lab_engine'],[seedLogin,'commerce_lab_engine_seed']] as const){const secret=randomBytes(32).toString('hex');await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${secret}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;GRANT ${role} TO "${name}"`);const u=new URL(engineUrl);u.username=name;u.password=secret;const p=new pg.Pool({connectionString:u.toString(),max:4});if(name===login)worker=p;else seedWorker=p;}
  scoped=rolePool(worker,'commerce_lab_engine');seed=rolePool(seedWorker,'commerce_lab_engine_seed');runtime=createNumberLabEngineRuntime(scoped,identity);
  ownedRoles=(await parent.query(rolesSql)).rows.filter(r=>allRoleNames.includes(r.rolname));expect(ownedRoles).toHaveLength(5);memberships=(await parent.query(membersSql)).rows;setupComplete=true;
 },60000);
 // Vitest requires an object pattern for its unused fixture context; suite is argument two.
 // eslint-disable-next-line no-empty-pattern
 afterAll(async({},suite)=>{await worker?.end();await seedWorker?.end();await admin?.end();
  try{if(setupComplete&&suite.tasks.length>0&&suite.tasks.every(t=>t.type==='test'&&t.result?.state==='pass')){
   const current=(await parent.query(rolesSql)).rows;expect(current.filter(r=>allRoleNames.includes(r.rolname))).toEqual(ownedRoles);expect(current.filter(r=>!allRoleNames.includes(r.rolname))).toEqual(roleBaseline);expect((await parent.query(membersSql)).rows).toEqual(memberships);
   const oid=(await parent.query('SELECT oid::text FROM pg_database WHERE datname=$1',[database])).rows[0]?.oid;expect(oid).toBe(engineDatabaseOid);
   const deps=(await parent.query("SELECT dbid::text FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[])",[ownedRoles.map((r:any)=>r.oid)])).rows;expect(deps.every(d=>d.dbid===oid)).toBe(true);
   await parent.query('DROP DATABASE "'+database+'"');expect((await parent.query("SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=ANY($1::oid[])",[ownedRoles.map((r:any)=>r.oid)])).rows).toEqual([]);
   expect((await parent.query(rolesSql)).rows.filter(r=>allRoleNames.includes(r.rolname))).toEqual(ownedRoles);await parent.query('DROP ROLE '+allRoleNames.map(n=>'"'+n+'"').join(','));expect((await parent.query(rolesSql)).rows).toEqual(roleBaseline);
   for(const directory of privateDirectories)await rm(directory,{recursive:true});
  }}finally{await apiNative?.end();await controlNative?.end();await aiNative?.end();if(parent){if(setupComplete&&suite.tasks.every(t=>t.type==='test'&&t.result?.state==='pass'))await parent.query('DROP ROLE "'+apiLogin+'","'+controlLogin+'","'+aiLogin+'"');await parent.end();}}/* Any failure preserves DB/roles and private synthetic files for diagnosis. */
 });

 async function next(f:Awaited<ReturnType<typeof fixture>>,action:NumberLabAction){const version=Number((await parent.query('SELECT version FROM commerce_number_lab.runs WHERE id=$1',[f.input.runId])).rows[0].version);const op=await withProfileTransaction(api,f.input.workspaceId,db=>enqueueNumberLab(db,authority(f.input.workspaceId),f.input.runId,{operation_id:randomUUID(),expected_version:version,action},key));return{...f.input,operationId:op.operation_id};}
 function afterStatement(pool:ProfilePool,match:string,after:()=>Promise<void>):ProfilePool{return{async connect(){const c=await pool.connect();let armed=false;return{async query(sql,values){const r=await c.query(sql,values);if(sql.includes(match))armed=true;if(sql==='COMMIT'&&armed){armed=false;await after();}return r;},release:c.release.bind(c)};}};}

 it('delivers a canonical text effect only after encrypted inbound and ACK consumers',async()=>{
  const f=await fixture({type:'message',text:'Hello'},false,false,'text'),d=f.driver({transport:{key:randomBytes(32)}}),result=await d.execute(f.input);
  expect(result).toMatchObject({state:'APPLIED',result:{transport_phase:'APPLIED',transport_result:{sent:1,inbound:1,observations:1,statuses:{DELIVERED:1}}}});
  expect((await admin.query("SELECT body->>'status' status FROM records WHERE workspace_id=$1 AND kind='message' AND body->>'direction'='OUTBOUND'",[f.plan.workspace_id])).rows).toEqual([{status:'DELIVERED'}]);
  const rows=(await admin.query('SELECT status,attempts,provider_message_id,result FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows;expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({status:'DELIVERED',attempts:1});expect(rows[0].provider_message_id).toMatch(/^sim:/);expect(rows[0].result.ack_keys).toHaveLength(1);
  expect((await admin.query("SELECT status,payload_ciphertext FROM inbound_envelopes WHERE workspace_id=$1",[f.plan.workspace_id])).rows[0]).toMatchObject({status:'PROCESSED'});
  expect((await admin.query("SELECT event_type FROM domain_events WHERE workspace_id=$1 AND event_type IN('provider.ack.observed','message.acknowledged') ORDER BY event_type",[f.plan.workspace_id])).rows).toEqual([{event_type:'message.acknowledged'},{event_type:'provider.ack.observed'}]);
  expect((await parent.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.input.workspaceId])).rows).toEqual([]);
  expect(await d.reconcile(f.input)).toMatchObject({result:{transport_result:{statuses:{DELIVERED:1}}}});expect((await admin.query('SELECT attempts FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([{attempts:1}]);
 });
 it('delivers copied encrypted material through the same dispatcher without source mutation',async()=>{
  const f=await fixture({type:'message',text:'Send file'},false,false,'file'),physical=f.physical!;
  const d=f.driver({materials:f.physicalPort(),transport:{key:randomBytes(32),reader:createNumberLabMaterialReader(physical)}});
  expect(await d.execute(f.input)).toMatchObject({result:{transport_result:{sent:1,inbound:1,observations:1,statuses:{DELIVERED:1}}}});
  expect(await readFile(physical.origin,'utf8')).toBe(physical.raw);expect(await readFile(f.physicalPath!,'utf8')).not.toBe(physical.raw);
  expect((await admin.query('SELECT payload FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows[0].payload).toMatchObject({kind:'document',asset_id:f.plan.variants[0]!.materials[0]!.id});
 });
 it('delivers a native link only as an internal LAB descriptor while preserving REAL source',async()=>{
  const f=await fixture({type:'message',text:'Send link'},false,false,'link'),physical=f.physical!,transportKey=randomBytes(32);
  const d=f.driver({materials:f.physicalPort(),transport:{key:transportKey}});expect(await d.execute(f.input)).toMatchObject({result:{transport_result:{sent:1,inbound:1,observations:1,statuses:{DELIVERED:1}}}});
  const asset=(await admin.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='asset'",[f.plan.workspace_id])).rows[0].body;
  expect(asset).toMatchObject({kind:'link',lab_delivery:{kind:'link',delivery:'LAB_ONLY',run_id:f.input.runId,variant_id:f.candidates[0]!.release.variant_id}});expect(asset.url).toMatch(/^\/number-laboratory\//);
  const messages=(await admin.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='message' AND body->>'direction'='OUTBOUND'",[f.plan.workspace_id])).rows;expect(messages).toHaveLength(1);expect(messages[0].body.text).toBe('Enlace de prueba disponible: '+asset.url);
  expect(JSON.stringify(messages)).not.toContain('source.example.test');expect((await parent.query('SELECT record_id,workspace_id,environment,kind,version,body FROM record_versions WHERE record_id=$1 AND version=1',[f.plan.variants[0]!.materials[0]!.source.id])).rows[0]).toEqual(physical.sourceVersion);expect(await readFile(physical.origin,'utf8')).toBe(physical.raw);
 });
 async function accessFixture(){const f=await fixture({type:'message',text:'Hello'},false,false,'access'),transportKey=randomBytes(32),d=f.driver({materials:f.physicalPort(),transport:{key:transportKey}});await d.execute(f.input);
  const conversation=(await admin.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='conversation'",[f.plan.workspace_id])).rows[0].body;expect(conversation.flow_state).toMatchObject({status:'WAITING',waiting_for:'commitment'});expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);return{f,d,transportKey};
 }
 it('uses canonical commitment, grant and causal notification with an encrypted LAB receipt',async()=>{
  const {f,d,transportKey}=await accessFixture(),result=await d.execute(await next(f,{type:'message',text:'acepto'}));
  expect(result).toMatchObject({state:'APPLIED',result:{transport_result:{sent:2,inbound:2,observations:2,statuses:{DELIVERED:2}}}});
  const rows=(await admin.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence',[f.plan.workspace_id])).rows;expect(rows).toHaveLength(2);const [grant,notification]=rows;
  expect(grant.payload.kind).toBe('grant');expect(notification.predecessor_id).toBe(grant.id);expect(notification.payload.grant_effect_id).toBe(grant.id);expect(grant.attempts).toBe(1);
  const receipt=openLabValue({workspaceId:f.plan.workspace_id,runId:f.input.runId,purpose:'result',operationId:grant.id},JSON.parse(grant.result.access_ciphertext),transportKey);
  expect(receipt).toMatchObject({kind:'LAB_ACCESS_GRANT',effect_id:grant.id,grant_id:grant.payload.grant_id,material:{delivery:'LAB_ONLY',kind:'access',run_id:f.input.runId,id:f.plan.variants[0]!.materials[0]!.id}});
  const all=(await admin.query('SELECT body FROM records WHERE workspace_id=$1',[f.plan.workspace_id])).rows;expect(all.find(row=>row.body.direction==='OUTBOUND')?.body.text).toBe('Acceso de prueba disponible: /number-laboratory/'+f.input.runId+'/materials/'+f.plan.variants[0]!.materials[0]!.id);expect(JSON.stringify(all)).not.toMatch(/PRIVATE-SOURCE-CODE|source\.example\.test|Private source instructions|delivery_ciphertext/);
  expect((await parent.query('SELECT record_id,workspace_id,environment,kind,version,body FROM record_versions WHERE record_id=$1 AND version=1',[f.plan.variants[0]!.materials[0]!.source.id])).rows[0]).toEqual(f.physical!.sourceVersion);
  await d.reconcile({...f.input,operationId:(await parent.query("SELECT id FROM commerce_number_lab.operations WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1",[f.input.runId])).rows[0].id});expect((await admin.query('SELECT attempts FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([{attempts:1},{attempts:1}]);
 });
 it('keeps an uncertain native LAB grant without ACK, access receipt or automatic resend',async()=>{
  const {f,d}=await accessFixture();await withProfileTransaction(admin,f.plan.workspace_id,async db=>{await db.query("SELECT set_config('app.environment','SIMULATION',true)");await db.query("UPDATE records SET body=jsonb_set(body,'{simulated_fault}','\"UNKNOWN\"'),version=version+1 WHERE workspace_id=$1 AND kind='channel_account'",[f.plan.workspace_id]);});
  const input=await next(f,{type:'message',text:'acepto'});await d.execute(input);const before=(await admin.query('SELECT id,status,attempts,result,payload FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence',[f.plan.workspace_id])).rows;
  expect(before).toHaveLength(2);expect(before[0]).toMatchObject({status:'UNKNOWN',attempts:1,payload:{kind:'grant'}});expect(before[0].result?.access_ciphertext).toBeUndefined();expect(before[1].attempts).toBe(0);expect((await admin.query('SELECT id FROM inbound_envelopes WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);
  await d.execute(input);await d.reconcile(input);expect((await admin.query('SELECT id,status,attempts,result,payload FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence',[f.plan.workspace_id])).rows).toEqual(before);
 });
 it('sends causal text effects in their canonical predecessor order',async()=>{
  const f=await fixture({type:'message',text:'Sequence'},false,false,'sequence'),d=f.driver({transport:{key:randomBytes(32)}});
  expect(await d.execute(f.input)).toMatchObject({result:{transport_result:{sent:1,inbound:1,observations:1,projected:1,statuses:{DELIVERED:1}}}});
  // NUMBER_FLOW_TEST advances one visible node per action. Prove the native
  // cursor before continuing; do not bypass it to manufacture a second effect.
  const conversation=(await admin.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='conversation'",[f.plan.workspace_id])).rows[0].body;
  expect(conversation).toMatchObject({flow_test_single_step:true,flow_state:{steps:1,node_id:'send2',status:'WAITING',waiting_for:'simulation_continue'}});
  expect(await d.execute(await next(f,{type:'continue'}))).toMatchObject({result:{transport_result:{sent:1,inbound:1,observations:1,projected:1,statuses:{DELIVERED:2}}}});
  const rows=(await admin.query('SELECT id,predecessor_id,status FROM outbox WHERE workspace_id=$1 ORDER BY dispatch_sequence',[f.plan.workspace_id])).rows;expect(rows).toHaveLength(2);expect(rows.every(row=>row.status==='DELIVERED')).toBe(true);expect(rows[1].predecessor_id).toBe(rows[0].id);
 });
 it('preserves READY work in another run while dispatching only the captured conversation',async()=>{
  const other=await fixture({type:'message',text:'Other'},false,false,'text');await other.driver().execute(other.input);
  const f=await fixture({type:'message',text:'Mine'},false,false,'text');await f.driver({transport:{key:randomBytes(32)}}).execute(f.input);
  expect((await admin.query('SELECT status,attempts FROM outbox WHERE workspace_id=$1',[other.plan.workspace_id])).rows).toEqual([{status:'READY',attempts:0}]);
  expect((await admin.query('SELECT id FROM inbound_envelopes WHERE workspace_id=$1',[other.plan.workspace_id])).rows).toEqual([]);
 });
 it('keeps a claim unsent when physical LAB custody is unavailable',async()=>{
  const f=await fixture({type:'message',text:'File'},false,false,'file');
  const result=await f.driver({materials:f.physicalPort(),transport:{key:randomBytes(32)}}).execute(f.input);expect(result).toMatchObject({result:{transport_result:{sent:0,inbound:0,observations:0,statuses:{BLOCKED:1}}}});
  expect(result).toMatchObject({result:{pending:expect.arrayContaining(['TRANSPORT'])}});
  expect((await admin.query('SELECT attempts,result FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows[0]).toMatchObject({attempts:0,result:{reason:'LAB_DELIVERY_CUSTODY_REQUIRED'}});
  expect((await admin.query("SELECT a.status FROM effect_attempts a JOIN outbox o ON o.id=a.effect_id WHERE o.workspace_id=$1",[f.plan.workspace_id])).rows).toEqual([{status:'NOT_SENT'}]);
 });
 it('applies the canonical pause gate after claim and before a simulator ACK',async()=>{
  const f=await fixture({type:'message',text:'Pause me'},false,false,'text');let paused=false;
  const enginePool=afterStatement(scoped,'INSERT INTO effect_attempts',async()=>{if(paused)return;paused=true;const row=(await admin.query('SELECT conversation_id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows[0];await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'conversation',$2,true,'SYNTHETIC_PAUSE','fixture')",[f.plan.workspace_id,row.conversation_id]);});
  expect(await f.driver({enginePool,transport:{key:randomBytes(32)}}).execute(f.input)).toMatchObject({result:{transport_result:{sent:0,inbound:0,observations:0,statuses:{BLOCKED:1}}}});expect(paused).toBe(true);
  expect((await admin.query('SELECT attempts,result FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows[0]).toMatchObject({attempts:0,result:{reason:'OPERATION_PAUSED'}});
 });
 it('preserves uncertain simulator commit without replaying or promoting its early ACK',async()=>{
  const f=await fixture({type:'message',text:'Lost ACK'},false,false,'text');let lost=false;
  const enginePool=afterStatement(scoped,'INSERT INTO inbound_envelopes',async()=>{if(!lost){lost=true;throw Error('SYNTHETIC_SIMULATOR_ACK_LOST');}});
  await expect(f.driver({enginePool,transport:{key:randomBytes(32)}}).execute(f.input)).rejects.toThrow();expect(lost).toBe(true);
  expect((await admin.query('SELECT status,attempts FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([{status:'SENDING',attempts:1}]);
  expect((await admin.query('SELECT status FROM inbound_envelopes WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([{status:'PENDING'}]);
  expect(await f.driver({transport:{key:randomBytes(32)}}).execute(f.input)).toMatchObject({state:'ALREADY_ATTEMPTED',read_only:true});
  expect((await admin.query('SELECT attempts FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([{attempts:1}]);
 });
 it('executes canonical inbound/workflow and settles two native encrypted stages',async()=>{const f=await fixture(),result=await f.driver().execute(f.input);expect(result).toMatchObject({state:'APPLIED',result:{state:'WORKFLOWS_APPLIED',workflow_phase:'APPLIED',external_effects:0}});const messages=(await admin.query("SELECT body FROM records WHERE workspace_id=$1 AND kind='message'",[f.plan.workspace_id])).rows;expect(messages).toHaveLength(1);expect(messages[0].body.text).toBe('Synthetic');expect((await admin.query('SELECT status,idempotency_key FROM commands WHERE id=$1',[f.input.operationId])).rows).toEqual([{status:'APPLIED',idempotency_key:f.input.operationId}]);expect((await admin.query('SELECT stage FROM commerce_number_lab_engine.driver_receipts WHERE run_id=$1 ORDER BY stage',[f.input.runId])).rows).toEqual([{stage:'ACTION_APPLIED'},{stage:'SETTLED'}]);expect((await admin.query('SELECT state FROM commerce_number_lab_engine.executions WHERE run_id=$1',[f.input.runId])).rows[0].state).toBe('APPLIED');await expect(runtime.lease(f.binding)).rejects.toThrow('LAB_ENGINE_BINDING_REQUIRED');});
 it('records selection without a fabricated customer message',async()=>{const f=await fixture({type:'continue'});const selection=await next(f,{type:'select_variant',variant_id:f.candidates[0]!.release.variant_id,origin:'EXPLICIT'}).catch(()=>null);expect(selection).toBeNull(); // pending original operation cannot be bypassed
  expect(await f.driver().execute(f.input)).toMatchObject({state:'FAILED',result:{reason:'LAB_CONVERSATION_REQUIRED',command_id:null}});
  const input=await next(f,{type:'select_variant',variant_id:f.candidates[0]!.release.variant_id,origin:'EXPLICIT'});expect(await f.driver().execute(input)).toMatchObject({state:'APPLIED',result:{state:'SELECTION_RECORDED',command_id:null}});expect((await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='message'",[f.plan.workspace_id])).rows).toEqual([]);});
 it.each<NumberLabAction>([{type:'continue'},{type:'advance',hours:2}])('settles $type before first message without advancing time and accepts the next real message',async action=>{
  const f=await fixture(action),before=(await parent.query('SELECT virtual_now FROM commerce_number_lab.runs WHERE id=$1',[f.input.runId])).rows[0].virtual_now;
  expect(await f.driver().execute(f.input)).toMatchObject({state:'FAILED',result:{state:'DEPENDENCY_REQUIRED',reason:'LAB_CONVERSATION_REQUIRED',command_id:null,external_effects:0}});
  expect((await parent.query('SELECT virtual_now FROM commerce_number_lab.runs WHERE id=$1',[f.input.runId])).rows[0].virtual_now).toEqual(before);
  expect((await admin.query('SELECT id FROM commands WHERE id=$1',[f.input.operationId])).rows).toEqual([]);
  expect(await f.driver().reconcile(f.input)).toMatchObject({state:'FAILED',result:{reason:'LAB_CONVERSATION_REQUIRED'}});
  const message=await next(f,{type:'message',text:'First real fixture input'});
  expect(await f.driver().execute(message)).toMatchObject({state:'APPLIED',result:{state:'WORKFLOWS_APPLIED'}});
  expect((await admin.query("SELECT body->>'text' text FROM records WHERE workspace_id=$1 AND kind='message'",[f.plan.workspace_id])).rows).toEqual([{text:'First real fixture input'}]);
 });
 it('retains an unresolved real text until an explicit captured F4 selection',async()=>{const f=await fixture({type:'message',text:'Original customer text'},true);expect(await f.driver().execute(f.input)).toMatchObject({state:'APPLIED',result:{state:'SELECTION_REQUIRED',command_id:null}});expect((await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='message'",[f.plan.workspace_id])).rows).toEqual([]);const selected=await next(f,{type:'select_variant',variant_id:f.candidates[1]!.release.variant_id,origin:'ADVERTISEMENT'});expect(await f.driver().execute(selected)).toMatchObject({state:'APPLIED',result:{variant_id:f.candidates[1]!.release.variant_id,state:'WORKFLOWS_APPLIED'}});const messages=(await admin.query("SELECT body->>'text' text FROM records WHERE workspace_id=$1 AND kind='message'",[f.plan.workspace_id])).rows;expect(messages).toEqual([{text:'Original customer text'}]);});
 it('advances the canonical virtual clock and control clock by the same eight hours',async()=>{const f=await fixture();await f.driver().execute(f.input);const before=(await parent.query('SELECT virtual_now FROM commerce_number_lab.runs WHERE id=$1',[f.input.runId])).rows[0].virtual_now;const input=await next(f,{type:'advance',hours:8});expect(await f.driver().execute(input)).toMatchObject({state:'APPLIED'});const after=(await parent.query('SELECT virtual_now FROM commerce_number_lab.runs WHERE id=$1',[f.input.runId])).rows[0].virtual_now;expect(after.getTime()-before.getTime()).toBe(8*3600000);expect((await admin.query("SELECT body->>'virtual_now' value FROM records WHERE id=$1",[f.input.runId])).rows[0].value).toBe(after.toISOString());});
 it('never reapplies a repeated operation or a read-only observation',async()=>{const f=await fixture();await f.driver().execute(f.input);const before=await count(f.plan.workspace_id);expect(await f.driver().execute(f.input)).toMatchObject({state:'ALREADY_ATTEMPTED',read_only:true});expect(await f.driver().observe(f.input)).toMatchObject({operation_state:'APPLIED',read_only:true});expect(await count(f.plan.workspace_id)).toBe(before);expect((await admin.query('SELECT count(*)::int n FROM commands WHERE id=$1',[f.input.operationId])).rows[0].n).toBe(1);});
 it('preserves committed action after lost command ACK and reconciles without replaying it',async()=>{const f=await fixture(),enginePool=afterStatement(scoped,'INSERT INTO commands',async()=>{throw Error('SYNTHETIC_COMMAND_ACK_LOST');});await expect(f.driver({enginePool}).execute(f.input)).rejects.toThrow('SYNTHETIC_COMMAND_ACK_LOST');expect(await f.driver().observe(f.input)).toMatchObject({operation_state:'INTENT',receipt:{stage:'ACTION_APPLIED'}});expect(await f.driver().reconcile(f.input)).toMatchObject({state:'APPLIED',result:{state:'COMMAND_APPLIED',workflow_phase:'PENDING'}});expect((await admin.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind='message'",[f.plan.workspace_id])).rows[0].n).toBe(1);});
 it('reconciles a lost control settlement ACK using the exact native final receipt',async()=>{const f=await fixture(),controlPool=afterStatement(control,"UPDATE commerce_number_lab.runs SET state",async()=>{throw Error('SYNTHETIC_SETTLEMENT_ACK_LOST');});await expect(f.driver({controlPool}).execute(f.input)).rejects.toThrow('SYNTHETIC_SETTLEMENT_ACK_LOST');expect(await f.driver().reconcile(f.input)).toMatchObject({state:'APPLIED',result:{state:'WORKFLOWS_APPLIED'}});expect((await parent.query('SELECT version FROM commerce_number_lab.runs WHERE id=$1',[f.input.runId])).rows[0].version).toBe('2');});
 it('keeps INTENT with no receipt after a canonical transaction failure',async()=>{const f=await fixture();await admin.query("CREATE FUNCTION public.fail_driver_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_COMMAND_FAILED';END $$;CREATE TRIGGER fail_driver_command BEFORE INSERT ON commands FOR EACH ROW EXECUTE FUNCTION public.fail_driver_command()");try{await expect(f.driver().execute(f.input)).rejects.toThrow('SYNTHETIC_COMMAND_FAILED');}finally{await admin.query('DROP TRIGGER fail_driver_command ON commands;DROP FUNCTION public.fail_driver_command()');}expect(await f.driver().observe(f.input)).toMatchObject({operation_state:'INTENT',receipt:null});await expect(f.driver().reconcile(f.input)).rejects.toThrow('LAB_DRIVER_RECEIPT_REQUIRED');expect((await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='simulation'",[f.plan.workspace_id])).rows).toEqual([]);});
 it('fails unsupported attachment work explicitly without manufacturing a receipt or external effect',async()=>{const f=await fixture({type:'receipt',attachment_id:randomUUID()});expect(await f.driver().execute(f.input)).toMatchObject({state:'FAILED',result:{state:'DEPENDENCY_REQUIRED',reason:'LAB_ATTACHMENT_DRIVER_REQUIRED',external_effects:0}});expect((await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='receipt'",[f.plan.workspace_id])).rows).toEqual([]);});
 it('rejects a profile suspended after native materialization before the canonical command',async()=>{const f=await fixture(),seedPool=afterStatement(seed,"SET state='READY'",async()=>{await parent.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[f.input.workspaceId]);});await expect(f.driver({seedPool}).execute(f.input)).rejects.toThrow('LAB_PROFILE_INACTIVE');expect((await admin.query('SELECT id FROM commands WHERE id=$1',[f.input.operationId])).rows).toEqual([]);});
 it('rejects suspension that wins after initial control read and before engine phase',async()=>{const f=await fixture();let changed=false;const controlPool=afterStatement(control,'o.action_ciphertext',async()=>{if(!changed){changed=true;await parent.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[f.input.workspaceId]);}});
  await expect(f.driver({controlPool}).execute(f.input)).rejects.toThrow('LAB_PROFILE_INACTIVE');expect(changed).toBe(true);expect((await admin.query('SELECT id FROM commands WHERE id=$1',[f.input.operationId])).rows).toEqual([]);
 });
 it('holds native control locks through engine COMMIT and blocks a concurrent suspension',async()=>{const f=await fixture(),writer=await parent.connect();let suspension:Promise<pg.QueryResult>|undefined,blocked=false;const writerPid=Number((await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  const enginePool:ProfilePool={async connect(){const c=await scoped.connect();return{async query(sql,values){const r=await c.query(sql,values);if(sql.startsWith('INSERT INTO commands')&&!suspension){suspension=writer.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[f.input.workspaceId]);void suspension.catch(()=>undefined);
    for(let n=0;n<50;n++){const row=(await parent.query('SELECT cardinality(pg_blocking_pids($1)) n',[writerPid])).rows[0];if(Number(row.n)>0){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);
   }return r;},release:c.release.bind(c)};}};
  const controlPool:ProfilePool={async connect(){const c=await control.connect();return{async query(sql,values){const r=await c.query(sql,values);if(sql==='COMMIT'&&suspension)await suspension;return r;},release:c.release.bind(c)};}};
  try{await expect(f.driver({enginePool,controlPool}).execute(f.input)).rejects.toThrow('LAB_PROFILE_INACTIVE');await suspension;expect(blocked).toBe(true);expect((await admin.query('SELECT status FROM commands WHERE id=$1',[f.input.operationId])).rows).toEqual([{status:'APPLIED'}]);expect((await admin.query('SELECT stage FROM commerce_number_lab_engine.driver_receipts WHERE run_id=$1',[f.input.runId])).rows).toEqual([{stage:'ACTION_APPLIED'}]);}finally{await suspension;writer.release();}
 });
 it('rejects foreign control scope before accessing engine contents',async()=>{const f=await fixture(),g=await fixture();await expect(f.driver().execute({...f.input,workspaceId:g.input.workspaceId})).rejects.toThrow('LAB_OPERATION_MISSING');expect(await count(f.plan.workspace_id)).toBe(0);});
 it('does not grant other command kinds or mutable driver receipts',async()=>{const f=await fixture();await f.factory().prepare(f.input);await expect(withNumberLabEngine(await runtime.lease(f.binding),p=>p.transaction(db=>db.query("INSERT INTO commands(id,workspace_id,environment,kind,resource_id,actor_id,idempotency_key) VALUES($1::uuid,$2,'SIMULATION','channel_command',$1::text,'number-laboratory',$1::text)",[f.input.operationId,f.plan.workspace_id])))).rejects.toThrow('LAB_DRIVER_COMMAND_REQUIRED');const g=await fixture();await g.driver().execute(g.input);await expect(admin.query("UPDATE commerce_number_lab_engine.driver_receipts SET stage='ACTION_APPLIED' WHERE run_id=$1",[g.input.runId])).rejects.toThrow('LAB_DRIVER_RECEIPT_IMMUTABLE');});
 function sellerResponse(proposal:unknown={reply:'Synthetic seller reply',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']}){return new Response(JSON.stringify({model:'synthetic',status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(proposal)}]}],usage:{input_tokens:3,output_tokens:1,input_tokens_details:{cached_tokens:0}}}),{headers:{'content-type':'application/json'}});}
 async function aiRuns(f:Awaited<ReturnType<typeof fixture>>){return(await admin.query("SELECT id,body FROM records WHERE workspace_id=$1 AND kind='ai_run'",[f.plan.workspace_id])).rows;}
 it('runs the canonical seller through separate native budgets and reconciles only simulated effects',async()=>{const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let calls=0;
  const driver=f.driver({seller:{...f.sellerConfiguration!,fetcher:async(url,init)=>{calls++;expect(String(url)).toBe('https://api.openai.com/v1/responses');expect(JSON.parse(String(init?.body)).instructions).toContain('Never confirm commitment');const a=(await aiRuns(f))[0];expect((await parent.query('SELECT state FROM ai_attempts WHERE attempt_id=$1',[a.id])).rows[0].state).toBe('INTENT');return sellerResponse();}}});
  expect(await driver.execute(f.input)).toMatchObject({state:'APPLIED',result:{ai_phase:'APPLIED',ai_network:'PROFILE_AI_ONLY',ai_result:{status:'COMPLETED',provider_state:'SUCCEEDED',human_review:false}}});expect(calls).toBe(1);
  const runs=await aiRuns(f);expect(runs).toHaveLength(1);expect(runs[0].body).toMatchObject({status:'COMPLETED',lab_ai:{operation_class:'TEST',execution_environment:'SIMULATION',state:'SUCCEEDED',outcome:{costMicrousd:5}}});expect(runs[0].body.usage?.cost_minor).toBeUndefined();
  expect((await admin.query("SELECT environment,payload->>'purpose' purpose FROM outbox WHERE workspace_id=$1",[f.plan.workspace_id])).rows).toEqual([{environment:'SIMULATION',purpose:'seller_reply'}]);
  expect((await parent.query('SELECT operation_class,measured_cost_microusd FROM result_ai_cost_facts WHERE attempt_id=$1',[runs[0].id])).rows).toEqual([{operation_class:'TEST',measured_cost_microusd:'5'}]);
  expect(await driver.execute(f.input)).toMatchObject({state:'ALREADY_ATTEMPTED'});expect(calls).toBe(1);
 });
 it('keeps canonical grounding and human review after a measured unsupported proposal',async()=>{const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let calls=0;
  await f.driver({seller:{...f.sellerConfiguration!,fetcher:async()=>{calls++;return sellerResponse({reply:'Invented',intent:'question',confidence:1,tool:'none',grounding:['foreign_source']});}}}).execute(f.input);
  expect(calls).toBe(1);expect((await aiRuns(f))[0].body.lab_ai.outcome.costMicrousd).toBe(5);expect((await admin.query("SELECT body->>'ai_status' state FROM records WHERE workspace_id=$1 AND kind='conversation'",[f.plan.workspace_id])).rows[0].state).toBe('HUMAN_REVIEW');expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);
 });
 it('preserves native uncertainty without a second provider call or fabricated usage',async()=>{const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let calls=0;const d=f.driver({seller:{...f.sellerConfiguration!,fetcher:async()=>{calls++;return new Response('',{status:500});}}});expect(await d.execute(f.input)).toMatchObject({result:{ai_result:{status:'FAILED',provider_state:'UNCERTAIN',human_review:true}}});const a=(await aiRuns(f))[0];expect(a.body).toMatchObject({status:'FAILED',lab_ai:{state:'UNCERTAIN',code:'HTTP_UNKNOWN'}});expect((await parent.query('SELECT charged_microusd,measured_cost_microusd FROM ai_attempts WHERE attempt_id=$1',[a.id])).rows[0]).toEqual({charged_microusd:'120',measured_cost_microusd:null});await d.reconcile(f.input);await d.execute(f.input);expect(calls).toBe(1);});
 it('applies canonical opt-out as suppression and never proposes the model text',async()=>{const f=await fixture({type:'message',text:'Please stop'},false,true);await f.driver({seller:{...f.sellerConfiguration!,fetcher:async()=>sellerResponse({reply:'Suppressed',intent:'opt_out',confidence:1,tool:'none',grounding:[]})}}).execute(f.input);expect((await admin.query('SELECT suppressed FROM manual_controls WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([{suppressed:true}]);expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);});
 it('blocks suspension before seller INTENT with no provider request and preserves the reservation',async()=>{const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let changed=false,calls=0;
  const enginePool=afterStatement(scoped,"kind='conversation'",async()=>undefined);
  const sourceAi:ProfilePool={async connect(){const c=await aiPool.connect();let reserved=false;return{async query(sql,v){const r=await c.query(sql,v);if(sql.startsWith('INSERT INTO ai_attempts'))reserved=true;if(sql==='COMMIT'&&reserved&&!changed){changed=true;await parent.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[f.input.workspaceId]);}return r;},release:c.release.bind(c)};}};
  await expect(f.driver({enginePool,seller:{...f.sellerConfiguration!,enterprisePool:sourceAi,fetcher:async()=>{calls++;return sellerResponse();}}}).execute(f.input)).rejects.toThrow('LAB_ENGINE_LEASE_CLOSED');expect(changed).toBe(true);expect(calls).toBe(0);const a=(await aiRuns(f))[0];expect((await parent.query('SELECT intent_at,charged_microusd FROM ai_attempts WHERE attempt_id=$1',[a.id])).rows[0]).toEqual({intent_at:null,charged_microusd:'120'});
 });

 it('keeps the cached canonical proposal across commercial pause without another provider call',async()=>{const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let calls=0;
  const d=f.driver({seller:{...f.sellerConfiguration!,fetcher:async()=>{calls++;const conversation=(await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='conversation'",[f.plan.workspace_id])).rows[0];await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'conversation',$2,true,'SYNTHETIC_PAUSE','fixture')",[f.plan.workspace_id,conversation.id]);return sellerResponse();}}});
  await d.execute(f.input);expect((await aiRuns(f))[0].body.status).toBe('AWAITING_EFFECT');expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);
  await admin.query("UPDATE manual_controls SET paused=false,version=version+1 WHERE workspace_id=$1",[f.plan.workspace_id]);const continued=await next(f,{type:'continue'});await d.execute(continued);expect(calls).toBe(1);expect((await aiRuns(f))[0].body.status).toBe('COMPLETED');expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toHaveLength(1);
 });
 async function pausedSeller(){const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let calls=0;
  const seller={...f.sellerConfiguration!,fetcher:async()=>{calls++;const conversation=(await admin.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='conversation'",[f.plan.workspace_id])).rows[0];await admin.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'conversation',$2,true,'SYNTHETIC_PAUSE','fixture')",[f.plan.workspace_id,conversation.id]);return sellerResponse();}};
  await f.driver({seller}).execute(f.input);const run=(await aiRuns(f))[0];expect(run.body.status).toBe('AWAITING_EFFECT');
  await admin.query("UPDATE manual_controls SET paused=false,version=version+1 WHERE workspace_id=$1",[f.plan.workspace_id]);
  return{f,seller,run,get calls(){return calls;}};
 }
 it.each(['key','grant','grant_expiry'] as const)('keeps a paid cached proposal without effect or new charge after %s changes',async change=>{
  const p=await pausedSeller(),{f,run,seller}=p;
  const before=(await parent.query('SELECT * FROM ai_attempts WHERE attempt_id=$1',[run.id])).rows[0];
  await withProfileTransaction(api,f.input.workspaceId,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");await db.query("SELECT ai_scope_lock($1,'REAL')",[f.input.workspaceId]);
   if(change==='key')await db.query('UPDATE ai_credentials SET enabled=false WHERE workspace_id=$1 AND id=$2',[f.input.workspaceId,before.credential_id]);
   else await db.query('UPDATE ai_runtime_grants SET version=version+1,'+(change==='grant'?'revoked_at=clock_timestamp()':'expires_at=clock_timestamp()')+' WHERE workspace_id=$1 AND id=$2',[f.input.workspaceId,before.grant_id]);
  });
  const continued=await next(f,{type:'continue'});expect(await f.driver({seller}).execute(continued)).toMatchObject({state:'APPLIED',result:{ai_result:{status:'AWAITING_EFFECT',provider_state:'SUCCEEDED',dependency:'AI_AUTHORITY_UNAVAILABLE'}}});
  expect(p.calls).toBe(1);expect((await aiRuns(f))[0].body.proposal).toEqual(run.body.proposal);expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);
  expect((await parent.query('SELECT * FROM ai_attempts WHERE attempt_id=$1',[run.id])).rows[0]).toEqual(before);
  expect((await parent.query("SELECT count(*)::int n FROM ai_attempts WHERE workspace_id=$1 AND task='laboratory.chat'",[f.input.workspaceId])).rows[0].n).toBe(1);
 });
 it.each(['key','grant'] as const)('preserves a newly paid proposal without effects when %s is revoked during the provider call',async change=>{
  const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let calls=0;
  const seller={...f.sellerConfiguration!,fetcher:async()=>{calls++;const run=(await aiRuns(f))[0];const attempt=(await parent.query('SELECT credential_id,grant_id FROM ai_attempts WHERE attempt_id=$1',[run.id])).rows[0];
   await withProfileTransaction(api,f.input.workspaceId,async db=>{await db.query("SELECT set_config('app.environment','REAL',true)");await db.query("SELECT ai_scope_lock($1,'REAL')",[f.input.workspaceId]);
    if(change==='key')await db.query('UPDATE ai_credentials SET enabled=false WHERE workspace_id=$1 AND id=$2',[f.input.workspaceId,attempt.credential_id]);
    else await db.query('UPDATE ai_runtime_grants SET version=version+1,revoked_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[f.input.workspaceId,attempt.grant_id]);
   });return sellerResponse();}};
  expect(await f.driver({seller}).execute(f.input)).toMatchObject({state:'APPLIED',result:{ai_result:{status:'AWAITING_EFFECT',provider_state:'SUCCEEDED',dependency:'AI_AUTHORITY_UNAVAILABLE'}}});
  const run=(await aiRuns(f))[0],before=(await parent.query('SELECT * FROM ai_attempts WHERE attempt_id=$1',[run.id])).rows[0];
  expect(run.body.proposal.reply).toBe('Synthetic seller reply');expect(run.body.lab_ai.outcome.costMicrousd).toBe(5);
  expect(before).toMatchObject({state:'SUCCEEDED',charged_microusd:'5',measured_cost_microusd:'5'});
  expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);
  const continued=await next(f,{type:'continue'});expect(await f.driver({seller}).execute(continued)).toMatchObject({result:{ai_result:{status:'AWAITING_EFFECT',dependency:'AI_AUTHORITY_UNAVAILABLE'}}});
  expect(calls).toBe(1);expect((await parent.query('SELECT * FROM ai_attempts WHERE attempt_id=$1',[run.id])).rows[0]).toEqual(before);
  expect((await parent.query("SELECT count(*)::int n FROM ai_attempts WHERE workspace_id=$1 AND task='laboratory.chat'",[f.input.workspaceId])).rows[0].n).toBe(1);
  expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);
 });
 it('holds current AI authority until the cached engine effect commits',async()=>{
  const p=await pausedSeller(),{f,run,seller}=p,writer=await parent.connect();const a=(await parent.query('SELECT credential_id FROM ai_attempts WHERE attempt_id=$1',[run.id])).rows[0];
  let revocation:Promise<pg.QueryResult>|undefined,blocked=false;const pid=Number((await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid);
  await writer.query('BEGIN');await writer.query("SELECT set_config('app.workspace_id',$1,true)",[f.input.workspaceId]);
  const enginePool:ProfilePool={async connect(){const c=await scoped.connect();return{async query(sql,values){const result=await c.query(sql,values);
   if(sql.includes('INSERT INTO outbox')&&!revocation){revocation=writer.query('UPDATE ai_credentials SET enabled=false WHERE workspace_id=$1 AND id=$2',[f.input.workspaceId,a.credential_id]);void revocation.catch(()=>undefined);
    for(let n=0;n<50;n++){if(Number((await parent.query('SELECT cardinality(pg_blocking_pids($1)) n',[pid])).rows[0].n)>0){blocked=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}expect(blocked).toBe(true);
   }return result;},release:c.release.bind(c)};}};
  try{const continued=await next(f,{type:'continue'});await f.driver({enginePool,seller}).execute(continued);await revocation;await writer.query('COMMIT');
   expect(blocked).toBe(true);expect(p.calls).toBe(1);expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toHaveLength(1);
  }finally{await writer.query('ROLLBACK');writer.release();}
 });
 it('retains measured provider cost after profile suspension without claiming an engine response',async()=>{const f=await fixture({type:'message',text:'Tell me about the offer'},false,true);let calls=0;
  const d=f.driver({seller:{...f.sellerConfiguration!,fetcher:async()=>{calls++;await parent.query("UPDATE profiles SET state='SUSPENDED',version=version+1 WHERE id=$1",[f.input.workspaceId]);return sellerResponse();}}});
  await expect(d.execute(f.input)).rejects.toThrow('LAB_PROFILE_INACTIVE');expect(calls).toBe(1);const a=(await aiRuns(f))[0];expect(a.body.status).toBe('RUNNING');expect(a.body.proposal).toBeUndefined();expect((await parent.query('SELECT state,measured_cost_microusd FROM ai_attempts WHERE attempt_id=$1',[a.id])).rows[0]).toEqual({state:'SUCCEEDED',measured_cost_microusd:'5'});expect((await admin.query('SELECT id FROM outbox WHERE workspace_id=$1',[f.plan.workspace_id])).rows).toEqual([]);
 });

});
