import {describe,expect,it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {MCP_TOOL_BUDGET,mcpRegistry} from '../../../packages/contracts/src/mcp-registry.js';
import {createProfileMcp} from './profile-server.js';

const token='cos_pat_'+'a'.repeat(43);
async function connect(fetcher:typeof fetch){
 const server=createProfileMcp('https://commerce.example.test',token,fetcher),client=new Client({name:'v7-test',version:'1.0.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);return{client,server};
}
const json=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
describe('composed V7 profile MCP server',()=>{
 it('rejects a missing origin or a non personal token before registering tools',()=>{
  expect(()=>createProfileMcp('commerce.example.test',token)).toThrow('MCP_CONFIGURATION_REQUIRED');
  expect(()=>createProfileMcp('https://commerce.example.test','service-token-value-123456')).toThrow('MCP_PROFILE_TOKEN_REQUIRED');
 });
 it('keeps the target registry at 40 tools: 34 profile and 6 platform, with disjoint pending actions',()=>{
  expect(mcpRegistry).toHaveLength(MCP_TOOL_BUDGET);
  expect(mcpRegistry.filter(t=>t.audience==='profile')).toHaveLength(34);expect(mcpRegistry.filter(t=>t.audience==='platform')).toHaveLength(6);
  expect(new Set(mcpRegistry.map(t=>t.name)).size).toBe(40);
  for(const t of mcpRegistry){expect(t.actions.filter(a=>t.pending.includes(a)),t.name).toEqual([]);expect(t.actions.length+t.pending.length,t.name).toBeGreaterThan(0);}
 });
 it('lists only registry tools with their implemented closed actions and no profile/token inputs',async()=>{
  const {client,server}=await connect(async()=>new Response('{}',{status:500}));
  try{
   const {tools}=await client.listTools(),names=tools.map(t=>t.name);
   expect(new Set(names).size).toBe(names.length);expect(names.length).toBeLessThanOrEqual(MCP_TOOL_BUDGET);
   for(const tool of tools){
    const entry=mcpRegistry.find(e=>e.name===tool.name);expect(entry,tool.name).toBeDefined();expect(entry!.audience).toBe('profile');
    const schema=tool.inputSchema as {properties?:Record<string,{enum?:string[]}>};
    expect([...(schema.properties?.action?.enum??[])].sort(),tool.name).toEqual([...entry!.actions].sort());
    for(const forbidden of ['workspaceId','workspace_id','token','origin','path','url','sql'])expect(Object.keys(schema.properties??{}),tool.name).not.toContain(forbidden);
   }
   for(const entry of mcpRegistry.filter(e=>e.audience==='profile'&&e.actions.length))expect(names,entry.name).toContain(entry.name);
  }finally{await client.close();await server.close();}
 });
 it('sends every call with the configured bearer token to the configured origin only',async()=>{
  const seen:{url:string;authorization:string|null}[]=[];
  const {client,server}=await connect(async(input,init)=>{seen.push({url:String(input),authorization:new Headers(init?.headers).get('authorization')});return json(401,{error:{code:'PROFILE_TOKEN_REVOKED'}});});
  try{
   for(const [name,args] of [['products_manage',{action:'listar',resource:'products'}],['profile_settings_manage',{action:'leer'}],['integrations_manage',{action:'listar'}],['employees_manage',{action:'listar'}]] as const){
    const result=await client.callTool({name,arguments:args});expect(result.isError,name).toBe(true);
   }
   expect(seen.length).toBeGreaterThanOrEqual(4);
   for(const call of seen){expect(new URL(call.url).origin).toBe('https://commerce.example.test');expect(call.authorization).toBe('Bearer '+token);}
  }finally{await client.close();await server.close();}
 });
 it('validates each action strictly, maps routes and returns human-action links for secrets',async()=>{
  const seen:{method:string;url:string;body:unknown}[]=[];
  const {client,server}=await connect(async(input,init)=>{seen.push({method:init?.method??'GET',url:new URL(String(input)).pathname+new URL(String(input)).search,body:init?.body?JSON.parse(String(init.body)):undefined});return json(200,{data:{ok:true}});});
  try{
   const text=(r:any)=>JSON.parse(r.content[0].text);
   expect(text(await client.callTool({name:'employees_manage',arguments:{action:'desactivar',userId:'user/1',expectedVersion:3,role:'operator'}}))).toEqual({ok:true});
   expect(seen.at(-1)).toEqual({method:'PATCH',url:'/v2/employees/user%2F1',body:{expectedVersion:3,role:'operator',active:false}});
   expect(text(await client.callTool({name:'integrations_manage',arguments:{action:'desactivar',provider:'meta',expectedRevision:2}}))).toEqual({ok:true});
   expect(seen.at(-1)).toEqual({method:'POST',url:'/v2/integrations/meta/state',body:{expectedRevision:2,enabled:false}});
   const before=seen.length,secret=await client.callTool({name:'integrations_manage',arguments:{action:'guardar',provider:'openai'}});
   expect(secret.isError).toBe(true);expect(text(secret).code).toBe('HUMAN_ACTION_REQUIRED');expect(text(secret).next).toContain('/account/integrations');expect(seen.length).toBe(before);
   const invalid=await client.callTool({name:'employees_manage',arguments:{action:'desactivar',userId:'u',expectedVersion:1,role:'operator',extra:true}});
   expect(invalid.isError).toBe(true);expect(seen.length).toBe(before);
   const switching=await client.callTool({name:'profile_context',arguments:{action:'cambiar'}});expect(text(switching).code).toBe('HUMAN_ACTION_REQUIRED');
   expect(text(await client.callTool({name:'profile_context',arguments:{action:'listar'}}))).toEqual({profiles:[{ok:true}]});
  }finally{await client.close();await server.close();}
 });
});

describe('V7 F3 number tools',()=>{
 it('reads the number journey with the token and sends writes with the operation as idempotency key',async()=>{
  const seen:{method:string;url:string;key:string|null;body:unknown}[]=[];
  const {client,server}=await connect(async(input,init)=>{seen.push({method:String(init?.method??'GET'),url:String(input),key:new Headers(init?.headers).get('idempotency-key'),body:init?.body?JSON.parse(String(init.body)):undefined});return json(200,{data:{ok:true}});});
  try{
   const operationId='11111111-1111-4111-8111-111111111111',numberId='22222222-2222-4222-8222-222222222222';
   await client.callTool({name:'numbers_manage',arguments:{action:'listar'}});
   await client.callTool({name:'numbers_manage',arguments:{action:'crear',operationId,alias:'Ventas MX',country:'MX',phone:'55 1234 5678'}});
   await client.callTool({name:'numbers_manage',arguments:{action:'eliminar',operationId,numberId,expectedVersion:3}});
   await client.callTool({name:'number_connection_manage',arguments:{action:'desconectar',operationId,numberId}});
   expect(seen.map(s=>[s.method,s.url,s.key])).toEqual([
    ['GET','https://commerce.example.test/v1/numbers/overview?environment=REAL',null],
    ['POST','https://commerce.example.test/v1/numbers/quick?environment=REAL','mcp:'+operationId],
    ['POST',`https://commerce.example.test/v1/numbers/${numberId}/removal?environment=REAL`,'mcp:'+operationId],
    ['POST',`https://commerce.example.test/v1/numbers/${numberId}/link?environment=REAL`,'mcp:'+operationId]]);
   expect(seen[2]!.body).toEqual({expected_version:3,confirmation:'REMOVE_NUMBER'});
   expect(seen[3]!.body).toEqual({action:'unlink'});
  }finally{await client.close();await server.close();}
 });
 it('never returns QR material: connecting is a human action in the application',async()=>{
  let calls=0;
  const {client,server}=await connect(async()=>{calls++;return json(200,{data:{}});});
  try{
   const result=await client.callTool({name:'number_connection_manage',arguments:{action:'conectar',numberId:'22222222-2222-4222-8222-222222222222'}});
   expect(JSON.stringify(result)).toContain('HUMAN_ACTION_REQUIRED');expect(JSON.stringify(result)).toContain('/numbers');expect(calls).toBe(0);
  }finally{await client.close();await server.close();}
 });
});
