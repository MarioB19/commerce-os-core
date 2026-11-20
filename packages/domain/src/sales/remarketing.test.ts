
import {describe,expect,it} from 'vitest';

describe('post-agreement collection reminders in Mexico City',()=>{
 const window={start_hour:9,end_hour:21,timezone:'America/Mexico_City'};
 const local=(time:string)=>new Date('2026-11-'+time+'-06:00');
 it.each([
  ['19T10:00','19T12:00','20T09:00'],
  ['19T19:30','20T09:00','20T18:30'],
  ['19T23:00','20T09:00','20T20:45'],
  ['19T07:00','19T09:00','19T20:45'],
 ])('schedules both touches from %s',async(anchor,expected1,expected2)=>{
  const {collectionReminderTime}=await import('./remarketing.js');
  const at=local(anchor);
  const first=collectionReminderTime(new Date(+at+2*3600_000),window,1,at);
  expect(first).toEqual(local(expected1));
  expect(collectionReminderTime(new Date(+at+23*3600_000),window,2,at,first!)).toEqual(local(expected2));
 });
 it('omits a second notice after the channel deadline or less than eight hours after the first',async()=>{
  const {collectionReminderTime}=await import('./remarketing.js');
  expect(collectionReminderTime(local('20T20:00'),window,2,local('19T19:00'),local('20T09:00'))).toBeNull();
  expect(collectionReminderTime(local('20T22:00'),window,2,local('20T07:00'),local('20T15:00'))).toBeNull();
 });
});
