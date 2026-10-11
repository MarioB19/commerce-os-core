import {getRecord,putRecord,appendEvent,type QueryExecutor} from './index.js';
import type {Body,DomainRecord} from '../../contracts/src/index.js';
import {creditedPaymentTier} from '../../domain/src/sales/payment-tier.js';
import {approvedBenefitTotal} from './launch-test-scope.js';
import {cancelAutomaticRemarketingForBuyer,excludeRecognizedBuyer} from './commercial-remarketing.js';

export async function firstObservedAttribution(c:QueryExecutor,order:DomainRecord):Promise<Body>{
 const touches=(await c.query(`SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='touchpoint'
 AND body->>'conversation_id'=$3 AND created_at<=(SELECT created_at FROM records WHERE id=$4 AND workspace_id=$1 AND environment=$2) ORDER BY (body->>'occurred_at')::timestamptz,created_at,id`,[order.workspace_id,order.environment,order.body.conversation_id,order.id])).rows as DomainRecord[];
 const touch=touches.find(t=>t.body.classification==='observed'&&t.body.referral?.source_type==='ad'&&/^\d+$/.test(String(t.body.referral.source_id))&&Date.parse(t.body.occurred_at)<=Date.parse(order.created_at));
 return touch?{model:'conversation_first_observed_v1',classification:'observed',ad_id:String(touch.body.referral.source_id),meta_ad_account_id:touch.body.referral.meta_ad_account_id??null,touchpoint_id:touch.id,evidence_ref:touch.body.evidence_ref,observed_at:touch.body.occurred_at}:{model:'conversation_first_observed_v1',classification:'unknown',reason:touches.some(t=>t.body.referral)?'NO_VERIFIED_AD_IDENTIFIER':'NO_AD_EVIDENCE'};
}
export async function receiptTerms(c:QueryExecutor,receipt:DomainRecord,order:DomainRecord){
 const asset=await getRecord(c,receipt.workspace_id,'asset',receipt.body.asset_id??'');
 if(!asset||asset.environment!==receipt.environment||asset.body.status!=='READY'||!asset.body.storage_key||!asset.body.sha256)throw new Error('PROTECTED_RECEIPT_ASSET_REQUIRED');
 const amount=receipt.body.extraction?.amount_minor,currency=receipt.body.extraction?.currency??order.body.currency;
 if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('RECEIPT_AMOUNT_REQUIRED');
 if(!/^[A-Z]{3}$/.test(currency??'')||currency!==order.body.currency)throw new Error('RECEIPT_CURRENCY_MISMATCH');
 if(receipt.body.commercial_classification==='FALSE')throw new Error('FALSE_RECEIPT_REQUIRES_RESTORATION');
 return{amount,currency,asset,currencySource:receipt.body.extraction?.currency?(receipt.body.extraction.source==='human_observation'?'human_observation':'document'):'order_configuration'};
}
/** Analytical recognition only. Caller owns transaction + conversation lock; never emits external effects. */
export async function recognizeReceipt(c:QueryExecutor,receipt:DomainRecord,options:{actor:string;cause:string;effectiveAt?:string;paymentKey?:string;replacesReceiptId?:string;historical?:boolean}){
 let order=await getRecord(c,receipt.workspace_id,'order',receipt.body.order_id);if(!order||order.environment!==receipt.environment)throw new Error('ORDER_NOT_FOUND');
 if(receipt.body.conversation_id!==order.body.conversation_id)throw new Error('ORDER_CONVERSATION_MISMATCH');
 if(receipt.body.product_id&&receipt.body.product_id!==order.body.product_id)throw new Error('ORDER_PRODUCT_MISMATCH');
 if(receipt.body.status!=='APPROVED')throw new Error('APPROVED_RECEIPT_REQUIRED');
 const terms=await receiptTerms(c,receipt,order);
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`receipt-evidence:${receipt.workspace_id}:${receipt.environment}`]);
 const evidence=(await c.query('SELECT * FROM payment_contributions WHERE workspace_id=$1 AND environment=$2 AND evidence_sha256=$3',[receipt.workspace_id,receipt.environment,terms.asset.body.sha256])).rows[0];
 if(evidence&&evidence.receipt_id!==receipt.id)throw new Error('DUPLICATE_PAYMENT_EVIDENCE');
 const historicalEvidence=await c.query(`SELECT 1 FROM domain_events ev JOIN records r ON r.id::text=ev.payload->>'receipt_id' JOIN records a ON a.id::text=r.body->>'asset_id' WHERE ev.workspace_id=$1 AND ev.environment=$2 AND ev.event_type IN ('sale.recognized','sale.contribution_corrected') AND a.body->>'sha256'=$3 AND r.id<>$4 LIMIT 1`,[receipt.workspace_id,receipt.environment,terms.asset.body.sha256,receipt.id]);if(historicalEvidence.rowCount)throw new Error('DUPLICATE_PAYMENT_EVIDENCE');
 const reference=receipt.body.extraction?.reference;
 if(reference&&(await c.query(`SELECT 1 FROM payment_contributions p JOIN records r ON r.id=p.receipt_id WHERE p.workspace_id=$1 AND p.environment=$2 AND p.order_id<>$3 AND r.body->'extraction'->>'reference'=$4`,[receipt.workspace_id,receipt.environment,order.id,reference])).rowCount)throw new Error('DUPLICATE_PAYMENT_REFERENCE');
 const existing=(await c.query('SELECT * FROM payment_contributions WHERE workspace_id=$1 AND environment=$2 AND receipt_id=$3',[receipt.workspace_id,receipt.environment,receipt.id])).rows[0];
 const paymentKey=existing?.payment_key??options.paymentKey??'primary';
 const previous=(await c.query('SELECT * FROM payment_contributions WHERE workspace_id=$1 AND environment=$2 AND order_id=$3 AND payment_key=$4 FOR UPDATE',[order.workspace_id,order.environment,order.id,paymentKey])).rows[0];
 if(previous&&previous.receipt_id!==receipt.id&&options.replacesReceiptId!==previous.receipt_id)throw new Error('PAYMENT_ALREADY_RECORDED');
 const effectiveAt=previous?.effective_at??options.effectiveAt??new Date().toISOString();
 const provenance={definition:'receipt_sales_v1',actor_id:options.actor,cause:options.cause,policy_version_id:order.body.receipt_policy_version_id??null,historical:!!options.historical};
 const contribution=(await c.query(`INSERT INTO payment_contributions(workspace_id,environment,order_id,receipt_id,payment_key,amount_minor,currency,currency_source,evidence_sha256,effective_at,provenance)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id,environment,order_id,payment_key) DO UPDATE SET receipt_id=EXCLUDED.receipt_id,amount_minor=EXCLUDED.amount_minor,currency=EXCLUDED.currency,currency_source=EXCLUDED.currency_source,evidence_sha256=EXCLUDED.evidence_sha256,provenance=EXCLUDED.provenance,revision=payment_contributions.revision+1 RETURNING *`,[order.workspace_id,order.environment,order.id,receipt.id,paymentKey,terms.amount,terms.currency,terms.currencySource,terms.asset.body.sha256,effectiveAt,provenance])).rows[0];
 if(!order.body.attribution)order=await putRecord(c,{id:order.id,workspaceId:order.workspace_id,environment:order.environment,kind:'order',version:order.version,body:{...order.body,attribution:await firstObservedAttribution(c,order)}});
 if(options.historical)order=await putRecord(c,{id:order.id,workspaceId:order.workspace_id,environment:order.environment,kind:'order',version:order.version,body:{...order.body,sale_effects_suppressed_by_migration:true}});
 order=await refreshReceiptSale(c,order);
 if(order.body.sale_status==='RECOGNIZED'&&order.body.commercial_classification!=='TEST'){
  await excludeRecognizedBuyer(c,order,receipt.id,options.historical?'receipt_sales_backfill':'receipt_recognition');
  await cancelAutomaticRemarketingForBuyer(c,order,options.historical?'BUYER_EXCLUDED_BY_BACKFILL':'BUYER_RECOGNIZED');
 }
 await appendEvent(c,{workspace_id:order.workspace_id,environment:order.environment,event_type:previous?'sale.contribution_corrected':'sale.recognized',aggregate_id:order.id,causation_id:options.cause,actor:{type:options.historical?'migration':options.actor==='receipt-policy'?'policy':'human',id:options.actor},payload:{definition:'receipt_sales_v1',contribution_id:contribution.id,receipt_id:receipt.id,amount_minor:terms.amount,currency:terms.currency,effective_at:effectiveAt,previous:previous?{receipt_id:previous.receipt_id,amount_minor:Number(previous.amount_minor),revision:previous.revision}:null,revision:contribution.revision,historical:!!options.historical}});
 return{order,contribution,newContribution:!previous&&!existing&&!options.historical&&!order.body.sale_effects_suppressed_by_migration,firstRecognition:!previous&&!order.body.sale_effects_applied_at&&!order.body.sale_effects_suppressed_by_migration&&!options.historical};
}
export async function refreshReceiptSale(c:QueryExecutor,order:DomainRecord){
 const totals=(await c.query(`SELECT COALESCE(sum(amount_minor) FILTER(WHERE classification='VALID'),0)::text amount,min(effective_at) effective_at FROM receipt_sale_facts WHERE workspace_id=$1 AND environment=$2 AND order_id=$3`,[order.workspace_id,order.environment,order.id])).rows[0];
 const amount=Number(totals.amount);if(!Number.isSafeInteger(amount))throw new Error('AMOUNT_OVERFLOW');
 const benefitTotal=order.body.commercial_classification==='TEST'?await approvedBenefitTotal(c,order):amount;
 const updated=await putRecord(c,{id:order.id,workspaceId:order.workspace_id,environment:order.environment,kind:'order',version:order.version,body:{...order.body,...creditedPaymentTier(order.body.offer_snapshot??{},order.body.currency,benefitTotal),sale_id:order.id,sale_definition:'receipt_sales_v1',sale_amount_minor:amount,sale_currency:order.body.currency,sale_status:amount>0?'RECOGNIZED':order.body.commercial_classification==='TEST'?'TEST':'EXCLUDED',sale_effective_at:totals.effective_at,status:amount>0?'RECEIPT_APPROVED':order.body.status,...(order.body.launch_test_scope_id||order.body.simulation_id?{test_approved_amount_minor:await approvedBenefitTotal(c,order)}:{})}});
 return updated;
}
