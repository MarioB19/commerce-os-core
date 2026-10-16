import {requireProfileId,type ProfileExecutor} from './profile-context.js';
import {resultFiltersSchema,resultDailyFactsSchema,type ResultFilters} from '../../contracts/src/results.js';
import {resultCounterNames} from '../../contracts/src/result-projection.js';
import {previousResultsPeriod} from '../../domain/src/sales/results.js';
const keys=['family_id','variant_id','market','account_id','campaign_id','ad_id','touch'] as const;
const funnel=['started','responded','offered','collection_sent','receipt_received','payment_approved'] as const;
const counters=resultCounterNames.filter(k=>!funnel.includes(k as typeof funnel[number]));
/** Financial current/previous periods, watermark and pending marker come from
 * one PostgreSQL statement, so a concurrent worker commit cannot mix batches. */
export async function readProjectedResultRange(db:ProfileExecutor,input:unknown){
 const q=resultFiltersSchema.parse(input),workspace=requireProfileId(db.workspaceId),from=previousResultsPeriod(q.from,q.to).from;
 const cuts=keys.map((k,i)=>`($${i+5}::text IS NULL OR m.grain->'dimensions'->>'${k}'=$${i+5})`).join(' AND ');
 const row=(await db.query(`WITH selected AS(
   SELECT m.grain,m.counters,m.latencies FROM result_metric_daily m WHERE m.workspace_id=$1 AND m.environment='REAL'
    AND NOT(m.grain ? 'ai_unattributed') AND m.grain->>'currency'=$4 AND m.grain->>'day' BETWEEN $2 AND $3 AND ${cuts}
  ), unattributed AS(SELECT m.grain,m.counters,m.latencies FROM result_metric_daily m WHERE m.workspace_id=$1 AND m.environment='REAL' AND m.grain->>'ai_unattributed'='true' AND m.grain->>'day' BETWEEN $2 AND $3 AND ${cuts}
  ), unattributed_daily AS(SELECT grain->>'day' AS day,${resultCounterNames.filter(k=>k.startsWith('ai_')).map(k=>`sum((counters->>'${k}')::numeric)::text AS ${k}`).join(',')} FROM unattributed GROUP BY 1
  ), latency_cells AS(SELECT grain->>'day' AS day,k.key AS kind,h.key AS ms,sum((h.value#>>'{}')::numeric)::text n FROM selected CROSS JOIN LATERAL jsonb_each(latencies) k CROSS JOIN LATERAL jsonb_each(k.value) h GROUP BY 1,2,3
  ), latency_kinds AS(SELECT day,kind,jsonb_object_agg(ms,n) histogram FROM latency_cells GROUP BY day,kind
  ), daily_counters AS(SELECT grain->>'day' AS day,${resultCounterNames.map(k=>`sum((counters->>'${k}')::numeric)::text AS ${k}`).join(',')} FROM selected GROUP BY 1
  ), daily AS(SELECT d.*,jsonb_build_object('response',COALESCE(r.histogram,'{}'::jsonb),'sale',COALESCE(t.histogram,'{}'::jsonb)) latencies FROM daily_counters d LEFT JOIN latency_kinds r ON r.day=d.day AND r.kind='response' LEFT JOIN latency_kinds t ON t.day=d.day AND t.kind='sale')
  SELECT s.phase,s.generation::text,s.source_watermark,s.completed_at,
   (SELECT COALESCE(jsonb_agg(to_jsonb(unattributed_daily) ORDER BY day),'[]'::jsonb) FROM unattributed_daily) unattributed,
   (SELECT COALESCE(jsonb_agg(to_jsonb(daily) ORDER BY day),'[]'::jsonb) FROM daily) facts,
   (SELECT COALESCE(jsonb_agg(t.timezone ORDER BY t.timezone),'[]'::jsonb) FROM (SELECT DISTINCT grain->>'timezone' timezone FROM selected) t) timezones
  FROM result_projection_state s WHERE s.workspace_id=$1 AND s.environment='REAL'
   AND current_user='commerce_api' AND current_setting('app.workspace_id',true)=$1 AND current_setting('app.environment',true)='REAL'`,
 [workspace,from,q.to,q.currency,...keys.map(k=>q[k]??null)])).rows[0];
 if(!row||row.phase!=='READY')throw Error('RESULT_PROJECTION_NOT_READY');
 return{generation:row.generation as string,watermark:new Date(row.source_watermark).toISOString(),completed_at:new Date(row.completed_at).toISOString(),timezones:row.timezones as string[],
  unattributed:row.unattributed as Array<Record<string,string>>,
  facts:(row.facts as Record<string,string>[]).map(r=>resultDailyFactsSchema.parse({day:r.day,currency:q.currency,dimensions:Object.fromEntries(keys.map(k=>[k,q[k]??(k==='touch'?'UNKNOWN':null)])),
   latencies:r.latencies,funnel:Object.fromEntries(funnel.map(k=>[k,r[k]])),...Object.fromEntries(counters.map(k=>[k,r[k]]))})),coverage:{from,to:q.to}};
}
export function projectedPeriod(facts:Awaited<ReturnType<typeof readProjectedResultRange>>['facts'],q:ResultFilters){return facts.filter(f=>f.day>=q.from&&f.day<=q.to);}
