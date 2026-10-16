import type {FastifyInstance} from 'fastify';
import {pool} from '../../../packages/db/src/index.js';

/** V7 F1: one public, content-free platform check for the external uptime
 * monitor. 200 only when the database answers, WAL archiving is on and keeping
 * up, and a recent base backup exists; otherwise 503 with problem codes only
 * (no timestamps, names, sizes or counts). */
export const platformHealthLimits=Object.freeze({archivePending:2,archivePendingAgeSeconds:300,backupAgeSeconds:36*3600,fullBackupAgeSeconds:8*86400});
export type RecoveryStatus={archive_mode:string;failed_count:number;last_archived_at:string|null;last_failed_at:string|null;pending:number;oldest_pending_age_s:number|null;last_backup_at:string|null;last_full_at:string|null;checked_at:string};

export function assessRecovery(s:RecoveryStatus):string[]{
 const problems:string[]=[],now=Date.parse(s.checked_at),age=(at:string|null)=>at?(now-Date.parse(at))/1000:Infinity;
 if(s.archive_mode!=='on')problems.push('ARCHIVING_DISABLED');
 if(s.pending>platformHealthLimits.archivePending||(s.oldest_pending_age_s??0)>platformHealthLimits.archivePendingAgeSeconds)problems.push('ARCHIVE_BACKLOG');
 if(s.last_failed_at&&(!s.last_archived_at||Date.parse(s.last_failed_at)>Date.parse(s.last_archived_at)))problems.push('ARCHIVE_FAILING');
 if(age(s.last_backup_at)>platformHealthLimits.backupAgeSeconds)problems.push('BACKUP_STALE');
 if(age(s.last_full_at)>platformHealthLimits.fullBackupAgeSeconds)problems.push('FULL_BACKUP_STALE');
 return problems;
}

export async function platformHealthRoutes(app:FastifyInstance){
 app.get('/healthz/platform',async(_req,reply)=>{
  let status:RecoveryStatus;
  try{status=(await pool.query('SELECT public.platform_recovery_status() AS s')).rows[0].s;}
  catch{return reply.code(503).send({status:'degraded',service:'platform',problems:['RECOVERY_STATUS_UNAVAILABLE']});}
  const problems=assessRecovery(status);
  return reply.code(problems.length?503:200).send({status:problems.length?'degraded':'ok',service:'platform',problems});
 });
}
