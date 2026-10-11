import {z} from 'zod';
import {STANDARD_V2_POLICY,warmupProfileSchema,warmupContentSchema} from '../../domain/src/warmup/policy.js';
export const CAPACITY_READBACK_TTL_MS=60_000;
export const pageSchema=z.object({q:z.string().max(100).optional(),state:z.string().max(30).optional(),offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(100).default(20)});
export const numberCreateSchema=z.object({alias:z.string().trim().min(2).max(100),responsible:z.string().trim().min(2).max(100),device_ref:z.string().trim().min(2).max(100)}).strict();
export const preparationCommandSchema=z.object({expected_version:z.number().int().positive(),action:z.enum(['start','declare','correct','migration_preview','migrate']),timezone:z.string().optional(),task:z.enum(['authentic_profile','responsible_device','consented_contacts','human_conversations']).optional(),status:z.enum(['COMPLETED','PENDING','UNVERIFIABLE']).optional(),note:z.string().max(500).default(''),supersedes_id:z.string().uuid().optional(),review:z.string().length(64).optional()}).strict();
export const programDraftSchema=z.object({name:z.string().trim().min(3).max(100),topology:z.enum(['direct','group']).default('group'),purpose:z.enum(['preparation','maintenance']).default('preparation'),group_id:z.string().uuid().optional(),account_ids:z.array(z.string().uuid()).min(2).max(20),content_ids:z.array(z.string().uuid()).max(100).default([]),profile:warmupProfileSchema,expires_at:z.string().datetime({offset:true}),max_messages:z.number().int().min(1).max(50000).optional()}).strict();
export const programCreateSchema=programDraftSchema.extend({profile:warmupProfileSchema.safeExtend({policy_version:z.literal(STANDARD_V2_POLICY).default(STANDARD_V2_POLICY),mode:z.literal('standard').default('standard')})});
export const programCommandSchema=z.object({expected_version:z.number().int().positive(),action:z.enum(['review','authorize','activate','pause','resume','cancel','archive','restore','revoke']),review:z.string().length(64).optional(),confirmation:z.enum(['AUTHORIZE_REVIEWED_PROGRAM','ACTIVATE_REVIEWED_PROGRAM']).optional(),reason:z.string().trim().min(3).max(500)}).strict();
export const librarySchema=z.object({label:z.string().min(3).max(100),turns:warmupContentSchema.shape.turns,ownership_confirmed:z.literal(true)}).strict();
export const capacityCommandSchema=z.object({action:z.enum(['preview','prepare','expand','drain','provision_existing','release']),count:z.number().int().min(1).max(20).optional(),slot_id:z.string().uuid().optional(),expected_version:z.number().int().positive().optional(),account_id:z.string().uuid().optional(),expected_account_version:z.number().int().positive().optional(),expected_session_version:z.number().int().positive().nullable().optional(),review:z.string().length(64).optional(),confirmation:z.literal('APPLY_REVIEWED_CAPACITY').optional(),reason:z.string().min(3).max(500)}).strict();
export const capacityLegacyAdoptionSchema=z.object({
 items:z.array(z.object({account_id:z.string().uuid(),slot:z.number().int().min(1).max(20),expected_account_version:z.number().int().positive(),expected_session_version:z.number().int().positive().nullable()}).strict()).min(1).max(20),
 confirmation:z.literal('ADOPT_RECONCILED_LEGACY_SLOTS'),
 reason:z.string().trim().min(3).max(500),
}).strict().superRefine((value,ctx)=>{
 const accounts=new Set<string>(),slots=new Set<number>();
 for(const [index,item]of value.items.entries()){
  if(accounts.has(item.account_id))ctx.addIssue({code:'custom',path:['items',index,'account_id'],message:'Cada cuenta sólo puede adoptarse una vez.'});
  if(slots.has(item.slot))ctx.addIssue({code:'custom',path:['items',index,'slot'],message:'Cada plaza física sólo puede adoptarse una vez.'});
  accounts.add(item.account_id);slots.add(item.slot);
 }
});

