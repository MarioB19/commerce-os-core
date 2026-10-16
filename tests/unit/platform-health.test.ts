import {expect,it} from 'vitest';
import {assessRecovery,type RecoveryStatus} from '../../apps/api/src/platform-health.js';

const now='2026-10-13T12:00:00.000Z',hours=(h:number)=>new Date(Date.parse(now)-h*3600000).toISOString();
const ok:RecoveryStatus={archive_mode:'on',failed_count:0,last_archived_at:hours(0.01),last_failed_at:null,pending:0,oldest_pending_age_s:null,last_backup_at:hours(20),last_full_at:hours(100),checked_at:now};

it('passes only with archiving on, no backlog and fresh base backups',()=>{
 expect(assessRecovery(ok)).toEqual([]);
 expect(assessRecovery({...ok,archive_mode:'off'})).toEqual(['ARCHIVING_DISABLED']);
 expect(assessRecovery({...ok,pending:3})).toEqual(['ARCHIVE_BACKLOG']);
 expect(assessRecovery({...ok,pending:1,oldest_pending_age_s:301})).toEqual(['ARCHIVE_BACKLOG']);
 expect(assessRecovery({...ok,last_failed_at:hours(0.001)})).toEqual(['ARCHIVE_FAILING']);
 expect(assessRecovery({...ok,last_failed_at:hours(1)})).toEqual([]);
 expect(assessRecovery({...ok,last_backup_at:hours(37)})).toEqual(['BACKUP_STALE']);
 expect(assessRecovery({...ok,last_full_at:hours(8*24+1)})).toEqual(['FULL_BACKUP_STALE']);
 expect(assessRecovery({...ok,last_backup_at:null,last_full_at:null})).toEqual(['BACKUP_STALE','FULL_BACKUP_STALE']);
});
