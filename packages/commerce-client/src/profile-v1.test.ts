import {describe,expect,it} from 'vitest';
import {personalProfileV1} from './profile-v2.js';

const token='cos_pat_'+'b'.repeat(43);
describe('V7 F3 personal /v1 number client',()=>{
 it('allows only the number families, fixes REAL and requires an operation id for writes',async()=>{
  const urls:string[]=[];
  const client=personalProfileV1('https://commerce.example.test',token,async input=>{urls.push(String(input));return new Response(JSON.stringify({data:{}}),{status:200});});
  await client('GET','/v1/numbers/overview');
  expect(urls).toEqual(['https://commerce.example.test/v1/numbers/overview?environment=REAL']);
  for(const path of ['/v1/settings/integrations','/v1/numbers/../settings','/v2/numbers','/v1/numbers?environment=SIMULATION','/v1/channel-accounts/x/qr'])
   await expect(client('GET',path)).rejects.toThrow('PROFILE_ROUTE_INVALID');
  await expect(client('POST','/v1/numbers/quick',{alias:'x'})).rejects.toThrow('OPERATION_ID_REQUIRED');
  await expect(personalProfileV1('https://commerce.example.test','cos_plt_'+'c'.repeat(43))('GET','/v1/numbers/overview')).rejects.toThrow('PROFILE_AUTHORITY_REQUIRED');
 });
});
