/** V7 RF-16.b: versioned API/MCP reference generated from the running code.
 *
 *   node --import tsx scripts/api-reference.ts write   # regenerate docs/reference/*
 *   node --import tsx scripts/api-reference.ts check   # exit 1 on any drift
 *
 * The OpenAPI document comes from the real Fastify app (createApp) and the MCP
 * table from the typed registry; nothing is written by hand. tests/unit/
 * api-reference.test.ts runs `check` in CI, so a route, schema or MCP action
 * change without regenerating the reference fails the build. */
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,join} from 'node:path';
import {mcpRegistry,MCP_TOOL_BUDGET,type McpRegistryEntry} from '../packages/contracts/src/mcp-registry.js';

const ROOT=join(dirname(fileURLToPath(import.meta.url)),'..');
export const REFERENCE_FILES=['docs/reference/openapi-v7.json','docs/reference/mcp-v7.json','docs/reference/api-mcp-v7.md'] as const;
const METHODS=['get','post','put','patch','delete'];

function sorted(value:unknown):unknown{
 if(Array.isArray(value))return value.map(sorted);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted((value as Record<string,unknown>)[k])]));
 return value;
}
export function normalizeOpenApi(spec:Record<string,any>){
 const {servers:_servers,...rest}=spec;
 return sorted({...rest,info:{title:'Commerce OS API V7',version:'v7'}}) as Record<string,any>;
}
export type ApiOperation={method:string;path:string;tags:string[];summary:string|null;public:boolean};
export function operations(spec:Record<string,any>):ApiOperation[]{
 const rows:ApiOperation[]=[];
 for(const [path,item] of Object.entries(spec.paths??{}) as [string,Record<string,any>][])
  for(const method of METHODS)if(item[method]){const op=item[method];rows.push({method:method.toUpperCase(),path,tags:op.tags??[],summary:op.summary??null,public:Array.isArray(op.security)&&op.security.length===0});}
 return rows.sort((a,b)=>a.path.localeCompare(b.path)||METHODS.indexOf(a.method.toLowerCase())-METHODS.indexOf(b.method.toLowerCase()));
}
export function renderReference(spec:Record<string,any>,registry:readonly McpRegistryEntry[]=mcpRegistry){
 const openapi=JSON.stringify(normalizeOpenApi(spec),null,1)+'\n';
 const mcp=JSON.stringify(sorted({budget:MCP_TOOL_BUDGET,tools:registry.map(t=>({name:t.name,audience:t.audience,family:t.family,scopes:[...t.scopes],actions:[...t.actions],pending:[...t.pending]}))}),null,1)+'\n';
 const ops=operations(normalizeOpenApi(spec)),digest=createHash('sha256').update(openapi).update(mcp).digest('hex');
 const families=new Map<string,ApiOperation[]>();
 for(const op of ops){const family=op.path.split('/').slice(0,3).join('/')||'/';families.set(family,[...(families.get(family)??[]),op]);}
 const lines=['# Referencia API y MCP — Commerce OS V7','',
  '> Generada por `scripts/api-reference.ts` desde el código (OpenAPI de la app y registro MCP tipado). No se edita a mano: CI falla si difiere del código.','',
  `Contenido: \`${digest.slice(0,16)}\` · ${ops.length} operaciones HTTP en ${Object.keys(spec.paths??{}).length} rutas · ${registry.length} herramientas MCP (presupuesto ${MCP_TOOL_BUDGET}).`,'',
  '## Herramientas MCP','','| Herramienta | Audiencia | Rutas | Permisos | Acciones | Pendientes |','|---|---|---|---|---|---|',
  ...registry.map(t=>`| \`${t.name}\` | ${t.audience==='profile'?'perfil':'plataforma'} | \`${t.family}\` | ${t.scopes.map(s=>'`'+s+'`').join(', ')} | ${t.actions.join(', ')||'—'} | ${t.pending.join(', ')||'—'} |`),
  '','## Operaciones HTTP',''];
 for(const [family,list] of [...families].sort(([a],[b])=>a.localeCompare(b))){
  lines.push(`### \`${family}\``,'','| Método | Ruta | Acceso |','|---|---|---|',...list.map(op=>`| ${op.method} | \`${op.path}\` | ${op.public?'público':'autenticado'} |`),'');
 }
 return{'docs/reference/openapi-v7.json':openapi,'docs/reference/mcp-v7.json':mcp,'docs/reference/api-mcp-v7.md':lines.join('\n')+'\n'} as Record<(typeof REFERENCE_FILES)[number],string>;
}
export async function currentSpec(){
 const {createApp}=await import('../apps/api/src/app.js');
 const app=await createApp();await app.ready();
 try{return app.swagger() as Record<string,any>;}finally{await app.close();}
}
export async function referenceDrift(rendered:Record<string,string>,root=ROOT){
 const drift:string[]=[];
 for(const file of REFERENCE_FILES){let committed='';try{committed=await readFile(join(root,file),'utf8');}catch{/* missing counts as drift */}if(committed!==rendered[file])drift.push(file);}
 return drift;
}
async function main(){
 const mode=process.argv[2];
 if(mode!=='write'&&mode!=='check')throw new Error('usage: api-reference.ts write|check');
 const rendered=renderReference(await currentSpec());
 if(mode==='write'){await mkdir(join(ROOT,'docs/reference'),{recursive:true});for(const file of REFERENCE_FILES)await writeFile(join(ROOT,file),rendered[file]);console.log(JSON.stringify({state:'REFERENCE_WRITTEN',files:REFERENCE_FILES}));return;}
 const drift=await referenceDrift(rendered);
 console.log(JSON.stringify({state:drift.length?'REFERENCE_DRIFT':'REFERENCE_CURRENT',drift}));
 if(drift.length)process.exitCode=1;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])await main().then(()=>process.exit(process.exitCode??0));
