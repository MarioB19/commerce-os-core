import {z} from 'zod';
import {marketLocaleSchema,marketCopyReviewFields} from './market-variants.js';
import {salesRouteAliasSchema,salesFlowContentSchema,remarketingPolicySchema} from './sales-flow.js';
import {fulfillmentSchema} from './index.js';

/** V7 F4 (RF-05, RF-06, RF-08, RF-14.a): the operator edits one variant document
 * per market. Publishing materializes immutable offer/flow/seller/collection
 * records for the existing engine and a market release that pins them. The
 * document never carries a CLABE, holder or payment URL: those live encrypted in
 * the variant's protected collection column and only a hint is shown. */
const id=z.string().uuid().transform(value=>value.toLowerCase());
const label=z.string().trim().min(1).max(160);
const text=(max:number)=>z.string().trim().max(max);
const amount=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const version=z.number().int().positive().max(2147483646);
export const variantCountrySchema=z.string().regex(/^[A-Z]{2}$/,'Usa el código ISO de país de dos letras, por ejemplo MX.');
export const variantLocaleSchema=marketLocaleSchema.extend({country:variantCountrySchema}).strict();
export const aiProviderSchema=z.enum(['openai','anthropic','google']);
export const variantAiSelectionSchema=z.object({provider:aiProviderSchema,model:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)}).strict();
/** null keeps the profile default; the fallback is used only for a capability the
 * primary model does not support (D-09), never silently for an outage. */
export const variantAiSchema=z.object({primary:variantAiSelectionSchema.nullable(),fallback:variantAiSelectionSchema.nullable()}).strict()
 .refine(value=>!value.fallback||!value.primary||value.fallback.provider!==value.primary.provider||value.fallback.model!==value.primary.model,'El modelo alterno debe ser distinto.');
export const variantSellerSchema=z.object({name:label,instructions:text(8000),knowledge:text(20000),limits:text(4000)}).strict();
export const conversationSaleSchema=z.object({
 offer_message:text(4000).min(1,'Escribe el mensaje de la oferta.'),
 agreement_message:text(4000).min(1,'Escribe cómo pides el acuerdo.'),
 deliver_before_payment:z.boolean(),
 payment_message:text(4000).min(1,'Escribe el mensaje de cobro.'),
 thanks_message:text(4000).min(1,'Escribe el agradecimiento.'),
}).strict();
export const variantSaleBases=['conversation','guided','existing'] as const;
export const variantSaleSchema=z.object({
 base:z.enum(variantSaleBases),
 aliases:z.array(salesRouteAliasSchema).max(30),
 conversation:conversationSaleSchema.nullable(),
 guided:salesFlowContentSchema.nullable(),
 // Migrated variants keep their published workflow until the operator chooses a base.
 existing_workflow_id:id.nullable(),
 seller:variantSellerSchema,
}).strict().superRefine((sale,ctx)=>{
 if(sale.base==='existing'&&!sale.existing_workflow_id)ctx.addIssue({code:'custom',path:['existing_workflow_id'],message:'Elige un flujo base.'});
 if(sale.base!=='existing'&&sale.existing_workflow_id)ctx.addIssue({code:'custom',path:['existing_workflow_id'],message:'Un flujo base nuevo no conserva el flujo anterior.'});
});
const tierSchema=z.object({id:z.string().regex(/^[a-z0-9_-]+$/).max(60),name:label,minimum_total_minor:amount,included_extra_from_minor:amount.optional()}).strict();
/** Legacy commercial terms preserved verbatim from the migrated offer (D-11). */
export const variantLegacyTermsSchema=z.object({
 tier_policy:z.literal('mcl-receipt-total-v5').optional(),
 madrina:z.object({enabled:z.literal(true),core_asset_id:z.string().uuid().optional(),threshold_exclusive_minor:z.literal(10700),historical_reference_minor:z.literal(19400).optional()}).strict().optional(),
 receipt_policy_version_id:z.string().uuid().optional(),
}).strict();
export const variantOfferSchema=z.object({
 name:label,
 price_minor:amount,
 tiers:z.array(tierSchema).max(20),
 fulfillment:z.array(fulfillmentSchema).max(30),
 billing_delay_seconds:z.number().int().min(0).max(604800),
 positive_payment_unlocks_all:z.boolean(),
 legacy:variantLegacyTermsSchema,
}).strict();
export const paymentLinkProviders=['whop','hotmart','stripe','mercado_pago','other'] as const;
export const paymentLinkProviderLabels:Record<typeof paymentLinkProviders[number],string>={whop:'Whop',hotmart:'Hotmart',stripe:'Stripe',mercado_pago:'Mercado Pago',other:'Otro proveedor'};
const linkId=z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
/** Public description only. SPEI and URLs are kept in the encrypted column. */
export const variantCollectionSchema=z.object({
 spei:z.object({bank:label,last4:z.string().regex(/^[0-9]{4}$/)}).strict().nullable(),
 links:z.array(z.object({id:linkId,label,provider:z.enum(paymentLinkProviders),host:z.string().max(253)}).strict()).max(5),
 instructions:text(2000),
 // A migrated bank profile is reused unchanged until the operator edits Cobro.
 legacy_profile_id:z.string().uuid().nullable(),
}).strict();
export const variantDocumentSchema=z.object({
 schema_version:z.literal(1),
 name:label,
 locale:variantLocaleSchema,
 sale:variantSaleSchema,
 ai:variantAiSchema,
 offer:variantOfferSchema,
 collection:variantCollectionSchema,
 remarketing:remarketingPolicySchema.nullable(),
 pending_review:z.array(z.enum(marketCopyReviewFields)).max(marketCopyReviewFields.length)
  .refine(values=>new Set(values).size===values.length,'Campo repetido.'),
}).strict();
export type VariantDocument=z.infer<typeof variantDocumentSchema>;
export type VariantLocale=z.infer<typeof variantLocaleSchema>;
export type VariantCollection=z.infer<typeof variantCollectionSchema>;

