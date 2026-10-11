import {afterEach,describe,expect,it} from 'vitest';
import {onboardingCode,onboardingEnabled,onboardingFailure} from './onboarding.js';
import {ProviderError} from './types.js';
const flags={ALLOW_CHANNEL_ONBOARDING:process.env.ALLOW_CHANNEL_ONBOARDING,ALLOW_REAL_OPERATIONS:process.env.ALLOW_REAL_OPERATIONS};
afterEach(()=>{for(const[key,value]of Object.entries(flags)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
describe('Safe onboarding diagnostics',()=>{
 it.each([[401,'GATEWAY_AUTH_REJECTED'],[403,'GATEWAY_AUTH_REJECTED'],[404,'SESSION_NOT_FOUND'],[409,'QR_NOT_READY'],[422,'QR_NOT_READY'],[429,'CHANNEL_TIMEOUT']] as const)('classifies provider HTTP %i without its body', (status,code)=>{expect(onboardingCode(new ProviderError('PROVIDER_HTTP_'+status,status),'get_qr')).toBe(code);});
 it('does not copy arbitrary provider text or session state into diagnostics',()=>{const secret='untrusted secret body or session';const code=onboardingCode(new Error(secret),'get_qr');const value=onboardingFailure(code,'get_qr',secret,'diagnostic-test');expect(JSON.stringify(value)).not.toContain(secret);expect(value.error.diagnostic.account_status).toBe('UNKNOWN');expect(value.error.diagnostic.diagnostic_id).toBe('diagnostic-test');expect(value.error.diagnostic.technical_intervention).toBe(true);});
 it('separately opts in to preparation while real operations remain disabled',()=>{delete process.env.ALLOW_CHANNEL_ONBOARDING;process.env.ALLOW_REAL_OPERATIONS='false';expect(onboardingEnabled({allow_channel_onboarding:false})).toBe(false);process.env.ALLOW_CHANNEL_ONBOARDING='true';expect(onboardingEnabled({allow_channel_onboarding:true})).toBe(true);expect(process.env.ALLOW_REAL_OPERATIONS).toBe('false');});
});
