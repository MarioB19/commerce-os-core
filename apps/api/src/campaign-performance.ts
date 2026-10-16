import {z} from 'zod';
import {hash,type QueryExecutor} from '@commerce/db';

import {campaignProductLabels,exactCatalogCandidate} from '../../../packages/domain/src/sales/campaign-product.js';

import {ratios} from '../../../packages/domain/src/sales/money.js';
import type {Body} from '@commerce/contracts';
import {fail} from './context.js';

const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
const metaId=z.string().regex(/^\d+$/),accountId=z.string().regex(/^act_\d+$/);
export const campaignFilterSchema=z.object({environment:z.enum(['REAL','SIMULATION']).optional(),from:day,to:day,currency:z.string().regex(/^[A-Z]{3}$/).default('MXN'),cost_basis:z.enum(['net','estimated_tax']).default('net'),fallback_tax_bps:z.coerce.number().int().min(0).max(10000).optional(),product_id:z.string().uuid().optional(),extracted_product:z.string().min(1).max(160).optional(),sold_product_id:z.string().uuid().optional(),campaign_id:metaId.optional(),ad_id:metaId.optional(),meta_ad_account_id:accountId.optional(),classification:z.enum(['VALID','ALL','PENDING','TEST','FALSE','DUPLICATE','UNATTRIBUTED']).default('VALID'),unassigned:z.enum(['true','false']).transform(v=>v==='true').optional(),offset:z.coerce.number().int().min(0).max(1000000).default(0),limit:z.coerce.number().int().min(1).max(100).default(30),granularity:z.enum(['day','week','month']).default('day')}).strict();
export type CampaignFilters=z.infer<typeof campaignFilterSchema>;
const paramsFor=(w:string,e:string,f:CampaignFilters,labels:Body[]=[])=>[w,e,f.from,f.to,f.currency,f.product_id??null,f.campaign_id??null,f.meta_ad_account_id??null,f.ad_id??null,f.sold_product_id??null,f.cost_basis,!!f.unassigned,JSON.stringify(labels),f.extracted_product??null,f.fallback_tax_bps??null];
// Account+ad identity, independent of spend date. No number, name or active-ad guessing.
export const campaignFactsSql=`WITH campaign_labels AS (SELECT * FROM jsonb_to_recordset($13::jsonb) AS l(meta_ad_account_id text,campaign_id text,key text,label text)), source_sales AS (
 SELECT p.id::text contribution_id,o.id::text order_id,r.id::text receipt_id,o.body->>'product_id' sold_product_id,
 o.body->'attribution' attribution,p.amount_minor,p.currency,p.effective_at,
 CASE WHEN o.body->>'commercial_classification'='TEST' THEN 'TEST' WHEN r.body->>'commercial_classification'='FALSE' THEN 'FALSE' WHEN r.body->>'status'='APPROVED' THEN 'VALID' ELSE 'PENDING' END classification
 FROM payment_contributions p JOIN records o ON o.id=p.order_id JOIN records r ON r.id=p.receipt_id WHERE p.workspace_id=$1 AND p.environment=$2
 UNION ALL
 SELECT r.id::text,o.id::text,r.id::text,o.body->>'product_id',o.body->'attribution',COALESCE((r.body->'extraction'->>'amount_minor')::bigint,0),COALESCE(r.body->'extraction'->>'currency',o.body->>'currency'),COALESCE((r.body->>'received_at')::timestamptz,r.created_at),
 CASE WHEN o.body->>'commercial_classification'='TEST' THEN 'TEST' WHEN r.body->>'commercial_classification'='FALSE' THEN 'FALSE' WHEN r.body->>'duplicate_of' IS NOT NULL THEN 'DUPLICATE' ELSE 'PENDING' END
 FROM records r JOIN records o ON o.id::text=r.body->>'order_id' AND o.workspace_id=r.workspace_id AND o.environment=r.environment AND o.kind='order'
 WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='receipt' AND NOT EXISTS(SELECT 1 FROM payment_contributions p WHERE p.receipt_id=r.id)
), sales_resolved AS (
 SELECT s.*,to_char(effective_at AT TIME ZONE 'America/Mexico_City','YYYY-MM-DD') AS day,
 CASE WHEN m.matches=1 THEN m.meta_ad_account_id END meta_ad_account_id,
 CASE WHEN m.matches=1 THEN m.campaign_id END campaign_id,
 CASE WHEN m.matches=1 THEN attribution->>'ad_id' END ad_id,
 CASE WHEN m.matches=1 THEN m.ad_name END ad_name,
 CASE WHEN m.matches=1 THEN m.campaign_name END campaign_name
 FROM source_sales s LEFT JOIN LATERAL (SELECT count(*) matches,min(meta_ad_account_id) meta_ad_account_id,min(campaign_id) campaign_id,min(ad_name) ad_name,min(campaign_name) campaign_name FROM meta_ad_metadata m
 WHERE m.workspace_id=$1 AND m.environment=$2 AND m.ad_id=s.attribution->>'ad_id'
 AND s.attribution->>'classification' IN ('observed','manual')
 AND (s.attribution->>'meta_ad_account_id' IS NULL OR m.meta_ad_account_id=s.attribution->>'meta_ad_account_id')) m ON true
 WHERE (effective_at AT TIME ZONE 'America/Mexico_City')::date BETWEEN $3::date AND $4::date AND currency=$5
), sales AS (
 SELECT s.*,cp.product_id::text promoted_product_id,CASE WHEN cp.product_id IS NULL THEN l.key END extracted_product_key FROM sales_resolved s LEFT JOIN LATERAL (
 SELECT product_id FROM campaign_products cp WHERE cp.workspace_id=$1 AND cp.environment=$2 AND cp.meta_ad_account_id=s.meta_ad_account_id AND cp.valid_from<=s.day::date
 AND (cp.entity_type='ad' AND cp.entity_id=s.ad_id OR cp.entity_type='campaign' AND cp.entity_id=s.campaign_id)
 ORDER BY (cp.entity_type='ad') DESC,cp.valid_from DESC,cp.revision DESC LIMIT 1) cp ON true LEFT JOIN campaign_labels l ON l.meta_ad_account_id=s.meta_ad_account_id AND l.campaign_id=s.campaign_id
), spend_base AS (
 SELECT d.day::text,d.meta_ad_account_id,d.campaign_id,d.entity_id ad_id,d.name ad_name,d.campaign_name,d.spend_minor,d.impressions,d.clicks,d.conversations,false control_difference FROM meta_insight_days d
 WHERE d.workspace_id=$1 AND d.environment=$2 AND d.day BETWEEN $3::date AND $4::date AND d.currency=$5 AND d.timezone='America/Mexico_City' AND d.level='ad'
 UNION ALL
 SELECT d.day::text,d.meta_ad_account_id,d.campaign_id,NULL,NULL,d.campaign_name,d.spend_minor-COALESCE(a.spend,0),NULL,NULL,NULL,true FROM meta_insight_days d
 LEFT JOIN LATERAL(SELECT sum(a.spend_minor) spend FROM meta_insight_days a WHERE a.workspace_id=d.workspace_id AND a.environment=d.environment AND a.meta_ad_account_id=d.meta_ad_account_id AND a.day=d.day AND a.level='ad' AND a.campaign_id=d.campaign_id) a ON true
 WHERE d.workspace_id=$1 AND d.environment=$2 AND d.day BETWEEN $3::date AND $4::date AND d.currency=$5 AND d.timezone='America/Mexico_City' AND d.level='campaign' AND d.spend_minor<>COALESCE(a.spend,0)
), spend AS (
 SELECT d.*,cp.product_id::text promoted_product_id,CASE WHEN cp.product_id IS NULL AND NOT d.control_difference THEN l.key END extracted_product_key,
 CASE WHEN $11='net' THEN d.spend_minor WHEN COALESCE(a.tax_bps,$15::int) IS NOT NULL THEN round(d.spend_minor::numeric*(10000+COALESCE(a.tax_bps,$15::int))/10000)::bigint ELSE NULL END selected_spend_minor
 FROM spend_base d JOIN meta_insight_accounts a ON a.workspace_id=$1 AND a.environment=$2 AND a.meta_ad_account_id=d.meta_ad_account_id
 LEFT JOIN LATERAL(SELECT product_id FROM campaign_products cp WHERE cp.workspace_id=$1 AND cp.environment=$2 AND cp.meta_ad_account_id=d.meta_ad_account_id AND cp.valid_from<=d.day::date
 AND NOT d.control_difference AND (cp.entity_type='ad' AND cp.entity_id=d.ad_id OR cp.entity_type='campaign' AND cp.entity_id=d.campaign_id)
 ORDER BY (cp.entity_type='ad') DESC,cp.valid_from DESC,cp.revision DESC LIMIT 1) cp ON true LEFT JOIN campaign_labels l ON l.meta_ad_account_id=d.meta_ad_account_id AND l.campaign_id=d.campaign_id
), filtered_sales AS (
 SELECT * FROM sales WHERE ($6::text IS NULL OR promoted_product_id=$6) AND ($7::text IS NULL OR campaign_id=$7) AND ($8::text IS NULL OR meta_ad_account_id=$8) AND ($9::text IS NULL OR ad_id=$9) AND ($10::text IS NULL OR sold_product_id=$10) AND (NOT $12 OR promoted_product_id IS NULL) AND ($14::text IS NULL OR extracted_product_key=$14)
), filtered_spend AS (
 SELECT * FROM spend WHERE ($6::text IS NULL OR promoted_product_id=$6) AND ($7::text IS NULL OR campaign_id=$7) AND ($8::text IS NULL OR meta_ad_account_id=$8) AND ($9::text IS NULL OR ad_id=$9) AND (NOT $12 OR promoted_product_id IS NULL) AND ($14::text IS NULL OR extracted_product_key=$14)
), measures AS (
 SELECT day,promoted_product_id,extracted_product_key,meta_ad_account_id,campaign_id,ad_id,campaign_name,ad_name,order_id,CASE WHEN classification='VALID' THEN amount_minor ELSE 0 END revenue_minor,classification,NULL::numeric spend_minor,NULL::numeric net_spend_minor,NULL::numeric impressions,NULL::numeric clicks,NULL::numeric conversations FROM filtered_sales
 UNION ALL SELECT day,promoted_product_id,extracted_product_key,meta_ad_account_id,campaign_id,ad_id,campaign_name,ad_name,NULL,0,NULL,selected_spend_minor,spend_minor,impressions,clicks,conversations FROM filtered_spend
)`;
const aggregate=`COALESCE(sum(spend_minor),0)::text spend_minor,COALESCE(sum(net_spend_minor),0)::text net_spend_observed_minor,COALESCE(sum(revenue_minor),0)::text revenue_minor,count(DISTINCT order_id) FILTER(WHERE classification='VALID')::int sales,
 COALESCE(sum(revenue_minor) FILTER(WHERE ad_id IS NOT NULL),0)::text attributed_revenue_minor,count(DISTINCT order_id) FILTER(WHERE classification='VALID' AND ad_id IS NOT NULL)::int attributed_sales,
 CASE WHEN count(*) FILTER(WHERE order_id IS NULL AND impressions IS NULL)>0 THEN NULL ELSE sum(impressions)::text END impressions,CASE WHEN count(*) FILTER(WHERE order_id IS NULL AND clicks IS NULL)>0 THEN NULL ELSE sum(clicks)::text END clicks,CASE WHEN count(*) FILTER(WHERE order_id IS NULL AND conversations IS NULL)>0 THEN NULL ELSE sum(conversations)::text END conversations`;
