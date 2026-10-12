import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {profileCatalogResourceSchema} from '../../../packages/contracts/src/profile-catalog-consumer.js';
import {profileCatalogListSchema,profileCatalogVersionsQuerySchema} from '../../../packages/contracts/src/profile-catalog.js';
import {ProfileCatalogError,type ProfileCatalogReader} from '../../../packages/commerce-client/src/profile-catalog.js';
import {safeResult} from './server.js';

/** Explicit V2 catalog server. The supplied reader already owns its fixed PAT. */
export function createProfileCatalogMcp(read:ProfileCatalogReader){
 const server=new McpServer({name:'commerce-profile-catalog',version:'7.0.0'},{capabilities:{tools:{}}});
 const definitions={
  profile_catalog_list:{operation:'list',title:'Consultar catálogo del perfil',schema:z.object({resource:profileCatalogResourceSchema,...profileCatalogListSchema.shape}).strict()},
  profile_catalog_get:{operation:'get',title:'Consultar recurso del perfil',schema:z.object({resource:profileCatalogResourceSchema,id:z.uuid(),environment:z.enum(['REAL','SIMULATION']).default('REAL')}).strict()},
  profile_catalog_versions:{operation:'versions',title:'Consultar versiones del recurso',schema:z.object({resource:profileCatalogResourceSchema,id:z.uuid(),...profileCatalogVersionsQuerySchema.shape}).strict()},
 } as const;
 for(const[name,definition]of Object.entries(definitions))server.registerTool(name,{title:definition.title,description:'Lectura autorizada por el PAT configurado. No permite elegir otro perfil ni escribir.',inputSchema:definition.schema,
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}},async(args:unknown)=>{
   try{const result=safeResult(await read({...definition.schema.parse(args),operation:definition.operation}));return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:result};}
   catch(error){const result={code:error instanceof ProfileCatalogError?error.code:'CATALOG_READ_UNCONFIRMED',next:'Consulta nuevamente de forma explícita cuando la identidad y el perfil estén vigentes.'};return{isError:true,content:[{type:'text' as const,text:JSON.stringify(result)}]};}
  });
 return server;
}
