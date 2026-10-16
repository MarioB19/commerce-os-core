import {privacyErasureEvidenceSchema,privacyRetentionPolicy} from '../../../contracts/src/privacy-retention.js';
const DAY=86400000;
/** Eligibility is necessary, not authority to erase. A SQL transaction must
 * lock/re-read every observation and assert the same source before mutation. */
export function privacyErasureEligibility(input:unknown){
 const v=privacyErasureEvidenceSchema.parse(input),now=Date.parse(v.observed_at),closed=v.closed_at===null?null:Date.parse(v.closed_at);
 const days=v.execution_kind==='TEST'?privacyRetentionPolicy.test_days:privacyRetentionPolicy.commercial_days;
 const due=closed===null?null:closed+days*DAY,reasons:string[]=[];
 if(!v.profile_active)reasons.push('PROFILE_INACTIVE');
 if(!v.owner_active||v.owner_version!==v.expected_owner_version)reasons.push('PRIVACY_AUTHORITY_CHANGED');
 if(!v.closure_verified||closed===null||closed>now)reasons.push('CLOSURE_UNVERIFIED');
 if(due!==null&&due>now)reasons.push('RETENTION_NOT_DUE');
 if(v.legal_hold)reasons.push('LEGAL_HOLD');
 if(v.active_obligation)reasons.push('ACTIVE_OBLIGATION');
 if(v.pending_effects||v.pending_commands||v.pending_timers||v.unsettled_ai)reasons.push('WORK_PENDING');
 if(!v.complete_reference_inventory||v.unclassified_references)reasons.push('REFERENCE_INVENTORY_INCOMPLETE');
 if(v.projection.phase!=='READY'||!v.projection.verified||v.projection.source_version!==v.source_version||v.projection.source_sha256!==v.source_sha256)reasons.push('PROJECTION_NOT_CONFIRMED');
 const changed=Date.parse(v.source_last_changed_at),b=v.backup;
 if(changed>now)reasons.push('SOURCE_CLOCK_INVALID');
 if(!b)reasons.push('BACKUP_REQUIRED');
 else{
  const snapshot=Date.parse(b.snapshot_at),verified=Date.parse(b.verified_at);
  if(b.workspace_id!==v.workspace_id||b.environment!==v.environment)reasons.push('BACKUP_SCOPE_MISMATCH');
  if(!b.restore_verified)reasons.push('BACKUP_RESTORE_UNVERIFIED');
  if(snapshot>now||verified>now||verified<snapshot||now-snapshot>DAY)reasons.push('BACKUP_STALE_OR_INVALID');
  if(changed>snapshot)reasons.push('SOURCE_NEWER_THAN_BACKUP');
 }
 return{eligible:reasons.length===0,reasons,policy:privacyRetentionPolicy.version,due_at:due===null?null:new Date(due).toISOString(),source_version:v.source_version,source_sha256:v.source_sha256,projection_generation:v.projection.generation};
}
/** Five calendar years, never an approximation by 365-day years. Feb 29
 * advances conservatively to March 1 when the target year has no Feb 29. */
export function financialRetentionDue(recordedAt:string){
 const instant=privacyErasureEvidenceSchema.shape.observed_at.parse(recordedAt),date=new Date(instant);
 date.setUTCFullYear(date.getUTCFullYear()+privacyRetentionPolicy.financial_years);
 return date.toISOString();
}