const number=(x:unknown)=>{const n=Number(x);if(!Number.isSafeInteger(n))throw fail(409,'AMOUNT_OVERFLOW');return n;};
function metric(row:Body,available:boolean,observed:boolean){const revenue=number(row.revenue_minor),spend=available?number(row.spend_minor):null,attributed=number(row.attributed_revenue_minor);return{...row,revenue_minor:revenue,spend_minor:spend,net_spend_observed_minor:observed?number(row.net_spend_observed_minor):null,attributed_revenue_minor:attributed,sales:Number(row.sales),attributed_sales:Number(row.attributed_sales),...ratios(spend,attributed,Number(row.attributed_sales)),balance_minor:spend===null?null:revenue-spend,average_ticket_minor:row.sales?revenue/row.sales:null,cost_per_meta_conversation_minor:spend!==null&&row.conversations!==null&&Number(row.conversations)>0?spend/Number(row.conversations):null,global_return:spend&&spend>0?revenue/spend:null};}
async function sourceQuality(c:QueryExecutor,w:string,e:string,f:CampaignFilters){
 const rows=(await c.query(`SELECT a.*,cv.covered_dates FROM meta_insight_accounts a LEFT JOIN LATERAL (
  SELECT array_agg(to_char(day,'YYYY-MM-DD') ORDER BY day) covered_dates FROM meta_insight_coverage cv
  WHERE cv.workspace_id=a.workspace_id AND cv.environment=a.environment AND cv.meta_ad_account_id=a.meta_ad_account_id AND cv.day BETWEEN $3::date AND $4::date
 ) cv ON true WHERE a.workspace_id=$1 AND a.environment=$2 AND ($5::text IS NULL OR a.meta_ad_account_id=$5) ORDER BY name`,[w,e,f.from,f.to,f.meta_ad_account_id??null])).rows;
 const accounts=rows.map(({covered_dates,...a})=>({...a,covered_days:(covered_dates??[]).length}));
 const comparable=accounts.filter(a=>a.currency===f.currency&&a.timezone==='America/Mexico_City'),days=(Date.parse(f.to)-Date.parse(f.from))/86400000+1;
 const accountDays=comparable.map(a=>new Set<string>(rows.find(r=>r.meta_ad_account_id===a.meta_ad_account_id)?.covered_dates??[]));
 const coverage=Array.from({length:days},(_,i)=>{const day=new Date(Date.parse(f.from)+i*86400000).toISOString().slice(0,10);return{day,complete:accountDays.length>0&&accountDays.every(d=>d.has(day)),observed:accountDays.some(d=>d.has(day))};});
 const unconfigured=comparable.filter(a=>a.tax_bps===null),taxRequested=f.cost_basis==='estimated_tax';
 const appliedAccounts=taxRequested&&f.fallback_tax_bps!==undefined?unconfigured.map(a=>a.meta_ad_account_id):[];
 const taxMissing=taxRequested&&unconfigured.length>0&&f.fallback_tax_bps===undefined;
 const latest=(await c.query('SELECT status,result,updated_at FROM meta_insight_jobs WHERE workspace_id=$1 AND environment=$2 ORDER BY created_at DESC LIMIT 1',[w,e])).rows[0];
 const complete=coverage.every(d=>d.complete),incompatibleTimezone=accounts.some(a=>a.currency===f.currency&&a.timezone!=='America/Mexico_City');
 const nonCoverageBlockers=[...(taxMissing?['TAX_RATE_MISSING']:[]),...(incompatibleTimezone?['INCOMPATIBLE_TIMEZONE']:[]),...(f.sold_product_id?['SOLD_PRODUCT_COST_UNAVAILABLE']:[])];
 const blockers=[...(!comparable.length?['NO_COMPARABLE_ACCOUNTS']:[]),...(!complete?['INCOMPLETE_COVERAGE']:[]),...nonCoverageBlockers];
 const available=blockers.length===0,partial=!complete||comparable.some(a=>a.status!=='SYNCED')||latest&&['PARTIAL','UNAVAILABLE'].includes(latest.status);
 const stale=comparable.some(a=>!a.last_success_at||Date.now()-Date.parse(a.last_success_at)>3600000);
 const quality={status:!comparable.length?'UNAVAILABLE':partial?'PARTIAL':stale?'STALE':'SYNCED',available,complete,tax_missing:taxMissing,
  tax_status:!taxRequested?'NOT_REQUESTED':taxMissing?'MISSING':appliedAccounts.length?'ESTIMATED':'CONFIGURED',tax_estimate:{fallback_bps:taxRequested?f.fallback_tax_bps??null:null,applied_accounts:appliedAccounts},
  coverage_days_count:coverage.filter(d=>d.complete).length,observed_days_count:coverage.filter(d=>d.observed).length,missing_days:coverage.filter(d=>!d.complete).map(d=>d.day),blockers,
  accounts,excluded_accounts:accounts.filter(a=>!comparable.includes(a)).map(a=>({meta_ad_account_id:a.meta_ad_account_id,currency:a.currency,timezone:a.timezone})),source:e==='SIMULATION'?'SIMULATION_FIXTURE':'META_API',last_job:latest??null,days,timezone:'America/Mexico_City',cost_basis:f.cost_basis,currency:f.currency};
 return{quality,coverage,nonCoverageBlockers};
}
async function productContext(c:QueryExecutor,w:string,e:string){
 const names=(await c.query('SELECT meta_ad_account_id,campaign_id,campaign_name,ad_id,ad_name FROM meta_ad_metadata WHERE workspace_id=$1 AND environment=$2 ORDER BY meta_ad_account_id,campaign_id,ad_id',[w,e])).rows;
 const extracted=campaignProductLabels(names.map(n=>n.campaign_name));
 const byCampaign=new Map<string,Body>();
 const conflicting=new Set<string>();
 names.forEach((n,i)=>{const key=n.meta_ad_account_id+':'+n.campaign_id,label=extracted[i];if(!label)return;const previous=byCampaign.get(key);if(previous&&previous.key!==label.key)conflicting.add(key);else byCampaign.set(key,{meta_ad_account_id:n.meta_ad_account_id,campaign_id:n.campaign_id,...label});});
 for(const key of conflicting)byCampaign.delete(key);
 return {names,labels:[...byCampaign.values()]};
}
export async function campaignPerformance(c:QueryExecutor,w:string,e:string,f:CampaignFilters){
 const context=await productContext(c,w,e),p=paramsFor(w,e,f,context.labels),source=await sourceQuality(c,w,e,f),{quality}=source,observed=quality.observed_days_count>0&&!f.sold_product_id;
 const totals=(await c.query(campaignFactsSql+` SELECT ${aggregate} FROM measures`,p)).rows[0];
 const groups=(await c.query(campaignFactsSql+` SELECT kind,id,meta_ad_account_id,array_agg(DISTINCT promoted_product_id) FILTER(WHERE promoted_product_id IS NOT NULL) product_ids,bool_or(promoted_product_id IS NULL) has_unassigned,${aggregate} FROM (
 SELECT 'campaign' kind,COALESCE(m.meta_ad_account_id||':'||campaign_id,'unattributed') id,m.* FROM measures m
 UNION ALL SELECT 'ad',COALESCE(m.meta_ad_account_id||':'||ad_id,'unattributed'),m.* FROM measures m
 ) grouped GROUP BY kind,id,meta_ad_account_id ORDER BY kind,sum(spend_minor) DESC NULLS LAST,id`,p)).rows;
 // Products aggregate all accounts exactly once. Reaggregate SQL grouping includes only group_account below.
 const productGroups=(await c.query(campaignFactsSql+` SELECT COALESCE(promoted_product_id,'campaign-name:'||extracted_product_key,'unassigned') id,${aggregate} FROM measures GROUP BY COALESCE(promoted_product_id,'campaign-name:'||extracted_product_key,'unassigned') ORDER BY sum(spend_minor) DESC NULLS LAST`,p)).rows;
 const series=(await c.query(campaignFactsSql+`, buckets AS (SELECT date_trunc('${f.granularity}',d) bucket,min(d)::date::text range_from,max(d)::date::text range_to FROM generate_series($3::date,$4::date,interval '1 day') d GROUP BY 1) SELECT to_char(b.bucket,'YYYY-MM-DD') AS day,b.range_from,b.range_to,${aggregate} FROM buckets b LEFT JOIN measures m ON date_trunc('${f.granularity}',m.day::date)=b.bucket GROUP BY b.bucket,b.range_from,b.range_to ORDER BY b.bucket`,p)).rows;
 const controls=(await c.query(campaignFactsSql+` SELECT classification,count(DISTINCT order_id)::int orders,count(*)::int documents,sum(amount_minor)::text amount_minor FROM filtered_sales GROUP BY classification`,p)).rows;
 const unattributed=(await c.query(campaignFactsSql+` SELECT count(DISTINCT order_id)::int sales,COALESCE(sum(amount_minor),0)::text revenue_minor FROM filtered_sales WHERE classification='VALID' AND ad_id IS NULL`,p)).rows[0];
 const reconciliation=(await c.query(campaignFactsSql+` SELECT COALESCE(sum(spend_minor) FILTER(WHERE control_difference),0)::text difference_minor,count(*) FILTER(WHERE control_difference)::int differences,COALESCE(sum(selected_spend_minor) FILTER(WHERE promoted_product_id IS NULL),0)::text unassigned_spend_minor,COALESCE(sum(spend_minor) FILTER(WHERE promoted_product_id IS NULL),0)::text net_unassigned_spend_observed_minor FROM filtered_spend`,p)).rows[0];
 const products=(await c.query("SELECT id::text,body->>'name' name FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='product'",[w,e])).rows;
 const names=context.names,extractedProducts=[...new Map(context.labels.map(l=>[l.key,{id:l.key,name:l.label,source:'CAMPAIGN_NAME'}])).values()];
 const decorate=(r:Body)=>{
  const m=names.find(x=>r.kind==='campaign'?`${x.meta_ad_account_id}:${x.campaign_id}`===r.id:`${x.meta_ad_account_id}:${x.ad_id}`===r.id);
  const label=context.labels.find(l=>l.meta_ad_account_id===m?.meta_ad_account_id&&l.campaign_id===m?.campaign_id);
  const productIds=r.product_ids??[],candidate=exactCatalogCandidate(label?.label??null,products);
  const extractedKey=r.kind==='product'&&r.id.startsWith('campaign-name:')?r.id.slice('campaign-name:'.length):null;
  const extractedLabel=extractedProducts.find(l=>l.id===extractedKey);
  const groupObserved=observed&&(!r.meta_ad_account_id||quality.accounts.some(a=>a.meta_ad_account_id===r.meta_ad_account_id&&a.currency===f.currency&&a.timezone==='America/Mexico_City'&&a.covered_days>0));
  return{...metric(r,quality.available,groupObserved),name:r.kind==='product'?extractedLabel?.name??products.find(x=>x.id===r.id)?.name??'Sin producto asignado':r.kind==='campaign'?m?.campaign_name??'Sin campaña atribuida':m?.ad_name??'Sin anuncio / diferencia de control',campaign_id:m?.campaign_id??null,ad_id:r.kind==='ad'?m?.ad_id??null:null,
   ...(r.kind==='product'?{source:extractedKey?'CAMPAIGN_NAME':r.id==='unassigned'?'UNASSIGNED':'EXPLICIT_MAPPING',product_id:extractedKey||r.id==='unassigned'?null:r.id,extracted_product:extractedKey}:{product_resolution:{...candidate,status:productIds.length>1||productIds.length&&r.has_unassigned?'MIXED':productIds.length===1?'EXPLICIT_MAPPING':candidate.status,product_ids:productIds,candidate_product_id:productIds.length?null:candidate.candidate_product_id},extraction:label?{label:label.label,key:label.key,source:'CAMPAIGN_NAME'}:null})};
 };
 const summary=metric(totals,quality.available,observed);
 const seriesMetrics=series.map(({range_from,range_to,...r})=>{const days=source.coverage.filter(d=>d.day>=range_from&&d.day<=range_to),complete=days.every(d=>d.complete);return{...metric(r,complete&&source.nonCoverageBlockers.length===0,days.some(d=>d.observed)&&!f.sold_product_id),coverage_days_count:days.filter(d=>d.complete).length,days:days.length,complete};});
 return{definition:'receipt_sales_v1',environment:e,filters:f,summary,series:seriesMetrics,groups:{products:productGroups.map(r=>decorate({...r,kind:'product'})),campaigns:groups.filter(r=>r.kind==='campaign').map(decorate),ads:groups.filter(r=>r.kind==='ad').map(decorate)},quality:{...quality,status:reconciliation.differences?'PARTIAL':quality.status,controls,unattributed:{...unattributed,revenue_minor:number(unattributed.revenue_minor)},spend_control:{...reconciliation,difference_minor:number(reconciliation.difference_minor),unassigned_spend_minor:quality.available?number(reconciliation.unassigned_spend_minor):null,net_unassigned_spend_observed_minor:observed?number(reconciliation.net_unassigned_spend_observed_minor):null},coverage_sales:summary.sales?Number(summary.attributed_sales)/summary.sales:null,coverage_revenue:summary.revenue_minor?summary.attributed_revenue_minor/summary.revenue_minor:null},options:{products,extracted_products:extractedProducts,ads:names.map(r=>({id:r.ad_id,meta_ad_account_id:r.meta_ad_account_id,campaign_id:r.campaign_id,name:r.ad_name})),campaigns:[...new Map(names.map(r=>[r.meta_ad_account_id+':'+r.campaign_id,{id:r.campaign_id,meta_ad_account_id:r.meta_ad_account_id,name:r.campaign_name}])).values()],accounts:quality.accounts.map(a=>({id:a.meta_ad_account_id,name:a.name,currency:a.currency,timezone:a.timezone}))},measured_at:new Date().toISOString(),basis:'Actividad por validación del comprobante; no es retorno de una cohorte de clics.',formulas:{cpa:'Gasto comparable / ventas atribuidas',roas:'Ingresos atribuidos / gasto comparable',balance:'Ingresos del ámbito − gasto; no incluye otros costos'},revision:await reportRevision(c,w,e)};
}
async function reportRevision(c:QueryExecutor,w:string,e:string){const r=(await c.query(`SELECT
 (SELECT max(recorded_at)::text FROM domain_events WHERE workspace_id=$1 AND environment=$2 AND event_type LIKE 'sale.%') sales,
 (SELECT max(updated_at)::text FROM meta_insight_jobs WHERE workspace_id=$1 AND environment=$2) insights,
 (SELECT max(created_at)::text FROM campaign_products WHERE workspace_id=$1 AND environment=$2) products,
 (SELECT max(updated_at)::text FROM records WHERE workspace_id=$1 AND environment=$2 AND kind IN ('product','order','receipt')) records,
 (SELECT jsonb_agg(to_jsonb(a)||jsonb_build_object('stale',a.last_success_at IS NULL OR a.last_success_at<now()-interval '1 hour') ORDER BY meta_ad_account_id) FROM meta_insight_accounts a WHERE workspace_id=$1 AND environment=$2) accounts,
 (SELECT max(observed_at)::text FROM meta_ad_metadata WHERE workspace_id=$1 AND environment=$2) metadata,
 (SELECT max(synced_at)::text FROM meta_insight_coverage WHERE workspace_id=$1 AND environment=$2) coverage`,[w,e])).rows[0];return hash(JSON.stringify(r));}

