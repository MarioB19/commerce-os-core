import {it,expect} from 'vitest';
import {WahaProvider} from '../../packages/messaging/src/providers.js';
const window={since:'2026-09-15T00:00:00Z',until:'2026-09-15T01:00:00Z',limit:2};
const item=(n:number)=>({id:'history-'+n,from:'12025550171@c.us',fromMe:false,timestamp:Date.parse(window.since)/1000+n,body:'Synthetic history',_data:{private:'never-copy'}});
it('reads a bounded closed inbound window without media downloads, seen receipts or mutations',async()=>{
 const calls:{url:URL;method:string}[]=[];
 const p=new WahaProvider({baseUrl:'http://fixture.invalid',apiKey:'synthetic',session:'default',engine:'GOWS'},async(u,i)=>{calls.push({url:new URL(String(u)),method:i?.method??'GET'});return Response.json([item(3),item(2),item(1)]);});
 const r=await p.recentInbound(window);expect(r.truncated).toBe(true);expect(r.messages.map(m=>m.id)).toEqual(['history-2','history-3']);expect(JSON.stringify(r)).not.toContain('never-copy');
 expect(calls).toHaveLength(1);expect(calls[0]!.method).toBe('GET');expect(calls[0]!.url.pathname).toBe('/api/default/chats/all/messages');
 expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({limit:'3',downloadMedia:'false','filter.fromMe':'false'});
});
it.each([{...item(1),fromMe:true},{...item(1),timestamp:1}])('rejects out of scope provider responses instead of importing them',async row=>{
 const p=new WahaProvider({baseUrl:'http://fixture.invalid',apiKey:'synthetic',session:'default',engine:'GOWS'},async()=>Response.json([row]));
 await expect(p.recentInbound(window)).rejects.toThrow('HISTORY_RESPONSE_OUT_OF_SCOPE');
});
it('rejects unsupported engines and oversized windows without provider calls',async()=>{
 let calls=0;const p=new WahaProvider({baseUrl:'http://fixture.invalid',apiKey:'synthetic',session:'default',engine:'WEBJS'},async()=>{calls++;return Response.json([]);});
 await expect(p.recentInbound(window)).rejects.toThrow('HISTORY_ENGINE_UNSUPPORTED');expect(calls).toBe(0);
});
