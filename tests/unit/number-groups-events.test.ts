import {describe,it,expect} from 'vitest';
import {parseGroup} from '../../packages/messaging/src/groups.js';
import {normalizeWaha} from '../../packages/messaging/src/normalize.js';
import {groupEligibility} from '../../packages/db/src/warmup-groups.js';
const runtime={version:'fixture-verified',engine:'GOWS'},now=new Date('2026-09-19T12:00:00Z');
describe('group transport boundaries',()=>{
 it('resolves LID only through explicit mappings and rejects incomplete participant/security results',()=>{
  const g=parseGroup('123@g.us',{subject:'Own group'},[{id:'123@lid',role:'participant'},{id:'321@lid',phoneNumber:'12025550179@c.us',role:'admin'}],{adminOnly:false},runtime);
  expect(g.members[0].verifiedIdentity).toBeNull();expect(g.members[1]).toMatchObject({verifiedIdentity:'wa:12025550179',mappingSource:'provider_explicit_mapping'});
  expect(()=>parseGroup('123@g.us',{},[{id:'123@lid'}],{adminOnly:false},runtime)).toThrow();expect(()=>parseGroup('123@g.us',{},[],{},runtime)).toThrow();
 });
 it('deduplicates messages within each receiving session, retains distinct receivers and identifies global ACK',()=>{
  const payload={id:'provider-message',from:'123@g.us',participant:'12025550179@c.us',body:'Own test',timestamp:Math.floor(+now/1000)};
  const a=normalizeWaha({id:'event-a',event:'message',session:'session-a',payload},now.toISOString())[0]!,duplicate=normalizeWaha({id:'event-b',event:'message',session:'session-a',payload},now.toISOString())[0]!,b=normalizeWaha({event:'message',session:'session-b',payload},now.toISOString())[0]!;
  expect(a.key).toBe(duplicate.key);expect(a.key).not.toBe(b.key);expect(a).toMatchObject({groupId:'123@g.us',senderIdentity:'wa:12025550179',receivingSession:'session-a'});
  const global=normalizeWaha({event:'message.ack',session:'session-a',payload:{id:'provider-message',chatId:'123@g.us',ack:2}},now.toISOString())[0]!;expect(global.participantIdentity).toBeUndefined();expect(global.groupId).toBe('123@g.us');
  const echo=normalizeWaha({event:'message.any',session:'session-a',payload:{...payload,fromMe:true,to:'123@g.us'}},now.toISOString())[0]!;expect(echo.fromMe).toBe(true);
 });
 it('requires all members, every fresh observation and sending permission',()=>{
  const g={members:[{account_id:'a',admin:true},{account_id:'b',admin:false}],capabilities:{all_members_resolved:true,observations:{a:{observed_at:now.toISOString()},b:{observed_at:now.toISOString()}}},permissions:{admin_only:false},observed_at:now,expires_at:new Date(+now+60000)};
  expect(groupEligibility(g,['a','b'],now)).toBeNull();expect(groupEligibility(g,['a'],now)).toBe('GROUP_ALL_MEMBERS_REQUIRED');expect(groupEligibility({...g,permissions:{admin_only:true}},['a','b'],now)).toBe('GROUP_SEND_PERMISSION_REQUIRED');
  expect(groupEligibility({...g,capabilities:{...g.capabilities,observations:{...g.capabilities.observations,b:{observed_at:new Date(+now-60001).toISOString()}}}},['a','b'],now)).toBe('GROUP_MEMBERSHIP_STALE');expect(groupEligibility({...g,retired_at:now},['a','b'],now)).toBe('GROUP_RETIRED');
 });
});
