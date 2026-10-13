import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {z} from 'zod';
import {mcpRegistryEntry} from '../../../packages/contracts/src/mcp-registry.js';
import {safeResult} from './server.js';

/** One registry tool with closed actions (RF-15). The advertised schema is an
 * object with an `action` enum and the union of every action's fields; each
 * call is then validated strictly against that action's own schema. */
export interface ManageAction {schema:z.ZodObject<any>;read:boolean;destructive?:boolean;run:(input:any)=>Promise<unknown>}
export interface ManageError {code:string;next:string;operationId?:string}
export function registerManageTool(server:McpServer,name:string,meta:{title:string;description:string},actions:Record<string,ManageAction>,fail:(action:string,error:unknown,input:unknown)=>ManageError){
 const entry=mcpRegistryEntry(name),keys=Object.keys(actions);
 if(!keys.length||keys.some(k=>!entry.actions.includes(k)))throw Error('MCP_ACTION_NOT_IN_REGISTRY:'+name);
 const shape:Record<string,z.ZodType>={},seen=new Map<string,string>();
 for(const spec of Object.values(actions))for(const [field,type] of Object.entries(spec.schema.shape)){
  if(field==='action')throw Error('MCP_ACTION_FIELD_RESERVED');
  if(!type)throw Error('MCP_ACTION_FIELD_UNDEFINED:'+name+'.'+field);
  let signature:string;try{signature=JSON.stringify(z.toJSONSchema(type as z.ZodType,{unrepresentable:'any',io:'input'}));}catch{signature='opaque:'+field+':'+Math.random();}
  if(!seen.has(field)){seen.set(field,signature);shape[field]=(type as z.ZodType).optional();}
  else if(seen.get(field)!==signature)shape[field]=z.unknown().optional().describe('Depende de la acción elegida.');
 }
 const advertised=z.object({action:z.enum(keys as [string,...string[]]).describe('Acción cerrada de esta herramienta.'),...shape}).strict();
 const read=Object.values(actions).every(a=>a.read),destructive=Object.values(actions).some(a=>a.destructive);
 server.registerTool(name,{title:meta.title,description:meta.description,inputSchema:advertised,annotations:{readOnlyHint:read,destructiveHint:destructive,idempotentHint:true,openWorldHint:false}},async(args:unknown)=>{
  const {action,...rest}=(args??{}) as {action?:string};
  const spec=typeof action==='string'&&Object.hasOwn(actions,action)?actions[action]:undefined;
  if(!spec)return{isError:true,content:[{type:'text' as const,text:JSON.stringify({code:'MCP_ACTION_INVALID',next:'Elige una de las acciones cerradas.'})}]};
  const parsed=spec.schema.strict().safeParse(Object.fromEntries(Object.entries(rest).filter(([,v])=>v!==undefined)));
  if(!parsed.success)return{isError:true,content:[{type:'text' as const,text:JSON.stringify({code:'MCP_INPUT_INVALID',next:'Revisa los campos de la acción '+action+'.',issues:parsed.error.issues.slice(0,10).map(i=>({path:i.path.join('.'),message:i.message}))})}]};
  try{const result=safeResult(await spec.run(parsed.data));const structured=result&&typeof result==='object'&&!Array.isArray(result)?result:{data:result};return{content:[{type:'text' as const,text:JSON.stringify(result)}],structuredContent:structured};}
  catch(error){return{isError:true,content:[{type:'text' as const,text:JSON.stringify(fail(action!,error,parsed.data))}]};}
 });
}
/** Actions that need the person in the app (secrets, QR, password): the same
 * result in UI/API/MCP — an authenticated link to do it there. */
export function humanAction(path:string,reason:string){return async()=>{throw Object.assign(new Error('HUMAN_ACTION_REQUIRED'),{code:'HUMAN_ACTION_REQUIRED',path,reason});};}
