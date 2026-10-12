import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {continuityRequestSchema} from '../../../packages/contracts/src/continuous-consumer.js';
import {ContinuityClientError,type ContinuityClient} from '../../../packages/commerce-client/src/continuous-authorization.js';
/** Fixed scoped PAT is supplied by the composition root, never by tool input. */
export function createContinuityMcp(client:ContinuityClient){
 const server=new McpServer({name:'commerce-continuity',version:'7.0.0'},{capabilities:{tools:{}}});
 for(const schema of continuityRequestSchema.options){
  const operation=schema.shape.operation.value,read=['list','get','receipt'].includes(operation);
  const {operation:_operation,...shape}=schema.shape,input=z.object(shape).strict();
  server.registerTool('profile_continuity_'+operation,{title:'Continuidad del perfil: '+operation,
   description:read?'Consulta autorizaciones o el resultado de una operación.':'Acción humana explícita. Conservar operationId y consultar receipt si el resultado es incierto. No envía mensajes.',
   inputSchema:input,annotations:{readOnlyHint:read,destructiveHint:!read,idempotentHint:true,openWorldHint:false}},async(args:unknown)=>{
    try{const result=await client(schema.parse({...input.parse(args),operation}));return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:{...result}};}
    catch(error){return{isError:true,content:[{type:'text' as const,text:JSON.stringify({code:error instanceof ContinuityClientError?error.code:'CONTINUITY_OUTCOME_UNCONFIRMED',next:read?'Consulta de nuevo con identidad vigente.':'Conserva operationId y consulta receipt; no repitas automáticamente.'})}]};}
   });
 }
 return server;
}
