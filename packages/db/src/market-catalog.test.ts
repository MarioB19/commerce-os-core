import {describe,it,expect,vi} from 'vitest';
import {readMarketCatalog} from './market-catalog.js';
import {marketRecordVersionHash} from './market-variants.js';
import type {ProfileExecutor} from './profile-context.js';
const id='10000000-0000-4000-8000-000000000001';
const row={option_kind:'collection',record_id:id,workspace_id:'w',environment:'REAL',kind:'bank_profile',version:3,body:{name:'Cobro',secret_ciphertext:'private',account_number:'private'}};
function db(rows=[row],product:unknown={id,version:1,name:'Producto',adopted:false}){const query=vi.fn().mockResolvedValueOnce({rows:product?[product]:[]}).mockResolvedValueOnce({rows});return{workspaceId:'w',query} as unknown as ProfileExecutor;}
describe('native market catalogue projection',()=>{
 it('derives exactly008 hash and never returns private bodies',async()=>{const d=db(),r=await readMarketCatalog(d,'REAL',id);expect(r.options).toEqual([{kind:'collection',label:'Cobro',ref:{id,revision:3,sha256:marketRecordVersionHash(row)}}]);expect(JSON.stringify(r)).not.toMatch(/private|ciphertext|account_number/);expect(r.product.adopted).toBe(false);expect(d.query).toHaveBeenCalledTimes(2);});
 it('keeps scope and product in both parameterized reads',async()=>{const d=db();await readMarketCatalog(d,'REAL',id);for(const call of vi.mocked(d.query).mock.calls)expect(call[1]).toEqual(['w','REAL',id]);expect(vi.mocked(d.query).mock.calls[1]![0]).toContain('v.version=r.version');});
 it('rejects inaccessible product before scanning options',async()=>{const d=db([],null);await expect(readMarketCatalog(d,'REAL',id)).rejects.toMatchObject({statusCode:404});expect(d.query).toHaveBeenCalledOnce();});
 it('rejects oversized option sets instead of returning a partial catalogue',async()=>{await expect(readMarketCatalog(db(Array.from({length:1001},()=>row)),'REAL',id)).rejects.toMatchObject({code:'MARKET_CATALOG_TOO_LARGE'});});
 it.each([['REAL','not-an-id'],['foreign',id]])('rejects malformed input before SQL',async(e,i)=>{const d=db();await expect(readMarketCatalog(d,e,i)).rejects.toThrow();expect(d.query).not.toHaveBeenCalled();});
});
