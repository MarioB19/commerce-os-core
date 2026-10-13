import {afterAll,beforeAll,expect,it} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createServer,type Server} from 'node:https';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {mcpRegistry} from '../../packages/contracts/src/mcp-registry.js';
import {profileScopes} from '../../packages/contracts/src/profiles.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 F8 (RF-15.a/b/d, Inventario y paridad V7 §3): the real MCP SDK client over
// the registered STDIO entrypoint and verified local HTTPS, with one personal
// token. Only the composed registry is offered; the retired service-token
// server no longer starts. Nothing is sent to WhatsApp or an AI provider.
const profile='mcp-stdio-'+randomUUID();
let app:Awaited<ReturnType<typeof createApp>>,server:Server,directory:string,cert:string,origin:string;
beforeAll(async()=>{
 await fixtureProfiles({id:profile,numbers:2});app=await createApp();await app.ready();
 directory=await mkdtemp(join(tmpdir(),'commerce-v7-mcp-'));cert=join(directory,'cert.pem');const key=join(directory,'key.pem');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>app.routing(req,res));
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));origin=`https://127.0.0.1:${(server.address() as {port:number}).port}`;
});
afterAll(async()=>{server?.closeAllConnections();await new Promise<void>(done=>server?server.close(()=>done()):done());await app?.close();await rm(directory,{recursive:true,force:true});await pool.end();});
async function owner(){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Dueña MCP',email,password,workspace_id:profile,role:'owner'});
 return (await pool.query('SELECT id FROM "user" WHERE email=$1',[email])).rows[0].id as string;
}
async function personalToken(user:string){
 const secret='cos_pat_'+randomBytes(32).toString('base64url');
 await pool.query(`INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,profile_scopes,expires_at)
  VALUES($1,$2,$3,'MCP STDIO sintético',$4,'["REAL"]',$5,clock_timestamp()+interval '1 hour')`,[randomUUID(),profile,user,createHash('sha256').update(secret).digest('hex'),JSON.stringify(profileScopes.filter(s=>s!=='profiles:switch'))]);
 return secret;
}
const entry=resolve('apps/commerce-mcp/src/index.ts');
it('serves only the composed V7 registry over STDIO and HTTPS with a personal token',async()=>{
 const tokenFile=join(directory,'profile-token');await writeFile(tokenFile,await personalToken(await owner()),{mode:0o600});
 const client=new Client({name:'Commerce V7 STDIO integration client',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',entry],env:{PATH:process.env.PATH!,NODE_EXTRA_CA_CERTS:cert,COMMERCE_API_ORIGIN:origin,COMMERCE_MCP_TOKEN_FILE:tokenFile},stderr:'pipe'});
 try{
  await client.connect(transport);
  const {tools}=await client.listTools(),names=tools.map(t=>t.name).sort();
  expect(names).toEqual(mcpRegistry.filter(e=>e.audience==='profile'&&e.actions.length).map(e=>e.name).sort());
  expect(names.length).toBeLessThanOrEqual(40);
  for(const retired of ['intelligence_search','catalog_list','number_program_command','simulation_run','assistant_propose'])expect(names).not.toContain(retired);
  const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args});expect(r.isError,JSON.stringify(r.content)).not.toBe(true);return r.structuredContent as Record<string,unknown>;};
  const created=await call('products_manage',{action:'crear',operationId:randomUUID(),name:'Curso por MCP',variant:{name:'México',locale:{market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'}}});
  expect(JSON.stringify(created)).toContain('Curso por MCP');
  expect(JSON.stringify(await call('products_manage',{action:'listar'}))).toContain('Curso por MCP');
  await call('home_get',{action:'resumen'});
  expect(await call('conversations_manage',{action:'listar'})).toMatchObject({data:[],meta:{total:0}});
  expect(await call('orders_manage',{action:'listar'})).toMatchObject({data:[],meta:{total:0}});
  const help=await call('help_read',{action:'guia'});expect(JSON.stringify(help)).toContain('Empieza a vender');
  // The token fixes the profile: no tool accepts another one.
  const foreign=await client.callTool({name:'products_manage',arguments:{action:'listar',workspaceId:'other'}});expect(foreign.isError).toBe(true);
 }finally{await client.close();await transport.close();}
},180000);
it('refuses a historical service token before registering any tool',async()=>{
 const tokenFile=join(directory,'service-token');await writeFile(tokenFile,'cos_v5_'+randomBytes(32).toString('base64url'),{mode:0o600});
 const run=spawnSync(process.execPath,['--import','tsx',entry],{env:{PATH:process.env.PATH!,COMMERCE_API_ORIGIN:origin,COMMERCE_MCP_TOKEN_FILE:tokenFile},input:'',encoding:'utf8',timeout:60000});
 expect(run.status).toBe(1);expect(run.stderr.trim()).toBe('MCP_PROFILE_TOKEN_REQUIRED');
},90000);
