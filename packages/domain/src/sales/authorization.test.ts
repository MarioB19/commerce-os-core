import {describe,it,expect} from 'vitest';
import {authorizedRecipient} from './authorization.js';
const now=Date.parse('2026-09-06T18:00:00Z'),approved=now-3600000;
const auth={created_at:new Date(approved),scope:{mode:'channel_setup',recipient_mode:'new_inbound',contact_ids:[]}};
const conversation={created_at:new Date(approved+1000),body:{started_at:new Date(approved+1000).toISOString(),last_inbound_at:new Date(now-1000).toISOString()}};
describe('Inbound authorization audience',()=>{
 it('accepts a new inbound conversation only within the customer window',()=>{expect(authorizedRecipient(auth,'opaque',conversation,now)).toBe(true);expect(authorizedRecipient(auth,'opaque',conversation,now+86400000)).toBe(false);});
 it('excludes old conversations, delayed historical events, future timestamps and missing evidence',()=>{for(const c of [{...conversation,created_at:new Date(approved-1)},{...conversation,body:{...conversation.body,started_at:new Date(approved-1).toISOString()}},{...conversation,body:{...conversation.body,last_inbound_at:new Date(now+1000).toISOString()}},{...conversation,body:{}}])expect(authorizedRecipient(auth,'opaque',c,now)).toBe(false);});
 it('keeps explicit recipient scopes strict and legacy scopes compatible',()=>{expect(authorizedRecipient({...auth,scope:{mode:'channel_setup',contact_ids:['a']}},'b',conversation,now)).toBe(false);expect(authorizedRecipient({...auth,scope:{mode:'channel_setup',contact_ids:['a']}},'a',conversation,now)).toBe(true);expect(authorizedRecipient({...auth,scope:{mode:'channel_setup'}},'a',conversation,now)).toBe(false);expect(authorizedRecipient({...auth,scope:{}},'a',conversation,now)).toBe(true);});
});
