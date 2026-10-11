import {afterEach,describe,expect,it,vi} from 'vitest';
import {integrationMetadata,integrationPatchSchema,isPublicAddress,privateIntegrationDigest,splitIntegrationKey,validateIntegrationConfig,validateIntegrationSecrets,validatePublicEndpoint,type IntegrationSetting} from './integration-settings.js';
afterEach(()=>vi.unstubAllEnvs());
describe('Operational integration validation without provider calls',()=>{
 it('rejects arbitrary gateway topology and unsafe public endpoints',()=>{
  expect(validateIntegrationConfig('waha',{base_url:'http://waha-01:3000'},true)).toEqual({base_url:'http://waha-01:3000'});
  for(const number of ['01','02','10','11','20'])expect(validateIntegrationConfig('waha',{base_url:`http://waha-${number}:3000`},true)).toEqual({base_url:`http://waha-${number}:3000`});
  for(const base_url of ['http://127.0.0.1:3000','http://waha-01:3000.attacker.invalid','http://waha-21:3000','https://metadata.google.internal'])expect(()=>validateIntegrationConfig('waha',{base_url},true)).toThrow();
  for(const url of ['http://portal.example/grants','https://localhost/grants','https://127.0.0.1','https://2130706433','https://169.254.169.254','https://metadata.google.internal','https://10.0.0.1','https://portal.example?token=private','https://user:password@portal.example','https://portal.example:444','https://portal.example/#fragment','https://[::1]'])expect(()=>validatePublicEndpoint(url)).toThrow();
  expect(validatePublicEndpoint('https://portal.example/grants').origin).toBe('https://portal.example');
  for(const value of ['127.0.0.1','10.1.2.3','192.168.2.1','172.31.1.2','169.254.169.254','100.100.100.200','0.0.0.0','224.0.0.1','192.0.2.1','198.51.100.5','203.0.113.1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:db8::1'])expect(isPublicAddress(value),value).toBe(false);
  for(const value of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])expect(isPublicAddress(value),value).toBe(true);
 });
 it('keeps provider types, fields, required secrets and fixed official endpoints typed',()=>{
  expect(()=>splitIntegrationKey('openai:other')).toThrow();expect(()=>splitIntegrationKey('meta:../../key')).toThrow();
  expect(()=>validateIntegrationConfig('openai',{base_url:'https://proxy.example/v1'},true)).toThrow();
  expect(()=>validateIntegrationConfig('openai',{base_url:'https://api.openai.com/v1',input_cost_per_million_minor:0,output_cost_per_million_minor:1},true)).toThrow();
  expect(()=>validateIntegrationConfig('cloud',{phone_number_id:'opaque-not-a-phone-id',graph_version:'v26.0'},true)).toThrow();
  expect(()=>validateIntegrationSecrets('meta',{token:'synthetic-token'},true)).toThrow();expect(()=>validateIntegrationSecrets('meta',{},true)).toThrow();
  expect(()=>validateIntegrationSecrets('meta',{},false)).not.toThrow();
  expect(()=>integrationPatchSchema.parse({expected_version:0,label:'Test',enabled:false,config:{},secrets:{access_token:'fixture\nheader'},reason:'Synthetic'})).toThrow();
 });
 it('returns presence without suffixes, ciphertext, plaintext, or a reusable plain hash',()=>{
  vi.stubEnv('PRIVATE_DATA_KEY','a'.repeat(64));
  const row:IntegrationSetting={key:'meta:fixture',type:'meta',reference:'fixture',label:'Synthetic',version:1,enabled:true,config:{},secret_fields:{access_token:true},secrets:{access_token:'synthetic-confidential-credential'},updated_at:new Date(0).toISOString()};
  const shown=integrationMetadata(row);expect(shown.secrets).toEqual({access_token:{configured:true}});expect(JSON.stringify(shown)).not.toContain(row.secrets.access_token!);
  const first=privateIntegrationDigest({secrets:row.secrets,environment:'REAL'});expect(first).toBe(privateIntegrationDigest({environment:'REAL',secrets:row.secrets}));vi.stubEnv('PRIVATE_DATA_KEY','b'.repeat(64));expect(first).not.toBe(privateIntegrationDigest({secrets:row.secrets,environment:'REAL'}));
 });
});
