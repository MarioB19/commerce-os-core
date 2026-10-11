import { z } from 'zod';

export const CREATIVE_ENGINE_VERSION = '1.1.0' as const;
export const SUPPORTED_CREATIVE_ENGINE_VERSIONS = ['1.0.0','1.1.0'] as const;
export const REMOTION_VERSION = '4.0.503' as const;
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const CreativeIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const AssetRefSchema = z.object({
  asset_id: CreativeIdSchema, sha256: Sha256Schema,
  media_type: z.enum(['image/png','image/jpeg','image/webp','video/mp4','audio/mpeg','audio/wav','audio/mp4','font/woff2']).optional(),
  bytes: z.number().int().positive().max(500 * 1024 * 1024).optional(),
}).strict();
export type AssetRef = z.infer<typeof AssetRefSchema>;
export const SourceSchema = z.object({source_id: CreativeIdSchema, sha256: Sha256Schema, locator: z.string().trim().min(1).max(500)}).strict();
export const TimedWordSchema = z.object({text: z.string().trim().min(1).max(80), startFrame: z.number().int().nonnegative(), endFrame: z.number().int().nonnegative(), chunkId: CreativeIdSchema}).strict();
export type TimedWord = z.infer<typeof TimedWordSchema>;
export const InputApprovalSchema = z.object({
  status: z.literal('APPROVED'), recipe_sha256: Sha256Schema, actor_id: CreativeIdSchema,
  authority: z.enum(['HUMAN','DELEGATED_PILOT']), source_reference: z.string().trim().min(1).max(500),
  approved_at: z.string().datetime({offset:true}),
}).strict();
export type InputApproval = z.infer<typeof InputApprovalSchema>;
export const ProductionAuthorizationSchema = z.object({
  authorization_id: CreativeIdSchema, recipe_sha256: Sha256Schema, recipe_version: z.number().int().positive(),
  authority: z.enum(['HUMAN','DELEGATED_PILOT']), source_reference: z.string().trim().min(1).max(500),
  expires_at: z.string().datetime({offset:true}),
}).strict();
export type ProductionAuthorization = z.infer<typeof ProductionAuthorizationSchema>;

/** Optional purpose preserves legacy request hashes and limits. WA settings are explicit inputs. */
export const VoiceSettingsSchema=z.object({speed:z.number().min(.7).max(1.2),stability:z.number().min(0).max(1),similarity_boost:z.number().min(0).max(1),style:z.number().min(0).max(1),use_speaker_boost:z.boolean()}).strict();
export const ElevenLabsVoiceRequestSchema=z.object({text:z.string().min(1).max(10000),voice_id:z.string().regex(/^[A-Za-z0-9]{8,64}$/),model_id:z.enum(['eleven_multilingual_v2','eleven_flash_v2_5']),max_duration_seconds:z.number().positive().max(180),output_format:z.literal('mp3_44100_128').default('mp3_44100_128'),purpose:z.enum(['ad','whatsapp']).optional(),voice_settings:VoiceSettingsSchema.optional()}).strict().superRefine((v,c)=>{
 if(v.purpose!=='whatsapp'){if(v.text.length>1200)c.addIssue({code:'custom',path:['text'],message:'Ad voice maximum1200 characters.'});if(v.max_duration_seconds>60)c.addIssue({code:'custom',path:['max_duration_seconds'],message:'Ad voice maximum60 seconds.'});}
 else if(!v.voice_settings)c.addIssue({code:'custom',path:['voice_settings'],message:'WhatsApp requires explicit approved voice settings.'});
 else if(v.voice_settings.speed<.84||v.voice_settings.speed>.98||v.voice_settings.stability!==.92||v.voice_settings.style!==0)c.addIssue({code:'custom',path:['voice_settings'],message:'Approved WhatsApp method: speed.84–.98, stability.92, style0.'});
});
export const DisplayApprovalSchema=z.object({source_id:CreativeIdSchema,source_sha256:Sha256Schema,locator:z.string().min(1).max(500),text_sha256:Sha256Schema,actor_id:CreativeIdSchema,approved_at:z.string().datetime({offset:true})}).strict();
export const VisualReviewSchema=z.object({asset_sha256:Sha256Schema,direction_sha256:Sha256Schema,actor_id:CreativeIdSchema,reviewed_at:z.string().datetime({offset:true}),status:z.literal('APPROVED')}).strict();
export const PresentationSchema=z.object({
 policy:z.literal('infoproduct-attraction-led-v2-packshot'),policy_source:SourceSchema,
 overlays:z.array(z.object({id:CreativeIdSchema,role:z.enum(['hook','benefit','offer','cta']),text:z.string().trim().min(1).max(180),start_frame:z.number().int().nonnegative(),duration_frames:z.number().int().positive(),box:z.object({x:z.number().min(65),y:z.number().min(270),width:z.number().positive().max(950),height:z.number().positive().max(980)}).strict(),font_size:z.number().int().min(36).max(72),approval:DisplayApprovalSchema}).strict()).min(4).max(16),
 packshot:z.object({asset_id:CreativeIdSchema,start_frame:z.number().int().nonnegative(),duration_frames:z.literal(60),preset:z.literal('costura-pop-float-exit-v1'),origin:z.enum(['product-real','existing-image','internal-library','chatgpt-image']),review:VisualReviewSchema}).strict(),
 music:z.object({asset_id:CreativeIdSchema,volume:z.number().positive().max(.25),ducked_volume:z.number().positive().max(.10),fade_frames:z.number().int().min(15).max(90),source_ids:z.array(CreativeIdSchema).min(1)}).strict(),
 caption_policy:z.literal('caption-canvas-bottom-20pct-v1'),
}).strict();

