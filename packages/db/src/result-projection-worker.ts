import {createHash} from 'node:crypto';
import {withProfileTransaction,type ProfilePool,type ProfileExecutor,type ProfileQuery} from './profile-context.js';
import {canonicalResultProjection} from '../../domain/src/sales/result-projection.js';
import {replaceResultProjection,resultSourceDigest,finishResultProjectionGeneration,verifyResultProjectionRebuild,removeMissingResultProjections} from './result-projections.js';
import type {ResultProjection} from '../../contracts/src/result-projection.js';
import {singleSourceLatencies} from '../../domain/src/sales/result-latency-source.js';
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** Reuses the common transaction/discard/pending-query boundary, changing only
 * its BEGIN. The collector independently rejects a reused READ COMMITTED scope. */
function snapshotPool(pool:ProfilePool):ProfilePool{return{async connect(){const c=await pool.connect();const query:ProfileQuery=(sql,values)=>c.query(sql==='BEGIN'?'BEGIN ISOLATION LEVEL REPEATABLE READ':sql,values);return{query,release:c.release.bind(c)};}};}
/** V7.1.1 (27-oct-2026): a conversation that never had a priced release, offer or
 * order has no currency, and the closed reader emits its contribution with
 * `currency: null`. Results add money and counts per currency, so such a
 * contribution cannot be placed in any of them: it is left out (nothing is
 * estimated) instead of failing the whole profile's projection, which kept
 * Resultados in RESULT_PROJECTION_NOT_READY in production. Any other invalid
 * contribution still fails the snapshot. */
export function pricedResultFacts(raw:unknown):unknown[]{
 if(!Array.isArray(raw))throw Error('RESULT_SOURCE_FACTS_INVALID');
 return raw.filter(fact=>!(fact!==null&&typeof fact==='object'&&(fact as {grain?:unknown}).grain!==null&&typeof (fact as {grain?:unknown}).grain==='object'
  &&'currency' in ((fact as {grain:object}).grain)&&((fact as {grain:{currency:unknown}}).grain.currency===null)));
}
export async function projectProfileResults(pool:ProfilePool,workspace:string){
 return withProfileTransaction(snapshotPool(pool),workspace,async db=>{
  await db.query("SELECT set_config('app.environment','REAL',true)");return collectResultProjection(db);
 });
}
/** No HTTP, credentials or wall-clock inputs. Pages and source revisions share
 * one PostgreSQL snapshot; transaction failure never exposes a partial batch. */
export async function collectResultProjection(db:ProfileExecutor){
 const snapshot=await reconcileResultProjectionSnapshot(db);
 const generation=await finishResultProjectionGeneration(db,{watermark:snapshot.watermark,source_count:snapshot.source_count});
 return{...generation,applied:snapshot.applied,removed:snapshot.removed,grains:snapshot.grains,fingerprint:snapshot.fingerprint};
}
/** Full reconciliation without publishing a second generation. D18 uses it
 * after source minimization in the SAME RR transaction: its snapshot watermark
 * is unchanged, so pretending to publish a newer observation would be false. */
export async function reconcileResultProjectionSnapshot(db:ProfileExecutor){
 const context=(await db.query("SELECT current_user role,current_setting('app.workspace_id',true) workspace,current_setting('app.environment',true) environment,current_setting('transaction_isolation') isolation,to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') watermark")).rows[0];
 if(context?.role!=='commerce_results'||context.workspace!==db.workspaceId||context.environment!=='REAL'||context.isolation!=='repeatable read')throw Error('RESULT_SNAPSHOT_CONTEXT_REQUIRED');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['result-projection-v1',db.workspaceId])]);
 const seen:Array<{kind:ResultProjection['kind'];digest:string}>=[];let applied=0;
 for(const kind of ['COHORT','FINANCIAL','AI'] as const){
  let after:string|null=null;
  for(;;){
   const rows=(await db.query('SELECT source_id,facts FROM read_result_source_page($1,$2,$3)',[kind,after,250])).rows;
   if(rows.length>250)throw Error('RESULT_SOURCE_PAGE_OVERFLOW');
   for(const row of rows){
    const priced=pricedResultFacts(row.facts);if(priced.length===0)continue;
    const source=canonicalResultProjection({kind,source_id:row.source_id,revision:'1',facts:singleSourceLatencies(priced)});
    if(after&&source.source_id<=after)throw Error('RESULT_SOURCE_PAGE_ORDER');after=source.source_id;
    const sourceDigest=resultSourceDigest(db.workspaceId,kind,source.source_id);seen.push({kind,digest:sourceDigest});
    if(seen.length>1000000)throw Error('RESULT_SNAPSHOT_WORK_BOUND');
    const old=(await db.query("SELECT revision::text,fingerprint,sealed_at FROM result_projection_sources WHERE workspace_id=$1 AND environment='REAL' AND kind=$2 AND source_digest=$3",[db.workspaceId,kind,sourceDigest])).rows[0];
    const fingerprint=digest(source.facts);
    if(old?.fingerprint===fingerprint)continue;
    if(old?.sealed_at)throw Error('RESULT_RESTORED_SOURCE_REQUIRES_ERASURE');
    const revision=old?(BigInt(old.revision)+1n).toString():'1';
    await replaceResultProjection(db,{...source,revision});applied++;
   }
   if(rows.length<250)break;
  }
 }
 const removed=await removeMissingResultProjections(db,seen);
 const rebuilt=await verifyResultProjectionRebuild(db);
 return{watermark:context.watermark,source_count:String(seen.length),applied,removed,grains:rebuilt.grains,fingerprint:rebuilt.fingerprint};
}
