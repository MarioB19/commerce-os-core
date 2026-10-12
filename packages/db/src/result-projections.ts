import {createHash} from 'node:crypto';
import {z} from 'zod';
import {requireProfileId,type ProfileExecutor} from './profile-context.js';
import {resultContributionSchema,type ResultContribution,type ResultProjection,resultCounterNames} from '../../contracts/src/result-projection.js';
import {canonicalResultProjection,resultProjectionDeltas,applyResultCounterDelta,emptyResultCounters,resultGrainKey,mergeResultContributions,projectionRevisionDecision} from '../../domain/src/sales/result-projection.js';
import {applyResultLatencyDelta} from '../../domain/src/sales/result-latency.js';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const factsSchema=z.array(resultContributionSchema).max(1000);
export function resultSourceDigest(workspace:string,kind:ResultProjection['kind'],id:string){return digest(JSON.stringify(['result-source-v1',requireProfileId(workspace),kind,z.uuid().parse(id).toLowerCase()]));}
/** Internal worker port; it is intentionally absent from the API/MCP registry. */
async function scope(db:ProfileExecutor){
 requireProfileId(db.workspaceId);
 const s=(await db.query("SELECT current_user role,current_setting('app.workspace_id',true) workspace,current_setting('app.environment',true) environment")).rows[0];
 if(s?.role!=='commerce_results'||s.workspace!==db.workspaceId||s.environment!=='REAL')throw Error('RESULT_WRITER_CONTEXT_REQUIRED');
 // One lock also orders source revisions, seal and rebuild. Never external I/O.
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['result-projection-v1',db.workspaceId])]);
}
async function add(db:ProfileExecutor,table:'result_metric_daily'|'result_metric_sealed',before:ResultContribution[],after:ResultContribution[]){
 for(const item of resultProjectionDeltas(before,after)){
  const key=resultGrainKey(item.grain),id=digest(key),old=(await db.query(`SELECT grain,counters,latencies FROM ${table} WHERE workspace_id=$1 AND environment='REAL' AND grain_hash=$2 FOR UPDATE`,[db.workspaceId,id])).rows[0];
  if(old&&resultGrainKey(old.grain)!==key)throw Error('RESULT_GRAIN_COLLISION');
  const next=applyResultCounterDelta(old?.counters??emptyResultCounters(),item.delta),latencies=applyResultLatencyDelta(old?.latencies,item.latency_delta);
  if(resultCounterNames.every(k=>next[k]==='0')){await db.query(`DELETE FROM ${table} WHERE workspace_id=$1 AND environment='REAL' AND grain_hash=$2`,[db.workspaceId,id]);continue;}
  await db.query(`INSERT INTO ${table}(workspace_id,grain_hash,grain,counters,latencies) VALUES($1,$2,$3,$4,$5)
   ON CONFLICT(workspace_id,environment,grain_hash) DO UPDATE SET counters=EXCLUDED.counters,latencies=EXCLUDED.latencies`,[db.workspaceId,id,item.grain,next,latencies]);
 }
}
/** Caller must COMMIT through withProfileTransaction; no receipt precedes commit. */
export async function replaceResultProjection(db:ProfileExecutor,input:unknown){
 const q=canonicalResultProjection(input),source=resultSourceDigest(db.workspaceId,q.kind,q.source_id),fingerprint=digest(JSON.stringify(q.facts));await scope(db);
 const old=(await db.query("SELECT revision::text,fingerprint,facts,sealed_at FROM result_projection_sources WHERE workspace_id=$1 AND environment='REAL' AND kind=$2 AND source_digest=$3 FOR UPDATE",[db.workspaceId,q.kind,source])).rows[0];
 const decision=projectionRevisionDecision(old??null,{revision:q.revision,fingerprint});
 if(decision==='NO_EFFECT')return{status:decision,revision:q.revision,fingerprint};
 if(old?.sealed_at)throw Error('RESULT_SOURCE_SEALED');
 await add(db,'result_metric_daily',old?factsSchema.parse(old.facts):[],q.facts);
 await db.query(`INSERT INTO result_projection_sources(workspace_id,kind,source_digest,revision,fingerprint,facts) VALUES($1,$2,$3,$4,$5,$6)
  ON CONFLICT(workspace_id,environment,kind,source_digest) DO UPDATE SET revision=EXCLUDED.revision,fingerprint=EXCLUDED.fingerprint,facts=EXCLUDED.facts`,[db.workspaceId,q.kind,source,q.revision,fingerprint,JSON.stringify(q.facts)]);
 return{status:'APPLIED' as const,revision:q.revision,fingerprint};
}
/** Seal removes per-source contributions, retaining only a deduplication digest.
 * Financial/AI sources stay mutable until their separate retention is due. */
