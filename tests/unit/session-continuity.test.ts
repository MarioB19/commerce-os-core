import {describe,it,expect} from 'vitest';
import {primaryMaintenance,normalizeSession,retryDelay} from '../../packages/domain/src/health/session-continuity.js';
describe('Session continuity contracts',()=>{
 it('keeps unknown primary dates unknown and uses exact preventive thresholds',()=>{const now=new Date('2026-09-15T12:00:00Z');expect(primaryMaintenance(null,now).status).toBe('UNKNOWN');for(const[day,status]of [[0,'CURRENT'],[9,'CURRENT'],[10,'DUE_10'],[12,'DUE_12'],[13,'DUE_13'],[14,'OVERDUE']]as const)expect(primaryMaintenance(new Date(now.getTime()-day*86400000),now).status).toBe(status);expect(primaryMaintenance(new Date(now.getTime()+1),now).status).toBe('UNKNOWN');});
 it('requires observed identity and does not call FAILED an authentication revocation',()=>{expect(normalizeSession('WORKING',false).observed_state).toBe('UNKNOWN');expect(normalizeSession('WORKING',true).observed_state).toBe('CONNECTED');expect(normalizeSession('FAILED',false).auth_state).toBe('UNKNOWN');expect(normalizeSession('PASSKEY_REQUIRED',false).auth_state).toBe('PASSKEY_REQUIRED');expect(normalizeSession('WORKING',true,true).auth_state).toBe('IDENTITY_CONFLICT');});
 it('has bounded jitter at all five steps',()=>{expect([0,1,2,3,4].map(n=>retryDelay(n,()=>.5))).toEqual([5000,15000,45000,120000,300000]);});
});
