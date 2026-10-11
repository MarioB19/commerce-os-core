import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,listRecords} from '../../packages/db/src/index.js';
import {applyMclRelease,compileMclPublicationPlan,mclImportIdempotencyKey,type MclApi,type MclIdempotencyBinding,type MclImportState} from '../../scripts/import-mi-ciclo-listo.js';
const workspace='mcl-import-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:Awaited<ReturnType<typeof createApp>>,cookie:string,dir:string;
const releaseHash='a'.repeat(64),configHash='b'.repeat(64);
const importerBinding:MclIdempotencyBinding={release_sha256:releaseHash,private_configuration_sha256:configHash,source_sha:'c'.repeat(40),compiler_sha256:'d'.repeat(64),compiled_plan_sha256:'e'.repeat(64),audio_review_sha256:'f'.repeat(64),approval_sha256:'1'.repeat(64)};
const api:MclApi=async(path,body,method='POST',key=randomUUID())=>{
	 const r=await app.inject({method:body===undefined?'GET':method as any,url:'/v1'+path+'?environment=SIMULATION',headers:{cookie,origin,'idempotency-key':mclImportIdempotencyKey(importerBinding,'SIMULATION',key)},...(body===undefined?{}:{payload:body as Record<string,unknown>})});
 expect(r.statusCode,r.body).toBeLessThan(300);return r.json().data;
};
beforeAll(async()=>{app=await createApp();dir=await mkdtemp(join(tmpdir(),'mcl-import-fixture-'));const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic importer owner',email,password,workspace_id:workspace,role:'owner'});const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});expect(r.statusCode).toBe(200);cookie=r.cookies.map(c=>c.name+'='+c.value).join('; ');});
afterAll(async()=>{await app.close();await pool.end();await rm(dir,{recursive:true,force:true});});
it('resumes an uncertain publish through the same API key and updates one canonical product without providers or numbers',async()=>{
 const product=await api('/products',{name:'Synthetic canonical Mi Ciclo Listo'});
 const access=async(tier:string)=>api('/assets',{name:'Synthetic '+tier,kind:'access',adapter:'link',delivery_reference:JSON.stringify({url:'https://example.invalid/portal',code:'fixture-'+tier,instructions:'Introduce el código de acceso sintético'})});
 const core=await access('Core'),kit=await access('Kit'),bank=await api('/bank-profiles',{name:'Synthetic bank',bank:'Fixture',holder:'Fixture',account_number:'0000'}),policy=await api('/receipt-policies',{name:'Synthetic manual review',auto_approve:false});
 const media=[];
 for(const key of ['pitch','agreement','collection','followup1','followup2','mockup','calendar']){const bytes=key==='mockup'?Buffer.from([137,80,78,71,13,10,26,10]):Buffer.from(key==='calendar'?'%PDF-1.4\nSynthetic fixture only\n%%EOF':'ID3 synthetic audio fixture '+key);const path=join(dir,key);await writeFile(path,bytes);media.push({key,path,sha256:createHash('sha256').update(bytes).digest('hex'),mime:key==='mockup'?'image/png':key==='calendar'?'application/pdf':'audio/mpeg',approval:'APPROVED'});}
 const corePdfs=[];
 for(let index=1;index<=9;index++){const bytes=Buffer.from(`%PDF-1.4\nSynthetic Core ${index}\n%%EOF`),sourcePath=join(dir,`core-${index}.pdf`);await writeFile(sourcePath,bytes);corePdfs.push({sourcePath,sha256:createHash('sha256').update(bytes).digest('hex')});}
 const needed=['WA00_ENTRADA','WA06_MOCKUP','WA07_OFERTA','WA08_ACUERDO','WA11_COBRO','WA24_SEGUIMIENTO_1','WA25_SEGUIMIENTO_2'];
	 const release={product:{displayName:'Mi Ciclo Listo · Preescolar y Primaria',productVersion:'synthetic',corePdfs,calendarPdf:{sourcePath:media[6]!.path,sha256:media[6]!.sha256}},messages:{messages:Array.from({length:34},(_,i)=>({id:needed[i]??'FIXTURE_'+i,text:'Contenido sintético '+i}))},knowledge:{systemPrompt:'Respetar precios, acuerdo y revisión humana.',faq:[]},media:{assets:media.slice(0,6)},review:{release_sha256:releaseHash}} as any;
	 const compiled=compileMclPublicationPlan(release);release.review={release_sha256:releaseHash,source_sha:importerBinding.source_sha,compiler:{sha256:importerBinding.compiler_sha256},compiled_plan:compiled.summary,hashes:{audio_review:importerBinding.audio_review_sha256}};importerBinding.compiled_plan_sha256=compiled.summary.sha256;
	 const state:MclImportState={release_sha256:releaseHash,configuration_sha256:configHash,source_sha:importerBinding.source_sha,compiler_sha256:importerBinding.compiler_sha256,compiled_plan_sha256:compiled.summary.sha256,audio_review_sha256:importerBinding.audio_review_sha256,approval_sha256:importerBinding.approval_sha256,environment:'SIMULATION',product_id:product.id,initial_product_version:product.version,steps:{},status:'PREPARED'};
 const refs={core:core.id,kit:kit.id,bank:bank.id,policy:policy.id};let failOnce=true;
 const uncertain:MclApi=async(path,body,method,key)=>{const r=await api(path,body,method,key);if(key==='workflow-publish'&&failOnce){failOnce=false;throw Error('SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT');}return r;};
 await expect(applyMclRelease(release,state,uncertain,async()=>{},refs)).rejects.toThrow('SYNTHETIC_RESPONSE_LOST_AFTER_COMMIT');expect(state.status).toBe('PARTIAL_RESUMABLE');
 const result=await applyMclRelease(release,state,api,async()=>{},refs);expect(result).toMatchObject({status:'CATALOG_PUBLISHED_CONNECTIONS_PENDING',ids:{product:product.id,core:core.id,kit:kit.id},sending_enabled:false,provider_evaluated:false});
 const replay=await applyMclRelease(release,state,api,async()=>{},refs);expect(replay).toEqual(result);
 for(const[kind,count]of [['product',1],['agent',1],['offer',2],['workflow',2],['asset',18],['channel_account',0]]as const)expect(await listRecords(pool,workspace,kind,'SIMULATION')).toHaveLength(count);
 const config=await api('/products/'+product.id+'/configuration');expect(config.configuration_published).toBe(true);expect(config.connections.sales_ai).toMatchObject({configured:false,state:'PROVIDER_PENDING',model:null});expect(config.accounts).toEqual([]);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);expect((await pool.query('SELECT count(*)::int n FROM integration_settings WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
});
