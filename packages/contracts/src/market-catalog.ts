import {z} from 'zod';
import {marketScopeSchema,marketVersionRefSchema} from './market-variants.js';
import {marketEnvironmentSchema} from './market-variant-store.js';
const id=z.uuid().transform(v=>v.toLowerCase());
export const marketCatalogQuerySchema=z.object({environment:marketEnvironmentSchema}).strict();
export const marketCatalogProductSchema=z.object({id,version:z.number().int().positive().max(2147483646),name:z.string().min(1).max(160),adopted:z.boolean()}).strict();
export const marketCatalogOptionSchema=z.object({kind:z.enum(['offer','flow','seller','collection','material']),label:z.string().min(1).max(160),ref:marketVersionRefSchema}).strict();
export const marketCatalogSchema=z.object({scope:marketScopeSchema,product:marketCatalogProductSchema,
 options:z.array(marketCatalogOptionSchema).max(1000)}).strict().superRefine((v,ctx)=>{
 if(new Set(v.options.map(o=>o.kind+':'+o.ref.id+':'+o.ref.revision)).size!==v.options.length)ctx.addIssue({code:'custom',message:'Repeated option.'});
});
export type MarketCatalog=z.infer<typeof marketCatalogSchema>;