/** Plain values entered in Cobro. Accepted only on write, never returned. */
const clabe=z.string().transform(value=>value.replace(/[\s-]/g,'')).pipe(z.string().regex(/^[0-9]{18}$/,'La CLABE tiene 18 dígitos.'))
 .refine(value=>clabeValid(value),'Revisa la CLABE: el dígito verificador no coincide.');
export function clabeValid(value:string){
 if(!/^[0-9]{18}$/.test(value))return false;
 const weights=[3,7,1];let sum=0;
 for(let i=0;i<17;i++)sum+=(Number(value[i])*weights[i%3]!)%10;
 return (10-(sum%10))%10===Number(value[17]);
}
export const httpsPaymentUrlSchema=z.string().trim().max(2000).url('Usa una dirección completa.').refine(value=>{
 try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&url.hostname.includes('.');}catch{return false;}
},'El enlace debe empezar con https://');
export const collectionInputSchema=z.object({
 spei:z.union([z.object({bank:label,holder:label,clabe}).strict(),z.literal('keep'),z.null()]),
 links:z.array(z.object({id:linkId.optional(),label,provider:z.enum(paymentLinkProviders),url:z.union([httpsPaymentUrlSchema,z.literal('keep')])}).strict()).max(5),
 instructions:text(2000),
}).strict();
export type CollectionInput=z.infer<typeof collectionInputSchema>;

export const variantSections=['sale','offer','collection','remarketing','ai','locale'] as const;
export type VariantSection=typeof variantSections[number];
export const variantSectionInputSchema=z.discriminatedUnion('section',[
 z.object({section:z.literal('sale'),expected_version:version,value:variantSaleSchema}).strict(),
 z.object({section:z.literal('offer'),expected_version:version,value:variantOfferSchema}).strict(),
 z.object({section:z.literal('collection'),expected_version:version,value:collectionInputSchema}).strict(),
 z.object({section:z.literal('remarketing'),expected_version:version,value:remarketingPolicySchema.nullable()}).strict(),
 z.object({section:z.literal('ai'),expected_version:version,value:variantAiSchema}).strict(),
 z.object({section:z.literal('locale'),expected_version:version,value:z.object({name:label,locale:variantLocaleSchema}).strict()}).strict(),
]);
export const productCreateInputSchema=z.object({name:label,description:text(4000).default(''),
 variant:z.object({name:label,locale:variantLocaleSchema}).strict()}).strict();
export const productEditInputSchema=z.object({expected_version:version,name:label,description:text(4000)}).strict();
export const productLifecycleInputSchema=z.object({expected_version:version}).strict();
export const variantCreateInputSchema=z.object({product_id:id,name:label,locale:variantLocaleSchema}).strict();
export const variantDuplicateInputSchema=z.object({name:label,locale:variantLocaleSchema}).strict();
export const variantPublishInputSchema=z.object({expected_version:version,document_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const variantReviewInputSchema=z.object({expected_version:version,reviewed:z.array(z.enum(marketCopyReviewFields)).min(1).max(marketCopyReviewFields.length)}).strict();
export const variantLifecycleInputSchema=z.object({expected_version:version}).strict();
export const variantNumberInputSchema=z.object({account_id:id,sell:z.boolean()}).strict();
export const variantListQuerySchema=z.object({product_id:id.optional(),include:z.enum(['active','all']).default('active')}).strict();
export const productListQuerySchema=z.object({include:z.enum(['active','all']).default('active'),q:z.string().trim().max(160).optional()}).strict();

/** Operator-facing state labels (Experiencia V7 §6). */
export const variantStates=['NEEDS_SETUP','MISSING_COLLECTION','READY_TO_ASSIGN','SELLING','ARCHIVED'] as const;
export type VariantState=typeof variantStates[number];
export const variantStateLabels:Record<VariantState,string>={NEEDS_SETUP:'Por configurar',MISSING_COLLECTION:'Falta cobro',READY_TO_ASSIGN:'Listo para asignar',SELLING:'Vendiendo',ARCHIVED:'Archivada'};
export const variantMissingLabels:Record<string,string>={
 sale_messages:'Falta configurar los mensajes de venta',seller:'Falta configurar el vendedor',offer_price:'Falta configurar el precio',
 materials:'Falta configurar qué recibe el cliente',collection:'Falta configurar el cobro',review_language:'Revisa el idioma de los textos',
 review_price_currency:'Revisa el precio y la moneda',review_collection:'Revisa el cobro',review_flow_seller:'Revisa el flujo y el vendedor',
 review_remarketing:'Revisa el remarketing',review_materials:'Revisa los materiales',
};
