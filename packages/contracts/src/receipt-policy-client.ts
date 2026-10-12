import {z} from 'zod';
import {receiptPolicyId,receiptPolicyStored,receiptProfilePolicyWrite,receiptVariantPolicyWrite} from './receipt-policy-store.js';
import {receiptPolicySchema,receiptPolicyOverrideSchema,resolvedReceiptPolicySchema} from './receipt-policy.js';
const environment=z.enum(['REAL','SIMULATION']);
export const receiptPolicyWriteCommand=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('save_profile'),environment,operationId:receiptPolicyId,body:receiptProfilePolicyWrite}).strict(),
 z.object({operation:z.literal('save_variant'),environment,operationId:receiptPolicyId,variantId:receiptPolicyId,body:receiptVariantPolicyWrite}).strict(),
]);
export const receiptPolicyCommand=z.discriminatedUnion('operation',[
 ...receiptPolicyWriteCommand.options,
 z.object({operation:z.literal('get_profile'),environment}).strict(),
 z.object({operation:z.literal('get_variant'),environment,variantId:receiptPolicyId}).strict(),
 z.object({operation:z.literal('reconcile'),environment,id:receiptPolicyId,expected:receiptPolicyWriteCommand}).strict(),
]);
export type ReceiptPolicyCommand=z.infer<typeof receiptPolicyCommand>;
export function receiptPolicyRoute(raw:unknown){
 const value=receiptPolicyCommand.parse(raw);
 if(value.operation==='reconcile'&&(value.id!==value.expected.operationId||value.environment!==value.expected.environment))throw Error('RECEIPT_POLICY_RECONCILE_BINDING');
 const method='operationId'in value?'PUT' as const:'GET' as const;
 const path=value.operation==='reconcile'?'operations/'+value.id:'variantId'in value?'variants/'+value.variantId:'profile';
 return{value,method,route:'/v2/payments/policies/'+path+'?environment='+value.environment};
}
export function receiptCanonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(receiptCanonical).join(',')+']';
 if(value!==null&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+receiptCanonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
export function receiptPolicyResponse(raw:unknown,command:ReceiptPolicyCommand,workspace?:string){
 const parsed:{data:z.infer<typeof receiptPolicyStored>|null;effective?:z.infer<typeof resolvedReceiptPolicySchema>}=(command.operation==='get_variant'?z.object({data:receiptPolicyStored.nullable(),effective:resolvedReceiptPolicySchema}).strict():z.object({data:receiptPolicyStored.nullable()}).strict()).parse(raw);
 const expected=command.operation==='reconcile'?command.expected:command;
 const target='variantId'in expected?expected.variantId:null;
 const data=parsed.data;
 if(data&&(data.variantId!==target||data.environment!==command.environment||workspace!==undefined&&data.workspaceId!==workspace))throw Error('RECEIPT_POLICY_RESULT_SCOPE');
 if(data)(target===null?receiptPolicySchema:receiptPolicyOverrideSchema).parse(data.body);
 if('operationId'in expected&&!(command.operation==='reconcile'&&data===null)){
  const body=expected.operation==='save_profile'?expected.body.policy:expected.body.override;
  if(!data||data.ref.revision!==expected.body.expectedRevision+1||receiptCanonical(data.body)!==receiptCanonical(body))throw Error('RECEIPT_POLICY_RESULT_WRITE');
 }
 if(parsed.effective){const e=parsed.effective;
  if(e.variantId!==target||e.scope.environment!==command.environment||workspace!==undefined&&e.scope.workspace_id!==workspace||data&&data.workspaceId!==e.scope.workspace_id||receiptCanonical(e.variant)!==receiptCanonical(data?.ref??null))throw Error('RECEIPT_POLICY_RESULT_EFFECTIVE');
 }
 return parsed;
}
export type ReceiptPolicyResult=ReturnType<typeof receiptPolicyResponse>;
