import {z} from 'zod';
import {resultLatenciesSchema,latencyCoverageValid} from './result-latency.js';
const id=z.uuid().transform(v=>v.toLowerCase());
export const resultsDaySchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v);
export const countSchema=z.string().regex(/^(0|[1-9]\d{0,29})$/);
const currency=z.string().regex(/^[A-Z]{3}$/).refine(v=>Intl.supportedValuesOf('currency').includes(v));
export const resultDimensionsSchema=z.object({family_id:id.nullable(),variant_id:id.nullable(),market:z.string().max(160).nullable(),account_id:id.nullable(),campaign_id:z.string().regex(/^\d+$/).nullable(),ad_id:z.string().regex(/^\d+$/).nullable(),touch:z.enum(['FIRST_CONTACT','REMARKETING','UNKNOWN'])}).strict();
export const resultFiltersSchema=z.object({from:resultsDaySchema,to:resultsDaySchema,granularity:z.enum(['day','week','month']).default('day'),currency,
 family_id:id.optional(),variant_id:id.optional(),market:z.string().min(1).max(160).optional(),account_id:id.optional(),campaign_id:z.string().regex(/^\d+$/).optional(),ad_id:z.string().regex(/^\d+$/).optional(),touch:z.enum(['FIRST_CONTACT','REMARKETING','UNKNOWN']).optional(),
}).strict().refine(v=>v.from<=v.to&&Date.parse(v.to)-Date.parse(v.from)<=365*86400000,'El periodo admite hasta 366 días.');
export const funnelStages=['started','responded','offered','collection_sent','receipt_received','payment_approved'] as const;
export const funnelSchema=z.object(Object.fromEntries(funnelStages.map(k=>[k,countSchema])) as Record<typeof funnelStages[number],typeof countSchema>).strict().superRefine((v,ctx)=>{
 for(const k of funnelStages)if(BigInt(v[k])>BigInt(v.started))ctx.addIssue({code:'custom',message:'Una etapa no puede superar la cohorte.'});
});
export const resultDailyFactsSchema=z.object({day:resultsDaySchema,currency,dimensions:resultDimensionsSchema,funnel:funnelSchema,
 revenue_minor:countSchema,sales:countSchema,attributed_revenue_minor:countSchema,attributed_sales:countSchema,
 response_ms_sum:countSchema,response_samples:countSchema,sale_ms_sum:countSchema,sale_samples:countSchema,latencies:resultLatenciesSchema.optional(),
 ai_cost_microusd:countSchema,ai_cost_unknown_attempts:countSchema,ai_input_tokens:countSchema,ai_output_tokens:countSchema,ai_cache_read_tokens:countSchema,ai_cache_write_tokens:countSchema,ai_audio_input_tokens:countSchema,ai_tokens_unknown_attempts:countSchema,
}).strict().superRefine((v,c)=>{
 if(!latencyCoverageValid(v.latencies,v))c.addIssue({code:'custom',message:'Distribución de latencia incompatible.'});
 if(BigInt(v.attributed_sales)>BigInt(v.sales)||BigInt(v.attributed_revenue_minor)>BigInt(v.revenue_minor)||BigInt(v.response_samples)>BigInt(v.funnel.responded)||BigInt(v.sale_samples)>BigInt(v.funnel.payment_approved))c.addIssue({code:'custom',message:'Agregado incompatible con su evidencia.'});
});
export const resultCutSchema=z.object({family_id:id.optional(),variant_id:id.optional(),market:z.string().max(160).optional(),account_id:id.optional(),campaign_id:z.string().regex(/^\d+$/).optional(),ad_id:z.string().regex(/^\d+$/).optional(),touch:z.enum(['FIRST_CONTACT','REMARKETING','UNKNOWN']).optional()}).strict();
export const resultSpendSchema=z.object({day:resultsDaySchema,currency,cut:resultCutSchema,spend_minor:countSchema.nullable(),attributed_conversations:z.string().regex(/^(0|[1-9]\d{0,23})(\.\d{1,6})?$/).nullable(),comparable:z.boolean(),reason:z.string().max(100).nullable()}).strict().refine(v=>v.comparable?v.spend_minor!==null&&v.attributed_conversations!==null&&v.reason===null:v.reason!==null,'Cobertura de gasto incompleta.');
export const goalFieldsSchema=z.object({from:resultsDaySchema,to:resultsDaySchema,currency,
 family_id:id.nullable(),variant_id:id.nullable(),metric:z.enum(['REVENUE','SALES','MAX_COST_PER_SALE','ROAS']),
 target:z.string().regex(/^(0|[1-9]\d{0,23})(\.\d{1,6})?$/),
}).strict().superRefine((v,c)=>{
 if(v.from>v.to||Date.parse(v.to)-Date.parse(v.from)>365*86400000)c.addIssue({code:'custom',message:'Periodo inválido.'});
 if(v.variant_id&&!v.family_id)c.addIssue({code:'custom',message:'La variante requiere su producto padre.'});
 if(v.metric!=='ROAS'&&v.target.includes('.'))c.addIssue({code:'custom',message:'Usa unidades enteras.'});
 if(BigInt(v.target.replace('.',''))===0n)c.addIssue({code:'custom',message:'La meta debe ser positiva.'});
}).transform(v=>({...v,target:v.metric==='ROAS'&&v.target.includes('.')?v.target.replace(/\.?0+$/,''):v.target}));
export const goalCreateSchema=z.object({fields:goalFieldsSchema}).strict();
export const goalUpdateSchema=z.object({expected_version:z.number().int().positive().max(2147483646),fields:goalFieldsSchema,active:z.boolean()}).strict();
export type ResultFilters=z.infer<typeof resultFiltersSchema>;
export type ResultDailyFacts=z.infer<typeof resultDailyFactsSchema>;
export type ResultSpend=z.infer<typeof resultSpendSchema>;
export type GoalFields=z.infer<typeof goalFieldsSchema>;
export const resultOptionQuerySchema=z.object({kind:z.enum(['family','variant','market','account','campaign','ad']),after:z.string().min(1).max(256).optional(),limit:z.coerce.number().int().min(1).max(100).default(50),search:z.string().max(80).optional(),family_id:id.optional()}).strict();
