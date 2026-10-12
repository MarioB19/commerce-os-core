import {funnelStages,resultDailyFactsSchema,resultSpendSchema,resultFiltersSchema,type ResultDailyFacts,type ResultSpend,type ResultFilters,type GoalFields} from '../../../contracts/src/results.js';
import {mergeResultLatencies,resultLatencyPercentile} from './result-latency.js';
export interface ResultMetric {value:string|null;reason:string|null}
const missing=(reason:string):ResultMetric=>({value:null,reason});
const value=(v:string):ResultMetric=>({value:v,reason:null});
function scaledDecimal(raw:string){if(!/^(0|[1-9]\d{0,29})(\.\d{1,6})?$/.test(raw))throw Error('RESULT_DECIMAL_INVALID');const [a,b='']=raw.split('.');return BigInt(a!)*1000000n+BigInt(b.padEnd(6,'0'));}
export function decimalRatio(n:bigint,d:bigint,places=6):ResultMetric{
 if(d===0n)return missing('NO_DENOMINATOR');if(d<0n||n<0n||!Number.isInteger(places)||places<0||places>8)throw Error('RESULT_RATIO_INVALID');
 const scale=10n**BigInt(places),rounded=(n*scale+d/2n)/d;
 if(!places)return value(rounded.toString());return value((rounded/scale).toString()+'.'+(rounded%scale).toString().padStart(places,'0'));
}
export function previousResultsPeriod(from:string,to:string){
 const parsed=resultFiltersSchema.parse({from,to,currency:'USD'}),days=1+(Date.parse(parsed.to)-Date.parse(parsed.from))/86400000;
 return{from:new Date(Date.parse(from)-days*86400000).toISOString().slice(0,10),to:new Date(Date.parse(from)-86400000).toISOString().slice(0,10),days};
}
export function resultBucket(day:string,granularity:ResultFilters['granularity']){
 if(granularity==='day')return day;if(granularity==='month')return day.slice(0,7)+'-01';
 const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-(d.getUTCDay()+6)%7);return d.toISOString().slice(0,10);
}
function matches(f:ResultDailyFacts,q:ResultFilters){return f.currency===q.currency&&f.day>=q.from&&f.day<=q.to&&
 (['family_id','variant_id','market','account_id','campaign_id','ad_id','touch'] as const).every(k=>q[k]===undefined||q[k]===f.dimensions[k]);}
const totalsKeys=['revenue_minor','sales','attributed_revenue_minor','attributed_sales','response_ms_sum','response_samples','sale_ms_sum','sale_samples','ai_cost_microusd','ai_cost_unknown_attempts','ai_input_tokens','ai_output_tokens','ai_cache_read_tokens','ai_cache_write_tokens','ai_audio_input_tokens','ai_tokens_unknown_attempts'] as const;
/** Facts are already deduplicated by the transactional projector. No monetary
 * conversion, provider calls, or guessed funnel steps are performed here. */
