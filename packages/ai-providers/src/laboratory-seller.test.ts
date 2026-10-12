import {describe,it,expect,vi} from 'vitest';
import {laboratorySellerInput,parseLaboratorySeller,PostgresNumberLabSellerAi} from './laboratory-seller.js';
import {OpenAiSalesProvider,sellerProposalInstructions} from '../../domain/src/sales/ai.js';
import {request,requestIdentity} from './protocol.js';
import type {ProfileQuery} from '../../db/src/profile-context.js';
import type {Model} from './contracts.js';
import {withProfileQueryRouting} from '../../db/src/profile-query-routing.js';
const id='11111111-1111-4111-8111-111111111111',binding={workspaceId:'profile-one',runId:id,operationId:id,variantId:id,releaseId:id,snapshotSha256:'a'.repeat(64),attemptId:id,grantId:id};
const proposal={reply:'Synthetic source',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']};
const context={customer_text:'Untrusted prompt',offer:{name:'Synthetic'}};
describe('RF19 canonical seller transport adapter',()=>{
 it('preserves exact canonical seller instructions and semantic input',async()=>{let sent:any;const provider=new OpenAiSalesProvider({apiKey:'synthetic-only',fetcher:async(_url,init)=>{sent=JSON.parse(String(init?.body));return new Response(JSON.stringify({status:'completed',output:[{content:[{type:'output_text',text:JSON.stringify(proposal)}]}],usage:{input_tokens:1,output_tokens:1}}));}});
  await provider.propose({provider:'openai',model:'synthetic',knowledge:'',instructions:'Profile instruction',max_cost_minor:100,max_tokens:10,timeout_ms:1000,input_cost_per_million_minor:100,output_cost_per_million_minor:100},context);
  const input=laboratorySellerInput('Profile instruction',context);expect(input.instructions).toBe(sent.instructions);expect(input.text).toBe(sent.input[0].content);expect(input.capability).toBe('chat');
 });
 it('keeps untrusted customer text out of the instruction channel',()=>{const input=laboratorySellerInput('Profile',context);expect(input.instructions).not.toContain(context.customer_text);expect(JSON.parse(input.text)).toEqual({context,knowledge:''});});
 it('uses the original canonical proposal parser without granting tool execution',()=>expect(parseLaboratorySeller(JSON.stringify(proposal))).toEqual(proposal));
 it.each(['not-json',JSON.stringify({...proposal,tool:'execute'}),JSON.stringify({...proposal,confidence:2}),JSON.stringify({...proposal,reply:'x'.repeat(4097)})])('rejects malformed/unsupported output %s',value=>expect(()=>parseLaboratorySeller(value)).toThrow());
 it('bounds input and output without truncation',()=>{expect(()=>laboratorySellerInput('x'.repeat(32769),context)).toThrow('INPUT_LIMIT');expect(()=>laboratorySellerInput('',{...context,extra:'x'.repeat(524288)})).toThrow('INPUT_LIMIT');expect(()=>parseLaboratorySeller('x'.repeat(65537))).toThrow('OUTPUT_REJECTED');});
 it('keeps shared instructions stable with no profile-specific inference',()=>{expect(sellerProposalInstructions('X')).toContain('Never confirm commitment or payment from your inference.');expect(sellerProposalInstructions('X')).toContain('Operator instructions: X');});
 it('rejects injected environment/credential selectors in the closed binding',()=>{const pool={connect:vi.fn()};expect(()=>new PostgresNumberLabSellerAi({controlPool:pool,enterprisePool:pool,binding:{...binding,environment:'REAL'} as any,custodyKey:new Uint8Array(32),maximumMicrousd:1})).toThrow();expect(pool.connect).not.toHaveBeenCalled();});
 it('cannot read key or model from an active canonical SQL transaction',async()=>{const pool={connect:vi.fn()},ai=new PostgresNumberLabSellerAi({controlPool:pool,enterprisePool:pool,binding,custodyKey:new Uint8Array(32),maximumMicrousd:1});await withProfileQueryRouting({workspaceId:'number-lab:'+id,query:vi.fn()},async()=>{await expect(ai.invoke('',context,async()=>undefined)).rejects.toThrow('AUTHORITY');});expect(pool.connect).not.toHaveBeenCalled();});
 function cachedFixture(){
  const now=Date.parse('2026-10-12T12:00:00Z'),model:Model={provider:'openai',model:'synthetic',revision:'v1',transport:'responses',capabilities:['chat'],responseModels:['synthetic'],inputTokenCeiling:100,outputTokenCeiling:10,
   price:{version:'price1',currency:'USD',input:1000000,output:2000000,cacheRead:0,cacheWrite:0,audioInput:0,validFrom:new Date(now-3600000).toISOString(),validUntil:new Date(now+3600000).toISOString()}};
  const input=laboratorySellerInput('Profile',context),identity=requestIdentity(model,input,request(model,input).bytes);
  const row={provider:model.provider,model:model.model,model_revision:model.revision,price_version:model.price.version,valid_from:model.price.validFrom,valid_until:model.price.validUntil,input_ceiling:100,output_ceiling:10,input_rate:1000000,output_rate:2000000,cache_read_rate:0,cache_write_rate:0,audio_input_rate:0,model_document:model,
   observed_at:new Date(now).toISOString(),valid_until_cache:new Date(now+600000).toISOString(),request_sha256:identity.sha256,request_bytes:identity.bytes};
  const state:{authority:typeof row|null;live:boolean;role:string}={authority:row,live:true,role:'commerce_number_lab'},sqls:string[]=[];
  const query=vi.fn(async(sql:string)=>{sqls.push(sql);return{command:sql==='COMMIT'?'COMMIT':'SELECT',rowCount:1,oid:0,fields:[],rows:sql.includes('current_user')?[{role:state.role}]:sql.includes('lock_cached_seller')?[{authority:state.authority}]:sql.includes('clock_timestamp')?[{live:state.live}]:[]};});
  const controlPool={connect:vi.fn(async()=>({query:query as ProfileQuery,release:vi.fn()}))},enterprisePool={connect:vi.fn(async()=>{throw Error('NO_ENTERPRISE_IO');})},fetcher=vi.fn();
  const ai=new PostgresNumberLabSellerAi({controlPool,enterprisePool,binding,custodyKey:new Uint8Array(32),maximumMicrousd:120,fetcher});return{state,sqls,ai,enterprisePool,fetcher,query};
 }
 it('uses only the closed reader for cache, holds its transaction through callback and checks native time',async()=>{const f=cachedFixture();await f.ai.withCachedAuthority('Profile',context,async(admitted,clock)=>{expect(admitted).toBe(true);expect(f.sqls).not.toContain('COMMIT');await clock();});expect(f.sqls.at(-1)).toBe('COMMIT');expect(f.enterprisePool.connect).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();expect(f.sqls.some(s=>/INSERT|UPDATE/.test(s))).toBe(false);});
 it('returns unavailable for revoked native authority without another attempt or key read',async()=>{const f=cachedFixture();f.state.authority=null;await f.ai.withCachedAuthority('Profile',context,async admitted=>expect(admitted).toBe(false));expect(f.enterprisePool.connect).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled();});
 it.each(['request_sha256','request_bytes'] as const)('rejects mismatched cached %s against canonical semantic input',async field=>{const f=cachedFixture();Object.assign(f.state.authority!,{[field]:field==='request_bytes'?1:'b'.repeat(64)});await f.ai.withCachedAuthority('Profile',context,async admitted=>expect(admitted).toBe(false));});
 it('rolls back when the final native cache deadline expires',async()=>{const f=cachedFixture();await expect(f.ai.withCachedAuthority('Profile',context,async(_admitted,clock)=>{f.state.live=false;await clock();})).rejects.toThrow('AUTHORITY');expect(f.sqls.at(-1)).toBe('ROLLBACK');});
 it('refuses the wrong runtime role before reading cached authority',async()=>{const f=cachedFixture();f.state.role='commerce_api';await expect(f.ai.withCachedAuthority('Profile',context,async()=>undefined)).rejects.toThrow('AUTHORITY');expect(f.sqls.some(s=>s.includes('lock_cached_seller'))).toBe(false);});

});
