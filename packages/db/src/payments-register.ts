import {paymentFilterSchema,paymentPageQuerySchema,paymentRegisterSchema,paymentOptionQuerySchema,paymentOptionResponseSchema,type PaymentFilters} from '../../contracts/src/payments-register.js';
import {bindProfileEnvironment} from './profile-environment.js';
import {requireProfileId,type ProfileExecutor} from './profile-context.js';

/** 017 owns recognized revenue. Other receipt states remain visible without
 * becoming income. All joins repeat tenant + environment; no external I/O. */
export const paymentRowsSql=`WITH source AS MATERIALIZED (
 SELECT r.id AS receipt_id,r.version AS receipt_version,p.id AS contribution_id,o.id AS order_id,c.id AS conversation_id,
 COALESCE(p.effective_at,r.created_at) occurred_at,
 CASE WHEN c.body->>'privacy_erased'='true' THEN (fc.grain->'dimensions'->>'family_id')::uuid ELSE family.id END AS family_id,left(family.body->>'name',200) family_name,
 CASE WHEN c.body->>'privacy_erased'='true' THEN fc.grain->'dimensions'->>'variant_id' ELSE s.body->'release'->>'variant_id' END AS variant_id,
 left(CASE WHEN c.body->>'privacy_erased'='true' THEN fc.grain->'dimensions'->>'market' ELSE s.body->'release'->'locale'->>'market' END,200) AS market,
 CASE WHEN p.id IS NOT NULL THEN p.amount_minor::text
  WHEN r.body->'extraction'->>'amount_minor' ~ '^[0-9]{1,16}$'
  THEN CASE WHEN (r.body->'extraction'->>'amount_minor')::numeric BETWEEN 0 AND 9007199254740991
   THEN ((r.body->'extraction'->>'amount_minor')::numeric)::text END END amount_minor,
 CASE WHEN p.id IS NOT NULL THEN p.currency WHEN r.body->'extraction'->>'currency' ~ '^[A-Z]{3}$' THEN r.body->'extraction'->>'currency' END currency,
 CASE o.body->'offer_snapshot'->>'payment_method' WHEN 'bank_transfer_receipt' THEN 'BANK_TRANSFER' WHEN 'payment_link' THEN 'LINK' ELSE 'UNKNOWN' END method,
 CASE WHEN r.body->>'commercial_classification'='FALSE' THEN 'FALSE'
  WHEN r.body->>'commercial_classification'='TEST' OR o.body->>'commercial_classification'='TEST' OR c.body->>'commercial_classification'='TEST'
    OR c.body->>'is_test'='true' OR c.body ? 'number_flow_test_id' OR c.body ? 'launch_test_id' THEN 'TEST'
  WHEN r.body->>'status'='REJECTED' THEN 'REJECTED'
  WHEN r.body->>'status'='APPROVED' AND r.body->>'duplicate_of' IS NULL THEN 'APPROVED' ELSE 'REVIEW' END status,
 CASE WHEN c.body->>'privacy_erased'='true' THEN (fc.grain->'dimensions'->>'account_id')::uuid ELSE account.id END AS account_id,
 CASE WHEN account.body->>'masked_number' ~ '^•••• ?[0-9]{4}$' THEN '••••'||right(account.body->>'masked_number',4) END account_masked,
 CASE WHEN contact.body->>'identity' ~ '^\\+?[0-9]{7,16}(@c\\.us|@s\\.whatsapp\\.net)?$' THEN '••••'||right(regexp_replace(split_part(contact.body->>'identity','@',1),'[^0-9]','','g'),4) END contact_masked,
 CASE WHEN c.body->>'privacy_erased'='true' THEN fc.grain->'dimensions'->>'campaign_id' WHEN attribution.n=1 THEN attribution.campaign_id END campaign_id,
 CASE WHEN c.body->>'privacy_erased'='true' THEN fc.grain->'dimensions'->>'ad_id' WHEN attribution.n=1 THEN attribution.ad_id END ad_id,
 asset.id AS asset_id,coalesce(revenue.amount_minor,0)::text recognized_revenue_minor,
 r.body->>'duplicate_of' IS NOT NULL AS duplicate
 FROM records r
 LEFT JOIN records o ON o.id::text=r.body->>'order_id' AND o.workspace_id=r.workspace_id AND o.environment=r.environment AND o.kind='order'
 LEFT JOIN records c ON c.id::text=o.body->>'conversation_id' AND c.workspace_id=r.workspace_id AND c.environment=r.environment AND c.kind='conversation'
 LEFT JOIN result_financial_context fc ON fc.journey_id=c.id AND fc.workspace_id=r.workspace_id AND fc.environment=r.environment AND c.body->>'privacy_erased'='true'
 LEFT JOIN market_journey_snapshots s ON s.journey_id=c.id AND s.workspace_id=r.workspace_id AND s.environment=r.environment AND c.body->>'privacy_erased' IS DISTINCT FROM 'true'
 LEFT JOIN records family ON family.id::text=CASE WHEN c.body->>'privacy_erased'='true' THEN fc.grain->'dimensions'->>'family_id' ELSE coalesce(s.body->'release'->>'family_id',o.body->>'product_id') END AND family.workspace_id=r.workspace_id AND family.environment=r.environment AND family.kind='product'
 LEFT JOIN records account ON account.id::text=c.body->>'account_id' AND account.workspace_id=r.workspace_id AND account.environment=r.environment AND account.kind='channel_account' AND c.body->>'privacy_erased' IS DISTINCT FROM 'true'
 LEFT JOIN records contact ON contact.id::text=c.body->>'contact_id' AND contact.workspace_id=r.workspace_id AND contact.environment=r.environment AND contact.kind='contact' AND c.body->>'privacy_erased' IS DISTINCT FROM 'true'
 LEFT JOIN records asset ON asset.id::text=r.body->>'asset_id' AND asset.workspace_id=r.workspace_id AND asset.environment=r.environment AND asset.kind='asset' AND asset.body->>'status'='READY' AND c.body->>'privacy_erased' IS DISTINCT FROM 'true'
 LEFT JOIN payment_contributions p ON p.receipt_id=r.id AND p.order_id=o.id AND p.workspace_id=r.workspace_id AND p.environment=r.environment
 LEFT JOIN result_payment_facts revenue ON revenue.contribution_id=p.id AND revenue.workspace_id=r.workspace_id AND revenue.environment=r.environment
  AND coalesce(r.body->>'commercial_classification','REAL')<>'TEST'
 LEFT JOIN LATERAL(SELECT count(*) n,min(m.campaign_id) campaign_id,min(m.ad_id) ad_id FROM meta_ad_metadata m
  WHERE c.body->>'privacy_erased' IS DISTINCT FROM 'true' AND m.workspace_id=r.workspace_id AND m.environment=r.environment AND m.ad_id=o.body->'attribution'->>'ad_id'
   AND o.body->'attribution'->>'classification' IN('observed','manual')
   AND (o.body->'attribution'->>'meta_ad_account_id' IS NULL OR m.meta_ad_account_id=o.body->'attribution'->>'meta_ad_account_id')) attribution ON true
 WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='receipt'
), filtered AS MATERIALIZED (
 SELECT * FROM source WHERE (occurred_at AT TIME ZONE (SELECT timezone FROM profiles WHERE id=$1))::date BETWEEN $3::date AND $4::date
 AND ($5::text IS NULL OR status=$5) AND ($6::text IS NULL OR currency=$6)
 AND ($7::uuid IS NULL OR family_id=$7) AND ($8::text IS NULL OR variant_id=$8) AND ($9::uuid IS NULL OR account_id=$9)
 AND ($10::text IS NULL OR campaign_id=$10)
 AND ($14::text IS NULL OR ad_id=$14) AND ($15::text IS NULL OR market=$15)
 AND ($11::text IS NULL OR strpos(lower(concat_ws(' ',receipt_id::text,order_id::text,family_name,market,campaign_id,ad_id,account_masked,contact_masked)),lower($11))>0)
)`;
const sorts={date:'occurred_at',amount:'amount_minor::numeric',status:'status'} as const;

