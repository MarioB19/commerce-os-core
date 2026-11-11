import {z} from 'zod';

export const warmupEnvironment=z.enum(['REAL','SIMULATION']);
const ids=z.array(z.uuid()).min(2).max(10).refine(a=>new Set(a).size===a.length,'DUPLICATE_NUMBER');
export const groupWarmupConfigSchema=z.object({
 name:z.string().trim().min(3).max(80),groupId:z.uuid(),senderIds:ids,
 libraryVersion:z.string().min(3).max(100),
 timezone:z.string().refine(t=>{try{new Intl.DateTimeFormat('en',{timeZone:t});return true;}catch{return false;}},'TIMEZONE_INVALID'),
 startHour:z.number().int().min(0).max(22).default(9),endHour:z.number().int().min(1).max(23).default(18),
 groupDailyLimit:z.number().int().min(10).max(500).default(500),
 senderDailyLimit:z.number().int().min(5).max(100).default(100),
 maintenance:z.boolean().default(false),
}).strict().refine(c=>c.endHour>c.startHour,'TIME_WINDOW_INVALID');
export type GroupWarmupConfig=z.infer<typeof groupWarmupConfigSchema>;
export const groupWarmupCreateSchema=z.object({environment:warmupEnvironment.default('REAL'),operationId:z.uuid(),config:groupWarmupConfigSchema}).strict();
export const groupWarmupPreviewSchema=z.object({environment:warmupEnvironment.default('REAL'),programId:z.uuid().optional(),config:groupWarmupConfigSchema}).strict();
export const groupWarmupCommandSchema=z.object({environment:warmupEnvironment.default('REAL'),operationId:z.uuid(),expectedVersion:z.number().int().positive(),
 action:z.enum(['start','pause','resume','archive','configure']),previewHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),config:groupWarmupConfigSchema.optional(),
 /** V7.4 C: the owner confirms that the group's external participants agreed to this activity. Required to start or resume when the reviewed group has members outside the profile. */
 audienceConfirmed:z.literal(true).optional(),
}).strict().superRefine((v,c)=>{if(['start','resume','configure'].includes(v.action)&&!v.previewHash)c.addIssue({code:'custom',message:'PREVIEW_REQUIRED',path:['previewHash']});if((v.action==='configure')!==!!v.config)c.addIssue({code:'custom',message:'CONFIG_ACTION_REQUIRED',path:['config']});});
export const libraryScriptSchema=z.object({label:z.string().trim().min(3).max(100),topic:z.string().trim().min(3).max(80),
 turns:z.array(z.object({kind:z.literal('text'),text:z.string().trim().min(12).max(1000)}).strict()).min(2).max(20),ownership_confirmed:z.literal(true),
}).strict();
export const libraryImportSchema=z.object({environment:warmupEnvironment.default('REAL'),operationId:z.uuid(),version:z.string().regex(/^[a-z0-9][a-z0-9./_-]{2,99}$/),
 name:z.string().trim().min(3).max(100),scripts:z.array(libraryScriptSchema).min(1).max(2000),ownershipConfirmed:z.literal(true),
}).strict();
export type LibraryScript=z.infer<typeof libraryScriptSchema>;
export const warmupReadSchema=z.object({environment:warmupEnvironment.default('REAL')}).strict();