export async function sealResultProjection(db:ProfileExecutor,input:{kind:ResultProjection['kind'];source_id:string;revision:string;fingerprint:string}){
 const q=z.object({kind:z.enum(['COHORT','FINANCIAL','AI']),source_id:z.uuid(),revision:z.string().regex(/^[1-9]\d{0,18}$/),fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(input);
 await scope(db);const source=resultSourceDigest(db.workspaceId,q.kind,q.source_id),row=(await db.query("SELECT revision::text,fingerprint,facts,sealed_at FROM result_projection_sources WHERE workspace_id=$1 AND environment='REAL' AND kind=$2 AND source_digest=$3 FOR UPDATE",[db.workspaceId,q.kind,source])).rows[0];
 if(!row||row.revision!==q.revision||row.fingerprint!==q.fingerprint)throw Error('RESULT_SEAL_SOURCE_CHANGED');
 if(row.sealed_at)return{status:'NO_EFFECT' as const};
 await add(db,'result_metric_sealed',[],factsSchema.parse(row.facts));
 await db.query("UPDATE result_projection_sources SET facts=NULL,sealed_at=clock_timestamp() WHERE workspace_id=$1 AND environment='REAL' AND kind=$2 AND source_digest=$3",[db.workspaceId,q.kind,source]);
 return{status:'SEALED' as const};
}
/** A generation is only declared after the collector reconciled its full snapshot.
 * watermark comes from the DB snapshot, never from a caller's wall clock. */
export async function finishResultProjectionGeneration(db:ProfileExecutor,input:{watermark:string;source_count:string}){
 const q=z.object({watermark:z.iso.datetime({offset:true}),source_count:z.string().regex(/^(0|[1-9]\d{0,18})$/)}).strict().parse(input);await scope(db);
 const row=(await db.query(`INSERT INTO result_projection_state(workspace_id,generation,phase,source_watermark,completed_at,source_count)
  SELECT $1,1,'READY',$2::timestamptz,clock_timestamp(),$3::bigint WHERE $2::timestamptz<=clock_timestamp()
  ON CONFLICT(workspace_id,environment) DO UPDATE SET generation=result_projection_state.generation+1,phase='READY',
   source_watermark=EXCLUDED.source_watermark,completed_at=EXCLUDED.completed_at,source_count=EXCLUDED.source_count
  WHERE result_projection_state.source_watermark IS NULL OR EXCLUDED.source_watermark>result_projection_state.source_watermark
  RETURNING generation::text,source_watermark,completed_at,source_count::text`,[db.workspaceId,q.watermark,q.source_count])).rows[0];
 if(!row)throw Error('RESULT_WATERMARK_STALE_OR_FUTURE');return row;
}
/** Rebuild does not discard the canonical table unless equality is proved.
 * A single transaction/role lock prevents exposing a half-rebuilt generation. */
export async function verifyResultProjectionRebuild(db:ProfileExecutor){
 await scope(db);
 const sealed=(await db.query("SELECT grain,counters,latencies FROM result_metric_sealed WHERE workspace_id=$1 AND environment='REAL' ORDER BY grain_hash",[db.workspaceId])).rows as ResultContribution[];
 const sources=(await db.query("SELECT facts FROM result_projection_sources WHERE workspace_id=$1 AND environment='REAL' AND sealed_at IS NULL ORDER BY kind,source_digest",[db.workspaceId])).rows;
 const expected=mergeResultContributions([...sealed,...sources.flatMap(r=>factsSchema.parse(r.facts))]).filter(r=>resultCounterNames.some(k=>r.counters[k]!=='0'));
 const current=mergeResultContributions((await db.query("SELECT grain,counters,latencies FROM result_metric_daily WHERE workspace_id=$1 AND environment='REAL'",[db.workspaceId])).rows);
 if(JSON.stringify(expected)!==JSON.stringify(current))throw Error('RESULT_REBUILD_DIFFERENCE');
 return{status:'VERIFIED' as const,grains:expected.length,fingerprint:digest(JSON.stringify(expected))};
}
/** Reporting must check this marker in the same SQL snapshot as its totals. */
export async function readResultProjectionGeneration(db:ProfileExecutor){
 const row=(await db.query("SELECT generation::text,phase,source_watermark,completed_at,source_count::text FROM result_projection_state WHERE workspace_id=$1 AND environment='REAL'",[requireProfileId(db.workspaceId)])).rows[0];
 if(!row||row.phase!=='READY')throw Error('RESULT_PROJECTION_NOT_READY');return row;
}
/** Full-snapshot reconciliation also removes reclassified TEST/deleted sources.
 * Sealed cohorts are never inferred absent from live records or subtracted. */
export async function removeMissingResultProjections(db:ProfileExecutor,seen:readonly {kind:ResultProjection['kind'];digest:string}[]){
 const entries=z.array(z.object({kind:z.enum(['COHORT','FINANCIAL','AI']),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).max(1000000).parse(seen);await scope(db);
 const present=new Set(entries.map(s=>s.kind+':'+s.digest));if(present.size!==entries.length)throw Error('RESULT_SNAPSHOT_DUPLICATE_SOURCE');
 const rows=(await db.query("SELECT kind,source_digest,facts,revision::text FROM result_projection_sources WHERE workspace_id=$1 AND environment='REAL' AND sealed_at IS NULL AND facts<>'[]'::jsonb ORDER BY kind,source_digest FOR UPDATE",[db.workspaceId])).rows;
 let removed=0;
 for(const row of rows){if(present.has(row.kind+':'+row.source_digest))continue;
  await add(db,'result_metric_daily',factsSchema.parse(row.facts),[]);
  await db.query("UPDATE result_projection_sources SET facts='[]',revision=revision+1,fingerprint=$4 WHERE workspace_id=$1 AND environment='REAL' AND kind=$2 AND source_digest=$3",[db.workspaceId,row.kind,row.source_digest,digest('[]')]);removed++;
 }
 return removed;
}
