import {describe,it,expect} from 'vitest';
import {metaSyncInput} from '../../packages/contracts/src/meta-portfolios.js';
import {campaignCsv} from '../../packages/contracts/src/campaign-export.js';
import {MetaReader} from '../../apps/api/src/meta-client.js';
const operationId='11111111-1111-4111-8111-111111111111';
describe('V7.3 read contracts',()=>{
 it('accepts exactly 90 inclusive days and rejects invalid calendars, ranges and caller profile routing',()=>{
  expect(metaSyncInput.safeParse({operationId,from:'2026-08-11',to:'2026-11-08'}).success).toBe(true);
  for(const input of [{from:'2026-08-10',to:'2026-11-08'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-11-08'},{workspace_id:'other'},{from:'2026-11-09',to:'2026-11-08'}])expect(metaSyncInput.safeParse({operationId,...input}).success).toBe(false);
 });
 it('resumes a single validated page without following foreign URLs or silently truncating',async()=>{
  let seen='';const reader=new MetaReader('synthetic',async input=>{const u=new URL(String(input));seen=u.searchParams.get('after')??'';return Response.json({data:[{id:'1'}],paging:{next:'https://graph.facebook.com/v26.0/me/adaccounts?after=second',cursors:{after:'second'}}});});
  expect(await reader.page('me/adaccounts','id',{},'first')).toEqual({data:[{id:'1'}],cursor:'second'});expect(seen).toBe('first');
  const malicious=new MetaReader('synthetic',async()=>Response.json({data:[],paging:{next:'https://example.invalid/leak?access_token=synthetic'}}));
  await expect(malicious.page('me/adaccounts','id')).rejects.toMatchObject({issue:{code:'META_UNSAFE_PAGINATION'}});
 });
 it('exports source labels, quotes and CSV formula guards without turning missing numbers into zero',()=>{
  const csv=campaignCsv({filters:{currency:'MXN',from:'2026-11-01',to:'2026-11-08'},groups:{accounts:[{id:'act_1',name:' =1+1',spend_minor:null,attributed_sales:0,quality:{status:'PARTIAL'}}]}});
  expect(csv).toContain('"\' =1+1"');expect(csv).toContain('"PARTIAL","META_API","COMMERCE_APPROVED_PAYMENTS"');expect(csv).not.toContain('undefined');
 });
});
