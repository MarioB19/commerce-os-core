import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {marketCommandSchema,type MarketCommand} from '../../../packages/contracts/src/market-variant-client.js';
import {MarketClientError,type MarketClient} from '../../../packages/commerce-client/src/market-variants.js';
import {safeResult} from './server.js';

const titles:Record<MarketCommand['operation'],string>={
 adopt:'Adoptar producto como familia de mercados',create:'Crear borrador de variante',copy:'Copiar versión a otro mercado',
 replace:'Editar borrador con revisión',publish:'Publicar versión interna revisada',get:'Consultar variante',
 release:'Consultar versión comercial inmutable',reconcile:'Consultar operación de variante',list:'Listar variantes de una familia',
};
const reads=new Set(['get','release','reconcile','list']);
const codes=new Set(['MARKET_INPUT_INVALID','MARKET_AUTHORITY_REQUIRED','MARKET_WRITE_UNCONFIRMED','MARKET_READ_UNCONFIRMED']);
/** Prepared server: the client owns one fixed profile credential and API origin. */
/** Registers these tools into a composed server (createProfileMcp). */
export function registerMarketVariantsTools(server:McpServer,client:MarketClient){
 for(const command of marketCommandSchema.options){
  const operation=command.shape.operation.value,readOnly=reads.has(operation);
  const schema=z.object(Object.fromEntries(Object.entries(command.shape).filter(([key])=>key!=='operation'))).strict();
  server.registerTool('market_variant_'+operation,{title:titles[operation],
   description:readOnly?'Consulta autorizada del perfil configurado; conserva versiones y recibos.':'Escritura interna con UUID explícito y revisión canónica. No activa números, campañas ni envíos. Ante respuesta incierta, consulta la operación antes de otro intento.',
   inputSchema:schema,annotations:{readOnlyHint:readOnly,destructiveHint:!readOnly,idempotentHint:true,openWorldHint:false}},async(args:unknown)=>{
    let value:MarketCommand|undefined;
    try{
     value=marketCommandSchema.parse({...schema.parse(args),operation});
     const result=safeResult(await client(value));
     return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};
    }catch(error){
     const code=error instanceof MarketClientError&&codes.has(error.code)?error.code:readOnly?'MARKET_READ_UNCONFIRMED':'MARKET_WRITE_UNCONFIRMED';
     const result={code,...(value&&'operation_id'in value?{operation_id:value.operation_id}:{}),
      next:readOnly?'Consulta de nuevo explícitamente con autoridad vigente.':'Consulta market_variant_reconcile con la misma clave. No repitas automáticamente la escritura.'};
     return{isError:true,content:[{type:'text' as const,text:JSON.stringify(result)}]};
    }
   });
 }
}
export function createMarketVariantsMcp(client:MarketClient){const server=new McpServer({name:'commerce-market-variants',version:'7.0.0'},{capabilities:{tools:{}}});registerMarketVariantsTools(server,client);return server;}
