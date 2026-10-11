import {afterEach,describe,it,expect,vi} from 'vitest';
import {smtpFailure,resetMailTemplate,publicWebOrigin} from '../../apps/api/src/identity-mail.js';
const originKeys=['PUBLIC_WEB_ORIGIN','CLIENT_ORIGIN','BETTER_AUTH_URL'] as const;
function productionOrigins(values:Partial<Record<typeof originKeys[number],string>>={}){
 vi.stubEnv('NODE_ENV','production');
 for(const key of originKeys)vi.stubEnv(key,values[key]);
}
afterEach(()=>vi.unstubAllEnvs());
describe('SMTP identity contract',()=>{
 it('treats ambiguous socket timeouts conservatively even when Nodemailer labels them CONN',()=>{
  for(const command of ['CONN','DATA',undefined])expect(smtpFailure({code:'ETIMEDOUT',command})).toMatchObject({retry:false,uncertain:true});
  expect(smtpFailure({code:'ESOCKET',syscall:'connect'})).toMatchObject({retry:true,uncertain:false});
  expect(smtpFailure({responseCode:451})).toMatchObject({retry:true,uncertain:false});
  expect(smtpFailure({responseCode:550})).toMatchObject({retry:false,uncertain:false});
  expect(smtpFailure({code:'EAUTH'})).toMatchObject({retry:false,uncertain:false});
 });
 it('identifies rejected SMTP credentials without losing retries for temporary AUTH failures',()=>{
  expect(smtpFailure({code:'EAUTH',responseCode:535,command:'AUTH PLAIN'})).toEqual({code:'SMTP_AUTH_FAILED',retry:false,uncertain:false});
  expect(smtpFailure({code:'EAUTH',responseCode:454,command:'AUTH PLAIN'})).toEqual({code:'SMTP_TEMPORARY_REJECTION',retry:true,uncertain:false});
 });
 it('renders Spanish HTML/text without external assets or tracking, escaping the URL',()=>{
  const template=resetMailTemplate('https://commerce.example.invalid/reset-password#token=x&y="<>');
  expect(template.text).toContain('30 minutos');expect(template.html).toContain('lang="es"');expect(template.html).toContain('&amp;y=&quot;&lt;&gt;');expect(template.html).not.toMatch(/<img|<script|<iframe/);
 });
 it('uses the existing production Better Auth origin when no separate web origin is configured',()=>{
  productionOrigins({BETTER_AUTH_URL:'https://commerce.example.invalid/'});
  expect(publicWebOrigin()).toBe('https://commerce.example.invalid');
 });
 it('prefers an explicit web origin, then the existing client origin, over Better Auth',()=>{
  productionOrigins({PUBLIC_WEB_ORIGIN:'https://web.example.invalid',CLIENT_ORIGIN:'https://client.example.invalid,https://second.example.invalid',BETTER_AUTH_URL:'https://auth.example.invalid'});
  expect(publicWebOrigin()).toBe('https://web.example.invalid');
  vi.stubEnv('PUBLIC_WEB_ORIGIN',undefined);
  expect(publicWebOrigin()).toBe('https://client.example.invalid');
  vi.stubEnv('CLIENT_ORIGIN',undefined);
  expect(publicWebOrigin()).toBe('https://auth.example.invalid');
 });
 it('rejects unsafe configured origins without silently falling back to another origin',()=>{
  for(const key of originKeys)for(const value of ['http://localhost:5173','https://example.invalid/path','https://user:pass@example.invalid','https://example.invalid/?callback=evil','https://example.invalid/#token','']){
   productionOrigins({BETTER_AUTH_URL:'https://safe.example.invalid',[key]:value});
   expect(()=>publicWebOrigin()).toThrow();
  }
 });
 it('never falls back to a development URL in production but preserves local development',()=>{
  productionOrigins();expect(()=>publicWebOrigin()).toThrow('PUBLIC_WEB_ORIGIN_INVALID');
  vi.stubEnv('NODE_ENV','development');expect(publicWebOrigin()).toBe('http://localhost:5173');
 });
});
