import {z} from 'zod';
import {paymentPageQuerySchema,paymentExportQuerySchema,paymentRegisterSchema,paymentOptionQuerySchema,paymentOptionResponseSchema} from './payments-register.js';
export const paymentsCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('options'),query:paymentOptionQuerySchema}).strict(),
 z.object({operation:z.literal('list'),query:paymentPageQuerySchema}).strict(),
 z.object({operation:z.literal('export'),query:paymentExportQuerySchema}).strict(),
]);
export type PaymentsCommand=z.infer<typeof paymentsCommandSchema>;
export function paymentsCommandRoute(input:unknown){const value=paymentsCommandSchema.parse(input);return{value,route:'/v2/payments'+(value.operation==='export'?'/export':value.operation==='options'?'/options':'')+'?'+new URLSearchParams(Object.entries(value.query).filter(([,v])=>v!==undefined).map(([key,v])=>[key,String(v)]))};}
export function paymentsListResponse(input:unknown,command:Extract<PaymentsCommand,{operation:'list'}>,workspaceId?:string){
 const data=z.object({data:paymentRegisterSchema}).strict().parse(input).data;
 const {limit,offset,...filters}=command.query;
 if(workspaceId!==undefined&&data.workspaceId!==workspaceId||data.limit!==limit||data.offset!==offset||JSON.stringify(data.filters)!==JSON.stringify(filters)||data.rows.length>limit||data.rows.length!==Math.min(limit,Math.max(0,data.total-offset)))throw Error('PAYMENTS_RESPONSE_MISMATCH');
 if(new Set(data.rows.map(r=>r.receiptId)).size!==data.rows.length)throw Error('PAYMENTS_DUPLICATE_RECEIPT');
 return{operation:'list' as const,data};
}
export const paymentsMime={csv:'text/csv; charset=utf-8',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} as const;

export function paymentsOptionResponse(input:unknown,command:Extract<PaymentsCommand,{operation:'options'}>,workspaceId?:string){
 const r=paymentOptionResponseSchema.parse(input),q=command.query;
 // PostgreSQL owns the collation order. UTF-16 comparison in a browser differs
 // for valid Unicode markets; validate identity/cursor progress, not JS sorting.
 if(workspaceId!==undefined&&r.workspaceId!==workspaceId||r.kind!==q.kind||r.data.length>q.limit||new Set(r.data.map(x=>x.id)).size!==r.data.length||r.data.some(x=>x.id===q.after)||r.next!==null&&(r.data.length!==q.limit||r.next!==r.data.at(-1)?.id))throw Error('PAYMENTS_OPTIONS_MISMATCH');
 return{operation:'options' as const,...r};
}