function row(r:any){return {receiptId:r.receipt_id,receiptVersion:r.receipt_version,contributionId:r.contribution_id,orderId:r.order_id,conversationId:r.conversation_id,
 occurredAt:new Date(r.occurred_at).toISOString(),familyId:r.family_id,familyName:r.family_name,variantId:r.variant_id,market:r.market,
 amountMinor:r.amount_minor,currency:r.currency,method:r.method,status:r.status,accountId:r.account_id,accountMasked:r.account_masked,contactMasked:r.contact_masked,
 campaignId:r.campaign_id,adId:r.ad_id,assetId:r.asset_id,recognizedRevenueMinor:r.recognized_revenue_minor,duplicate:r.duplicate};}

async function read(db:ProfileExecutor,q:PaymentFilters,limit:number,offset:number){
 requireProfileId(db.workspaceId);
 const context=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) AS workspace")).rows[0];
 if(context?.role!=='commerce_api'||context.workspace!==db.workspaceId)throw Error('PAYMENTS_PROFILE_CONTEXT_REQUIRED');
 await bindProfileEnvironment(db,q.environment);
 const order=`${sorts[q.sort]} ${q.direction==='asc'?'ASC':'DESC'} NULLS LAST,receipt_id ${q.direction==='asc'?'ASC':'DESC'}`;
 const record=(await db.query(paymentRowsSql+`, page AS(SELECT * FROM filtered ORDER BY ${order} LIMIT $12 OFFSET $13),
 totals AS(SELECT currency,sum(recognized_revenue_minor::numeric)::text AS amount,count(*) FILTER(WHERE recognized_revenue_minor::numeric>0)::integer AS payments FROM filtered WHERE currency IS NOT NULL GROUP BY currency)
 SELECT (SELECT count(*)::text FROM filtered) AS total,
 coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY ${order}) FROM page),'[]'::jsonb) AS rows,
 coalesce((SELECT jsonb_agg(jsonb_build_object('currency',currency,'approvedRevenueMinor',amount,'approvedPayments',payments) ORDER BY currency) FROM totals),'[]'::jsonb) AS totals,
 (SELECT timezone FROM profiles WHERE id=$1) AS timezone,clock_timestamp() AS observed_at`,
 [db.workspaceId,q.environment,q.from,q.to,q.status??null,q.currency??null,q.familyId??null,q.variantId??null,q.accountId??null,q.campaignId??null,q.q??null,limit,offset,q.adId??null,q.market??null])).rows[0];
 if(!record?.timezone)throw Object.assign(new Error('PAYMENTS_PROFILE_REQUIRED'),{statusCode:404});
 return paymentRegisterSchema.parse({workspaceId:db.workspaceId,filters:q,rows:record.rows.map(row),total:Number(record.total),totals:record.totals,timezone:record.timezone,observedAt:new Date(record.observed_at).toISOString(),limit,offset});
}
export async function listPayments(db:ProfileExecutor,input:unknown){const {limit,offset,...filters}=paymentPageQuerySchema.parse(input);return read(db,filters,limit,offset);}
export async function exportPayments(db:ProfileExecutor,input:unknown){const q=paymentFilterSchema.parse(input),result=await read(db,q,10000,0);
 if(result.total>10000)throw Object.assign(new Error('PAYMENTS_EXPORT_LIMIT'),{statusCode:413});return result;}

