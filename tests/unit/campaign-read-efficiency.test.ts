import {describe,it,expect,vi} from 'vitest';
import {ReadCache} from '../../apps/api/src/read-cache.js';
import {MetaReader,MetaReadCoordinator} from '../../apps/api/src/meta-client.js';
import {campaignProductLabels,extractCampaignProduct,exactCatalogCandidate} from '../../packages/domain/src/sales/campaign-product.js';

describe('Campaign labels preserve evidence boundaries',()=>{
 it('extracts only the WA convention and merges only an unambiguous literal alias',()=>{
  const names=['WA | TEST | Costura | A1','WA | Costura que Vende | A2','WA | TEST | Oraciones | A3','Arbitrary campaign','WA | TEST | | A4'];
  expect(campaignProductLabels(names).map(x=>x?.label??null)).toEqual(['Costura que Vende','Costura que Vende','Oraciones',null,null]);
  expect(campaignProductLabels([...names,'WA | Costura para Principiantes | A5'])[0]?.label).toBe('Costura');
  expect(campaignProductLabels(['WA | TEST | Francés | A1','WA | TEST | Francés avanzado | A2'])[0]?.label).toBe('Francés');
  expect(extractCampaignProduct('WA | VALIDACIÓN | Invitaciones | A6')).toBe('Invitaciones');
 });
 it('offers only exact unique catalog matches and never fuzzy or duplicate identity',()=>{
  expect(exactCatalogCandidate('Preescolar',[{id:'1',name:'Preescolar Listo · Mi Ciclo Listo'}]).candidate_product_id).toBeNull();
  expect(exactCatalogCandidate('costura',[{id:'1',name:' Costura '}])).toMatchObject({status:'EXACT_NAME_CANDIDATE',candidate_product_id:'1'});
  expect(exactCatalogCandidate('oración',[{id:'1',name:'Oracion'},{id:'2',name:'Oración'}])).toMatchObject({status:'AMBIGUOUS',candidate_product_id:null});
 });
});

describe('Scoped short-lived report cache',()=>{
 it('coalesces concurrent reads, expires, separates keys and does not share mutable results',async()=>{
  let now=0,release!:()=>void;const wait=new Promise<void>(r=>{release=r;}),cache=new ReadCache<{amount:number}>(30,2,()=>now),read=vi.fn(async()=>{await wait;return{amount:17};});
  const one=cache.get('workspace:REAL:revision1',read),two=cache.get('workspace:REAL:revision1',read);release();
  const a=await one,b=await two;expect(read).toHaveBeenCalledTimes(1);expect(a.cache.status).toBe('MISS');expect(b.cache.status).toBe('COALESCED');a.value.amount=999;
  expect((await cache.get('workspace:REAL:revision1',read)).value.amount).toBe(17);
  await cache.get('workspace:SIMULATION:revision1',read);await cache.get('other:REAL:revision1',read);expect(read).toHaveBeenCalledTimes(3);
  now=31;await cache.get('workspace:REAL:revision1',read);expect(read).toHaveBeenCalledTimes(4);
 });
 it('does not cache errors or strand an in-flight request',async()=>{
  const cache=new ReadCache<number>(30),fail=vi.fn(async()=>{throw Error('unavailable');});
  await expect(cache.get('key',fail)).rejects.toThrow('unavailable');expect((await cache.get('key',async()=>2)).value).toBe(2);
 });
});

describe('Meta quota coordination',()=>{
 it('coalesces identical GETs, serializes different requests and separates credentials',async()=>{
  let active=0,maxActive=0,release!:()=>void;const blocked=new Promise<void>(r=>{release=r;});
  const fetcher=vi.fn(async()=>{active++;maxActive=Math.max(maxActive,active);await blocked;active--;return Response.json({data:[]});});
  const a=new MetaReader('one',fetcher),b=new MetaReader('one',fetcher);
  const reads=[a.get('me'),b.get('me'),b.get('me/adaccounts')];await Promise.resolve();release();await Promise.all(reads);
  expect(fetcher).toHaveBeenCalledTimes(2);expect(maxActive).toBe(1);await a.get('me');expect(fetcher).toHaveBeenCalledTimes(2);
  await new MetaReader('two',fetcher).get('me');expect(fetcher).toHaveBeenCalledTimes(3);
 });
 it('does not retry429 or queued edges and preserves a long Retry-After',async()=>{
  const now=Date.now(),fetcher=vi.fn(async()=>Response.json({error:{code:4}},{status:429,headers:{'retry-after':'3600'}}));
  const a=new MetaReader('fixture',fetcher),b=new MetaReader('fixture',fetcher);
  const results=await Promise.allSettled([a.get('me'),b.get('me/adaccounts')]);expect(fetcher).toHaveBeenCalledTimes(1);
  for(const result of results){expect(result.status).toBe('rejected');if(result.status==='rejected'){expect(result.reason.issue.retry_after_seconds).toBe(3600);expect(Date.parse(result.reason.issue.retry_at)).toBeGreaterThanOrEqual(now+3600_000);}}
  await expect(a.get('different')).rejects.toMatchObject({issue:{code:'META_RATE_LIMIT'}});expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('honors HTTP-date Retry-After and expires successful GET cache',async()=>{
  const deadline=new Date(Date.now()+7200_000).toUTCString(),limited=vi.fn(async()=>Response.json({error:{code:17}},{status:429,headers:{'retry-after':deadline}}));
  await expect(new MetaReader('fixture',limited).get('me')).rejects.toMatchObject({issue:{retry_at:new Date(deadline).toISOString()}});
  let now=0;const fetcher=vi.fn(async()=>Response.json({data:[]})),reader=new MetaReader('fixture',fetcher,undefined,25,new MetaReadCoordinator(()=>now,60));
  await reader.get('me');now=59;await reader.get('me');expect(fetcher).toHaveBeenCalledTimes(1);now=60;await reader.get('me');expect(fetcher).toHaveBeenCalledTimes(2);
 });
});
