import { z } from 'zod';
import {knowledgeSchema,categorySchema,editorSchema,sellerStyleSchema} from './seller.js';
import {salesFlowConfigurationSchema} from './sales-flow.js';
export const environmentSchema=z.enum(['SIMULATION','REAL']);
export type Environment=z.infer<typeof environmentSchema>;
export type Body=Record<string,any>;
export interface DomainRecord { id:string; workspace_id:string; environment:Environment; kind:string; version:number; body:Body; created_at:string; updated_at:string }
const currencyCodes=new Set(Intl.supportedValuesOf('currency'));
const currency=z.string().regex(/^[A-Z]{3}$/).refine(value=>currencyCodes.has(value),'Usa una moneda ISO 4217 vigente, por ejemplo MXN o USD.');
const id=z.string().uuid(); const name=z.string().trim().min(1).max(160); const str=z.string().max(12000); const timestamp=z.string().datetime({offset:true});
export const fulfillmentSchema=z.object({asset_id:id,release_on:z.enum(['commitment_accepted','receipt_approved','reconciled']),min_amount_minor:z.number().int().nonnegative().optional()}).strict();
export const offerSchema=z.object({name:name.optional(),currency,base_amount_minor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),payment_method:z.literal('bank_transfer_receipt').default('bank_transfer_receipt'),payment_profile_version_id:id.optional(),receipt_policy_version_id:id.optional(),fulfillment:z.array(fulfillmentSchema).max(30).default([]),positive_payment_unlocks_all:z.boolean().default(false),workflow_version_id:id.optional(),agent_version_id:id.optional(),sales_flow:salesFlowConfigurationSchema.optional(),billing_delay_seconds:z.number().int().min(0).max(604800).default(1800),tiers:z.array(z.object({id:z.string().regex(/^[a-z0-9_-]+$/).max(60),name,minimum_total_minor:z.number().int().nonnegative(),included_extra_from_minor:z.number().int().nonnegative().optional()}).strict()).max(20).optional(),tier_policy:z.literal('mcl-receipt-total-v5').optional(),madrina:z.object({enabled:z.literal(true),core_asset_id:id.optional(),threshold_exclusive_minor:z.literal(10700),historical_reference_minor:z.literal(19400).optional()}).strict().optional(),status:z.enum(['DRAFT','PUBLISHED']).default('DRAFT')}).strict();
export const positiveRevisionSchema=z.number().int().positive();
export const salesFlowDraftChangesSchema=z.object({
 name:offerSchema.shape.name.optional(),
 currency:offerSchema.shape.currency.optional(),
 base_amount_minor:offerSchema.shape.base_amount_minor.optional(),
 payment_profile_version_id:offerSchema.shape.payment_profile_version_id.optional(),
 receipt_policy_version_id:offerSchema.shape.receipt_policy_version_id.optional(),
 workflow_version_id:offerSchema.shape.workflow_version_id.optional(),
 agent_version_id:offerSchema.shape.agent_version_id.optional(),
 fulfillment:offerSchema.shape.fulfillment.optional(),
 positive_payment_unlocks_all:offerSchema.shape.positive_payment_unlocks_all.optional(),
 billing_delay_seconds:offerSchema.shape.billing_delay_seconds.optional(),
 sales_flow:salesFlowConfigurationSchema,
}).strict();
export const salesFlowValidateInputSchema=z.object({expected_version:positiveRevisionSchema.optional(),changes:salesFlowDraftChangesSchema}).strict();
export const salesFlowSaveDraftInputSchema=z.object({expected_version:positiveRevisionSchema,changes:salesFlowDraftChangesSchema}).strict();
export const offerVersionChangesSchema=offerSchema.omit({status:true}).partial();
export const offerVersionCreateInputSchema=z.object({expected_version:positiveRevisionSchema,changes:offerVersionChangesSchema.default({})}).strict();
export const remarketingCycleStatusSchema=z.enum(['OPEN','PAID','REPLIED','DECLINED','OPTED_OUT','HUMAN_REVIEW','CLOSED']);
export const remarketingReprogramPreviewInputSchema=z.object({offer_version_id:id}).strict();
export const remarketingReprogramApplyInputSchema=z.object({
 offer_version_id:id,
 expected_revision:positiveRevisionSchema,
 preview_hash:z.string().length(64).regex(/^[a-f0-9]+$/),
 previewed_at:z.string().datetime({offset:true}),
}).strict();
export const productSchema=z.object({name,category_id:id.nullable().optional(),knowledge:knowledgeSchema.default([]),asset_ids:z.array(id).max(100).default([]),references:z.array(z.object({label:name,url:z.string().url().refine(x=>x.startsWith('https://'))}).strict()).max(100).default([]),slug:z.string().regex(/^[a-z0-9-]+$/).max(120).optional(),description:str.default(''),initial_offer:offerSchema.optional(),workflow_template_version_id:id.optional(),agent_version_id:id.nullable().optional()}).strict();
export const workflowNodeSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]+$/).max(64),type:z.enum(['entry','condition','ai','message','reply','wait','stage','approval','handoff','commitment','fulfillment','bank_instructions','receipt','post_receipt','reconcile','subflow','end']),config:z.record(z.string(),z.unknown()).default({}),next:z.string().optional(),branches:z.record(z.string(),z.string()).optional()}).strict();
export const workflowSchema=z.object({name,message_library:z.array(z.object({id:z.string().min(1).max(80),text:z.string().min(1).max(12000)}).strict()).max(100).optional(),description:str.default(''),product_id:id.optional(),editor:editorSchema.optional(),nodes:z.array(workflowNodeSchema).max(100),entry_node_id:z.string(),offer_version_id:id.optional(),agent_version_id:id.optional(),recipe_id:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/).optional(),recipe_revision:z.number().int().positive().optional(),max_steps:z.number().int().min(1).max(1000).default(100),status:z.literal('DRAFT').default('DRAFT')}).strict();
const paidAcquisitionStatus=z.enum(['DRAFT','IMPORTED','PAUSED']).default('DRAFT');
const whatsappAttributionSchema=z.object({method:z.literal('conversation_first_observed_v1'),source:z.literal('meta'),destination:z.literal('whatsapp'),prefill_keyword:z.string().trim().min(1).max(120)}).strict();
export const schemas:Record<string,z.ZodType<any>>={
 category:categorySchema, product:productSchema, offer:offerSchema, workflow:workflowSchema,
 agent:z.object({name,product_id:id.optional(),offer_version_id:id.optional(),style:sellerStyleSchema.optional(),provider:z.enum(['deterministic','openai','workspace','profile']).default('deterministic'),model:name.nullable().default('deterministic-v1'),knowledge:str.default(''),instructions:str.default(''),max_cost_minor:z.number().int().min(0).max(10000).default(20),timeout_ms:z.number().int().min(100).max(60000).default(10000),input_cost_per_million_minor:z.number().nonnegative().optional(),output_cost_per_million_minor:z.number().nonnegative().optional(),max_tokens:z.number().int().min(1).max(4096).default(500)}).strict(),
 asset:z.object({name,kind:z.enum(['file','link','access']).default('file'),mime_type:z.enum(['application/pdf','image/jpeg','image/png','audio/mpeg','audio/ogg','video/mp4','text/plain','application/octet-stream']).default('application/pdf'),size_bytes:z.number().int().min(0).max(20971520).default(0),sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),url:z.string().url().refine(x=>x.startsWith('https://')).optional(),adapter:z.enum(['private_file','link','webhook']).optional(),delivery_reference:str.optional()}).strict(),
 channel_account:z.object({name,alias:name.optional(),provider:z.enum(['simulator','waha','cloud']).default('simulator'),purpose:str.default(''),owner_id:z.string().optional(),gateway_ref:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),engine:z.enum(['GOWS','NOWEB','WEBJS']).optional(),offer_version_id:id.optional(),workflow_version_id:id.optional(),agent_version_id:id.optional(),conversion_config:z.object({dataset_id:z.string().regex(/^[0-9]+$/),graph_api_version:z.string().regex(/^v[0-9]+\.[0-9]+$/),account_identifier:z.enum(['page_id','whatsapp_business_account_id']),account_identifier_value:z.string().regex(/^[0-9]+$/),eligibility_evidence:z.string().min(10).max(2000),eligibility_valid_until:z.string().datetime({offset:true}),contract_source_url:z.string().url()}).strict().optional(),sending_enabled:z.literal(false).default(false)}).strict(),
 receipt_policy:z.object({name,allow_amount_mismatch:z.boolean().default(false),allow_pending:z.boolean().default(false),require_currency:z.boolean().default(false),require_destination:z.boolean().default(false),min_amount_minor:z.number().int().nonnegative().default(1),auto_approve:z.boolean().default(false)}).strict(),
 bank_profile:z.object({name,bank:name,holder:name,account_number:z.string().regex(/^[0-9 ]{4,34}$/),currency:currency.default('MXN'),instructions:str.default(''),
  // RF-09.d: public text the buyer must write in the transfer (V7 Cobro).
  expected_reference:z.string().trim().min(1).max(120).nullable().optional(),expected_concept:z.string().trim().min(1).max(120).nullable().optional()}).strict(),
 acquisition_campaign:z.object({name,external_id:z.string().max(128).optional(),platform:z.enum(['meta','manual','other']).default('manual'),source:str,evidence:str,status:paidAcquisitionStatus,objective:z.literal('OUTCOME_ENGAGEMENT').optional(),destination:z.literal('WHATSAPP').optional(),account_id:id.optional(),product_id:id.optional(),offer_version_id:id.optional(),workflow_version_id:id.optional(),attribution:whatsappAttributionSchema.optional(),spend_minor:z.number().int().nonnegative().optional(),currency:currency.optional(),period_start:timestamp.optional(),period_end:timestamp.optional()}).strict(),
 ad_set:z.object({name,campaign_id:id,external_id:z.string().max(128).optional(),source:str,evidence:str,status:paidAcquisitionStatus,account_id:id.optional(),product_id:id.optional(),offer_version_id:id.optional(),workflow_version_id:id.optional(),attribution:whatsappAttributionSchema.optional()}).strict(),
 ad:z.object({name,ad_set_id:id,external_id:z.string().max(128).optional(),source:str,evidence:str,status:paidAcquisitionStatus,creative_ref:z.string().trim().min(1).max(2000).optional(),creative_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),primary_text:z.string().trim().min(1).max(2200).optional(),headline:z.string().trim().min(1).max(255).optional(),description:z.string().trim().min(1).max(255).optional(),call_to_action:z.literal('SEND_WHATSAPP_MESSAGE').optional(),prefilled_message:z.string().trim().min(1).max(1000).optional()}).strict(),
 binding:z.object({name:name.optional(),account_id:id,offer_version_id:id,workflow_version_id:id.optional(),agent_version_id:id.optional(),campaign_id:id.optional(),ad_set_id:id.optional(),ad_id:id.optional(),valid_from:timestamp,valid_to:timestamp.optional(),source:str,evidence:str,confidence:z.enum(['observed','inferred']).default('inferred')}).strict(),
 message_campaign:z.object({name,account_id:id,offer_version_id:id.optional(),message:z.string().min(1).max(4096),segment:z.object({stage:z.string().optional(),tag:z.string().optional(),product_id:id.optional(),contact_ids:z.array(id).max(10000).optional()}).strict().default({}),scheduled_at:timestamp.optional(),max_recipients:z.number().int().min(1).max(10000).default(500),status:z.enum(['DRAFT','PAUSED']).default('DRAFT')}).strict(),
};
export const resourceKinds:Record<string,string>={'categories':'category','products':'product','offers':'offer','assets':'asset','workflows':'workflow','agents':'agent','channel-accounts':'channel_account','conversations':'conversation','contacts':'contact','leads':'contact','orders':'order','receipts':'receipt','fulfillments':'fulfillment','touchpoints':'touchpoint','acquisition-campaigns':'acquisition_campaign','ad-sets':'ad_set','ads':'ad','bindings':'binding','message-campaigns':'message_campaign','imports':'import_batch','incidents':'incident','health-signals':'health_signal','bank-profiles':'bank_profile','receipt-policies':'receipt_policy','conversions':'conversion','simulations':'simulation'};
export const roles=['owner','operator','seller','reconciler','analyst','viewer'] as const;
export type Role=typeof roles[number];
export const rolePermissions:Record<Role,string[]>={owner:['*'],operator:['read','finance:review','finance:classify','catalog:write','workflows:write','sales:operate','channels:manage','campaigns:write','imports:write','reports:read'],seller:['catalog:read','sales:assigned','sales:operate'],reconciler:['catalog:read','sales:read','finance:review','finance:classify','finance:reconcile','reports:read'],analyst:['catalog:read','reports:read','reports:export'],viewer:['catalog:read','sales:read','reports:read']};
export function flatten(r:DomainRecord):Body{return {...r.body,id:r.id,version:r.version,environment:r.environment,created_at:r.created_at,updated_at:r.updated_at};}

export const serviceScopes=['products:read','products:write','products:publish','offers:read','offers:write','offers:publish','workflows:read','workflows:draft','workflows:publish','simulations:run','assets:read','assets:write','sales:read','sales:propose','channels:read','channels:manage','channels:capacity','channels:capacity:agent','commands:read','warmup:read','warmup:manage','warmup:activate','warmup:simulate','assignments:read','assignments:write','assignments:authorize','integrations:read','integrations:write','integrations:verify','assistant:read','assistant:propose','reports:read','intelligence:read','intelligence:write','intelligence:analyze','intelligence:refresh'] as const;
export const serviceProfileKeys=['intelligence:openai','openai:default','openai:assistant','creative:searchapi','creative:r2','creative:elevenlabs','provider-budget:global'] as const;
export const serviceResourceIdSchema=z.union([z.string().uuid(),z.enum(serviceProfileKeys),z.string().regex(/^(?:waha|cloud):[A-Za-z][A-Za-z0-9_-]{0,63}$/)]);

export * from './operational-settings.js';
export * from './sales-flow.js';