/** Filter choices come from the same observed register and period, not arbitrary
 * record bodies. Callers cannot choose a SQL expression or another profile. */
export async function paymentOptions(db:ProfileExecutor,input:unknown){
 const {kind,after,limit,...q}=paymentOptionQuerySchema.parse(input);
 requireProfileId(db.workspaceId);const context=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) AS workspace")).rows[0];
 if(context?.role!=='commerce_api'||context.workspace!==db.workspaceId)throw Error('PAYMENTS_PROFILE_CONTEXT_REQUIRED');
 await bindProfileEnvironment(db,q.environment);
 const fields={family:['family_id::text','family_name'],variant:['variant_id',"coalesce(market,'Sin mercado')||' · '||left(variant_id,8)"],market:['market','market'],account:['account_id::text',"coalesce(account_masked,'Número sin identificación')"],campaign:['campaign_id',"'Campaña '||campaign_id"],ad:['ad_id',"'Anuncio '||ad_id"]} as const;
 const [id,label]=fields[kind],rows=(await db.query(paymentRowsSql+`,choices AS(SELECT DISTINCT ${id} id,${label} label FROM filtered)
 SELECT id,min(label) label FROM choices WHERE id IS NOT NULL AND label IS NOT NULL AND ($12::text IS NULL OR id>$12) GROUP BY id ORDER BY id LIMIT $13`,
 [db.workspaceId,q.environment,q.from,q.to,q.status??null,q.currency??null,q.familyId??null,q.variantId??null,q.accountId??null,q.campaignId??null,q.q??null,after??null,limit+1,q.adId??null,q.market??null])).rows;
 return paymentOptionResponseSchema.parse({workspaceId:db.workspaceId,kind,data:rows.slice(0,limit),next:rows.length>limit?rows[limit-1].id:null});
}
