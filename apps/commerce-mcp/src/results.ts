import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {resultsCommandSchema,type ResultsCommand} from '../../../packages/contracts/src/results-client.js';
import {ResultsClientError,type ResultsClient} from '../../../packages/commerce-client/src/results.js';
import {safeResult} from './server.js';
const titles:Record<ResultsCommand['operation'],string>={options:'Buscar opciones para filtrar resultados',report:'Consultar resultados y comparación',goals:'Listar metas del perfil',goal:'Consultar una meta',progress:'Consultar avance y proyección de una meta',create:'Crear una meta',update:'Editar una meta con su revisión',reconcile:'Comprobar una operación de metas'};
/** Uses the same fixed-credential HTTP client as the UI and official client. */
export function createResultsMcp(client:ResultsClient){
 const server=new McpServer({name:'commerce-results',version:'7.0.0'},{capabilities:{tools:{}}});
 for(const command of resultsCommandSchema.options){
  const operation=command.shape.operation.value,readOnly=!['create','update'].includes(operation),schema=z.object(Object.fromEntries(Object.entries(command.shape).filter(([key])=>key!=='operation'))).strict();
  server.registerTool('results_'+operation,{title:titles[operation],description:readOnly?'Consulta resultados reales del perfil configurado. Sin datos no equivale a cero; no se mezclan monedas.':'Guarda una meta interna con UUID explícito. Si no se confirma, consulta la misma operación antes de reenviar. No modifica campañas ni pagos.',inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async(args:unknown)=>{
   let q:ResultsCommand|undefined;try{q=resultsCommandSchema.parse({...schema.parse(args),operation});const result=safeResult(await client(q));return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};}
   catch(error){const code=error instanceof ResultsClientError?error.code:readOnly?'RESULTS_READ_UNCONFIRMED':'RESULTS_WRITE_UNCONFIRMED';return{isError:true,content:[{type:'text' as const,text:JSON.stringify({code,...(q&&'operation_id'in q?{operation_id:q.operation_id}:{}),next:readOnly?'Consulta de nuevo con autoridad vigente.':'Consulta results_reconcile con la misma clave; no repitas automáticamente.'})}]};}
  });
 }
 return server;
}
