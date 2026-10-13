import {describe,expect,it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {mcpRegistry} from '../../../packages/contracts/src/mcp-registry.js';
import {createPlatformMcp} from './platform-server.js';

const token='cos_plt_'+'p'.repeat(43);
async function connect(fetcher:typeof fetch){
 const server=createPlatformMcp('https://commerce.example.test',token,fetcher),client=new Client({name:'v7-platform-test',version:'1.0.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);return{client,server};
}
describe('V7 platform MCP server',()=>{
 it('requires a platform token, never a profile token',()=>{
  expect(()=>createPlatformMcp('https://commerce.example.test','cos_pat_'+'a'.repeat(43))).toThrow('MCP_PLATFORM_TOKEN_REQUIRED');
 });
 it('lists only platform registry tools with their implemented actions',async()=>{
  const {client,server}=await connect(async()=>new Response('{}',{status:500}));
  try{
   const {tools}=await client.listTools();
   for(const tool of tools){const entry=mcpRegistry.find(e=>e.name===tool.name);expect(entry?.audience,tool.name).toBe('platform');
    expect([...((tool.inputSchema as any).properties.action.enum as string[])].sort()).toEqual([...entry!.actions].sort());}
   expect(tools.map(t=>t.name).sort()).toEqual(['admin_capacity_manage','admin_profiles_manage']);
  }finally{await client.close();await server.close();}
 });
 it('maps closed actions to platform routes with the bound bearer only',async()=>{
  const seen:{method:string;url:string;auth:string|null;body:unknown}[]=[];
  const {client,server}=await connect(async(input,init)=>{seen.push({method:init?.method??'GET',url:new URL(String(input)).pathname,auth:new Headers(init?.headers).get('authorization'),body:init?.body?JSON.parse(String(init.body)):undefined});
   return new Response(JSON.stringify({data:{ok:true}}),{status:200,headers:{'content-type':'application/json'}});});
  try{
   const operationId=crypto.randomUUID();
   await client.callTool({name:'admin_profiles_manage',arguments:{action:'suspender',profileId:'p/1',operationId,expectedVersion:2}});
   expect(seen.at(-1)).toEqual({method:'PATCH',url:'/v2/platform/profiles/p%2F1',auth:'Bearer '+token,body:{operationId,expectedVersion:2,state:'SUSPENDED'}});
   await client.callTool({name:'admin_capacity_manage',arguments:{action:'leer'}});expect(seen.at(-1)?.url).toBe('/v2/platform/capacity');
   const bad=await client.callTool({name:'admin_profiles_manage',arguments:{action:'limites',profileId:'p',operationId,expectedVersion:1,limits:{numbers:21,products:1,dailyConversations:1}}});
   expect(bad.isError).toBe(true);expect(seen).toHaveLength(2);
  }finally{await client.close();await server.close();}
 });
});
