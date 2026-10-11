import {afterAll,afterEach,beforeAll,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {retirementFixture} from './platform-retirement-fixture.js';
import {pool,encrypt} from '../../packages/db/src/index.js';
import {MODEL,processIntelligenceAnalysis} from '../../packages/intelligence/src/index.js';
let f:Awaited<ReturnType<typeof retirementFixture>>,serial=0;
const call=(method:any,url:string,payload?:any)=>f.app.inject({method,url:url+'?environment=REAL',payload,remoteAddress:'192.0.2.'+(++serial%240+1),headers:{cookie:f.cookie,origin:f.origin,'idempotency-key':randomUUID()}});
beforeAll(async()=>{f=await retirementFixture();
 await pool.query("INSERT INTO creative_settings(workspace_id,environment,provider,version,enabled,config,secret_ciphertext) VALUES($1,'REAL','openai',1,true,$2,$3)",[f.workspace,{models:[MODEL]},encrypt({api_key:'synthetic-no-real-provider-key'})]);
 await pool.query("INSERT INTO creative_budgets(id,workspace_id,environment,provider,limit_usd,max_units,authorization_source,actor_id,expires_at) VALUES($1,$2,'REAL','openai',.10,100000,'Isolated synthetic test only',$3,now()+interval '1 hour')",[randomUUID(),f.workspace,f.user.id]);
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});afterAll(async()=>{await f.app.close();await pool.end();});
it.each([
 ['completed','unlisted-source','ANALYSIS_UNKNOWN_EVIDENCE'],
 ['incomplete','source-present','ANALYSIS_INCOMPLETE'],
] as const)('keeps the paid %s receipt and failed batch through read and reconciliation without another provider POST',async(status,citation,errorCode)=>{
 const adId='source-present',key=randomUUID(),search=(await call('POST','/v1/intelligence/searches',{name:'Synthetic invalid format '+key,query:{q:'synthetic fixture',country:'MX'}})).json().data;
 const imported=await call('POST','/v1/intelligence/import',{search_id:search.id,expected_version:search.version,observed_at:new Date().toISOString(),source_url:'https://example.invalid/source',ads:[{ad_archive_id:adId,page_id:key,snapshot:{title:'Synthetic source',body:{text:'Incluye PDF. Precio $97 MXN.'},link_url:'https://example.invalid/'+key}}]});expect(imported.statusCode,imported.body).toBe(201);
 const run=(await call('GET','/v1/intelligence/runs/'+imported.json().data.id)).json().data,offer=(await call('GET','/v1/intelligence/offers/'+run.observations[0].offer_id)).json().data;
 const providerResult={id:'synthetic-response-'+key,status,usage:{input_tokens:100,output_tokens:100},output_text:JSON.stringify({summary_es:'Synthetic response',observed_offer:'PDF',audience_inference:'Unknown',angles:[],claims:[{claim:'PDF',evidence_ad_ids:[citation],type:'OBSERVED',confidence:'LOW'}],unknowns:['Ventas desconocidas'],modalities_analyzed:['text']})};
 const send=vi.fn(async()=>Response.json(providerResult));vi.stubGlobal('fetch',send);
 const queued=await call('POST','/v1/intelligence/offers/'+offer.id+'/analyze',{expected_version:offer.version});expect(queued.statusCode,queued.body).toBe(202);const id=queued.json().data.id;
 const process=async()=>processIntelligenceAnalysis((await pool.query('SELECT * FROM intelligence_analyses WHERE id=$1',[id])).rows[0]);await process();
 const read=await call('GET','/v1/intelligence/analyses/'+id),analysis=read.json().data;expect(analysis,read.body).toMatchObject({status:'FAILED',result:{error_code:errorCode},costs:{confirmed_usd:.000525,unknown_operations:0,reserved_usd:0,operations:1}});expect(analysis.provider_operation_id).toBeTruthy();expect(analysis.batches[0]).toMatchObject({status:'FAILED',provider_operation_id:analysis.provider_operation_id});
 const batch=(await call('GET',`/v1/intelligence/analyses/${id}/batches/0`)).json().data;expect(batch.result).toMatchObject({error_code:errorCode,provider_result_status:'CONFIRMED'});
 const operation=(await pool.query('SELECT * FROM creative_provider_operations WHERE id=$1',[analysis.provider_operation_id])).rows[0];expect(operation.status).toBe('CONFIRMED');expect(operation.result).toEqual(providerResult);expect(Number(operation.confirmed_cost)).toBe(.000525);
 const reconciled=await call('POST','/v1/intelligence/analyses/'+id+'/reconcile',{content_hash:analysis.content_hash,expected_status:'FAILED'});expect(reconciled.statusCode,reconciled.body).toBe(200);expect(reconciled.json().data.paid_post_repeated).toBe(false);await process();
 const replay=(await call('GET','/v1/intelligence/analyses/'+id)).json().data;expect(replay).toMatchObject({status:'FAILED',provider_operation_id:operation.id,result:{error_code:errorCode},costs:{operations:1,confirmed_usd:.000525}});expect(replay.batches[0].status).toBe('FAILED');expect(send).toHaveBeenCalledTimes(1);
 expect((await pool.query('SELECT count(*) FROM creative_provider_operations WHERE operation_key=$1',['intelligence-analysis:'+id+':batch:0'])).rows[0].count).toBe('1');
});
