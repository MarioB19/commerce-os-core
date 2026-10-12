import {z} from 'zod';
import {profileIdSchema} from './profiles.js';

const id=z.uuid().transform(value=>value.toLowerCase());
const text=z.string().min(1).max(200);
const minor=z.string().regex(/^(0|[1-9][0-9]*)$/).max(40);
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value);
export const paymentStatuses=['APPROVED','REVIEW','REJECTED','TEST','FALSE'] as const;
export const paymentLabels:Record<typeof paymentStatuses[number],string>={APPROVED:'Aprobado',REVIEW:'Por revisar',REJECTED:'Rechazado',TEST:'Prueba',FALSE:'Falso'};
export const paymentFilterSchema=z.object({environment:z.enum(['REAL','SIMULATION']).default('REAL'),from:day,to:day,
 status:z.enum(paymentStatuses).optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),familyId:id.optional(),variantId:id.optional(),accountId:id.optional(),
 campaignId:z.string().regex(/^[0-9]{1,40}$/).optional(),adId:z.string().regex(/^[0-9]{1,40}$/).optional(),market:text.optional(),q:z.string().trim().min(1).max(160).optional(),
 sort:z.enum(['date','amount','status']).default('date'),direction:z.enum(['asc','desc']).default('desc'),
}).strict().refine(value=>value.from<=value.to&&Date.parse(value.to)-Date.parse(value.from)<=366*86400000,'El periodo máximo es de 367 días.');
export const paymentPageQuerySchema=paymentFilterSchema.safeExtend({limit:z.coerce.number().int().min(1).max(100).default(50),offset:z.coerce.number().int().min(0).max(10000).default(0)});
export const paymentOptionQuerySchema=paymentFilterSchema.safeExtend({kind:z.enum(['family','variant','market','account','campaign','ad']),after:z.string().min(1).max(256).optional(),limit:z.coerce.number().int().min(1).max(50).default(25)});
export const paymentOptionResponseSchema=z.object({workspaceId:profileIdSchema,kind:paymentOptionQuerySchema.shape.kind,data:z.array(z.object({id:z.string().min(1).max(256),label:z.string().min(1).max(240)}).strict()).max(50),next:z.string().min(1).max(256).nullable()}).strict();
export const paymentExportQuerySchema=paymentFilterSchema.safeExtend({format:z.enum(['csv','xlsx'])});
export const paymentRowSchema=z.object({receiptId:id,receiptVersion:z.number().int().positive(),contributionId:id.nullable(),orderId:id.nullable(),conversationId:id.nullable(),
 occurredAt:z.iso.datetime(),familyId:id.nullable(),familyName:text.nullable(),variantId:id.nullable(),market:text.nullable(),
 amountMinor:minor.nullable(),currency:z.string().regex(/^[A-Z]{3}$/).nullable(),method:z.enum(['BANK_TRANSFER','LINK','UNKNOWN']),status:z.enum(paymentStatuses),
 accountId:id.nullable(),accountMasked:z.string().regex(/^••••[0-9]{4}$/).nullable(),contactMasked:z.string().regex(/^••••[0-9]{4}$/).nullable(),
 campaignId:z.string().regex(/^[0-9]{1,40}$/).nullable(),adId:z.string().regex(/^[0-9]{1,40}$/).nullable(),
 assetId:id.nullable(),recognizedRevenueMinor:minor,duplicate:z.boolean(),
}).strict();
export const paymentRegisterSchema=z.object({workspaceId:profileIdSchema,filters:paymentFilterSchema,rows:z.array(paymentRowSchema).max(10000),total:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
 totals:z.array(z.object({currency:z.string().regex(/^[A-Z]{3}$/),approvedRevenueMinor:minor,approvedPayments:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict()).max(300),
 timezone:z.string().min(1).max(128),observedAt:z.iso.datetime(),limit:z.number().int().positive().max(10000),offset:z.number().int().nonnegative(),
}).strict();
export type PaymentFilters=z.infer<typeof paymentFilterSchema>;
export type PaymentRow=z.infer<typeof paymentRowSchema>;
export type PaymentRegister=z.infer<typeof paymentRegisterSchema>;
