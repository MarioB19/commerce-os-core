import {describe,expect,it} from 'vitest';
import {nextRemarketingTime,insideRemarketingWindow} from './remarketing.js';
import {remarketingPolicySchema} from '../../../contracts/src/sales-flow.js';

// V7 F5 (RF-10.d, REM-TIME): reminders only inside the variant's local hours.
describe('remarketing window',()=>{
 const mx={start_hour:9,end_hour:21,timezone:'America/Mexico_City'};
 it('keeps an instant already inside the window',()=>{
  const at=new Date('2026-10-13T16:30:00Z');// 10:30 in Mexico City
  expect(nextRemarketingTime(at,mx)).toEqual(at);expect(insideRemarketingWindow(at,mx)).toBe(true);
 });
 it('moves early morning to 09:00 the same local day and late night to 09:00 the next day',()=>{
  expect(nextRemarketingTime(new Date('2026-10-13T08:20:15Z'),mx).toISOString()).toBe('2026-10-13T15:00:00.000Z');// 02:20 → 09:00 (UTC-6)
  expect(nextRemarketingTime(new Date('2026-10-14T03:30:00Z'),mx).toISOString()).toBe('2026-10-14T15:00:00.000Z');// 21:30 → 09:00 next day
  expect(insideRemarketingWindow(new Date('2026-10-14T03:00:00Z'),mx)).toBe(false);// 21:00 is the end (exclusive)
 });
 it('crosses midnight and DST transitions in the variant time zone',()=>{
  const ny={start_hour:9,end_hour:20,timezone:'America/New_York'};
  // 2026-03-08: clocks spring forward at 02:00. 01:30 EST → 09:00 EDT (13:00Z).
  expect(nextRemarketingTime(new Date('2026-03-08T06:30:00Z'),ny).toISOString()).toBe('2026-03-08T13:00:00.000Z');
  // 2026-11-01: clocks fall back. 23:10 EDT on Oct 31 → 09:00 EST on Nov 1 (14:00Z).
  expect(nextRemarketingTime(new Date('2026-11-01T03:10:00Z'),ny).toISOString()).toBe('2026-11-01T14:00:00.000Z');
 });
 it('without a window sends at the scheduled instant',()=>{const at=new Date('2026-10-13T08:00:00Z');expect(nextRemarketingTime(at,undefined)).toBe(at);});
 it('accepts text-only reminders and validates the window',()=>{
  const slot=(position:1|2|3,enabled:boolean,hours:number)=>({id:'s'+position,position,enabled,warning_acknowledged:true,delay:{quantity:hours,unit:'hours'},stages:{awaiting_agreement:{medium:'text',text:'¿Sigues interesado?'},awaiting_payment:{medium:'text',text:'Te dejo los datos de pago'}}});
  const policy={schema_version:1,policy_id:'remarketing-3-slot',policy_revision:1,window:{start_hour:9,end_hour:21},slots:[slot(1,true,2),slot(2,false,8),slot(3,false,24)]};
  expect(remarketingPolicySchema.safeParse(policy).success).toBe(true);
  expect(remarketingPolicySchema.safeParse({...policy,window:{start_hour:21,end_hour:9}}).success).toBe(false);
  const audio={...policy,slots:[{...slot(1,true,2),stages:{awaiting_agreement:{medium:'audio',text:'x'},awaiting_payment:{medium:'text',text:'y'}}},slot(2,false,8),slot(3,false,24)]};
  expect(remarketingPolicySchema.safeParse(audio).success).toBe(false);// audio still needs its asset
 });
});
