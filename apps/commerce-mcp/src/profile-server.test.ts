import {describe,expect,it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createProfileMcp} from './profile-server.js';

const token='cos_pat_'+'a'.repeat(43);
async function connect(fetcher:typeof fetch){
 const server=createProfileMcp('https://commerce.example.test',token,fetcher),client=new Client({name:'v7-test',version:'1.0.0'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);return{client,server};
}
describe('composed V7 profile MCP server',()=>{
 it('rejects a missing origin or a non personal token before registering tools',()=>{
  expect(()=>createProfileMcp('commerce.example.test',token)).toThrow('MCP_CONFIGURATION_REQUIRED');
  expect(()=>createProfileMcp('https://commerce.example.test','service-token-value-123456')).toThrow('MCP_PROFILE_TOKEN_REQUIRED');
 });
 it('lists one coherent registry within the 40-tool budget and no profile/token inputs',async()=>{
  const {client,server}=await connect(async()=>new Response('{}',{status:500}));
  try{
   const {tools}=await client.listTools(),names=tools.map(t=>t.name);
   expect(new Set(names).size).toBe(names.length);expect(names.length).toBeGreaterThan(10);expect(names.length).toBeLessThanOrEqual(40);
   for(const prefix of ['profile_catalog_','profile_continuity_','payments_','results_'])expect(names.some(n=>n.startsWith(prefix))).toBe(true);
   for(const tool of tools){const properties=Object.keys((tool.inputSchema as {properties?:Record<string,unknown>}).properties??{});for(const forbidden of ['workspaceId','workspace_id','token','origin'])expect(properties,tool.name).not.toContain(forbidden);}
  }finally{await client.close();await server.close();}
 });
 it('sends every call with the configured bearer token to the configured origin only',async()=>{
  const seen:{url:string;authorization:string|null}[]=[];
  const {client,server}=await connect(async(input,init)=>{seen.push({url:String(input),authorization:new Headers(init?.headers).get('authorization')});return new Response(JSON.stringify({error:{code:'PROFILE_TOKEN_REVOKED'}}),{status:401,headers:{'content-type':'application/json'}});});
  try{
   const result=await client.callTool({name:'profile_catalog_list',arguments:{resource:'products'}});
   expect(result.isError).toBe(true);expect(seen.length).toBeGreaterThan(0);
   for(const call of seen){expect(new URL(call.url).origin).toBe('https://commerce.example.test');expect(call.authorization).toBe('Bearer '+token);}
  }finally{await client.close();await server.close();}
 });
});
