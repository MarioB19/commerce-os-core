import {describe,it,expect} from 'vitest';
import {WahaProvider} from '../../packages/messaging/src/providers.js';
describe('existing WAHA adapter profile contract',()=>{
 it('uses scoped official profile paths and only reports accepted writes',async()=>{
  const calls:{url:string;method:string;body:any}[]=[];
  const provider=new WahaProvider({baseUrl:'http://gateway.test:3000',apiKey:'fixture-only',session:'own profile',engine:'GOWS'},async(url,init)=>{calls.push({url:String(url),method:init?.method??'GET',body:init?.body?JSON.parse(String(init.body)):null});return new Response(JSON.stringify(init?.method==='PUT'?{success:true}:{id:'12025550180@c.us',name:'Commerce fixture'}),{headers:{'content-type':'application/json'}});});
  expect(await provider.profile()).toMatchObject({name:'Commerce fixture'});await provider.updateProfile({name:'Commerce fixture',about:'Own business test',picture:{bytes:new Uint8Array([1,2,3]),mimeType:'image/png'}});
  expect(calls.map(c=>new URL(c.url).pathname)).toEqual(['/api/own%20profile/profile','/api/own%20profile/profile/name','/api/own%20profile/profile/status','/api/own%20profile/profile/picture']);expect(calls[3]?.body.file.mimetype).toBe('image/png');
 });
 it('does not claim successful profile updates for ambiguous provider responses',async()=>{const provider=new WahaProvider({baseUrl:'http://gateway.test:3000',apiKey:'fixture-only',session:'default',engine:'NOWEB'},async()=>new Response('{}',{headers:{'content-type':'application/json'}}));await expect(provider.profile()).rejects.toThrow('PROFILE_RESPONSE_INVALID');await expect(provider.updateProfile({name:'Own profile',about:'Own about'})).rejects.toThrow('PROFILE_UPDATE_UNCONFIRMED');});
});
