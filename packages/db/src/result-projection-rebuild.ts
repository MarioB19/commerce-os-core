import {createHash} from 'node:crypto';
import {z} from 'zod';
import {requireProfileId,type ProfileExecutor} from './profile-context.js';
import {resultContributionSchema,resultCounterNames,type ResultContribution} from '../../contracts/src/result-projection.js';
import {mergeResultContributions,resultGrainKey} from '../../domain/src/sales/result-projection.js';
import {verifyResultProjectionRebuild} from './result-projections.js';
import {emptyResultLatencies} from '../../domain/src/sales/result-latency.js';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const request=z.object({operation_id:z.uuid(),expected_generation:z.string().regex(/^[1-9]\d{0,18}$/).refine(v=>BigInt(v)<9223372036854775807n),canonical_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
async function scope(db:ProfileExecutor){
 requireProfileId(db.workspaceId);
 const r=(await db.query("SELECT current_user role,current_setting('app.workspace_id',true) workspace,current_setting('app.environment',true) environment,current_setting('transaction_isolation') isolation")).rows[0];
 if(r?.role!=='commerce_results'||r.workspace!==db.workspaceId||r.environment!=='REAL'||r.isolation!=='repeatable read')throw Error('RESULT_REBUILD_CONTEXT_REQUIRED');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['result-projection-v1',db.workspaceId])]);
}
async function canonical(db:ProfileExecutor){
 const sealed=(await db.query("SELECT grain,counters,latencies FROM result_metric_sealed WHERE workspace_id=$1 AND environment='REAL' ORDER BY grain_hash",[db.workspaceId])).rows;
 const sources=(await db.query("SELECT facts FROM result_projection_sources WHERE workspace_id=$1 AND environment='REAL' AND sealed_at IS NULL ORDER BY kind,source_digest",[db.workspaceId])).rows;
 const facts=mergeResultContributions([...sealed.map(v=>resultContributionSchema.parse(v)),...sources.flatMap(v=>z.array(resultContributionSchema).max(1000).parse(v.facts))]).filter(r=>resultCounterNames.some(k=>r.counters[k]!=='0'));
 return{facts,canonical_sha256:hash(JSON.stringify(facts))};
}
/** Internal preview from anonymous sources only; no public API mutation port. */
export async function previewResultProjectionRebuild(db:ProfileExecutor){
 await scope(db);const state=(await db.query("SELECT generation::text,phase,source_watermark FROM result_projection_state WHERE workspace_id=$1 AND environment='REAL'",[db.workspaceId])).rows[0];
 if(!state)throw Error('RESULT_REBUILD_GENERATION_REQUIRED');const data=await canonical(db);
 return{expected_generation:state.generation as string,phase:state.phase as 'READY'|'PENDING',source_watermark:state.source_watermark,canonical_sha256:data.canonical_sha256,grain_count:data.facts.length};
}
/** A single transaction replaces derived rows and records its receipt. The caller
 * must COMMIT, or reconcile the same operation UUID after a lost response.
 * Rebuild repairs derived values, never advances source coverage or clears a
 * previously PENDING collector marker. All other profiles remain untouched. */
export async function rebuildResultProjection(db:ProfileExecutor,input:unknown){
 const q=request.parse(input);await scope(db);
 const previous=(await db.query("SELECT generation_before::text,generation_after::text,canonical_sha256,grain_count,phase,source_watermark FROM result_rebuild_receipts WHERE workspace_id=$1 AND environment='REAL' AND operation_id=$2",[db.workspaceId,q.operation_id])).rows[0];
 if(previous){if(previous.generation_before!==q.expected_generation||previous.canonical_sha256!==q.canonical_sha256)throw Error('RESULT_REBUILD_OPERATION_CONFLICT');return{status:'NO_EFFECT' as const,...previous};}
 const state=(await db.query("SELECT generation::text,phase,source_watermark FROM result_projection_state WHERE workspace_id=$1 AND environment='REAL' FOR UPDATE",[db.workspaceId])).rows[0];
 if(!state||state.generation!==q.expected_generation)throw Error('RESULT_REBUILD_GENERATION_CHANGED');
 const data=await canonical(db);if(data.canonical_sha256!==q.canonical_sha256)throw Error('RESULT_REBUILD_SOURCE_CHANGED');
 // MVCC readers continue seeing the old complete set until this transaction
 // commits. The pending triggers remain installed and are never bypassed.
 await db.query("DELETE FROM result_metric_daily WHERE workspace_id=$1 AND environment='REAL'",[db.workspaceId]);
 for(const f of data.facts as ResultContribution[])await db.query('INSERT INTO result_metric_daily(workspace_id,grain_hash,grain,counters,latencies) VALUES($1,$2,$3,$4,$5)',[db.workspaceId,hash(resultGrainKey(f.grain)),f.grain,f.counters,f.latencies??emptyResultLatencies()]);
 const verified=await verifyResultProjectionRebuild(db);if(verified.fingerprint!==data.canonical_sha256)throw Error('RESULT_REBUILD_DIFFERENCE');
 const generation=(await db.query("UPDATE result_projection_state SET generation=generation+1,phase=$3 WHERE workspace_id=$1 AND environment='REAL' AND generation=$2::bigint RETURNING generation::text",[db.workspaceId,q.expected_generation,state.phase])).rows[0];
 if(!generation)throw Error('RESULT_REBUILD_GENERATION_CHANGED');
 await db.query('INSERT INTO result_rebuild_receipts(workspace_id,operation_id,generation_before,generation_after,canonical_sha256,grain_count,phase,source_watermark) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[db.workspaceId,q.operation_id,q.expected_generation,generation.generation,data.canonical_sha256,data.facts.length,state.phase,state.source_watermark]);
 return{status:'REBUILT' as const,generation_before:q.expected_generation,generation_after:generation.generation as string,canonical_sha256:data.canonical_sha256,grain_count:data.facts.length,phase:state.phase as 'READY'|'PENDING',source_watermark:state.source_watermark};
}
