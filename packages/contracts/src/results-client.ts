import {z} from 'zod';
import {profileIdSchema} from './profiles.js';
import {resultFiltersSchema,goalFieldsSchema,goalCreateSchema,goalUpdateSchema,countSchema,resultsDaySchema,funnelStages,resultOptionQuerySchema} from './results.js';
const id=z.uuid().transform(v=>v.toLowerCase()),version=z.number().int().positive();
const metric=z.object({value:z.string().regex(/^\d+(\.\d+)?$/).nullable(),reason:z.string().min(1).nullable()}).strict().refine(v=>(v.value===null)!==(v.reason===null));
const totals=z.object(Object.fromEntries(['revenue_minor','sales','attributed_revenue_minor','attributed_sales','response_ms_sum','response_samples','sale_ms_sum','sale_samples','ai_cost_microusd','ai_cost_unknown_attempts','ai_input_tokens','ai_output_tokens','ai_cache_read_tokens','ai_cache_write_tokens','ai_audio_input_tokens','ai_tokens_unknown_attempts'].map(k=>[k,countSchema])) as Record<'revenue_minor'|'sales'|'attributed_revenue_minor'|'attributed_sales'|'response_ms_sum'|'response_samples'|'sale_ms_sum'|'sale_samples'|'ai_cost_microusd'|'ai_cost_unknown_attempts'|'ai_input_tokens'|'ai_output_tokens'|'ai_cache_read_tokens'|'ai_cache_write_tokens'|'ai_audio_input_tokens'|'ai_tokens_unknown_attempts',typeof countSchema>).strict();
export const resultsSummarySchema=z.object({currency:z.string(),funnel:z.array(z.object({stage:z.enum(funnelStages),count:countSchema,fraction:metric}).strict()).length(6),totals,
 conversion:metric,average_ticket_minor:metric,spend_minor:metric,cost_per_conversation_minor:metric,cost_per_sale_minor:metric,roas:metric,first_response_ms:metric,first_sale_ms:metric,
 latency_percentiles:z.object({method:z.literal('nearest_rank'),unit:z.literal('ms'),response:z.object({p50:metric,p95:metric}).strict(),sale:z.object({p50:metric,p95:metric}).strict()}).strict(),
 ai:z.object({currency:z.literal('USD'),unit:z.literal('microUSD'),cost:metric,per_conversation:metric,per_sale:metric,tokens:z.object({input:metric,output:metric,cache_read:metric,cache_write:metric,audio_input:metric}).strict()}).strict(),
 basis:z.object({funnel:z.literal('conversation_start_cohort'),revenue:z.literal('payment_effective_date'),spend:z.literal('meta_activity_date'),comparison:z.literal('same_length_previous_calendar_period')}).strict(),
}).strict();
const period={from:resultsDaySchema,to:resultsDaySchema,summary:resultsSummarySchema};
export const unattributedAiSchema=z.object({currency:z.literal('USD'),unit:z.literal('microUSD'),calendar:z.literal('UTC'),independent_of_sales_currency:z.literal(true),cost_microusd:countSchema,cost_unknown_attempts:countSchema,input_tokens:countSchema,output_tokens:countSchema,cache_read_tokens:countSchema,cache_write_tokens:countSchema,audio_input_tokens:countSchema,tokens_unknown_attempts:countSchema}).strict();
export const resultsReportSchema=z.object({workspace_id:profileIdSchema,environment:z.literal('REAL'),timezone:z.string(),filters:resultFiltersSchema,
 timezones:z.array(z.string()).max(1000),calendar:z.literal('MARKET_SNAPSHOT'),generation:z.string().regex(/^[1-9]\d{0,18}$/),
 unattributed_ai:unattributedAiSchema.extend({previous:unattributedAiSchema}).strict(),
 summary:resultsSummarySchema,previous:z.object(period).strict(),series:z.array(z.object({bucket:resultsDaySchema,...period,previous:z.object(period).strict()}).strict()).max(366),
 measured_at:z.iso.datetime(),source:z.literal('profile_projection_v1'),coverage:z.object({from:resultsDaySchema,to:resultsDaySchema}).strict(),
}).strict();
export const goalViewSchema=z.object({id,workspace_id:profileIdSchema,version,active:z.boolean(),fields:goalFieldsSchema,created_at:z.iso.datetime(),updated_at:z.iso.datetime()}).strict();
const goalProgress=z.object({actual:metric,target:z.string(),progress:metric,met:z.boolean().nullable(),projection:metric,elapsed_days:z.number().int().nonnegative(),total_days:z.number().int().positive().max(366),projection_basis:z.enum(['unchanged_observed_ratio','calendar_linear_run_rate']),as_of:resultsDaySchema}).strict();
export const resultsCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('options'),query:resultOptionQuerySchema}).strict(),
 z.object({operation:z.literal('report'),filters:resultFiltersSchema}).strict(),
 z.object({operation:z.literal('goals'),after:id.optional(),limit:z.number().int().min(1).max(100).default(50)}).strict(),
 z.object({operation:z.literal('goal'),id}).strict(),z.object({operation:z.literal('progress'),id}).strict(),
 z.object({operation:z.literal('create'),operation_id:id,body:goalCreateSchema}).strict(),
 z.object({operation:z.literal('update'),operation_id:id,id,body:goalUpdateSchema}).strict(),
 z.object({operation:z.literal('reconcile'),id}).strict(),
]);
export type ResultsCommand=z.infer<typeof resultsCommandSchema>;
export function resultsCommandRoute(input:unknown){const value=resultsCommandSchema.parse(input);let route='/v2/goals',method:'GET'|'POST'|'PUT'='GET';
 switch(value.operation){case 'options':route='/v2/results/options?'+new URLSearchParams(Object.entries(value.query).map(([k,v])=>[k,String(v)]));break;case 'report':route='/v2/results?'+new URLSearchParams(Object.entries(value.filters).map(([k,v])=>[k,String(v)]));break;
 case 'goals':{const q=new URLSearchParams({limit:String(value.limit)});if(value.after)q.set('after',value.after);route+='?'+q;break;}
 case 'goal':route+='/'+value.id;break;case 'progress':route+='/'+value.id+'/progress';break;case 'create':method='POST';break;case 'update':method='PUT';route+='/'+value.id;break;case 'reconcile':route+='/operations/'+value.id;break;}
 return{value,route,method};
}
export function resultsCommandResult(raw:unknown,q:ResultsCommand,workspace?:string){
 const selected=(value:{workspace_id:string})=>{if(workspace&&value.workspace_id!==workspace)throw Error('RESULT_PROFILE_MISMATCH');};
 const page=(rows:readonly{id:string}[],next:string|null,limit:number,after?:string)=>{if(rows.some((r,i)=>i>0?r.id<=rows[i-1]!.id:after!==undefined&&r.id<=after)||next!==null&&(rows.length!==limit||next!==rows.at(-1)?.id))throw Error('RESULT_PAGE_INVALID');};
 if(q.operation==='options'){const r=z.object({workspace_id:profileIdSchema,kind:z.literal(q.query.kind),data:z.array(z.object({id:z.string().min(1).max(256),label:z.string().min(1).max(512)}).strict()).max(q.query.limit),next:z.string().max(256).nullable()}).strict().parse(raw);selected(r);page(r.data,r.next,q.query.limit,q.query.after);return{operation:q.operation,...r};}
 if(q.operation==='report'){const data=z.object({data:resultsReportSchema}).strict().parse(raw).data;selected(data);if(JSON.stringify(data.filters)!==JSON.stringify(q.filters))throw Error('RESULT_FILTER_MISMATCH');return{operation:q.operation,data};}
 if(q.operation==='goals'){const r=z.object({data:z.array(goalViewSchema).max(q.limit),next:id.nullable()}).strict().parse(raw);r.data.forEach(selected);page(r.data,r.next,q.limit,q.after);return{operation:q.operation,...r};}
 if(q.operation==='progress'){const data=z.object({data:z.object({goal:goalViewSchema,progress:goalProgress,measured_at:z.iso.datetime()}).strict()}).strict().parse(raw).data;selected(data.goal);if(data.goal.id!==q.id)throw Error('GOAL_ID_MISMATCH');return{operation:q.operation,data};}
 const data=z.object({data:goalViewSchema.nullable()}).strict().parse(raw).data;
 if(!data){if(q.operation!=='reconcile')throw Error('GOAL_MISSING');return{operation:q.operation,data:null};}
 selected(data);if((q.operation==='goal'||q.operation==='update')&&data.id!==q.id)throw Error('GOAL_ID_MISMATCH');
 if(q.operation==='create'&&(data.version!==1||JSON.stringify(data.fields)!==JSON.stringify(q.body.fields)))throw Error('GOAL_RESPONSE_MISMATCH');
 if(q.operation==='update'&&(data.version!==q.body.expected_version+1||data.active!==q.body.active||JSON.stringify(data.fields)!==JSON.stringify(q.body.fields)))throw Error('GOAL_RESPONSE_MISMATCH');
 return{operation:q.operation,data};
}
export type ResultsCommandResult=ReturnType<typeof resultsCommandResult>;
