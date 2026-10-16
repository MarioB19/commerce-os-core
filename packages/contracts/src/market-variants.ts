import {z} from 'zod';

const id=z.string().uuid();
const revision=z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const label=z.string().trim().min(1).max(160);
const currencies=new Set(Intl.supportedValuesOf('currency'));
const currency=z.string().refine(value=>currencies.has(value),'Moneda ISO no admitida.');
const language=z.string().min(2).max(80).refine(value=>{
 try{return Intl.getCanonicalLocales(value)[0]===value;}catch{return false;}
},'Usa un idioma BCP47 canónico.');
const timezone=z.string().max(128).refine(value=>{
 if(value!=='UTC'&&!/^[A-Za-z_]+\/[A-Za-z0-9_+/-]+$/.test(value))return false;
 try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}
},'Usa una zona horaria IANA.');

/** Same workspace identity as F2. This schema never authenticates a profile. */
export const marketScopeSchema=z.object({workspace_id:z.string().min(1).max(256).refine(value=>!value.includes('\0')),
 environment:z.enum(['REAL','SIMULATION'])}).strict();
export const marketLocaleSchema=z.object({market:label,currency,language,timezone}).strict();
export const marketVersionRefSchema=z.object({id,revision,sha256:digest}).strict();
export const marketConfigurationSchema=z.object({offer:marketVersionRefSchema,flow:marketVersionRefSchema,
 seller:marketVersionRefSchema,collection:marketVersionRefSchema,remarketing:marketVersionRefSchema,
 materials:z.array(marketVersionRefSchema).max(100)}).strict().superRefine((value,ctx)=>{
 if(new Set(value.materials.map(ref=>ref.id)).size!==value.materials.length)
  ctx.addIssue({code:'custom',message:'Material repetido.'});
});
export const productFamilySchema=z.object({id,scope:marketScopeSchema,name:label,revision}).strict();
/** Loaded versions must be authenticated by a scoped transactional repository. */
export const marketReleaseSchema=z.object({id,scope:marketScopeSchema,family_id:id,variant_id:id,revision,
 locale:marketLocaleSchema,amount_minor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 configuration:marketConfigurationSchema}).strict();
export const marketCopyReviewFields=['language','price_currency','collection','flow_seller','remarketing','materials'] as const;
export const marketDraftCopySchema=z.object({id,scope:marketScopeSchema,family_id:id,revision:z.literal(1),
 status:z.literal('DRAFT'),locale:marketLocaleSchema,source_release:marketVersionRefSchema,
 suggested_amount_minor:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 configuration:marketConfigurationSchema,pending_review:z.tuple([
  z.literal('language'),z.literal('price_currency'),z.literal('collection'),z.literal('flow_seller'),
  z.literal('remarketing'),z.literal('materials')]),
 number_assignments:z.tuple([]),campaign_bindings:z.tuple([]),publication_authorized:z.literal(false)}).strict();
export const marketChatScopeSchema=marketScopeSchema.extend({account_id:id,contact_id:id}).strict();
export const marketJourneySnapshotSchema=z.object({journey_id:id,chat:marketChatScopeSchema,
 release:marketReleaseSchema,binding:marketVersionRefSchema}).strict();
export const marketRouteCandidateSchema=z.object({binding:marketVersionRefSchema,account_id:id,
 release:marketReleaseSchema,state:z.enum(['ACTIVE','DRAFT','RETIRED'])}).strict();
const evidenceRef=z.object({id,sha256:digest}).strict();
const selection=z.object({variant_id:id,release_id:id,evidence:evidenceRef}).strict();
const origin=z.object({binding:marketVersionRefSchema,variant_id:id,evidence:evidenceRef}).strict();

/** Internal evidence projection, never exposed as an HTTP authorization body. */
export const marketRouteInputSchema=z.object({chat:marketChatScopeSchema,
 protections:z.array(z.enum(['PROFILE_SUSPENDED','HUMAN_PAUSED','OPTED_OUT','CHANNEL_UNAVAILABLE','BUDGET_BLOCKED'])).max(5),
 candidates:z.array(marketRouteCandidateSchema).max(1000),
 open_journeys:z.array(marketJourneySnapshotSchema).max(100),
 origins:z.array(origin).max(20),selections:z.array(selection).max(20)}).strict();
export type MarketScope=z.infer<typeof marketScopeSchema>;
export type MarketRelease=z.infer<typeof marketReleaseSchema>;
export type MarketJourneySnapshot=z.infer<typeof marketJourneySnapshotSchema>;
export type MarketRouteInput=z.infer<typeof marketRouteInputSchema>;
export type MarketRouteCandidate=z.infer<typeof marketRouteCandidateSchema>;
export type MarketDraftCopy=z.infer<typeof marketDraftCopySchema>;
