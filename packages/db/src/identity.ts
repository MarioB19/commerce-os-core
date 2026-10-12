import {createHmac} from 'node:crypto';
import {pool,type QueryExecutor} from './index.js';
export const resetTTLSeconds=30*60;
export function identityDigest(kind:string,value:string){
 const key=process.env.BETTER_AUTH_SECRET;
 if(!key)throw new Error('IDENTITY_SECRET_REQUIRED');
 return createHmac('sha256',key).update(`commerce.identity.${kind}.v1\0`).update(value).digest('hex');
}
export async function identityLock(c:QueryExecutor,user:string){await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['identity:'+user]);}
/** Identity-level fact (V7): some active membership exists. Never reveals or selects a profile. */
export async function activeMember(c:QueryExecutor,user:string){return (await c.query('SELECT public.identity_active_membership($1) AS active',[user])).rows[0]?.active===true?{active:true}:undefined;}
export async function identityAudit(c:QueryExecutor,event:string,outcome:string,correlation:string,user?:string,actor?:string,job?:string){
 await c.query('INSERT INTO identity_audit(event_type,outcome,correlation_id,user_id,actor_id,job_id) VALUES($1,$2,$3,$4,$5,$6)',[event,outcome,correlation,user??null,actor??null,job??null]);
}
export async function invalidateResetLinks(c:QueryExecutor,user:string){
 await c.query('DELETE FROM verification WHERE identifier IN (SELECT digest FROM identity_reset_links WHERE user_id=$1)',[user]);
 await c.query('DELETE FROM identity_reset_links WHERE user_id=$1',[user]);
 await c.query("UPDATE identity_mail_jobs SET status='CANCELLED',payload_ciphertext=NULL,finished_at=now(),diagnostic_code='LINK_INVALIDATED' WHERE user_id=$1 AND status IN ('PENDING','SENDING')",[user]);
}
/** Fixed windows anchored at first use; the atomic upsert works across processes/restarts. */
export async function identityLimit(kind:string,value:string,max:number,seconds=900,executor:QueryExecutor=pool){
 const key=identityDigest(kind,value);
 const r=await executor.query(`INSERT INTO identity_rate_limits(bucket,hits,expires_at) VALUES($1,1,now()+$2*interval '1 second')
 ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN identity_rate_limits.expires_at<=now() THEN 1 ELSE LEAST(identity_rate_limits.hits+1,$3+1) END,
 expires_at=CASE WHEN identity_rate_limits.expires_at<=now() THEN now()+$2*interval '1 second' ELSE identity_rate_limits.expires_at END RETURNING hits`,[key,seconds,max]);
 return r.rows[0].hits<=max;
}
