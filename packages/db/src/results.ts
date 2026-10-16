import {requireProfileId,type ProfileExecutor} from './profile-context.js';
import {resultDailyFactsSchema,resultSpendSchema,resultFiltersSchema,type ResultFilters,type ResultDailyFacts} from '../../contracts/src/results.js';
import {summarizeResults,previousResultsPeriod,resultBucket} from '../../domain/src/sales/results.js';
import {readProjectedResultRange,projectedPeriod} from './result-projection-reader.js';
const keys=['family_id','variant_id','market','account_id','campaign_id','ad_id','touch'] as const;
const totalKeys=['revenue_minor','sales','attributed_revenue_minor','attributed_sales','response_ms_sum','response_samples','sale_ms_sum','sale_samples','ai_cost_microusd','ai_cost_unknown_attempts','ai_input_tokens','ai_output_tokens','ai_cache_read_tokens','ai_cache_write_tokens','ai_audio_input_tokens','ai_tokens_unknown_attempts'] as const;
async function scope(db:ProfileExecutor){requireProfileId(db.workspaceId);const row=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) AS workspace,timezone FROM profiles WHERE id=$1",[db.workspaceId])).rows[0];if(row?.role!=='commerce_api'||row.workspace!==db.workspaceId)throw Error('RESULT_PROFILE_CONTEXT_REQUIRED');return row.timezone as string;}
const cuts=keys.map((key,i)=>`($${i+5}::text IS NULL OR ${key}::text=$${i+5})`).join(' AND ');
function params(db:ProfileExecutor,q:ResultFilters){return[db.workspaceId,q.from,q.to,q.currency,...keys.map(k=>q[k]??null)];}
function fact(row:Record<string,string>,q:ResultFilters):ResultDailyFacts{return resultDailyFactsSchema.parse({day:row.day,currency:q.currency,
 dimensions:Object.fromEntries(keys.map(k=>[k,q[k]??(k==='touch'?'UNKNOWN':null)])),
 funnel:Object.fromEntries(['started','responded','offered','collection_sent','receipt_received','payment_approved'].map(k=>[k,row[k]??'0'])),
 ...Object.fromEntries(totalKeys.map(k=>[k,row[k]??'0']))});}
