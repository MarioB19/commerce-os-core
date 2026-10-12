import {describe,it,expect,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createMarketVariantsMcp} from './market-variants.js';
import {personalMarketVariants,type MarketClient} from '../../../packages/commerce-client/src/market-variants.js';
import {marketCopyReviewFields} from '../../../packages/contracts/src/market-variants.js';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const ref={id,revision:1,sha256:'a'.repeat(64)},locale={market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
const fields={locale,amount_minor:100,configuration:{offer:ref,flow:ref,seller:ref,collection:ref,remarketing:ref,materials:[]}};
const view={id:other,family_id:id,version:1,draft:fields,draft_sha256:'a'.repeat(64),current_release_id:null,source_release_id:null,release_revision:0};
async function protocol(work:(client:Client)=>Promise<void>,invoke:MarketClient){
 const server=createMarketVariantsMcp(invoke),client=new Client({name:'synthetic-market-client',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
 await server.connect(st);await client.connect(ct);try{await work(client);}finally{await client.close();await server.close();}
}
describe('market variant MCP uses the canonical profile client',()=>{
 it('registers exactly nine closed tools with accurate read/write annotations',async()=>{
  const invoke=vi.fn<MarketClient>();await protocol(async client=>{
   const {tools}=await client.listTools();expect(tools.map(t=>t.name)).toEqual(['adopt','create','copy','replace','publish','get','release','reconcile','list'].map(x=>'market_variant_'+x));
   for(const t of tools){const read=['get','release','reconcile','list'].some(x=>t.name==='market_variant_'+x);expect(t.annotations).toMatchObject({readOnlyHint:read,destructiveHint:!read,idempotentHint:true,openWorldHint:false});}
  },invoke);expect(invoke).not.toHaveBeenCalled();
 });
 it.each(['workspace_id','profile_id','token','origin','route','operation'])('rejects caller override %s before the client',async key=>{
  const invoke=vi.fn<MarketClient>();await protocol(async client=>{expect((await client.callTool({name:'market_variant_get',arguments:{environment:'REAL',id,[key]:'foreign'}})).isError).toBe(true);},invoke);expect(invoke).not.toHaveBeenCalled();
 });
 it('preserves mutation UUIDs, CAS and complete review fields without manufacturing IDs',async()=>{
  const invoke=vi.fn<MarketClient>().mockResolvedValue({data:{id}});
  const commands=[
   ['adopt',{operation_id:id,body:{product_id:other,expected_product_version:1}}],
   ['create',{operation_id:id,body:{family_id:other,fields}}],
   ['copy',{operation_id:id,body:{source_release_id:other,locale}}],
   ['replace',{operation_id:id,id:other,body:{expected_version:1,fields}}],
   ['publish',{operation_id:id,id:other,body:{expected_version:1,draft_sha256:ref.sha256,reviewed_fields:[...marketCopyReviewFields]}}],
  ]as const;
  await protocol(async client=>{for(const[operation,args]of commands){const result=await client.callTool({name:'market_variant_'+operation,arguments:{environment:'REAL',...args}});expect(result.isError).not.toBe(true);}},invoke);
  expect(invoke.mock.calls.map(c=>c[0])).toEqual(commands.map(([operation,args])=>({...args,environment:'REAL',operation})));
 });
 it('requires operation identity, expected version and every publication review before invoking',async()=>{
  const invoke=vi.fn<MarketClient>();await protocol(async client=>{
   for(const args of [{id:other,body:{expected_version:1,draft_sha256:ref.sha256,reviewed_fields:marketCopyReviewFields}},{operation_id:id,id:other,body:{draft_sha256:ref.sha256,reviewed_fields:marketCopyReviewFields}},{operation_id:id,id:other,body:{expected_version:1,draft_sha256:ref.sha256,reviewed_fields:[]}}])expect((await client.callTool({name:'market_variant_publish',arguments:{environment:'REAL',...args}})).isError).toBe(true);
  },invoke);expect(invoke).not.toHaveBeenCalled();
 });
 it('makes one uncertain POST and only an explicit operation read uses the next HTTP request',async()=>{
  const transport=vi.fn<typeof fetch>().mockRejectedValueOnce(Error('synthetic private transport')).mockResolvedValueOnce(new Response(JSON.stringify({data:view})));
  const invoke=personalMarketVariants('https://example.invalid','cos_pat_'+'s'.repeat(43),transport);
  await protocol(async client=>{
   const result=await client.callTool({name:'market_variant_create',arguments:{environment:'REAL',operation_id:id,body:{family_id:id,fields}}});
   expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('MARKET_WRITE_UNCONFIRMED');expect(JSON.stringify(result)).toContain(id);expect(JSON.stringify(result)).not.toContain('private transport');expect(transport).toHaveBeenCalledTimes(1);
   const found=await client.callTool({name:'market_variant_reconcile',arguments:{environment:'REAL',id}});expect(found.structuredContent).toEqual({data:view});expect(transport).toHaveBeenCalledTimes(2);expect(transport.mock.calls[1]?.[1]?.method).toBe('GET');
  },invoke);
 });
 it('redacts nested secret and temporary-link fields without hiding operation references',async()=>{
  const invoke=vi.fn<MarketClient>().mockResolvedValue({data:Object.assign({id},{token:'synthetic private',nested:{api_key:'synthetic key',signed_url:'https://example.invalid/?token=private'},url:'https://example.invalid/?signature=private'})});
  await protocol(async client=>{const result=await client.callTool({name:'market_variant_reconcile',arguments:{environment:'REAL',id}});expect(JSON.stringify(result)).toContain(id);expect(JSON.stringify(result)).not.toMatch(/synthetic private|synthetic key|signature=private|signed_url/);},invoke);
 });
 it('does not reflect unknown errors or attach mutation keys to a failed read',async()=>{
  const invoke=vi.fn<MarketClient>().mockRejectedValue(Error('private detail'));await protocol(async client=>{const result=await client.callTool({name:'market_variant_get',arguments:{environment:'REAL',id}});expect(result.isError).toBe(true);expect(JSON.stringify(result)).toContain('MARKET_READ_UNCONFIRMED');expect(JSON.stringify(result)).not.toMatch(/private detail|operation_id/);},invoke);expect(invoke).toHaveBeenCalledTimes(1);
 });
});