export const CreativeRecipeSchema = z.object({
  id: CreativeIdSchema, recipe_version: z.number().int().positive(), engine_version: z.enum(SUPPORTED_CREATIVE_ENGINE_VERSIONS),
  product_id: CreativeIdSchema, offer_id: CreativeIdSchema, offer_version: z.number().int().positive(),
  language: z.enum(['es-MX','pt-BR','es','pt','en']), format: z.literal('faceless-narrative'),
  width: z.literal(1080), height: z.literal(1920), fps: z.literal(30), duration_frames: z.number().int().min(900).max(1800),
  content: z.object({product_name:z.string().trim().min(1).max(150),audience:z.string().trim().min(1).max(500),angle:z.string().trim().min(1).max(500),hook:z.string().trim().min(1).max(180),body:z.string().trim().min(1).max(8000),cta:z.string().trim().min(1).max(180),
    ad_copy:z.object({primary_text:z.string().trim().min(1).max(10000),headline:z.string().trim().min(1).max(200),description:z.string().trim().min(1).max(1000),whatsapp_message:z.string().trim().min(1).max(2000)}).strict(),
    source_ids:z.array(CreativeIdSchema).min(1).max(100),
  }).strict(),
  scenes: z.array(z.object({id:CreativeIdSchema,asset_id:CreativeIdSchema,kind:z.enum(['image','video']),start_frame:z.number().int().nonnegative(),duration_frames:z.number().int().positive(),trim_before_frames:z.number().int().nonnegative().default(0),role:z.enum(['hook','problem','bridge','product','proof','result','offer','cta']),fit:z.enum(['cover','contain']),motion:z.enum(['none','zoom-in','zoom-out','pan-left','pan-right']),source_ids:z.array(CreativeIdSchema).min(1),origin:z.enum(['stock','internal-library','magnific-generated-clip','winning-ad','product-real']).optional(),direction:z.string().trim().min(1).max(1000).optional(),visual_review:VisualReviewSchema.optional()}).strict()).min(1).max(60),
  voice:z.object({mode:z.enum(['supplied','elevenlabs']),asset:AssetRefSchema,body_asset:AssetRefSchema.optional(),transcript:z.string().trim().min(1).max(10000),alignment_sha256:Sha256Schema,alignment_status:z.literal('VERIFIED'),alignment_source:SourceSchema,provider_receipt_id:CreativeIdSchema.optional()}).strict(),
  captions:z.object({words:z.array(TimedWordSchema).min(1).max(1000),max_words_per_card:z.number().int().min(1).max(6),style:z.enum(['karaoke-band','kinetic-pop','minimal'])}).strict(),
  font:z.object({family:z.literal('Bricolage Grotesque'),version:z.literal('5.3.0'),sha256:Sha256Schema}).strict(),
  palette:z.object({background:z.string().regex(/^#[a-fA-F0-9]{6}$/),foreground:z.string().regex(/^#[a-fA-F0-9]{6}$/),accent:z.string().regex(/^#[a-fA-F0-9]{6}$/)}).strict(),
  assets:z.array(AssetRefSchema).min(1).max(100),
  claims:z.array(z.object({id:CreativeIdSchema,text:z.string().trim().min(1).max(1000),status:z.literal('VERIFIED'),source_ids:z.array(CreativeIdSchema).min(1)}).strict()).max(100),
  sources:z.array(SourceSchema).min(1).max(100),
  excluded_claims:z.array(z.string().trim().min(1).max(500)).max(100).default([]),
  presentation:PresentationSchema.optional(),
  legacy:z.object({launch_id:CreativeIdSchema,angle_id:z.string().regex(/^A0[1-6]$/),hook_id:z.string().regex(/^h[1-3]$/),bundle_sha256:Sha256Schema}).strict().optional(),
}).strict();
export type CreativeRecipe = z.infer<typeof CreativeRecipeSchema>;
export interface RecipeIssue { code:string; path:string; message:string }
export interface RecipeFingerprints { recipe:string; prepare:string; voice:string; captions:string; render:string; copy:string }
/** Supplied by the authority after reading asset records, never accepted from recipe JSON. */
export interface AssetAttestation { asset_id:string; sha256:string; state:'READY'; permission:'ALLOWED'; source_reference:string; media_type?:string; bytes?:number }
export interface RenderPlan { schema_version:1; recipe:CreativeRecipe; recipe_sha256:string; platform:string; engine_version:typeof SUPPORTED_CREATIVE_ENGINE_VERSIONS[number]; remotion_version:typeof REMOTION_VERSION; fingerprints:RecipeFingerprints; input_approval:InputApproval; authorization:ProductionAuthorization; asset_attestations:AssetAttestation[];playbook_intake?:unknown }
export interface TechnicalQa { status:'PASS'|'FAIL'; checks:Array<{code:string;passed:boolean;actual:unknown;expected:unknown}>; editorial_review:'PENDING'; production_approval:'PENDING'; checked_at:string }
export interface RenderOutput { kind:'master'|'preview'|'captions'|'copy'|'manifest'; path:string; contentType:string; sha256:string; sizeBytes:number }
export interface RenderResult { files:RenderOutput[]; qa:TechnicalQa; recipe_sha256:string; fingerprints:RecipeFingerprints; reused:boolean; elapsed_ms:number }
