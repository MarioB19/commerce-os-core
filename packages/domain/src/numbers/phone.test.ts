import {describe,expect,it} from 'vitest';
import {normalizePhone,observedPhoneDigits,canonicalPhoneDigits,PhoneError} from './phone.js';

describe('private phone normalization (V7 F3)',()=>{
 it('normalizes national and international Mexican forms to one line',()=>{
  for(const input of ['55 1234 5678','5512345678','+52 55 1234 5678','52 1 55 1234 5678','+5215512345678','(55) 1234-5678'])
   expect(normalizePhone('MX',input)).toEqual({digits:'525512345678',last4:'5678',masked:'•••• 5678'});
 });
 it('matches the identity WhatsApp reports, with or without the legacy 1',()=>{
  expect(observedPhoneDigits('wa:5215512345678')).toBe('525512345678');
  expect(observedPhoneDigits('wa:525512345678')).toBe('525512345678');
  expect(observedPhoneDigits('wa:14155550123')).toBe(normalizePhone('US','415 555 0123').digits);
 });
 it('rejects foreign codes, wrong lengths, letters and non-line identities',()=>{
  expect(()=>normalizePhone('MX','+57 300 123 4567')).toThrow(PhoneError);
  expect(()=>normalizePhone('MX','5512')).toThrow('PHONE_INVALID');
  expect(()=>normalizePhone('MX','55a2345678')).toThrow('PHONE_INVALID');
  expect(()=>observedPhoneDigits('wa:group-123')).toThrow('PHONE_IDENTITY_NOT_A_LINE');
  expect(()=>canonicalPhoneDigits('123')).toThrow('PHONE_INVALID');
  expect(()=>normalizePhone('XX' as never,'5512345678')).toThrow('PHONE_COUNTRY_UNSUPPORTED');
 });
 it('accepts Argentina with 10 or 11 national digits and Guatemala with 8',()=>{
  expect(normalizePhone('AR','11 2345 6789').digits).toBe('541123456789');
  expect(normalizePhone('GT','5512 3456').digits).toBe('50255123456');
 });
});
