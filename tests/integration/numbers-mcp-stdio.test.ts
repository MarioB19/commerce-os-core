import {it,expect,afterAll} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createServer} from 'node:https';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {processWarmup} from '../../apps/automation-worker/src/warmup.js';
import {dispatchOutbox} from '../../apps/channel-worker/src/dispatch.js';
import {processInbound} from '../../apps/automation-worker/src/inbound.js';
import {processChannelCommands,heartbeatOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {numberTools} from '../../apps/commerce-mcp/src/numbers.js';
import {apiFailureDiagnostic,createRollingRequestBudget} from '../support/request-budget.js';
import {evidencePath} from '../support/evidence.js';
afterAll(()=>pool.end());
it('uses the registered STDIO server over verified local HTTPS and persists the same API resources',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'commerce-mcp-test-')),workspace='stdio-'+randomUUID();
 const reserveRequest=createRollingRequestBudget(),apiFailures:ReturnType<typeof apiFailureDiagnostic>[]=[];
 const app=await createApp(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
 app.addHook('onError',async(req,_reply,error)=>{if(req.method==='POST'&&req.routeOptions.url==='/v1/number-groups/refresh'){apiFailures.push(apiFailureDiagnostic(error,pool));if(apiFailures.length>8)apiFailures.shift();}});
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'MCP isolated operator',email,password,workspace_id:workspace,role:'owner'});
 await reserveRequest();const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});
 const cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 const direct=async(method:any,url:string,body?:any)=>{await reserveRequest();return app.inject({method,url,payload:body,headers:{cookie,origin,'idempotency-key':randomUUID()}});};
 const token=await direct('POST','/v1/service-tokens',{environment:'SIMULATION',name:'Explicit test-only MCP',allowed_environments:['SIMULATION'],scopes:['channels:read','channels:manage','channels:capacity','warmup:read','warmup:manage','warmup:activate','warmup:simulate'],expires_at:new Date(Date.now()+3600000).toISOString()});expect(token.statusCode).toBe(201);
 const cert=join(directory,'cert.pem'),key=join(directory,'key.pem'),tokenFile=join(directory,'token');
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{stdio:'ignore'});
 await writeFile(tokenFile,token.json().data.token,{mode:0o600});await app.ready();
 const server=createServer({key:await readFile(key),cert:await readFile(cert)},(req,res)=>app.routing(req,res));
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address() as {port:number};
 const client=new Client({name:'Commerce isolated STDIO integration client',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx',resolve('apps/commerce-mcp/src/index.ts')],env:{PATH:process.env.PATH!,NODE_EXTRA_CA_CERTS:cert,COMMERCE_API_ORIGIN:`https://127.0.0.1:${address.port}`,COMMERCE_MCP_TOKEN_FILE:tokenFile},stderr:'pipe'});
 const heartbeat=setInterval(()=>{void heartbeatOwnership().catch(()=>{});},10000);
 const seen=new Set<string>();
 const tool=async(name:string,args:any={})=>{await reserveRequest(name==='numbers_batch'?(args.items?.length??0)+1:1);const r=await client.callTool({name,arguments:{environment:'SIMULATION',idempotency_key:randomUUID(),...args}});const body=JSON.parse((r.content as any)[0].text);expect(r.isError,JSON.stringify({result:body,api_failures:apiFailures})).not.toBe(true);seen.add(name);return body;};
 try{
  await client.connect(transport);const listed=await client.listTools();for(const name of Object.keys(numberTools))expect(listed.tools.some(t=>t.name===name),name).toBe(true);
  const initial=await tool('number_policy_get');expect(initial.data).toMatchObject({version:'standard-15d/v2',manual_days:0,automatic_days:14,completion_day:15,manual_checklist_required:false});
  const at=new Date(Date.now()-20*86400000);at.setUTCHours(10,0,0,0);let clock=(await tool('number_simulation_clock',{body:{action:'create',at:at.toISOString()}})).data;
  const ids:string[]=[];
  for(let n=0;n<2;n++){
   const args={body:{alias:'MCP propio '+n,responsible:'Operador de ensayo',device_ref:'Dispositivo MCP '+n},idempotency_key:randomUUID()};
   const created=(await tool('number_create',args)).data;expect((await tool('number_create',args)).data).toEqual(created);ids.push(created.id);await processNumberOperations();
   expect((await tool('number_operation_get',{operation_id:created.operation_id})).data.state).toBe('SUCCEEDED');
   let a=(await tool('number_get',{account_id:created.id})).data;
   await tool('number_identity_observe',{account_id:a.id,expected_version:a.version});await processNumberOperations();a=(await tool('number_get',{account_id:a.id})).data;
   await tool('number_identity_confirm',{account_id:a.id,expected_version:a.version,ownership_confirmed:true,name:a.alias,about:'Declaración sintética de propiedad'});a=(await tool('number_get',{account_id:a.id})).data;
   await tool('channel_command',{account_id:a.id,expected_version:a.version,type:'connect',reason:'Conectar sólo simulador aislado'});
  }
  await processChannelCommands(20);
  for(const id of ids){const session=(await tool('channel_session_get',{account_id:id})).data;await tool('channel_session_configure',{account_id:id,expected_version:session.revision,body:{operational_pause:false,reason:'Explicit isolated simulation transport'}});}
  for(const id of ids){const a=(await tool('number_get',{account_id:id})).data;await tool('number_identity_observe',{account_id:id,expected_version:a.version});}await processNumberOperations();
  await tool('number_simulation_group',{body:{name:'Grupo MCP propio',account_ids:ids}});await tool('number_groups_refresh',{account_ids:ids});await processNumberOperations();const groups=(await tool('number_groups_list')).data;
  const drafts=(await tool('number_library_seed')).data.drafts,contentIds=[];
  for(const d of drafts)contentIds.push((await tool('number_library_approve',{content_id:d.id,expected_version:d.version,confirmation:'APPROVE_OWN_TEST_CONTENT'})).data.approved_content_id);
  let program=(await tool('number_program_create',{body:{name:'Preparación MCP de prueba',topology:'group',group_id:groups[0].id,account_ids:ids,content_ids:contentIds,profile:{name:'Estándar quince días',timezone:'UTC',start_hour:0,end_hour:23},expires_at:new Date(at.getTime()+40*86400000).toISOString()}})).data;
  expect((await tool('number_program_preview',{program_id:program.id})).data.ready).toBe(true);
  const command=async(action:string,extra:any={})=>{program=(await tool('number_program_command',{program_id:program.id,body:{action,expected_version:program.version,reason:'Ensayo aislado de '+action,...extra}})).data;return program;};
  await command('review');await command('authorize',{review:program.review,confirmation:'AUTHORIZE_REVIEWED_PROGRAM'});await command('activate',{review:program.review,confirmation:'ACTIVATE_REVIEWED_PROGRAM'});
  const automatic=(await tool('number_preparation_get',{account_id:ids[0]})).data;expect(automatic).toMatchObject({policy_version:'standard-15d/v2',declarations:[],progress:{day:1,automatic_days:0,required_automatic_days:14,manual:null}});
  const readback=await direct('GET','/v1/number-programs/'+program.id+'?environment=SIMULATION');expect(readback.json().data.status).toBe('ACTIVE');
  await command('pause');await command('resume');
  // Advance the calendar through the real API, planner, outbox and receiving adapter. No delivery/progress inserts.
  let graduated:any=null;
  for(let step=0;step<780;step++){
   // Active warm-up programs deliberately cap virtual advances at 30 minutes.
   clock=(await tool('number_simulation_clock',{body:{action:'advance',seconds:1800,expected_version:clock.version}})).data;
   const current=(await tool('numbers_list',{limit:100})).data;
   const batch=await tool('numbers_batch',{items:current.filter((a:any)=>ids.includes(a.id)).map((a:any)=>({key:a.id,action:'observe-identity',id:a.id,body:{expected_version:a.version}}))});expect(batch.data.every((r:any)=>r.status===202),JSON.stringify(batch.data)).toBe(true);await processNumberOperations();
   await tool('number_groups_refresh',{account_ids:ids});await processNumberOperations();await heartbeatOwnership();await processWarmup();
   for(let pass=0;pass<4;pass++){await dispatchOutbox(100);await processInbound(100);}
   if(step%48===0||step>720){graduated=(await tool('number_preparation_get',{account_id:ids[0]})).data;if(step%96===0)console.info('MCP calendar',JSON.stringify({step,day:graduated.progress.day,automatic_days:graduated.progress.automatic_days,reason:graduated.progress.reason}));if(graduated.progress.completed)break;}
  }
  expect(graduated.progress).toMatchObject({completed:true,automatic_days:14,day:15,stable:true,manual:null});expect(graduated.declarations).toEqual([]);expect(graduated.progress.mature_samples).toBeGreaterThanOrEqual(20);
  const readyNumber=(await tool('number_get',{account_id:ids[0]})).data;expect(readyNumber.primary_state).toBe('PREPARED');expect(readyNumber.sales_readiness).toEqual([]);
  const finished=(await tool('number_program_get',{program_id:program.id})).data;expect(finished.status).toBe('COMPLETED');
  expect((await tool('number_program_evidence',{program_id:program.id})).evidence.totals.some((r:any)=>r.status==='DELIVERED')).toBe(true);
  // Maintenance is a separately authorized program; completed preparation remains unchanged.
  program=(await tool('number_program_create',{body:{name:'Mantenimiento MCP separado',purpose:'maintenance',topology:'group',group_id:groups[0].id,account_ids:ids,content_ids:contentIds,profile:{name:'Mantenimiento opcional',timezone:'UTC',start_hour:0,end_hour:23,jitter_seconds:0},expires_at:new Date(new Date(clock.virtual_now).getTime()+20*86400000).toISOString()}})).data;
  await command('review');await command('authorize',{review:program.review,confirmation:'AUTHORIZE_REVIEWED_PROGRAM'});await command('activate',{review:program.review,confirmation:'ACTIVATE_REVIEWED_PROGRAM'});
  expect((await tool('number_preparation_get',{account_id:ids[0]})).data.progress.automatic_days).toBe(14);
  await command('pause');await command('revoke');await command('archive');await command('restore');expect(program.status).toBe('DRAFT');
  await writeFile(evidencePath('numbers-mcp-calendar.json'),JSON.stringify({status:'PASSED',client:'MCP SDK over registered STDIO server and local verified HTTPS; not Codex desktop',environment:'SIMULATION',policy:'standard-15d/v2',manual_days:0,automatic_days:14,nominal_day:15,progress:graduated.progress,without_sales_permission:readyNumber.primary_state,maintenance_separately_authorized:true,external_effects:0,completed_at:new Date().toISOString()},null,2));
  const capacity=(await tool('number_capacity_command',{body:{action:'preview',count:20,reason:'Dimensionar ensayo hasta veinte'}})).data;
  const expanded=(await tool('number_capacity_command',{body:{action:'expand',count:20,review:capacity.review,confirmation:'APPLY_REVIEWED_CAPACITY',reason:'Ensayo sintético de capacidad'}})).data;await processNumberOperations();expect((await tool('number_operation_get',{operation_id:expanded.operation_id})).data.state).toBe('SUCCEEDED');expect((await tool('number_capacity_get')).data.installed).toBe(20);
  const beforeFailure=(await tool('number_get',{account_id:ids[0]})).data;
  const readJob=(await tool('number_identity_observe',{account_id:ids[0],expected_version:beforeFailure.version})).data;
  await processNumberOperations('failing-read',async()=>{throw new Error('SIMULATED_PROVIDER_UNAVAILABLE');});
  const failed=(await tool('number_operation_get',{operation_id:readJob.operation_id})).data;expect(failed.state).toBe('FAILED');
  await tool('number_operation_command',{operation_id:readJob.operation_id,body:{action:'resume_read',expected_version:failed.version,reason:'Proveedor de ensayo recuperado'}});
  await processNumberOperations('another-session');expect((await tool('number_operation_get',{operation_id:readJob.operation_id})).data.state).toBe('SUCCEEDED');
  const page=await tool('numbers_list',{limit:1});expect(page.data).toHaveLength(1);expect(page.meta.next_offset).toBe(1);
  await reserveRequest();const denied=await client.callTool({name:'numbers_list',arguments:{environment:'REAL'}});expect(denied.isError).toBe(true);
  await reserveRequest();const conflict=await client.callTool({name:'number_edit',arguments:{environment:'SIMULATION',account_id:ids[0],idempotency_key:randomUUID(),body:{alias:'Cambio obsoleto',responsible:'Operador',device_ref:'Dispositivo',expected_version:1}}});expect(conflict.isError).toBe(true);
  expect(seen.size).toBeGreaterThanOrEqual(20);
 }finally{clearInterval(heartbeat);await client.close();await transport.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await app.close();await rm(directory,{recursive:true,force:true});}
},2700000);
