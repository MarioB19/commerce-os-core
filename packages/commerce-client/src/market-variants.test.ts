import {afterEach,describe,expect,it,vi} from 'vitest';
import {personalMarketVariants,sessionMarketVariants} from './market-variants.js';
import {marketCommandRoute,marketCommandResult} from '../../contracts/src/market-variant-client.js';
import {marketCopyReviewFields} from '../../contracts/src/market-variants.js';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',third='33333333-3333-4333-8333-333333333333';
const ref={id,revision:1,sha256:'a'.repeat(64)},token='cos_pat_'+'a'.repeat(43),locale={market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
const fields={locale,amount_minor:100,configuration:{offer:ref,flow:ref,seller:ref,collection:ref,remarketing:ref,materials:[]}};
const view={id:other,family_id:id,version:1,draft:fields,draft_sha256:'a'.repeat(64),current_release_id:null,source_release_id:null,release_revision:0};
const create={operation:'create',environment:'REAL',operation_id:third,body:{family_id:id,fields}};
function fetcher(value:unknown={data:view},status=200){return vi.fn(async()=>new Response(JSON.stringify(value),{status}));}
const pat=(f:typeof fetch)=>personalMarketVariants('https://example.invalid',token,f);
afterEach(()=>vi.useRealTimers());
describe('market variants shared client: fixed authority, exact results and uncertain writes',()=>{
 it('one explicit mutation binds operation and fixed PAT, never cookie or profile selector',async()=>{
  const f=fetcher();expect(await pat(f)(create)).toEqual({data:view});expect(f).toHaveBeenCalledTimes(1);
  const [url,args]=f.mock.calls[0]as unknown as[string,RequestInit];expect(url).toBe('https://example.invalid/v2/market/variants?environment=REAL');expect(args).toMatchObject({method:'POST',credentials:'omit',redirect:'error',cache:'no-store',headers:{authorization:'Bearer '+token,'idempotency-key':third}});expect(args.headers).not.toHaveProperty('x-commerce-profile-id');expect(JSON.parse(args.body as string)).toEqual(create.body);
 });
 it('copies session selection into closure and refuses result from another workspace',async()=>{
  const selection={workspaceId:'one',version:3},f=fetcher();const client=sessionMarketVariants(selection,f);selection.workspaceId='two';selection.version=4;await client(create);
  expect((f.mock.calls[0]as unknown as[string,RequestInit])[1]).toMatchObject({credentials:'include',headers:{'x-commerce-profile-id':'one','x-commerce-profile-version':'3'}});
  const release={id,scope:{workspace_id:'two',environment:'REAL'},family_id:id,variant_id:other,revision:1,...fields};const foreign=fetcher({data:release});await expect(sessionMarketVariants({workspaceId:'one',version:3},foreign)({operation:'release',environment:'REAL',id})).rejects.toMatchObject({code:'MARKET_READ_UNCONFIRMED'});
 });
 it.each([400,401,403,409,429,500,502,504])('HTTP %s preserves uncertain write with one POST, no fallback or retry',async status=>{
  const f=fetcher({error:{code:'FAILURE'}},status);await expect(pat(f)(create)).rejects.toMatchObject({code:'MARKET_WRITE_UNCONFIRMED',status});expect(f).toHaveBeenCalledTimes(1);
 });
 it.each([{error:{code:'MARKET_NOT_FOUND',message:'MARKET_NOT_FOUND'}},{statusCode:404,code:'MARKET_NOT_FOUND',error:'Not Found',message:'MARKET_NOT_FOUND'}])('recognizes only a canonical operation absence',async body=>{const f=fetcher(body,404);await expect(pat(f)({operation:'reconcile',environment:'REAL',id:third})).rejects.toMatchObject({code:'MARKET_OPERATION_NOT_FOUND',status:404});await expect(pat(f)({operation:'get',environment:'REAL',id:third})).rejects.toMatchObject({code:'MARKET_READ_UNCONFIRMED',status:404});});
 it.each(['<html>404 proxy</html>',JSON.stringify({error:{code:'NOT_FOUND'}}),JSON.stringify({error:{code:'MARKET_NOT_FOUND',message:'MARKET_NOT_FOUND'},extra:true})])('preserves ambiguity for noncanonical404 %s',async body=>{const f=vi.fn(async()=>new Response(body,{status:404}));await expect(pat(f)({operation:'reconcile',environment:'REAL',id:third})).rejects.toMatchObject({code:'MARKET_READ_UNCONFIRMED',status:404});});
 it('network ambiguity is reconciled only by an explicit GET with the same operation UUID',async()=>{
  const f=vi.fn<typeof fetch>().mockRejectedValueOnce(Error('private-network-detail')).mockResolvedValueOnce(new Response(JSON.stringify({data:view})));const client=pat(f);
  await expect(client(create)).rejects.toMatchObject({message:'MARKET_WRITE_UNCONFIRMED',status:0});expect(f).toHaveBeenCalledTimes(1);
  expect(await client({operation:'reconcile',environment:'REAL',id:third})).toEqual({data:view});expect(f).toHaveBeenCalledTimes(2);expect(f.mock.calls[1]?.[0]).toBe('https://example.invalid/v2/market/operations/'+third+'?environment=REAL');expect(f.mock.calls[1]?.[1]).toMatchObject({method:'GET'});expect(f.mock.calls[1]?.[1]?.headers).not.toHaveProperty('idempotency-key');
 });
 it('15 second timeout keeps ambiguous POST without retransmission',async()=>{
  vi.useFakeTimers();const f=vi.fn<typeof fetch>((_u,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(Error('abort')))));const result=pat(f)(create);const check=expect(result).rejects.toMatchObject({code:'MARKET_WRITE_UNCONFIRMED'});await vi.advanceTimersByTimeAsync(15000);await check;expect(f).toHaveBeenCalledTimes(1);
 });
 it('pre-aborted reads send nothing and post-response abort cannot confirm a write',async()=>{
  const ctrl=new AbortController();ctrl.abort();const f=fetcher();await expect(pat(f)({operation:'get',environment:'REAL',id:other},ctrl.signal)).rejects.toMatchObject({code:'MARKET_READ_UNCONFIRMED'});expect(f).not.toHaveBeenCalled();
  const later=new AbortController(),g=vi.fn(async()=>{later.abort();return new Response(JSON.stringify({data:view}));});await expect(pat(g)(create,later.signal)).rejects.toMatchObject({code:'MARKET_WRITE_UNCONFIRMED'});expect(g).toHaveBeenCalledTimes(1);
 });
 it.each(['not JSON','x'.repeat(2*1024*1024+1)])('malformed or oversized body remains unconfirmed',async body=>{
  const f=vi.fn(async()=>new Response(body));await expect(pat(f)(create)).rejects.toMatchObject({code:'MARKET_WRITE_UNCONFIRMED'});expect(f).toHaveBeenCalledTimes(1);
 });
 it.each([{...create,workspace_id:'other'},{...create,body:{...create.body,authorized:true}},{...create,operation_id:'not-uuid'},{...create,environment:'other'}])('rejects client authority/input changes before transport',async q=>{
  const f=fetcher();await expect(pat(f)(q)).rejects.toMatchObject({code:'MARKET_INPUT_INVALID'});expect(f).not.toHaveBeenCalled();
 });
 it('rejects unsafe origins and malformed credentials at construction',()=>{
  for(const origin of ['http://remote.example','https://name:secret@example.invalid','https://example.invalid/path','https://example.invalid/?x=y'])expect(()=>personalMarketVariants(origin,token)).toThrow('MARKET_AUTHORITY_REQUIRED');
  expect(()=>personalMarketVariants('https://example.invalid','invalid')).toThrow('MARKET_AUTHORITY_REQUIRED');expect(()=>sessionMarketVariants({workspaceId:null,version:0})).toThrow('MARKET_AUTHORITY_REQUIRED');
 });
 it('rejects mismatched create, replace and copy receipts',()=>{
  for(const changed of [{...view,family_id:other},{...view,version:2},{...view,source_release_id:third},{...view,draft:{...fields,amount_minor:200}}])expect(()=>marketCommandResult({data:changed},marketCommandRoute(create).value)).toThrow();
  const replace=marketCommandRoute({operation:'replace',environment:'REAL',operation_id:third,id:other,body:{expected_version:1,fields}}).value;
  expect(()=>marketCommandResult({data:view},replace)).toThrow();expect(marketCommandResult({data:{...view,version:2}},replace)).toBeTruthy();
  const copy=marketCommandRoute({operation:'copy',environment:'REAL',operation_id:third,body:{source_release_id:id,locale}}).value;
  const copied={...view,source_release_id:id,source_release:ref,pending_review:[...marketCopyReviewFields],publication_authorized:false};expect(marketCommandResult({data:copied},copy)).toBeTruthy();expect(()=>marketCommandResult({data:{...copied,source_release_id:third}},copy)).toThrow();
 });
 it('validates publication pointer, revision, draft and environment before confirmation',()=>{
  const q=marketCommandRoute({operation:'publish',environment:'REAL',operation_id:third,id:other,body:{expected_version:1,draft_sha256:view.draft_sha256,reviewed_fields:[...marketCopyReviewFields]}}).value;
  const release={id:third,scope:{workspace_id:'one',environment:'REAL'},family_id:id,variant_id:other,revision:1,...fields},data={variant:{...view,version:2,current_release_id:third,release_revision:1},release,sha256:'b'.repeat(64),effects_authorized:false};expect(marketCommandResult({data},q,'one')).toBeTruthy();
  for(const changed of [{...data,variant:{...data.variant,version:3}},{...data,release:{...release,amount_minor:200}},{...data,release:{...release,scope:{workspace_id:'two',environment:'REAL'}}},{...data,effects_authorized:true}])expect(()=>marketCommandResult({data:changed},q,'one')).toThrow();
 });
 it('bounds and validates list cursor, order, unique IDs and family',()=>{
  const q=marketCommandRoute({operation:'list',environment:'REAL',family_id:id,limit:1}).value;
  expect(marketCommandResult({data:[view],meta:{has_more:true,next:other}},q)).toBeTruthy();
  for(const page of [{data:[view,view],meta:{has_more:false,next:null}},{data:[view],meta:{has_more:true,next:third}},{data:[{...view,family_id:other}],meta:{has_more:false,next:null}},{data:[view],meta:{has_more:false,next:other}}])expect(()=>marketCommandResult(page,q)).toThrow();
 });
});
