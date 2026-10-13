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
   for(const [name,args] of [['products_manage',{action:'listar'}],['profile_settings_manage',{action:'leer'}],['integrations_manage',{action:'listar'}],['employees_manage',{action:'listar'}]] as const){
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
 it('pauses warm-up through the human command on the current QR grant, never a raw state write',async()=>{
  const numberId='33333333-3333-4333-8333-333333333333',grantId='44444444-4444-4444-8444-444444444444',operationId='55555555-5555-4555-8555-555555555555';
  const grant={id:grantId,workspaceId:'w1',environment:'REAL',accountId:numberId,source:{kind:'VERIFIED_QR_CONNECTION',connectionId:'66666666-6666-4666-8666-666666666666',identityFingerprint:'a'.repeat(64)},
   createdBy:'channel',createdAt:'2026-10-13T06:00:00.000Z',version:1,humanPaused:false,revokedAt:null,protections:[]};
  const seen:{method:string;url:string;body:unknown}[]=[];
  const {client,server}=await connect(async(input,init)=>{const url=String(input);seen.push({method:String(init?.method??'GET'),url,body:init?.body?JSON.parse(String(init.body)):undefined});
   return url.includes('/commands')?json(200,{data:{...grant,version:2,humanPaused:true}}):json(200,{data:[grant],nextAfterId:null});});
  try{
   const result=await client.callTool({name:'warmup_manage',arguments:{action:'pausar',operationId,numberId}});
   expect(JSON.stringify(result)).not.toContain('UNCONFIRMED');
   expect(seen.map(s=>[s.method,s.url.replace(/\?.*$/,'')])).toEqual([['GET','https://commerce.example.test/v2/continuity/warmup'],['POST',`https://commerce.example.test/v2/continuity/warmup/${grantId}/commands`]]);
   expect(seen[1]!.body).toEqual({environment:'REAL',operationId,expectedVersion:1,action:'pause'});
  }finally{await client.close();await server.close();}
 });
 it('creates products and saves variant sections with the operation UUID as Idempotency-Key',async()=>{
  const seen:{method:string;url:string;key:string|null;body:unknown}[]=[],operationId='77777777-7777-4777-8777-777777777777',variantId='88888888-8888-4888-8888-888888888888';
  const {client,server}=await connect(async(input,init)=>{seen.push({method:String(init?.method??'GET'),url:String(input),key:new Headers(init?.headers).get('idempotency-key'),body:init?.body?JSON.parse(String(init.body)):undefined});return json(200,{data:{id:variantId,version:2}});});
  try{
   const locale={market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
   for(const [name,args] of [['products_manage',{action:'crear',operationId,name:'Curso',variant:{name:'México',locale}}],
    ['offers_manage',{action:'guardar',operationId,variantId,expectedVersion:1,value:{name:'Curso',price_minor:9700,tiers:[],fulfillment:[],billing_delay_seconds:1800,positive_payment_unlocks_all:false,legacy:{}}}],
    ['sellers_manage',{action:'leer',variantId}],['variants_manage',{action:'publicar',operationId,variantId,expectedVersion:2,documentSha256:'a'.repeat(64)}],
    ['materials_manage',{action:'iniciar_subida',operationId,kind:'link',name:'Portal',link:'https://example.com/p'}]] as const){
    const result=await client.callTool({name,arguments:args as unknown as Record<string,unknown>});expect(JSON.stringify(result),name).not.toContain('UNCONFIRMED');
   }
   expect(seen.map(s=>[s.method,s.url.replace('https://commerce.example.test',''),s.key])).toEqual([
    ['POST','/v2/products',operationId],['PUT',`/v2/variants/${variantId}/offer`,operationId],['GET',`/v2/variants/${variantId}/seller`,null],
    ['POST',`/v2/variants/${variantId}/publish`,operationId],['POST','/v2/materials',operationId]]);
   expect(seen[0]!.body).toEqual({name:'Curso',variant:{name:'México',locale}});
   expect(seen[3]!.body).toEqual({expected_version:2,document_sha256:'a'.repeat(64)});
   expect(seen[4]!.body).toEqual({kind:'link',name:'Portal',url:'https://example.com/p'});
  }finally{await client.close();await server.close();}
 });
 it('leaves selling a variant in a number to the human, but lets an agent stop it',async()=>{
  const seen:string[]=[],variantId='88888888-8888-4888-8888-888888888888',numberId='99999999-9999-4999-8999-999999999999',operationId='77777777-7777-4777-8777-777777777777';
  const {client,server}=await connect(async(input,init)=>{seen.push(String(init?.method??'GET')+' '+String(input));return json(200,{data:{sells:false}});});
  try{
   const assign=await client.callTool({name:'number_assignments_manage',arguments:{action:'asignar',variantId,numberId}});
   expect(JSON.stringify(assign)).toContain('HUMAN_ACTION_REQUIRED');expect(seen).toEqual([]);
   await client.callTool({name:'number_assignments_manage',arguments:{action:'retirar',operationId,variantId,numberId}});
   expect(seen).toEqual([`POST https://commerce.example.test/v2/variants/${variantId}/numbers?`.replace('?','')]);
  }finally{await client.close();await server.close();}
 });
 it('works the receipt queue: lists, reads, decides with the operation as key and keeps the file in the app',async()=>{
  const seen:{method:string;url:string;key:string|null;body:unknown}[]=[],receiptId='66666666-6666-4666-8666-666666666666',operationId='77777777-7777-4777-8777-777777777777';
  const {client,server}=await connect(async(input,init)=>{seen.push({method:String(init?.method??'GET'),url:String(input).replace('https://commerce.example.test',''),key:new Headers(init?.headers).get('idempotency-key'),body:init?.body?JSON.parse(String(init.body)):undefined});
   return json(init?.method==='POST'?202:200,{data:{id:receiptId,has_document:true,mime_type:'image/png',rows:[],command_id:operationId}});});
  try{
   await client.callTool({name:'receipts_manage',arguments:{action:'listar',view:'pending'}});
   await client.callTool({name:'receipts_manage',arguments:{action:'leer',receiptId}});
   const file=await client.callTool({name:'receipts_manage',arguments:{action:'archivo',receiptId}});
   expect(file.structuredContent).toEqual({data:{available:true,mime_type:'image/png',open_in_app:'/sales/receipts?receipt='+receiptId}});
   await client.callTool({name:'receipts_manage',arguments:{action:'revisar',operationId,receiptId,decision:'APPROVED',expectedVersion:3}});
   expect(seen.map(x=>[x.method,x.url,x.key])).toEqual([['GET','/v2/receipts?view=pending',null],['GET',`/v2/receipts/${receiptId}`,null],['GET',`/v2/receipts/${receiptId}`,null],['POST',`/v2/receipts/${receiptId}/decision`,operationId]]);
   expect(seen[3]!.body).toEqual({decision:'APPROVED',expected_version:3});
  }finally{await client.close();await server.close();}
 });
 it('works conversations and orders with the application routes; an unconfirmed reply is read back, never resent (RF-15.a)',async()=>{
  const seen:{method:string;url:string;key:string|null;auth:string|null;body:unknown}[]=[],conversationId='88888888-8888-4888-8888-888888888888',operationId='99999999-9999-4999-8999-999999999999',now='2026-10-13T12:00:00.000Z';
  const row={id:conversationId,version:4,environment:'REAL',created_at:now,updated_at:now};
  const command={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',workspace_id:'ws-1',environment:'REAL',kind:'conversation_command',resource_id:conversationId,actor_id:'u-1',idempotency_key:operationId,status:'APPLIED',payload:{},result:{},created_at:now,updated_at:now};
  let replies=0;
  const {client,server}=await connect(async(input,init)=>{const url=String(input).replace('https://commerce.example.test',''),method=String(init?.method??'GET');seen.push({method,url,key:new Headers(init?.headers).get('idempotency-key'),auth:new Headers(init?.headers).get('authorization'),body:init?.body?JSON.parse(String(init.body)):undefined});
   if(url.startsWith('/v1/conversations?')||url.startsWith('/v1/orders?'))return json(200,{data:[row],meta:{total:1}});
   if(url.startsWith('/v1/conversations/'+conversationId+'?'))return json(200,{data:{...row,messages:[]}});
   if(url.endsWith('/commands')&&replies++===0)return new Response('',{status:502});
   if(url.endsWith('/controls'))return json(202,{data:{command_id:command.id,workspace_id:'ws-1',environment:'REAL',scope_type:'conversation',scope_id:conversationId,paused:false,takeover:true,suppressed:false,version:2}});
   if(url.startsWith('/v1/sales-operations/'))return json(200,{data:{key:operationId,operation:'conversation.command',resource_id:conversationId,command}});
   return json(500,{});});
  try{
   const list=await client.callTool({name:'conversations_manage',arguments:{action:'listar',q:'Ana'}});expect(list.isError).toBeFalsy();
   await client.callTool({name:'conversations_manage',arguments:{action:'leer',conversationId}});
   await client.callTool({name:'orders_manage',arguments:{action:'listar'}});
   const reply=await client.callTool({name:'conversations_manage',arguments:{action:'responder',operationId,conversationId,text:'Hola',expectedVersion:4}});
   expect(reply.isError).toBeFalsy();expect(JSON.stringify(reply.structuredContent)).toContain('read_back');
   const take=await client.callTool({name:'conversations_manage',arguments:{action:'tomar_control',operationId,conversationId,reason:'La atiendo yo'}});expect(take.isError).toBeFalsy();
   expect(seen.map(x=>x.method+' '+x.url.split('?')[0])).toEqual(['GET /v1/conversations','GET /v1/conversations/'+conversationId,'GET /v1/orders','POST /v1/conversations/'+conversationId+'/commands','GET /v1/sales-operations/'+operationId,'POST /v1/conversations/'+conversationId+'/controls']);
   expect(seen[0]!.url).toContain('q=Ana');expect(seen[0]!.url).toContain('environment=REAL');
   expect(seen.every(x=>x.auth==='Bearer '+token)).toBe(true);
   expect(seen.filter(x=>x.method==='POST').map(x=>x.key)).toEqual([operationId,operationId]);
   expect(seen.filter(x=>x.url.endsWith('/commands'))).toHaveLength(1);
   expect(seen[3]!.body).toEqual({type:'send_message',kind:'text',text:'Hola',expected_version:4,environment:'REAL'});
   expect(seen[5]!.body).toEqual({takeover:true,reason:'La atiendo yo',environment:'REAL'});
  }finally{await client.close();await server.close();}
 });
 it('reads help, campaigns and follow-up results with the same routes as the application (RF-16.d, RF-11, RF-10.e)',async()=>{
  const seen:string[]=[],variantId='55555555-5555-4555-8555-555555555555';
  const {client,server}=await connect(async(input,init)=>{const url=String(input).replace('https://commerce.example.test','');seen.push(String(init?.method??'GET')+' '+url);
   return json(200,{data:url.startsWith('/v2/campaigns')?{connected:true,accounts:[{id:'act_1'}],report:{summary:{spend_minor:2000},quality:{status:'OK'},groups:{campaigns:[{name:'C'}],ads:[]}}}:url.startsWith('/v2/help')?{version:'x',sections:[]}:{entered:1}});});
  try{
   const guide=await client.callTool({name:'help_read',arguments:{action:'guia',section:'empezar'}});expect(guide.isError).toBeFalsy();
   const md=await client.callTool({name:'help_read',arguments:{action:'descargar'}});expect(JSON.stringify(md.structuredContent)).toContain('Empieza a vender');
   const camp=await client.callTool({name:'campaigns_read',arguments:{action:'campanas',from:'2026-10-01',to:'2026-10-12'}});expect(JSON.stringify(camp.structuredContent)).toContain('"name":"C"');
   await client.callTool({name:'remarketing_manage',arguments:{action:'resultados',variantId,from:'2026-10-01',to:'2026-10-12'}});
   const sync=await client.callTool({name:'campaigns_read',arguments:{action:'sincronizar_lectura',operationId:'66666666-6666-4666-8666-666666666666'}});expect(sync.isError).toBeFalsy();
   expect(seen).toEqual(['GET /v2/help?section=empezar','GET /v2/campaigns?from=2026-10-01&to=2026-10-12',`GET /v2/variants/${variantId}/remarketing/results?from=2026-10-01&to=2026-10-12`,'POST /v2/campaigns/sync']);
  }finally{await client.close();await server.close();}
 });
 it('tests a number by task: estimate first, start with the accepted ceiling, then queued actions (MCP-EMU)',async()=>{
  const seen:{method:string;url:string;key:string|null;body:unknown}[]=[],accountId='88888888-8888-4888-8888-888888888888',runId='99999999-9999-4999-8999-999999999999',operationId='77777777-7777-4777-8777-777777777777';
  const {client,server}=await connect(async(input,init)=>{seen.push({method:String(init?.method??'GET'),url:String(input).replace('https://commerce.example.test',''),key:new Headers(init?.headers).get('idempotency-key'),body:init?.body?JSON.parse(String(init.body)):undefined});
   return json(200,{data:{maximum_microusd:51200,run:{account_id:accountId,run_id:runId,version:2}}});});
  try{
   const estimate=await client.callTool({name:'number_test_manage',arguments:{action:'estimar',accountId}});
   expect(JSON.stringify(estimate.structuredContent)).toContain('51200');
   await client.callTool({name:'number_test_manage',arguments:{action:'crear',operationId,accountId,acceptedMaximumMicrousd:51200}});
   await client.callTool({name:'number_test_manage',arguments:{action:'mensaje',operationId,runId,expectedVersion:1,text:'Hola'}});
   await client.callTool({name:'number_test_manage',arguments:{action:'avanzar_reloj',operationId,runId,expectedVersion:2,hours:8}});
   await client.callTool({name:'number_test_manage',arguments:{action:'continuar',operationId,runId,expectedVersion:3}});
   await client.callTool({name:'number_test_manage',arguments:{action:'leer',runId}});
   await client.callTool({name:'number_test_manage',arguments:{action:'ultima',accountId}});
   const bad=await client.callTool({name:'number_test_manage',arguments:{action:'avanzar_reloj',operationId,runId,expectedVersion:2,hours:5}});
   expect(bad.isError).toBe(true);
   expect(seen.map(x=>[x.method,x.url])).toEqual([['POST','/v2/number-tests/estimate'],['POST','/v2/number-tests'],['POST',`/v2/number-tests/${runId}/actions`],['POST',`/v2/number-tests/${runId}/actions`],
    ['POST',`/v2/number-tests/${runId}/actions`],['GET',`/v2/number-tests/${runId}`],['GET',`/v2/number-tests/latest?account_id=${accountId}`]]);
   expect(seen[1]).toMatchObject({key:operationId,body:{account_id:accountId,mode:'CHAT',accepted_maximum_microusd:51200}});
   expect(seen.slice(2,5).map(x=>x.body)).toEqual([{expected_version:1,action:{type:'message',text:'Hola'}},{expected_version:2,action:{type:'advance',hours:8}},{expected_version:3,action:{type:'continue'}}]);
  }finally{await client.close();await server.close();}
 });
});
