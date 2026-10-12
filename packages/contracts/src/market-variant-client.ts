import {z} from 'zod';
import {marketDraftFieldsSchema,marketEnvironmentSchema,marketDraftCreateSchema,marketDraftReplaceSchema,
 marketFamilyCreateSchema,marketCopySchema,marketPublishSchema,marketVariantListSchema} from './market-variant-store.js';
import {marketReleaseSchema,marketVersionRefSchema,marketCopyReviewFields} from './market-variants.js';
const id=z.uuid().transform(value=>value.toLowerCase()),version=z.number().int().positive().max(2147483646);
const common={environment:marketEnvironmentSchema},mutation={...common,operation_id:id};
export const marketCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('adopt'),...mutation,body:marketFamilyCreateSchema}).strict(),
 z.object({operation:z.literal('create'),...mutation,body:marketDraftCreateSchema}).strict(),
 z.object({operation:z.literal('copy'),...mutation,body:marketCopySchema}).strict(),
 z.object({operation:z.literal('replace'),...mutation,id,body:marketDraftReplaceSchema}).strict(),
 z.object({operation:z.literal('publish'),...mutation,id,body:marketPublishSchema}).strict(),
 z.object({operation:z.literal('get'),...common,id}).strict(),
 z.object({operation:z.literal('release'),...common,id}).strict(),
 z.object({operation:z.literal('reconcile'),...common,id}).strict(),
 z.object({operation:z.literal('list'),...marketVariantListSchema.shape}).strict(),
]);
export type MarketCommand=z.infer<typeof marketCommandSchema>;
export const marketDraftViewSchema=z.object({id,family_id:id,version,draft:marketDraftFieldsSchema,
 draft_sha256:z.string().regex(/^[a-f0-9]{64}$/),current_release_id:id.nullable(),source_release_id:id.nullable(),
 release_revision:z.number().int().nonnegative().max(2147483646)}).strict();
const copied=marketDraftViewSchema.extend({source_release:marketVersionRefSchema,pending_review:z.tuple([
 z.literal(marketCopyReviewFields[0]),z.literal(marketCopyReviewFields[1]),z.literal(marketCopyReviewFields[2]),
 z.literal(marketCopyReviewFields[3]),z.literal(marketCopyReviewFields[4]),z.literal(marketCopyReviewFields[5])]),publication_authorized:z.literal(false)}).strict();
const published=z.object({variant:marketDraftViewSchema,release:marketReleaseSchema,sha256:z.string().regex(/^[a-f0-9]{64}$/),effects_authorized:z.literal(false)}).strict();
const family=z.object({id}).strict(),receipt=z.union([family,marketDraftViewSchema,copied,published]);
export function marketCommandRoute(input:unknown){
 const value=marketCommandSchema.parse(input),query=new URLSearchParams({environment:value.environment});
 let path='/v2/market/',method:'GET'|'POST'|'PUT'='GET';
 switch(value.operation){
 case'adopt':path+='families';method='POST';break;
 case'create':path+='variants';method='POST';break;
 case'copy':path+='variants/copy';method='POST';break;
 case'replace':path+='variants/'+value.id+'/draft';method='PUT';break;
 case'publish':path+='variants/'+value.id+'/releases';method='POST';break;
 case'get':path+='variants/'+value.id;break;
 case'release':path+='releases/'+value.id;break;
 case'reconcile':path+='operations/'+value.id;break;
 case'list':path+='variants';query.set('family_id',value.family_id);query.set('limit',String(value.limit));if(value.after)query.set('after',value.after);break;
 }
 return{value,route:path+'?'+query,method};
}
export function marketCommandResult(raw:unknown,q:MarketCommand,workspace?:string){
 if(q.operation==='list'){
  const page=z.object({data:z.array(marketDraftViewSchema).max(q.limit),meta:z.object({has_more:z.boolean(),next:id.nullable()}).strict()}).strict().parse(raw);
  if(new Set(page.data.map(r=>r.id)).size!==page.data.length||page.data.some((r,i)=>r.family_id!==q.family_id||r.id<=(i===0?q.after??'':page.data[i-1]!.id))||page.meta.has_more&&(page.data.length!==q.limit||page.meta.next!==page.data.at(-1)!.id)||!page.meta.has_more&&page.meta.next!==null)throw new Error('MARKET_PAGE_CHANGED');
  return page;
 }
 const schema=q.operation==='adopt'?family:q.operation==='copy'?copied:q.operation==='publish'?published:q.operation==='release'?marketReleaseSchema:q.operation==='reconcile'?receipt:marketDraftViewSchema;
 const data=z.object({data:schema}).strict().parse(raw).data;
 if(q.operation==='adopt'&&('id'in data&&data.id!==q.body.product_id)||q.operation==='create'&&('family_id'in data&&data.family_id!==q.body.family_id)||['get','replace'].includes(q.operation)&&'id'in data&&'id'in q&&data.id!==q.id)throw new Error('MARKET_RESULT_ID_CHANGED');
 if(q.operation==='create'&&'draft'in data&&(data.version!==1||data.current_release_id!==null||data.source_release_id!==null||data.release_revision!==0||JSON.stringify(data.draft)!==JSON.stringify(q.body.fields)))throw new Error('MARKET_CREATE_CHANGED');
 if(q.operation==='replace'&&'draft'in data&&(data.version!==q.body.expected_version+1||JSON.stringify(data.draft)!==JSON.stringify(q.body.fields)))throw new Error('MARKET_REPLACE_CHANGED');
 if(q.operation==='publish'&&'variant'in data&&(data.variant.version!==q.body.expected_version+1||data.variant.draft_sha256!==q.body.draft_sha256||data.release.amount_minor!==data.variant.draft.amount_minor||JSON.stringify(data.release.locale)!==JSON.stringify(data.variant.draft.locale)||JSON.stringify(data.release.configuration)!==JSON.stringify(data.variant.draft.configuration)))throw new Error('MARKET_PUBLICATION_CHANGED');
 if(q.operation==='copy'&&'source_release'in data&&(data.source_release.id!==q.body.source_release_id||data.source_release_id!==q.body.source_release_id||JSON.stringify(data.draft.locale)!==JSON.stringify(q.body.locale)||data.current_release_id!==null||data.release_revision!==0||data.version!==1))throw new Error('MARKET_COPY_CHANGED');
 if('release'in data&&'variant'in data&&(data.release.variant_id!==data.variant.id||data.variant.current_release_id!==data.release.id||data.variant.release_revision!==data.release.revision||data.variant.family_id!==data.release.family_id||q.operation==='publish'&&data.variant.id!==q.id))throw new Error('MARKET_PUBLICATION_CHANGED');
 const release='scope'in data?data:'release'in data?data.release:null;
 if(release&&(release.scope.environment!==q.environment||workspace!==undefined&&release.scope.workspace_id!==workspace||q.operation==='release'&&release.id!==q.id))throw new Error('MARKET_RELEASE_SCOPE_CHANGED');
 return{data};
}
export type MarketCommandResult=ReturnType<typeof marketCommandResult>;
