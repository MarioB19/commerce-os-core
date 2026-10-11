import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {retirementFixture} from './platform-retirement-fixture.js';
import {pool} from '../../packages/db/src/index.js';
let f:Awaited<ReturnType<typeof retirementFixture>>,search:any;
const ad=(index:number,group='large')=>({ad_archive_id:group+'-'+index,page_id:'synthetic-comparison',snapshot:{title:'Synthetic '+group,body:{text:'Incluye PDF. Precio $97 MXN. Fuente '+index+'.'},link_url:'https://example.invalid/coverage/'+group}});
const importAds=(ads:any[])=>f.call('POST','/v1/intelligence/import',{search_id:search.id,expected_version:search.version,observed_at:new Date().toISOString(),source_url:'https://example.invalid/source',ads});
beforeAll(async()=>{f=await retirementFixture();search=(await f.call('POST','/v1/intelligence/searches',{name:'Synthetic comparison coverage',query:{q:'coverage fixture',country:'MX'}})).json().data;});
afterAll(async()=>{vi.unstubAllGlobals();await f.app.close();await pool.end();});
it('retains per-offer truncation and evidence cursor for the original comparison cohort beyond500 sources',async()=>{
 const send=vi.fn();vi.stubGlobal('fetch',send);
 for(let start=0;start<500;start+=100){const r=await importAds(Array.from({length:100},(_,i)=>ad(start+i)));expect(r.statusCode,r.body).toBe(201);}
 const imported=await importAds([ad(500),ad(0,'small'),ad(1,'small')]);expect(imported.statusCode,imported.body).toBe(201);
 const offers=(await f.call('GET','/v1/intelligence/offers')).json().data,large=offers.find((o:any)=>o.landing_url.endsWith('/large')),small=offers.find((o:any)=>o.landing_url.endsWith('/small'));
 const response=await f.call('GET',`/v1/intelligence/compare?offer_ids=${large.id},${small.id}`);expect(response.statusCode,response.body).toBe(200);const compared=response.json().data,first=compared.offers.find((o:any)=>o.offer_id===large.id),second=compared.offers.find((o:any)=>o.offer_id===small.id);
 expect(first).toMatchObject({coverage_counts:{received:500,unique:500},dossier_scope:{kind:'ANALYSIS_SNAPSHOT',included:500,available:501,truncated:true},evidence_page:{limit:500,total:501,ordering:'ID_ASC_WITH_CREATED_SNAPSHOT'}});expect(first.evidence_page.next_cursor).toBeTypeOf('string');expect(Number.isFinite(Date.parse(first.evidence_page.as_of))).toBe(true);
 expect(second).toMatchObject({coverage_counts:{received:2},dossier_scope:{included:2,available:2,truncated:false},evidence_page:{total:2,next_cursor:null}});
 expect(compared.comparison).toHaveLength(11);expect(compared.comparison.every((d:any)=>d.offers.length===2)).toBe(true);
 const later=await importAds([ad(501)]);expect(later.statusCode,later.body).toBe(201);
 const continuation=await f.call('GET',`/v1/intelligence/offers/${large.id}?limit=100&cursor=${encodeURIComponent(first.evidence_page.next_cursor)}`),remaining=continuation.json().data;expect(continuation.statusCode,continuation.body).toBe(200);expect(remaining.observations).toHaveLength(1);expect(remaining.evidence_page).toMatchObject({as_of:first.evidence_page.as_of,total:501,next_cursor:null});expect(remaining.observations[0].ad_id).not.toBe('large-501');
 expect(send).not.toHaveBeenCalled();expect((await pool.query('SELECT count(*) FROM intelligence_analyses WHERE workspace_id=$1',[f.workspace])).rows[0].count).toBe('0');
});