export function summarizeResults(facts:readonly ResultDailyFacts[],spend:readonly ResultSpend[],query:ResultFilters){
 const q=resultFiltersSchema.parse(query),rows=facts.map(f=>resultDailyFactsSchema.parse(f)).filter(f=>matches(f,q));
 const totals=Object.fromEntries(totalsKeys.map(k=>[k,rows.reduce((n,r)=>n+BigInt(r[k]),0n)])) as Record<typeof totalsKeys[number],bigint>;
 const counts=Object.fromEntries(funnelStages.map(k=>[k,rows.reduce((n,r)=>n+BigInt(r.funnel[k]),0n)])) as Record<typeof funnelStages[number],bigint>;
 const days=1+(Date.parse(q.to)-Date.parse(q.from))/86400000;
 const costs=spend.map(s=>resultSpendSchema.parse(s)).filter(s=>s.currency===q.currency&&s.day>=q.from&&s.day<=q.to);
 for(const cost of costs)if((['family_id','variant_id','market','account_id','campaign_id','ad_id','touch'] as const).some(k=>cost.cut[k]!==q[k]))throw Error('RESULT_SPEND_SCOPE_MISMATCH');
 if(new Set(costs.map(c=>c.day)).size!==costs.length)throw Error('RESULT_SPEND_DAY_DUPLICATED');
 const comparable=costs.length===days&&costs.every(s=>s.comparable);
 const costReason=costs.find(s=>!s.comparable)?.reason??'SPEND_COVERAGE_INCOMPLETE';
 const spent=costs.reduce((n,s)=>n+BigInt(s.spend_minor??'0'),0n),attributedConversations=costs.reduce((n,s)=>n+scaledDecimal(s.attributed_conversations??'0'),0n);
 const validSpend=(n:bigint,d:bigint)=>comparable?decimalRatio(n,d):missing(costReason);
 const latencies=mergeResultLatencies(rows.map(r=>r.latencies));
 const ai=(d:bigint)=>totals.ai_cost_unknown_attempts?missing('AI_COST_INCOMPLETE'):decimalRatio(totals.ai_cost_microusd,d);
 return{currency:q.currency,funnel:funnelStages.map(stage=>({stage,count:counts[stage].toString(),fraction:decimalRatio(counts[stage],counts.started)})),
  totals:Object.fromEntries(totalsKeys.map(k=>[k,totals[k].toString()])),
  conversion:decimalRatio(counts.payment_approved,counts.started),average_ticket_minor:decimalRatio(totals.revenue_minor,totals.sales),
  spend_minor:comparable?value(spent.toString()):missing(costReason),cost_per_conversation_minor:validSpend(spent*1000000n,attributedConversations),cost_per_sale_minor:validSpend(spent,totals.attributed_sales),roas:validSpend(totals.attributed_revenue_minor,spent),
  first_response_ms:decimalRatio(totals.response_ms_sum,totals.response_samples),first_sale_ms:decimalRatio(totals.sale_ms_sum,totals.sale_samples),
  latency_percentiles:{method:'nearest_rank' as const,unit:'ms' as const,response:{p50:resultLatencyPercentile(latencies.response,totals.response_samples.toString(),50),p95:resultLatencyPercentile(latencies.response,totals.response_samples.toString(),95)},sale:{p50:resultLatencyPercentile(latencies.sale,totals.sale_samples.toString(),50),p95:resultLatencyPercentile(latencies.sale,totals.sale_samples.toString(),95)}},
  ai:{currency:'USD' as const,unit:'microUSD' as const,cost:totals.ai_cost_unknown_attempts?missing('AI_COST_INCOMPLETE'):value(totals.ai_cost_microusd.toString()),per_conversation:ai(counts.started),per_sale:ai(totals.sales),tokens:Object.fromEntries((['input','output','cache_read','cache_write','audio_input'] as const).map(k=>[k,totals.ai_tokens_unknown_attempts?missing('AI_TOKENS_INCOMPLETE'):value(totals[`ai_${k}_tokens`].toString())]))},
  basis:{funnel:'conversation_start_cohort',revenue:'payment_effective_date',spend:'meta_activity_date',comparison:'same_length_previous_calendar_period'},
 };
}

/** Calendar run rate, explicitly an assumption rather than a sales forecast. */
export function resultGoalProgress(fields:GoalFields,summary:ReturnType<typeof summarizeResults>,today:string){
 resultFiltersSchema.parse({from:today,to:today,currency:fields.currency});if(fields.currency!==summary.currency)throw Error('GOAL_CURRENCY_MISMATCH');
 const actual=fields.metric==='REVENUE'?value(summary.totals.revenue_minor!):fields.metric==='SALES'?value(summary.totals.sales!):fields.metric==='MAX_COST_PER_SALE'?summary.cost_per_sale_minor:summary.roas;
 const totalDays=1+(Date.parse(fields.to)-Date.parse(fields.from))/86400000,elapsedDays=Math.max(0,Math.min(totalDays,1+(Date.parse(today)-Date.parse(fields.from))/86400000));
 const target=scaledDecimal(fields.target),observed=actual.value===null?null:scaledDecimal(actual.value),met=observed===null?null:fields.metric==='MAX_COST_PER_SALE'?observed<=target:observed>=target;
 const progress=observed===null?missing(actual.reason??'NO_DATA'):fields.metric==='MAX_COST_PER_SALE'?(observed===0n?missing('ZERO_COST_TARGET_MET'):decimalRatio(target,observed)):decimalRatio(observed,target);
 const ratio=fields.metric==='MAX_COST_PER_SALE'||fields.metric==='ROAS';
 const projection=observed===null?missing(actual.reason??'NO_DATA'):elapsedDays===0?missing('PERIOD_NOT_STARTED'):ratio?actual:decimalRatio(observed*BigInt(totalDays),BigInt(elapsedDays)*1000000n);
 return{actual,target:fields.target,progress,met,projection,elapsed_days:elapsedDays,total_days:totalDays,projection_basis:ratio?'unchanged_observed_ratio':'calendar_linear_run_rate',as_of:today};
}
