import {describe,expect,it} from 'vitest';
import {isLegacyIntegrationVariable,planLegacyIntegrations} from './legacy-integrations.js';
const secret='synthetic-legacy-credential-only';
describe('One-time legacy import planner (memory fixtures only)',()=>{
 it('whitelists operational credentials, separates providers and never imports bootstrap credentials',()=>{
  for(const key of ['DATABASE_URL','DATA_ENCRYPTION_KEY','BOOTSTRAP_PASSWORD','INTERNAL_SERVICE_TOKEN','BETTER_AUTH_SECRET'])expect(isLegacyIntegrationVariable(key),key).toBe(false);
  const plans=planLegacyIntegrations({WORKSPACE_ID:'synthetic',META_WORKSPACE_ID:'synthetic',META_ACCOUNT_KEYS:'one,two',META_ACCOUNT_ONE_ACCESS_TOKEN:secret,META_ACCOUNT_TWO_ACCESS_TOKEN:secret+'2',WAHA_01_URL:'http://waha-01:3000',WAHA_01_API_KEY:secret,WAHA_01_WEBHOOK_SECRET:secret,OPENAI_API_KEY:secret},'synthetic');expect(plans.map(p=>p.key)).toEqual(['meta:one','meta:two','openai:default','waha:WAHA_01']);expect(plans.find(p=>p.key==='openai:default')?.patch.enabled).toBe(false);expect(plans.every(p=>p.patch.expected_version===0)).toBe(true);
 });
 it('rejects workspace mismatches, unapproved URLs, incomplete credentials and token alias mistakes',()=>{
  expect(()=>planLegacyIntegrations({META_WORKSPACE_ID:'other'},'synthetic')).toThrow('LEGACY_WORKSPACE_MISMATCH');expect(()=>planLegacyIntegrations({META_ACCOUNT_KEYS:'one'},'synthetic')).toThrow('LEGACY_META_TOKEN_REQUIRED');expect(()=>planLegacyIntegrations({WAHA_01_URL:'http://localhost',WAHA_01_API_KEY:secret,WAHA_01_WEBHOOK_SECRET:secret},'synthetic')).toThrow();expect(()=>planLegacyIntegrations({WAHA_01_WEBHOOK_SECRET:secret,WAHA_01_API_KEY:secret},'synthetic')).toThrow('LEGACY_GATEWAY_CONFIGURATION_INCOMPLETE');
 });
});
