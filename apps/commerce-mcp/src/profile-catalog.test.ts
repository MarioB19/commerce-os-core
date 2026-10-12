import {describe,it,expect,vi} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createProfileCatalogMcp} from './profile-catalog.js';
import {ProfileCatalogError,type ProfileCatalogReader} from '../../../packages/commerce-client/src/profile-catalog.js';
const id='10000000-0000-4000-8000-000000000001';
async function fixture(work:(client:Client,reader:ReturnType<typeof vi.fn<ProfileCatalogReader>>)=>Promise<void>){
 const reader=vi.fn<ProfileCatalogReader>().mockResolvedValue({data:[],hasMore:false}),server=createProfileCatalogMcp(reader);
 const client=new Client({name:'synthetic-profile-reader',version:'1'}),[ct,st]=InMemoryTransport.createLinkedPair();
 await server.connect(st);await client.connect(ct);try{await work(client,reader);}finally{await client.close();await server.close();}
}
describe('profile catalog MCP protocol',()=>{
 it('exposes exactly three read-only tools',()=>fixture(async client=>{const result=await client.listTools();expect(result.tools.map(x=>x.name)).toEqual(['profile_catalog_list','profile_catalog_get','profile_catalog_versions']);for(const tool of result.tools)expect(tool.annotations).toMatchObject({readOnlyHint:true,destructiveHint:false,openWorldHint:false});}));
 it.each(['workspaceId','profile_id','token','authorization','route'])('rejects extra authority or path argument %s before HTTP',key=>fixture(async(client,read)=>{const result=await client.callTool({name:'profile_catalog_list',arguments:{resource:'products',[key]:'foreign'}});expect(result.isError).toBe(true);expect(read).not.toHaveBeenCalled();}));
 it('preserves closed filters, detail identity and history cursor through SDK',()=>fixture(async(client,read)=>{
  for(const [name,args]of [['profile_catalog_list',{resource:'offers',q:'two markets',limit:10,offset:20,environment:'SIMULATION'}],['profile_catalog_get',{resource:'products',id}],['profile_catalog_versions',{resource:'flows',id,before:3}]]as const){const result=await client.callTool({name,arguments:args});expect(result.structuredContent).toEqual({data:[],hasMore:false});}
  expect(read.mock.calls.map(x=>x[0])).toEqual([{operation:'list',resource:'offers',q:'two markets',limit:10,offset:20,include_archived:'false',environment:'SIMULATION'},{operation:'get',resource:'products',id,environment:'REAL'},{operation:'versions',resource:'flows',id,before:3,limit:50,environment:'REAL'}]);
 }));
 it('uses one call after transport failure and never reflects credentials or private messages',()=>fixture(async(client,read)=>{read.mockRejectedValue(Error('private bearer and account info'));const result=await client.callTool({name:'profile_catalog_get',arguments:{resource:'products',id}});expect(result.isError).toBe(true);expect(read).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain('private bearer');expect(JSON.stringify(result)).toContain('CATALOG_READ_UNCONFIRMED');}));
 it('keeps authorization rejection distinct without returning the API body',()=>fixture(async(client,read)=>{read.mockRejectedValue(new ProfileCatalogError('CATALOG_REQUEST_REJECTED',403));expect(JSON.stringify(await client.callTool({name:'profile_catalog_list',arguments:{resource:'products'}}))).toContain('CATALOG_REQUEST_REJECTED');expect(read).toHaveBeenCalledTimes(1);}));
 it('preserves the existing MCP secret and temporary access redaction',()=>fixture(async(client,read)=>{
  read.mockResolvedValue({data:[{id,version:1,environment:'REAL',created_at:'2026-10-12T00:00:00Z',updated_at:'2026-10-12T00:00:00Z',name:'Public name',api_key:'synthetic secret',nested:{token:'synthetic token',signed_url:'https://example.invalid/?token=private'},reference:'https://example.invalid/file?signature=private'}],hasMore:false});
  const result=await client.callTool({name:'profile_catalog_get',arguments:{resource:'products',id}}),text=JSON.stringify(result);
  expect(text).toContain('Public name');expect(text).not.toMatch(/synthetic secret|synthetic token|signature=private|signed_url|api_key/);
 }));
});