export const capacityInventorySchema=z.object({observed_at:z.string().datetime(),slots:z.array(z.object({slot:z.number().int().min(1).max(20),running:z.boolean(),session_count:z.number().int().nonnegative(),connected_sessions:z.number().int().nonnegative().optional(),image_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),network_present:z.literal(true),volumes_preserved:z.literal(true)}).strict()).max(20)}).strict();
const digest=z.string().regex(/^[a-f0-9]{64}$/),version=z.number().int().positive();
export const hostMetricsSchema=z.object({cpu_cores:z.number().positive().max(1024),cpu_busy_ratio:z.number().min(0).max(1),memory_total_bytes:z.number().positive(),memory_available_bytes:z.number().nonnegative(),disk_available_bytes:z.number().nonnegative(),gateway_count:z.number().int().min(0).max(20),physical_sessions_verified:z.number().int().min(0).max(20),overlay_sha:digest.or(z.literal('absent')),measured_gateway_memory_bytes:z.number().nonnegative(),required_margin_ram:z.number().min(.25).max(1).default(.25),required_margin_cpu:z.number().min(.3).max(1).default(.3)}).strict();
export const hostMeasurementSchema=z.object({host_ref:z.literal('primary'),observed_at:z.string().datetime(),source:z.literal('bounded_capacity_administrator'),metrics:hostMetricsSchema}).strict();
export const administrationCommandSchema=z.object({expected_version:version,action:z.enum(['claim','complete','reconcile']),overlay_sha:digest.optional(),outcome:z.enum(['PREPARED','VERIFIED','FAILED','UNKNOWN']).optional(),slots:z.array(z.object({slot:z.number().int().min(1).max(20),running:z.boolean(),session_count:z.number().int().nonnegative(),connected_sessions:z.number().int().nonnegative().optional(),image_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),network_present:z.literal(true),volumes_preserved:z.literal(true)}).strict()).max(20).optional(),reason:z.string().min(3).max(300)}).strict();

export const numberOperationCommandSchema=z.object({action:z.literal('resume_read'),expected_version:z.number().int().positive(),reason:z.string().min(3).max(300)}).strict();

export const numberFlowTestStartSchema=z.object({
 contact_name:z.string().trim().min(1).max(120).default('Contacto de prueba'),
 start_mode:z.enum(['EMPTY','SEEDED']).default('EMPTY'),
 initial_message:z.string().trim().min(1).max(4096).optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.start_mode==='EMPTY'&&value.initial_message!==undefined)ctx.addIssue({code:'custom',path:['initial_message'],message:'initial_message sólo se admite con start_mode SEEDED.'});
});

export const numberFlowTestResetSchema=z.object({
 contact_name:z.string().trim().min(1).max(120).optional(),
 start_mode:z.enum(['EMPTY','SEEDED']).default('EMPTY'),
 initial_message:z.string().trim().min(1).max(4096).optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.start_mode==='EMPTY'&&value.initial_message!==undefined)ctx.addIssue({code:'custom',path:['initial_message'],message:'initial_message sólo se admite con start_mode SEEDED.'});
});

export const numberFlowTestActionSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('message'),text:z.string().trim().min(1).max(4096)}).strict(),
 z.object({type:z.literal('question'),text:z.string().trim().min(1).max(4096)}).strict(),
 z.object({type:z.literal('select_product'),selection_key:z.string().regex(/^ruta-[1-9][0-9]?$/)}).strict(),
 z.object({type:z.literal('accept'),text:z.string().trim().min(1).max(4096).optional()}).strict(),
 z.object({type:z.literal('receipt'),amount_minor:z.number().int().positive().safe(),currency:z.string().regex(/^[A-Z]{3}$/).default('MXN')}).strict(),
 z.object({type:z.literal('approve_receipt')}).strict(),
 z.object({type:z.literal('continue')}).strict(),
 z.object({type:z.literal('advance'),seconds:z.number().int().min(1).max(604800)}).strict(),
 z.object({type:z.literal('next_reminder')}).strict(),
]);

export const numberSetupCommandSchema=z.object({
 action:z.enum(['connect','restart','check_health','observe_identity','reconcile_unknown','cancel_pending']),
 expected_version:z.number().int().positive(),
 expected_session_version:z.number().int().positive(),
 reason:z.string().trim().min(3).max(1000),
 command_id:z.string().uuid().optional(),
 outcome:z.enum(['confirmed_applied','confirmed_not_applied','keep_unknown']).optional(),
}).strict().superRefine((value,ctx)=>{
 if(value.action==='cancel_pending'&&!value.command_id)ctx.addIssue({code:'custom',path:['command_id'],message:'command_id es obligatorio para cancelar una orden sin ejecutar.'});
 if(value.action==='reconcile_unknown'){
  if(!value.command_id)ctx.addIssue({code:'custom',path:['command_id'],message:'command_id es obligatorio para conciliar.'});
  if(!value.outcome)ctx.addIssue({code:'custom',path:['outcome'],message:'outcome es obligatorio para conciliar.'});
 }
});
