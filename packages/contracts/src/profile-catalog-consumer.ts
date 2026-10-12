import {z} from 'zod';
import {profileCatalogResources,profileCatalogListSchema,profileCatalogVersionsQuerySchema} from './profile-catalog.js';

export const profileCatalogResourceSchema=z.enum(['categories','products','offers','materials','flows','sellers']);
export type ProfileCatalogResource=z.infer<typeof profileCatalogResourceSchema>;
const recordId=z.uuid().transform(value=>value.toLowerCase());
export const profileCatalogReadSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('list'),resource:profileCatalogResourceSchema,...profileCatalogListSchema.shape}).strict(),
 z.object({operation:z.literal('get'),resource:profileCatalogResourceSchema,id:recordId,environment:z.enum(['REAL','SIMULATION']).default('REAL')}).strict(),
 z.object({operation:z.literal('versions'),resource:profileCatalogResourceSchema,id:recordId,...profileCatalogVersionsQuerySchema.shape}).strict(),
]);
export type ProfileCatalogRead=z.infer<typeof profileCatalogReadSchema>;
export const profileCatalogRowSchema=z.object({id:z.uuid(),version:z.number().int().positive().max(2147483647),environment:z.enum(['REAL','SIMULATION']),
 created_at:z.iso.datetime({offset:true}),updated_at:z.iso.datetime({offset:true})}).catchall(z.unknown());
export type ProfileCatalogRow=z.infer<typeof profileCatalogRowSchema>;
export interface ProfileCatalogResult {data:ProfileCatalogRow[];hasMore:boolean}

export function profileCatalogReadRoute(input:unknown){
 const value=profileCatalogReadSchema.parse(input),query=new URLSearchParams();
 const {operation,resource,...fields}=value;
 for(const[key,item]of Object.entries(fields))if(key!=='id'&&item!==undefined)query.set(key,String(item));
 if(!Object.hasOwn(profileCatalogResources,resource))throw new Error('CATALOG_RESOURCE_INVALID');
 return{value,route:'/v2/catalog/'+resource+(operation==='list'?'':'/'+value.id+(operation==='versions'?'/versions':''))+'?'+query};
}

/** Decode the exact page returned by the scoped API. No client-side tenant choice. */
export function profileCatalogResult(value:unknown,request:ProfileCatalogRead):ProfileCatalogResult{
 const rows=z.array(profileCatalogRowSchema).max(request.operation==='get'?1:request.limit);
 let data:ProfileCatalogRow[],hasMore=false;
 if(request.operation==='get')data=[z.object({data:profileCatalogRowSchema}).strict().parse(value).data];
 else{
  const meta=request.operation==='list'?z.object({hasMore:z.boolean(),limit:z.literal(request.limit),offset:z.literal(request.offset)}).strict():z.object({hasMore:z.boolean(),limit:z.literal(request.limit)}).strict();
  const parsed=z.object({data:rows,meta}).strict().parse(value);data=parsed.data;hasMore=parsed.meta.hasMore;
  if(hasMore&&data.length!==request.limit)throw new Error('CATALOG_PAGE_INVALID');
 }
 if(data.some(row=>row.environment!==request.environment||request.operation!=='list'&&row.id!==request.id))throw new Error('CATALOG_ROW_CONTEXT_INVALID');
 const identities=data.map(row=>request.operation==='versions'?row.version:row.id);
 if(new Set(identities).size!==identities.length)throw new Error('CATALOG_DUPLICATE_ROW');
 if(request.operation==='versions'&&data.some((row,i)=>row.version>=(i===0?request.before??Infinity:data[i-1]!.version)))throw new Error('CATALOG_HISTORY_ORDER_INVALID');
 return{data,hasMore};
}