/** Aggregation is pushed down to PostgreSQL; at most 366 daily rows reach API. */
export async function readResultFacts(db:ProfileExecutor,input:unknown){
 const q=resultFiltersSchema.parse(input);await scope(db);
 const cohort=(await db.query(`SELECT (started_at AT TIME ZONE timezone)::date::text AS day,count(*)::text started,
  count(*) FILTER(WHERE first_response_at IS NOT NULL)::text responded,count(*) FILTER(WHERE offered)::text offered,
  count(*) FILTER(WHERE collection_sent)::text collection_sent,count(*) FILTER(WHERE receipt_received)::text receipt_received,
  count(*) FILTER(WHERE first_sale_at IS NOT NULL)::text payment_approved,
  COALESCE(sum(floor(extract(epoch FROM(first_response_at-started_at))*1000)) FILTER(WHERE first_response_at>=started_at),0)::text response_ms_sum,
  count(*) FILTER(WHERE first_response_at>=started_at)::text response_samples,
  COALESCE(sum(floor(extract(epoch FROM(first_sale_at-started_at))*1000)) FILTER(WHERE first_sale_at>=started_at),0)::text sale_ms_sum,
  count(*) FILTER(WHERE first_sale_at>=started_at)::text sale_samples
 FROM result_journey_facts WHERE workspace_id=$1 AND environment='REAL' AND currency=$4
  AND started_at>=$2::date AT TIME ZONE timezone AND started_at<($3::date+1) AT TIME ZONE timezone AND ${cuts}
 GROUP BY 1 ORDER BY 1`,params(db,q))).rows;
 const payments=(await db.query(`SELECT (effective_at AT TIME ZONE timezone)::date::text AS day,
  COALESCE(sum(amount_minor),0)::text revenue_minor,count(DISTINCT order_id) FILTER(WHERE effective_at=first_order_payment_at)::text sales,
  COALESCE(sum(amount_minor) FILTER(WHERE ad_id IS NOT NULL),0)::text attributed_revenue_minor,
  count(DISTINCT order_id) FILTER(WHERE ad_id IS NOT NULL AND effective_at=first_order_payment_at)::text attributed_sales
 FROM result_payment_facts WHERE workspace_id=$1 AND environment='REAL' AND currency=$4
  AND effective_at>=$2::date AT TIME ZONE timezone AND effective_at<($3::date+1) AT TIME ZONE timezone AND ${cuts}
 GROUP BY 1 ORDER BY 1`,params(db,q))).rows;
 // Ledger 019 separates reservations from measured usage. TEST never contributes.
 const ai=(await db.query(`WITH scoped AS(SELECT a.*,j.timezone,j.currency,j.family_id,j.market,j.account_id,j.campaign_id,j.ad_id,j.touch
  FROM result_ai_cost_facts a JOIN result_journey_facts j ON j.workspace_id=a.workspace_id AND j.environment=a.environment AND j.journey_id=a.conversation_id
  WHERE a.workspace_id=$1 AND a.environment='REAL' AND a.operation_class='OPERATION' AND a.intent_at IS NOT NULL)
 SELECT (occurred_at AT TIME ZONE timezone)::date::text AS day,COALESCE(sum(measured_cost_microusd),0)::text ai_cost_microusd,
  count(*) FILTER(WHERE measured_cost_microusd IS NULL)::text ai_cost_unknown_attempts,
  COALESCE(sum(input_tokens),0)::text ai_input_tokens,COALESCE(sum(output_tokens),0)::text ai_output_tokens,
  COALESCE(sum(cache_read_tokens),0)::text ai_cache_read_tokens,COALESCE(sum(cache_write_tokens),0)::text ai_cache_write_tokens,COALESCE(sum(audio_input_tokens),0)::text ai_audio_input_tokens,
  count(*) FILTER(WHERE input_tokens IS NULL OR output_tokens IS NULL OR cache_read_tokens IS NULL OR cache_write_tokens IS NULL OR audio_input_tokens IS NULL)::text ai_tokens_unknown_attempts
 FROM scoped WHERE currency=$4 AND occurred_at>=$2::date AT TIME ZONE timezone AND occurred_at<($3::date+1) AT TIME ZONE timezone AND ${cuts}
 GROUP BY 1 ORDER BY 1`,params(db,q))).rows;
 const rows=new Map<string,Record<string,string>>();for(const row of [...cohort,...payments,...ai])rows.set(row.day,{...rows.get(row.day),...row});
 return [...rows.values()].sort((a,b)=>a.day!.localeCompare(b.day!)).map(r=>fact(r,q));
}
export async function readResultSpend(db:ProfileExecutor,input:unknown,snapshotTimezone?:string|null){
 const q=resultFiltersSchema.parse(input),profileTimezone=await scope(db),timezone=snapshotTimezone??profileTimezone,cut=Object.fromEntries(keys.filter(k=>q[k]!==undefined).map(k=>[k,q[k]]));
 const unavailable=snapshotTimezone===null?'SPEND_TIMEZONE_MIXED':q.variant_id||q.market||q.account_id||q.touch?'SPEND_DIMENSION_NOT_ATTRIBUTABLE':null;
 const rows=(await db.query(`WITH dates AS(SELECT generate_series($2::date,$3::date,interval '1 day')::date AS day),accounts AS(
  SELECT * FROM meta_insight_accounts WHERE workspace_id=$1 AND environment='REAL' AND currency=$4
 ), ad_spend AS(SELECT d.*,cp.product_id::text family_id FROM meta_insight_days d
  LEFT JOIN LATERAL(SELECT product_id FROM campaign_products cp WHERE cp.workspace_id=d.workspace_id AND cp.environment=d.environment
   AND cp.meta_ad_account_id=d.meta_ad_account_id AND cp.valid_from<=d.day AND (cp.entity_type='ad' AND cp.entity_id=d.entity_id OR cp.entity_type='campaign' AND cp.entity_id=d.campaign_id)
   ORDER BY (cp.entity_type='ad') DESC,cp.valid_from DESC,cp.revision DESC LIMIT 1) cp ON true
  WHERE d.workspace_id=$1 AND d.environment='REAL' AND d.currency=$4 AND d.timezone=$5 AND d.day BETWEEN $2::date AND $3::date AND d.level='ad'
 ), coverage AS(SELECT dates.day,
  EXISTS(SELECT 1 FROM accounts) AND NOT EXISTS(SELECT 1 FROM accounts a WHERE a.timezone<>$5 OR NOT EXISTS(SELECT 1 FROM meta_insight_coverage cv
   WHERE cv.workspace_id=a.workspace_id AND cv.environment=a.environment AND cv.meta_ad_account_id=a.meta_ad_account_id AND cv.day=dates.day)) complete,
  EXISTS(SELECT 1 FROM meta_insight_days campaign WHERE campaign.workspace_id=$1 AND campaign.environment='REAL' AND campaign.day=dates.day AND campaign.currency=$4 AND campaign.level='campaign'
   AND campaign.spend_minor<>(SELECT COALESCE(sum(ad.spend_minor),0) FROM ad_spend ad WHERE ad.day=campaign.day AND ad.meta_ad_account_id=campaign.meta_ad_account_id AND ad.campaign_id=campaign.campaign_id)) discrepancy
 FROM dates)
 SELECT cv.day::text,cv.complete,cv.discrepancy,EXISTS(SELECT 1 FROM ad_spend missing WHERE missing.day=cv.day AND missing.family_id IS NULL AND ($7::text IS NULL OR missing.campaign_id=$7) AND ($8::text IS NULL OR missing.entity_id=$8)) mapping_missing,COALESCE(sum(d.spend_minor),0)::text spend_minor,
  CASE WHEN count(d.entity_id) FILTER(WHERE d.conversations IS NULL)>0 THEN NULL ELSE COALESCE(sum(d.conversations),0)::text END attributed_conversations
 FROM coverage cv LEFT JOIN ad_spend d ON d.day=cv.day AND ($6::text IS NULL OR d.family_id=$6) AND ($7::text IS NULL OR d.campaign_id=$7) AND ($8::text IS NULL OR d.entity_id=$8)
 GROUP BY cv.day,cv.complete,cv.discrepancy ORDER BY cv.day`,[db.workspaceId,q.from,q.to,q.currency,timezone,q.family_id??null,q.campaign_id??null,q.ad_id??null])).rows;
 return rows.map(row=>{const reason=unavailable??(!row.complete?'SPEND_COVERAGE_INCOMPLETE':row.discrepancy?'SPEND_RECONCILIATION_DIFFERENCE':q.family_id&&row.mapping_missing?'SPEND_PRODUCT_MAPPING_INCOMPLETE':row.attributed_conversations===null?'ATTRIBUTED_CONVERSATIONS_MISSING':null);
  return resultSpendSchema.parse({day:row.day,currency:q.currency,cut,spend_minor:reason?null:row.spend_minor,attributed_conversations:reason?null:row.attributed_conversations,comparable:!reason,reason});});
}
/** Reference projection used by pre-adoption reconciliation tests only. */
export async function observedResultsReport(db:ProfileExecutor,input:unknown){
 const q=resultFiltersSchema.parse(input),timezone=await scope(db),previous=previousResultsPeriod(q.from,q.to),combined={...q,from:previous.from};
 // Two bounded periods are read separately because each public period is <=366d.
 const facts=await readResultFacts(db,q),spend=await readResultSpend(db,q),oldQuery={...q,from:previous.from,to:previous.to};
 const oldFacts=await readResultFacts(db,oldQuery),oldSpend=await readResultSpend(db,oldQuery);
 const buckets=new Map<string,{from:string;to:string}>();for(let day=Date.parse(q.from);day<=Date.parse(q.to);day+=86400000){const date=new Date(day).toISOString().slice(0,10),key=resultBucket(date,q.granularity),prior=buckets.get(key);buckets.set(key,{from:prior?.from??date,to:date});}
 return{workspace_id:db.workspaceId,environment:'REAL' as const,timezone,filters:q,
  summary:summarizeResults(facts,spend,q),previous:{from:previous.from,to:previous.to,summary:summarizeResults(oldFacts,oldSpend,oldQuery)},
  series:[...buckets].map(([bucket,period])=>{const oldPeriod={from:new Date(Date.parse(period.from)-previous.days*86400000).toISOString().slice(0,10),to:new Date(Date.parse(period.to)-previous.days*86400000).toISOString().slice(0,10)};return{bucket,...period,summary:summarizeResults(facts,spend,{...q,...period}),previous:{...oldPeriod,summary:summarizeResults(oldFacts,oldSpend,{...q,...oldPeriod})}};}),
  measured_at:new Date().toISOString(),source:'profile_sql_evidence_v1',coverage:{from:combined.from,to:q.to}};
}
/** Public V7 report uses persisted anonymous aggregates, including sealed history. */
export async function resultsReport(db:ProfileExecutor,input:unknown){
 const q=resultFiltersSchema.parse(input),range=await readProjectedResultRange(db,q),previous=previousResultsPeriod(q.from,q.to);
 const unallocated=(period:{from:string;to:string})=>({currency:'USD' as const,unit:'microUSD' as const,calendar:'UTC' as const,independent_of_sales_currency:true as const,...Object.fromEntries(['cost_microusd','cost_unknown_attempts','input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','audio_input_tokens','tokens_unknown_attempts'].map(k=>[k,range.unattributed.filter(f=>f.day!>=period.from&&f.day!<=period.to).reduce((v,f)=>v+BigInt(f['ai_'+k]!),0n).toString()]))});
 const timezone=range.timezones.length===1?range.timezones[0]!:await scope(db),comparableTimezone=range.timezones.length>1?null:timezone;
 const oldQuery={...q,from:previous.from,to:previous.to},facts=projectedPeriod(range.facts,q),oldFacts=projectedPeriod(range.facts,oldQuery);
 const spend=await readResultSpend(db,q,comparableTimezone),oldSpend=await readResultSpend(db,oldQuery,comparableTimezone);
 const buckets=new Map<string,{from:string;to:string}>();for(let day=Date.parse(q.from);day<=Date.parse(q.to);day+=86400000){const date=new Date(day).toISOString().slice(0,10),key=resultBucket(date,q.granularity),prior=buckets.get(key);buckets.set(key,{from:prior?.from??date,to:date});}
 return{workspace_id:db.workspaceId,environment:'REAL' as const,timezone,timezones:range.timezones,calendar:'MARKET_SNAPSHOT' as const,generation:range.generation,filters:q,unattributed_ai:{...unallocated(q),previous:unallocated(previous)},
  summary:summarizeResults(facts,spend,q),previous:{from:previous.from,to:previous.to,summary:summarizeResults(oldFacts,oldSpend,oldQuery)},
  series:[...buckets].map(([bucket,period])=>{const oldPeriod={from:new Date(Date.parse(period.from)-previous.days*86400000).toISOString().slice(0,10),to:new Date(Date.parse(period.to)-previous.days*86400000).toISOString().slice(0,10)};return{bucket,...period,summary:summarizeResults(facts,spend,{...q,...period}),previous:{...oldPeriod,summary:summarizeResults(oldFacts,oldSpend,{...q,...oldPeriod})}};}),
  measured_at:range.watermark,source:'profile_projection_v1' as const,coverage:range.coverage};
}
