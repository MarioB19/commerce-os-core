import {z} from 'zod';
const id=z.uuid().transform(v=>v.toLowerCase()),environment=z.enum(['REAL','SIMULATION']);
const reason=z.string().trim().min(3).max(2000);
export const profileSalesResource=z.enum(['conversations','orders','receipts']);
const common={resource_id:id,operation_id:id,environment};
const conversationBody=z.discriminatedUnion('type',[
 z.object({type:z.literal('send_message'),kind:z.literal('text'),text:z.string().min(1).max(4096),expected_version:z.number().int().positive()}).strict(),
 z.object({type:z.literal('close_conversation'),reason}).strict(),
 z.object({type:z.literal('commitment')}).strict(),
 z.object({type:z.literal('opt_out'),reason}).strict(),
]);
export const profileSalesMutation=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('conversation.command'),...common,body:conversationBody}).strict(),
 z.object({operation:z.literal('conversation.controls'),...common,body:z.object({paused:z.boolean().optional(),takeover:z.boolean().optional(),suppressed:z.boolean().optional(),reason}).strict().refine(v=>v.paused!==undefined||v.takeover!==undefined||v.suppressed!==undefined)}).strict(),
 z.object({operation:z.literal('receipt.review'),...common,body:z.object({decision:z.enum(['APPROVED','REJECTED','HUMAN_REVIEW']),reason,expected_version:z.number().int().positive(),amount_minor:z.number().int().positive().safe().optional(),currency:z.string().regex(/^[A-Z]{3}$/).optional(),payment_key:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/).optional(),replaces_receipt_id:id.optional()}).strict()}).strict(),
]);
export type ProfileSalesMutation=z.infer<typeof profileSalesMutation>;
export const profileSalesPointer=z.object({operation:z.enum(['conversation.command','conversation.controls','receipt.review']),operation_id:id,resource_id:id,environment,request_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type ProfileSalesPointer=z.infer<typeof profileSalesPointer>;
export const profileSalesRead=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('list'),resource:profileSalesResource,environment,q:z.string().max(160).optional(),status:z.string().max(100).optional(),stage:z.string().max(100).optional(),limit:z.number().int().min(1).max(50).default(20),offset:z.number().int().min(0).max(10000).default(0)}).strict(),
 z.object({operation:z.literal('get'),resource:profileSalesResource,id,environment}).strict(),
]);
export type ProfileSalesRead=z.infer<typeof profileSalesRead>;
export const profileSalesRow=z.object({id,version:z.number().int().positive(),environment,created_at:z.iso.datetime({offset:true}),updated_at:z.iso.datetime({offset:true})}).catchall(z.unknown());
export type ProfileSalesRow=z.infer<typeof profileSalesRow>;
export const profileSalesCommand=z.object({id,workspace_id:z.string().min(1),environment,kind:z.enum(['conversation_command','receipt_review']),resource_id:id,actor_id:z.string().min(1),idempotency_key:id,status:z.enum(['PENDING','APPLIED','FAILED']),payload:z.record(z.string(),z.unknown()),result:z.record(z.string(),z.unknown()),created_at:z.iso.datetime({offset:true}),updated_at:z.iso.datetime({offset:true})}).catchall(z.unknown());
export type ProfileSalesCommand=z.infer<typeof profileSalesCommand>;
export function profileSalesRows(raw:unknown,request:ProfileSalesRead){
 const page=request.operation==='list'?z.object({data:z.array(profileSalesRow).max(request.limit),meta:z.object({total:z.number().int().nonnegative()}).strict()}).strict().parse(raw):{data:[z.object({data:profileSalesRow}).strict().parse(raw).data],meta:{total:1}};
 if(page.data.some(r=>r.environment!==request.environment||request.operation==='get'&&r.id!==request.id)||new Set(page.data.map(r=>r.id)).size!==page.data.length)throw Error('SALES_CONTEXT_INVALID');
 if(request.operation==='get'&&request.resource==='conversations')for(const row of page.data){
  if(!Array.isArray(row.messages))throw Error('SALES_CONTEXT_INVALID');
  for(const item of row.messages){const message=profileSalesRow.parse(item);if(message.environment!==request.environment||message.conversation_id!==row.id)throw Error('SALES_CONTEXT_INVALID');}
  for(const field of['contact','order','offer'])if(row[field]!=null&&profileSalesRow.parse(row[field]).environment!==request.environment)throw Error('SALES_CONTEXT_INVALID');
 }
 return page;
}
export function verifyProfileSalesCommand(value:unknown,request:Pick<ProfileSalesPointer,'resource_id'|'operation_id'|'operation'|'environment'>,workspace:string){
 const command=profileSalesCommand.parse(value);
 if(command.workspace_id!==workspace||command.environment!==request.environment||command.resource_id!==request.resource_id||command.idempotency_key!==request.operation_id||command.kind!==(request.operation==='receipt.review'?'receipt_review':'conversation_command'))throw Error('SALES_COMMAND_CONTEXT_INVALID');
 return command;
}
