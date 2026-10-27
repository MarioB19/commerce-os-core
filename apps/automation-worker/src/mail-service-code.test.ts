import {describe,it,expect} from 'vitest';
import {mailServiceCode} from './mail-service-code.js';
const reply=(body:unknown)=>({json:async()=>{if(body instanceof Error)throw body;return body;}});
describe('mail service refusal code (V7.1.1)',()=>{
 it('keeps only a closed MAIL_* code',async()=>{
  expect(await mailServiceCode(reply({error:{code:'MAIL_JOURNAL_MISSING_NO_RESET'}}))).toBe('MAIL_JOURNAL_MISSING_NO_RESET');
  expect(await mailServiceCode(reply({error:{code:'MAIL_NATIVE_HTTP_403'}}))).toBe('MAIL_NATIVE_HTTP_403');
 });
 it('never echoes anything else',async()=>{
  for(const body of [{error:{code:'someone@example.invalid'}},{error:{code:'MAIL_x'}},{error:{code:'MAIL_'+'A'.repeat(80)}},{error:'MAIL_X'},{},null,'MAIL_X',new Error('bad json')])
   expect(await mailServiceCode(reply(body))).toBe('MAIL_CODE_UNREADABLE');
 });
});
