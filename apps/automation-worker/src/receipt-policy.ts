import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';
import {z} from 'zod';
import {decrypt,encrypt,type QueryExecutor} from '@commerce/db';
import type {DomainRecord} from '@commerce/contracts';
import {captureOrderReceiptPolicy,readOrderReceiptPolicy} from '../../../packages/db/src/receipt-policies.js';
import {readMarketJourney,marketRecordVersionHash} from '../../../packages/db/src/market-variants.js';
import {evaluateReceiptPolicy,receiptPolicyHash} from '../../../packages/domain/src/sales/receipt-policy.js';
import {receiptDocumentEvidence} from '../../../packages/contracts/src/receipt-extraction.js';
function need(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
async function schema(client:QueryExecutor){return(await client.query("SELECT to_regclass('public.market_journey_snapshots') market,to_regclass('public.receipt_order_policy_snapshots') policy")).rows[0];}
/** Only the transaction that creates a new market order may capture policy. */
export async function captureNewReceiptPolicy(client:QueryExecutor,conversation:DomainRecord,order:DomainRecord){
 const present=await schema(client);if(!present.market)return null;
 const journey=(await client.query('SELECT journey_id FROM market_journey_snapshots WHERE workspace_id=$1 AND environment=$2 AND journey_id=$3',[conversation.workspace_id,conversation.environment,conversation.id])).rows[0];if(!journey)return null;
 need(present.policy,'RECEIPT_POLICY_SCHEMA_REQUIRED');const db=await recordProfileExecutor(client,conversation.workspace_id,conversation.environment);
 const source=await readMarketJourney(db,conversation.environment,conversation.id);
 need(order.environment===conversation.environment&&order.workspace_id===conversation.workspace_id&&order.body.conversation_id===conversation.id&&order.body.offer_version_id===source.release.configuration.offer.id&&order.body.payment_profile_version_id===source.release.configuration.collection.id,'RECEIPT_POLICY_ORDER_CHANGED');
 return captureOrderReceiptPolicy(db,order.environment,order.id);
}
/** Called with the canonical conversation lock and before any state changes.
 * Null alone selects the preserved legacy path, never a missing declared pin. */
export async function prepareReceiptPolicyAnalysis(client:QueryExecutor,receipt:DomainRecord,raw:unknown,cause:string){
 const present=await schema(client),order=(await client.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='order' AND id=$3 FOR UPDATE",[receipt.workspace_id,receipt.environment,receipt.body.order_id])).rows[0] as DomainRecord|undefined;
 need(order,'ORDER_NOT_FOUND');
 if(!present.policy){need(!order.body.receipt_policy_snapshot_sha256,'RECEIPT_POLICY_SCHEMA_REQUIRED');return null;}
 const exists=(await client.query('SELECT order_id FROM receipt_order_policy_snapshots WHERE workspace_id=$1 AND environment=$2 AND order_id=$3',[receipt.workspace_id,receipt.environment,order.id])).rows[0];
 if(!exists){need(!order.body.receipt_policy_snapshot_sha256,'RECEIPT_POLICY_SNAPSHOT_REQUIRED');return null;}
 const db=await recordProfileExecutor(client,receipt.workspace_id,receipt.environment);const policy=await readOrderReceiptPolicy(db,receipt.environment,order.id);need(policy,'RECEIPT_POLICY_SNAPSHOT_REQUIRED');
 need(!order.body.receipt_policy_snapshot_sha256||order.body.receipt_policy_snapshot_sha256===policy.sha256,'RECEIPT_POLICY_SNAPSHOT_CHANGED');
 const native=(await db.query("SELECT * FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='receipt' AND id=$3 FOR UPDATE",[receipt.workspace_id,receipt.environment,receipt.id])).rows[0] as DomainRecord|undefined;
 need(native&&native.version===receipt.version&&native.body.order_id===order.id&&native.body.conversation_id===order.body.conversation_id,'RECEIPT_POLICY_RECEIPT_CHANGED');
 const document=receiptDocumentEvidence(raw,policy.policy.destination.mode==='SUFFIX'),documentHash=receiptPolicyHash(document.document);
 if(native.body.policy_analysis){need(native.body.policy_analysis.cause===cause&&native.body.policy_analysis.document_sha256===documentHash&&native.body.policy_analysis.policy_sha256===policy.sha256,'RECEIPT_POLICY_ANALYSIS_CONFLICT');return{state:'EXISTING' as const};}
 need(!native.body.review&&!['HUMAN_REVIEWED','COMPLETED'].includes(native.body.analysis_status),'RECEIPT_POLICY_ANALYSIS_ALREADY_REVIEWED');
 need(!(await db.query("SELECT 1 FROM commands WHERE workspace_id=$1 AND environment=$2 AND kind='receipt_review' AND resource_id=$3 AND status='PENDING' LIMIT 1",[receipt.workspace_id,receipt.environment,receipt.id])).rowCount,'RECEIPT_POLICY_HUMAN_REVIEW_PENDING');
 const journey=await readMarketJourney(db,receipt.environment,order.body.conversation_id),release=journey.release,ref=release.configuration.collection;
 need(release.variant_id===policy.variantId&&order.body.product_id===release.family_id&&order.body.offer_version_id===release.configuration.offer.id&&order.body.payment_profile_version_id===ref.id&&order.body.currency===release.locale.currency&&(order.body.amount_minor===release.amount_minor||order.body.launch_test_scope_id&&order.body.launch_test_role==='beneficiary'&&order.body.amount_minor===0),'RECEIPT_POLICY_ORDER_CHANGED');
 const bank=(await db.query(`SELECT v.record_id,v.workspace_id,v.environment,v.kind,v.version,v.body FROM record_versions v JOIN records r ON r.id=v.record_id AND r.workspace_id=v.workspace_id AND r.environment=v.environment AND r.kind=v.kind
 WHERE v.workspace_id=$1 AND v.environment=$2 AND v.kind='bank_profile' AND v.record_id=$3 AND v.version=$4 FOR SHARE OF r`,[receipt.workspace_id,receipt.environment,ref.id,ref.revision])).rows[0];
 need(bank&&marketRecordVersionHash(bank)===ref.sha256&&bank.body.currency===release.locale.currency,'RECEIPT_POLICY_COLLECTION_CHANGED');
 let privateBank:{account_number?:string;holder?:string}={};
 if(bank.body.secret_ciphertext)privateBank=z.object({account_number:z.string().max(500),holder:z.string().max(500),instructions:z.string().optional()}).strict().parse(JSON.parse(decrypt(bank.body.secret_ciphertext)));
 const asset=(await db.query("SELECT id,body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='asset' AND id=$3 FOR SHARE",[receipt.workspace_id,receipt.environment,native.body.asset_id])).rows[0];
 need(asset&&asset.body.status==='READY'&&asset.body.storage_key&&/^[a-f0-9]{64}$/.test(asset.body.sha256),'PROTECTED_RECEIPT_ASSET_REQUIRED');
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`receipt-evidence:${receipt.workspace_id}:${receipt.environment}`]);
 const reference=document.legacy.reference?.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleUpperCase('en-US')??null;
 const duplicate=(await db.query(`SELECT 1 FROM records r LEFT JOIN records a ON a.id::text=r.body->>'asset_id' AND a.workspace_id=r.workspace_id AND a.environment=r.environment AND a.kind='asset'
 WHERE r.workspace_id=$1 AND r.environment=$2 AND r.kind='receipt' AND r.id<>$3 AND (a.body->>'sha256'=$4 OR ($5::text IS NOT NULL AND upper(regexp_replace(btrim(normalize(r.body->'extraction'->>'reference',NFKC)),'\\s+',' ','g'))=$5)) LIMIT 1`,[receipt.workspace_id,receipt.environment,receipt.id,asset.body.sha256,reference])).rows.length>0;
 const conversation=(await db.query("SELECT body FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='conversation' AND id=$3 FOR SHARE",[receipt.workspace_id,receipt.environment,order.body.conversation_id])).rows[0];need(conversation,'RECEIPT_POLICY_CONVERSATION_CHANGED');
 const clock=(await db.query('SELECT clock_timestamp() now')).rows[0].now;let observedAt=new Date(clock).toISOString();
 if(receipt.environment==='SIMULATION'&&conversation.body.simulation_id){const simulation=(await db.query("SELECT body FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='simulation' AND id=$2 FOR SHARE",[receipt.workspace_id,conversation.body.simulation_id])).rows[0];need(simulation&&Number.isFinite(Date.parse(simulation.body.virtual_now)),'RECEIPT_POLICY_SIMULATION_CLOCK_REQUIRED');observedAt=new Date(simulation.body.virtual_now).toISOString();}
 const classification=native.body.commercial_classification==='FALSE'?'FALSE':native.body.commercial_classification==='TEST'||order.body.commercial_classification==='TEST'||order.body.launch_test_scope_id||conversation.body.is_test||conversation.body.number_flow_test_id||conversation.body.launch_test_id?'TEST':'COMMERCIAL';
 const assessment=evaluateReceiptPolicy(policy,{scope:policy.scope,variantId:policy.variantId,receipt:{id:native.id,revision:native.version,sha256:marketRecordVersionHash({record_id:native.id,workspace_id:native.workspace_id,environment:native.environment,kind:native.kind,version:native.version,body:native.body})},evidenceSha256:asset.body.sha256,collection:ref,amountMinor:order.body.amount_minor,currency:release.locale.currency,timezone:release.locale.timezone,observedAt,expectedDestination:privateBank.account_number??null,expectedBeneficiary:privateBank.holder??null,expectedReference:null,expectedConcept:null,duplicate:!!native.body.duplicate_of||duplicate,classification},document.evidence);
 return{state:'PREPARED' as const,assessment,extraction:document.legacy,evidenceCiphertext:encrypt(document.document),policyAnalysis:{cause,document_sha256:documentHash,policy_sha256:policy.sha256},observedAt};
}
