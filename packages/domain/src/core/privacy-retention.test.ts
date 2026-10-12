import {describe,it,expect} from 'vitest';
import {privacyErasureEligibility,financialRetentionDue} from './privacy-retention.js';
import type {PrivacyErasureEvidence} from '../../../contracts/src/privacy-retention.js';
const base:PrivacyErasureEvidence={workspace_id:'one',environment:'REAL',journey_id:'10000000-0000-4000-8000-000000000001',execution_kind:'COMMERCIAL',source_version:7,source_sha256:'a'.repeat(64),observed_at:'2026-10-12T08:00:00Z',closed_at:'2026-04-15T08:00:00Z',closure_verified:true,profile_active:true,owner_active:true,owner_version:4,expected_owner_version:4,legal_hold:false,active_obligation:false,pending_effects:0,pending_commands:0,pending_timers:0,unsettled_ai:0,complete_reference_inventory:true,unclassified_references:0,source_last_changed_at:'2026-10-12T06:00:00Z',projection:{phase:'READY',source_version:7,source_sha256:'a'.repeat(64),verified:true,generation:'19'},backup:{workspace_id:'one',environment:'REAL',receipt_id:'10000000-0000-4000-8000-000000000002',snapshot_at:'2026-10-12T06:45:00Z',verified_at:'2026-10-12T07:00:00Z',restore_verified:true,sha256:'b'.repeat(64)}};
describe('D18 deterministic retention admission',()=>{
 it('uses authenticated closure plus 180 days, independent of a later edit',()=>{const r=privacyErasureEligibility(base);expect(r.eligible).toBe(true);expect(r.due_at).toBe('2026-10-12T08:00:00.000Z');expect(r.projection_generation).toBe('19');});
 it('one millisecond before the exact deadline stays blocked',()=>{expect(privacyErasureEligibility({...base,observed_at:'2026-10-12T07:59:59.999Z'}).reasons).toContain('RETENTION_NOT_DUE');});
 it('TEST transcript has 30 days while the same commercial closure still needs 180',()=>{const v={...base,closed_at:'2026-09-12T08:00:00Z'};expect(privacyErasureEligibility({...v,execution_kind:'TEST'}).eligible).toBe(true);expect(privacyErasureEligibility(v).reasons).toContain('RETENTION_NOT_DUE');});
 it.each([
  [{closed_at:null},'CLOSURE_UNVERIFIED'],[{closure_verified:false},'CLOSURE_UNVERIFIED'],[{closed_at:'2026-10-13T08:00:00Z'},'CLOSURE_UNVERIFIED'],
  [{profile_active:false},'PROFILE_INACTIVE'],[{owner_active:false},'PRIVACY_AUTHORITY_CHANGED'],[{owner_version:5},'PRIVACY_AUTHORITY_CHANGED'],
  [{legal_hold:true},'LEGAL_HOLD'],[{active_obligation:true},'ACTIVE_OBLIGATION'],
  [{pending_effects:1},'WORK_PENDING'],[{pending_commands:1},'WORK_PENDING'],[{pending_timers:1},'WORK_PENDING'],[{unsettled_ai:1},'WORK_PENDING'],
  [{complete_reference_inventory:false},'REFERENCE_INVENTORY_INCOMPLETE'],[{unclassified_references:1},'REFERENCE_INVENTORY_INCOMPLETE'],
  [{projection:{...base.projection,phase:'PENDING'}},'PROJECTION_NOT_CONFIRMED'],[{projection:{...base.projection,verified:false}},'PROJECTION_NOT_CONFIRMED'],
  [{projection:{...base.projection,source_version:6}},'PROJECTION_NOT_CONFIRMED'],[{projection:{...base.projection,source_sha256:'c'.repeat(64)}},'PROJECTION_NOT_CONFIRMED'],
  [{backup:null},'BACKUP_REQUIRED'],[{backup:{...base.backup,workspace_id:'other'}},'BACKUP_SCOPE_MISMATCH'],
  [{backup:{...base.backup,restore_verified:false}},'BACKUP_RESTORE_UNVERIFIED'],
  [{backup:{...base.backup,snapshot_at:'2026-10-11T07:59:59Z'}},'BACKUP_STALE_OR_INVALID'],
  [{backup:{...base.backup,verified_at:'2026-10-12T09:00:00Z'}},'BACKUP_STALE_OR_INVALID'],
  [{backup:{...base.backup,verified_at:'2026-10-12T06:40:00Z'}},'BACKUP_STALE_OR_INVALID'],
  [{source_last_changed_at:'2026-10-12T07:30:00Z'},'SOURCE_NEWER_THAN_BACKUP'],[{source_last_changed_at:'2026-10-12T08:00:01Z'},'SOURCE_CLOCK_INVALID'],
 ]as const)('rejects a failed independent gate %j', (patch,reason)=>{const result=privacyErasureEligibility({...base,...patch});expect(result.eligible).toBe(false);expect(result.reasons).toContain(reason);});
 it('preserves all independent reasons instead of hiding one blocker behind another',()=>{expect(privacyErasureEligibility({...base,legal_hold:true,pending_effects:1,backup:null}).reasons).toEqual(['LEGAL_HOLD','WORK_PENDING','BACKUP_REQUIRED']);});
 it('rejects injected TTL, forged environment and non-integer counts',()=>{for(const patch of [{ttl:1},{environment:'SIMULATION'},{pending_effects:-1},{source_version:1.5},{observed_at:'invalid'}])expect(()=>privacyErasureEligibility({...base,...patch})).toThrow();});
 it('five-year financial retention handles leap years without early erasure',()=>{expect(financialRetentionDue('2024-02-29T12:00:00Z')).toBe('2029-03-01T12:00:00.000Z');expect(financialRetentionDue('2026-10-12T08:00:00Z')).toBe('2031-10-12T08:00:00.000Z');});
});
