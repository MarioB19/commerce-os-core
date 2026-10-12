import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {receiptPolicyCommand} from '../../../packages/contracts/src/receipt-policy-client.js';
import {ReceiptPolicyClientError,type ReceiptPolicyClient} from '../../../packages/commerce-client/src/receipt-policies.js';
import {safeResult} from './server.js';
export function createReceiptPolicyMcp(client:ReceiptPolicyClient){
 const server=new McpServer({name:'commerce-receipt-policies',version:'7.0.0'},{capabilities:{tools:{}}});
 for(const command of receiptPolicyCommand.options){
  const operation=command.shape.operation.value,readOnly=!operation.startsWith('save_');
  const schema=z.object(Object.fromEntries(Object.entries(command.shape).filter(([key])=>key!=='operation'))).strict();
  server.registerTool('receipt_policy_'+operation,{title:operation,description:readOnly?'Consulta la regla o recibo exacto del perfil configurado.':'Guarda una regla versionada con UUID explícito; no aprueba comprobantes ni genera entregas. Ante incertidumbre consulta el mismo UUID antes de otra escritura.',inputSchema:schema,
   annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:true,openWorldHint:false}},async(args:unknown)=>{
    try{const result=safeResult(await client(receiptPolicyCommand.parse({...schema.parse(args),operation})));return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};}
    catch(error){const code=error instanceof ReceiptPolicyClientError?error.code:readOnly?'RECEIPT_POLICY_READ_UNCONFIRMED':'RECEIPT_POLICY_WRITE_UNCONFIRMED';return{isError:true,content:[{type:'text' as const,text:JSON.stringify({code,next:readOnly?'Consulta explícitamente con permiso vigente.':'Consulta receipt_policy_reconcile con el mismo UUID y solicitud original. No reenvíes automáticamente.'})}]};}
   });
 }
 return server;
}