export async function campaignSales(c:QueryExecutor,w:string,e:string,f:CampaignFilters){
 const where=f.classification==='ALL'?'true':f.classification==='UNATTRIBUTED'?"classification='VALID' AND ad_id IS NULL":`classification='${f.classification}'`;
 const context=await productContext(c,w,e),p=paramsFor(w,e,f,context.labels);
 const rows=(await c.query(campaignFactsSql+` SELECT order_id AS sale_id,order_id,sold_product_id,promoted_product_id,extracted_product_key AS extracted_product,meta_ad_account_id,campaign_id,ad_id,campaign_name,ad_name,
 min(effective_at) effective_at,array_agg(DISTINCT classification) classifications,array_agg(DISTINCT receipt_id) receipt_ids,sum(amount_minor)::text amount_minor,
 sum(amount_minor) FILTER(WHERE classification='VALID')::text revenue_minor,currency,count(*) OVER()::int total
 FROM filtered_sales WHERE ${where} GROUP BY order_id,sold_product_id,promoted_product_id,extracted_product_key,meta_ad_account_id,campaign_id,ad_id,campaign_name,ad_name,currency ORDER BY min(effective_at) DESC,order_id LIMIT $16 OFFSET $17`,[...p,f.limit,f.offset])).rows;
 return{data:rows.map(({total:_,...r})=>({...r,amount_minor:number(r.amount_minor),revenue_minor:Number(r.revenue_minor??0)})),meta:{total:rows[0]?.total??0,offset:f.offset,limit:f.limit,definition:'receipt_sales_v1',revision:await reportRevision(c,w,e)}};
}
