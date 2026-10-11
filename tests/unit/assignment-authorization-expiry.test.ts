import {describe,expect,it} from 'vitest';
import {assignmentAuthorizationExpiryAllowed} from '../../apps/api/src/assignment-authorization-expiry.js';
import {authorizedRecipient} from '../../packages/domain/src/sales/authorization.js';

describe('assignment authorization renewal',()=>{
 it('allows a human annual term while keeping service grants within seven days',()=>{
  const now=Date.parse('2026-09-23T18:00:00Z');
  expect(assignmentAuthorizationExpiryAllowed('2027-01-01T05:59:59Z',now,false)).toBe(true);
  expect(assignmentAuthorizationExpiryAllowed('2027-01-01T05:59:59Z',now,true)).toBe(false);
  expect(assignmentAuthorizationExpiryAllowed(new Date(now+367*86400000).toISOString(),now,false)).toBe(false);
  expect(assignmentAuthorizationExpiryAllowed(new Date(now-1).toISOString(),now,false)).toBe(false);
 });
 it('keeps earlier inbound conversations eligible only when the renewed scope carries its original start',()=>{
  const conversation={created_at:'2026-09-23T18:05:00Z',body:{started_at:'2026-09-23T18:05:00Z',last_inbound_at:'2026-09-23T18:20:00Z'}};
  const auth={created_at:'2026-09-23T18:30:00Z',scope:{mode:'product_assignment',recipient_mode:'new_inbound',new_inbound_since:'2026-09-23T18:00:00Z'}};
  expect(authorizedRecipient(auth,'contact',conversation,Date.parse('2026-09-23T18:31:00Z'))).toBe(true);
  expect(authorizedRecipient({...auth,scope:{...auth.scope,new_inbound_since:'2026-09-23T18:10:00Z'}},'contact',conversation,Date.parse('2026-09-23T18:31:00Z'))).toBe(false);
  expect(authorizedRecipient(auth,'contact',{...conversation,created_at:'2026-09-23T17:59:00Z'},Date.parse('2026-09-23T18:31:00Z'))).toBe(false);
 });
});
