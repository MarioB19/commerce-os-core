import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {paymentsCommandSchema} from '../../../packages/contracts/src/payments-client.js';
import {PaymentsClientError,type PaymentsClient} from '../../../packages/commerce-client/src/payments.js';
import {safeResult} from './server.js';
/** A fixed PAT client supplies authority. Export bytes stay in a typed resource;
 * no file paths, signed receipt links or credentials are created here. */
export function createPaymentsMcp(client:PaymentsClient){
 const server=new McpServer({name:'commerce-payments',version:'7.0.0'},{capabilities:{tools:{}}});
 for(const command of paymentsCommandSchema.options){const operation=command.shape.operation.value,schema=z.object({query:command.shape.query}).strict();
  server.registerTool('payments_'+operation,{title:operation==='options'?'Buscar opciones del registro':operation==='list'?'Consultar comprobantes y totales por moneda':'Exportar pagos a CSV o Excel',description:'Mismos filtros y autoridad del perfil configurado. La exportación requiere permiso de exportar y registra una auditoría; no aprueba pagos ni envía mensajes.',inputSchema:schema,annotations:{readOnlyHint:operation!=='export',destructiveHint:false,idempotentHint:operation!=='export',openWorldHint:false}},async(args:unknown)=>{
   try{const result=await client({...schema.parse(args),operation});if(result.operation!=='export'){const data=safeResult(result);return{content:[{type:'text' as const,text:JSON.stringify(data)}],structuredContent:data};}
    const {bytes,...metadata}=result,data=safeResult(metadata);return{structuredContent:data,content:[{type:'resource' as const,resource:{uri:`commerce://payments/exports/${result.sha256}.${result.format}`,mimeType:result.mime,blob:Buffer.from(bytes).toString('base64')}}]};
   }catch(error){return{isError:true,content:[{type:'text' as const,text:JSON.stringify({code:error instanceof PaymentsClientError?error.code:'PAYMENTS_READ_UNCONFIRMED',next:'Consulta con autoridad vigente; no se aprueban pagos automáticamente.'})}]};}
  });
 }
 return server;
}
