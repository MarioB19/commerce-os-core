import {beforeAll,afterAll,it,expect,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,getRecord,listRecords,putRecord,withTransaction} from '../../packages/db/src/index.js';
import {salesAiConfiguration} from '../../packages/db/src/sales-ai-configuration.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {saveIntegrationSetting} from '../../packages/db/src/integration-settings.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
const workspace='commercial-config-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,viewer:string;
const request=(method:any,path:string,payload?:Body,auth=cookie,key=randomUUID())=>app.inject({method,url:path+(path.includes('?')?'&':'?')+'environment=SIMULATION',payload,headers:{origin,cookie:auth,'idempotency-key':key}});
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
let product:Body,offer:Body,flow:Body,seller:Body;const accounts:Body[]=[];
beforeAll(async()=>{app=await createApp();for(const role of ['owner','viewer']as const){const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic '+role,email,password,workspace_id:workspace,role});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:role==='owner'?'192.0.2.71':'192.0.2.72',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);const value=login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');if(role==='owner')cookie=value;else viewer=value;}});
afterAll(async()=>{await app.close();await pool.end();});
it('publishes and rereads a complete package with zero accounts and no Sales provider',async()=>{
 const spec=(await app.inject({method:'GET',url:'/v1/openapi.json',headers:{cookie,origin}})).json();
 expect(spec.paths['/v1/agents/{id}/publish'].post['x-required-service-scopes']).toEqual(['workflows:publish']);
 expect(spec.paths['/v1/products/{id}/configuration'].get.responses[200].content['application/json'].schema.properties.data.type).toBe('object');
 const batchSpec=spec.paths['/v1/channel-accounts/setup-batch'].post;
 expect(batchSpec.security).toEqual([{session:[]},{ownerPersonalToken:[]}]);expect(batchSpec.responses[207]).toBeDefined();
 expect(batchSpec.requestBody.content['application/json'].schema.properties.assignments.maxItems).toBe(50);
 expect(spec.paths['/v1/agents/{id}/archive'].post['x-required-service-scopes']).toEqual(['workflows:draft']);
 const asset=data(await request('POST','/v1/assets',{name:'Synthetic Core',kind:'link',url:'https://example.invalid/core'}),201);
 const bank=data(await request('POST','/v1/bank-profiles',{name:'Synthetic bank',bank:'Fixture',holder:'Fixture',account_number:'0000',currency:'MXN'}),201);
 const policy=data(await request('POST','/v1/receipt-policies',{name:'Synthetic human review',auto_approve:false}),201);
 product=data(await request('POST','/v1/products',{name:'Synthetic shared package',asset_ids:[asset.id]}),201);
 seller=data(await request('POST','/v1/agents',{name:'Synthetic prepared seller',product_id:product.id,provider:'workspace',model:null,max_cost_minor:0,knowledge:'Contenido aprobado: Core.',instructions:'Respetar oferta y revisión humana.'}),201);
 seller=data(await request('POST',`/v1/agents/${seller.id}/publish`,{expected_version:seller.version}));
 const draft=data(await request('POST','/v1/workflows',{name:'Synthetic shared flow',product_id:product.id,agent_version_id:seller.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}),201);
 flow=data(await request('POST',`/v1/workflows/${draft.id}/publish`,{expected_version:draft.version}));
 const offerDraft=data(await request('POST',`/v1/products/${product.id}/offers`,{name:'Synthetic shared offer',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:flow.id,agent_version_id:seller.id,fulfillment:[{asset_id:asset.id,release_on:'commitment_accepted'}]}),201);
 offer=data(await request('POST',`/v1/offers/${offerDraft.id}/publish`,{expected_version:offerDraft.version}));
 product=data(await request('PATCH',`/v1/products/${product.id}`,{expected_version:product.version,workflow_template_version_id:flow.id,agent_version_id:seller.id}));
 product=data(await request('POST',`/v1/products/${product.id}/transition`,{expected_version:product.version,status:'PUBLISHED'}));
 const config=data(await request('GET',`/v1/products/${product.id}/configuration`));
 expect(config).toMatchObject({configuration_published:true,materials:[{id:asset.id,status:'READY'}],checks:{materials:true},simulation:{status:'NO_DATA',source:'records.simulation+canonical_flow_proof',environment:'SIMULATION',external_effects:null},visibility:{assignments:true},accounts:[],connections:{assigned_accounts:0,sales_ai:{configured:false,state:'PROVIDER_PENDING',model:null}},operation:{authorized:false}});
 expect(config.seller.id).toBe(seller.id);expect(config.seller.model).toBeNull();expect((await listRecords(pool,workspace,'channel_account','SIMULATION')).length).toBe(0);
 expect((await pool.query('SELECT count(*)::int n FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 expect((await pool.query('SELECT count(*)::int n FROM integration_settings WHERE workspace_id=$1',[workspace])).rows[0].n).toBe(0);
 expect((await app.inject({method:'GET',url:`/v1/products/${product.id}/configuration?environment=REAL`,headers:{cookie,origin}})).statusCode).toBe(404);
});
it('does not verify the full simulation graph for a non-completed historical run',async()=>{
 await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'simulation',body:{mode:'NUMBER_FLOW_TEST_V1',status:'RUNNING',assignments:[{product_id:product.id}],external_effects:false}});
 const querySpy=vi.spyOn(pool,'query');try{
  const config=data(await request('GET',`/v1/products/${product.id}/configuration`));
  expect(config.simulation).toMatchObject({status:'NO_DATA',verification:'SIMULATION_NOT_COMPLETED'});
  expect(querySpy.mock.calls.some(call=>String(typeof call[0]==='string'?call[0]:(call[0] as Body).text??'').includes('graph_conversations'))).toBe(false);
 }finally{querySpy.mockRestore();}
});
const assignment=(account:Body)=>({account_id:account.id,expected_version:account.version,product_id:product.id,offer_version_id:offer.id,workflow_version_id:flow.id,agent_version_id:seller.id,reason:'Synthetic shared package assignment'});
it('adds one then three accounts without rebuilding resources; reports conflicts and retries idempotently',async()=>{
 for(let i=0;i<3;i++)accounts.push(data(await request('POST','/v1/channel-accounts',{name:'Synthetic number '+(i+1),provider:'simulator'}),201));
 expect((await request('POST','/v1/channel-accounts/setup-batch',{assignments:[assignment(accounts[0]!)]},viewer)).statusCode).toBe(403);
 const key=randomUUID(),single={assignments:[assignment(accounts[0]!)]};const one=data(await request('POST','/v1/channel-accounts/setup-batch',single,cookie,key));expect(one.succeeded).toBe(1);expect(data(await request('POST','/v1/channel-accounts/setup-batch',single,cookie,key))).toEqual(one);
 const mixed={assignments:[assignment(accounts[1]!),{...assignment(accounts[2]!),expected_version:999}]};const mixedKey=randomUUID();const partial=data(await request('POST','/v1/channel-accounts/setup-batch',mixed,cookie,mixedKey),207);expect(partial).toMatchObject({status:'PARTIAL_FAILURE',succeeded:1,failed:1});expect(partial.results[1].code).toBe('VERSION_CONFLICT');
 expect(data(await request('POST','/v1/channel-accounts/setup-batch',mixed,cookie,mixedKey),207)).toEqual(partial);
 data(await request('POST','/v1/channel-accounts/setup-batch',{assignments:[assignment(accounts[2]!)]}));
 await pool.query("INSERT INTO mcl_test_scopes(workspace_id,environment,account_id,offer_version_id,participants,purpose,actor_id,expires_at) VALUES($1,'SIMULATION',$2,$3,'[]','Synthetic scope is not execution evidence','fixture',now()+interval '1 hour')",[workspace,accounts[0]!.id,offer.id]);
 const scoped=data(await request('GET',`/v1/products/${product.id}/configuration`));
 expect(scoped.simulation.status).toBe('NO_DATA');
 await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'simulation',body:{status:'COMPLETED',product_id:product.id,offer_version_id:offer.id,external_effects:false}});
 const config=data(await request('GET',`/v1/products/${product.id}/configuration`));expect(config.connections.assigned_accounts).toBe(3);expect(config.simulation).toMatchObject({status:'NO_DATA',source:'records.simulation+canonical_flow_proof',environment:'SIMULATION',external_effects:null});for(const a of config.accounts){expect(a.effective_assignment).toMatchObject({product_id:product.id,offer_version_id:offer.id,workflow_version_id:flow.id,agent_version_id:seller.id});expect(a.sending_enabled).toBe(false);}
	 const querySpy=vi.spyOn(pool,'query');try{const reread=data(await request('GET',`/v1/products/${product.id}/configuration`)),sql=querySpy.mock.calls.map(call=>typeof call[0]==='string'?call[0]:(call[0] as any).text??''),snapshots=sql.filter(statement=>statement.includes('commercial_assignment_snapshot'));expect(reread.assignment_snapshot.current_visible).toBe(3);expect(snapshots).toHaveLength(1);expect(snapshots[0]).toContain('COALESCE($4::timestamptz,clock_timestamp()) AS observed_at');expect(snapshots[0]).toContain('SELECT a.*,b.body,auth.expires_at AS authorization_expires_at');expect(snapshots[0]).toContain('SELECT DISTINCT ON (candidate.account_id)');expect(sql.some(statement=>statement.includes('FROM session_ownership'))).toBe(false);}finally{querySpy.mockRestore();}
	 const newerUnassignedOffer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{name:'Synthetic newer unassigned offer',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:12000,workflow_version_id:flow.id,agent_version_id:seller.id,fulfillment:[]}}),pinned=data(await request('GET',`/v1/products/${product.id}/configuration`));expect(pinned.offer.id).toBe(offer.id);expect(pinned.offer.id).not.toBe(newerUnassignedOffer.id);expect(pinned.offer_selection).toEqual({state:'ASSIGNED_CURRENT',offer_id:offer.id});expect(pinned.configuration_published).toBe(true);
 const restricted=data(await request('GET',`/v1/products/${product.id}/configuration`,undefined,viewer));
 expect(restricted).toMatchObject({visibility:{assignments:false},accounts:[],connections:{assigned_accounts:null},simulation:{status:'NO_DATA'}});
 expect(await listRecords(pool,workspace,'product','SIMULATION')).toHaveLength(1);expect(await listRecords(pool,workspace,'agent','SIMULATION')).toHaveLength(1);expect(await listRecords(pool,workspace,'binding','SIMULATION')).toHaveLength(3);
 expect((await request('POST','/v1/channel-accounts/setup-batch',{assignments:[assignment(accounts[0]!),assignment(accounts[0]!)]})).statusCode).toBe(400);
});
it('uses one database-clock snapshot, suppresses legacy fallback for any canonical row, and diagnoses historical configuration',async()=>{
 const clock=Date.parse(new Date((await pool.query('SELECT clock_timestamp() AS now')).rows[0].now).toISOString()),iso=(offset:number)=>new Date(clock+offset).toISOString();
 const futureAccount=data(await request('POST','/v1/channel-accounts',{name:'Synthetic future assignment',provider:'simulator'}),201);
 const expiredAccount=data(await request('POST','/v1/channel-accounts',{name:'Synthetic expired assignment',provider:'simulator'}),201);
 const legacyAccount=data(await request('POST','/v1/channel-accounts',{name:'Synthetic legacy binding',provider:'simulator'}),201);
 const historicalAccount=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Synthetic historical account fields',provider:'simulator',status:'STOPPED',product_id:product.id,offer_version_id:offer.id,workflow_version_id:flow.id,agent_version_id:seller.id,sending_enabled:false}});
 let future=data(await request('POST','/v1/assignments',{...assignment(futureAccount),expected_version:0,valid_from:iso(86400000)}),201);future=data(await request('POST','/v1/assignments',{...assignment(futureAccount),expected_version:future.revision,valid_from:iso(172800000),reason:'Synthetic future assignment revision two'}),201);
 const expired=data(await request('POST','/v1/assignments',{...assignment(expiredAccount),expected_version:0,valid_from:iso(-172800000),valid_to:iso(-86400000)}),201);
 const suppressedLegacy=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'binding',body:{account_id:futureAccount.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:flow.id,agent_version_id:seller.id,valid_from:iso(-3600000),source:'synthetic_legacy_should_not_win'}});
 const currentLegacy=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'binding',body:{account_id:legacyAccount.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:flow.id,agent_version_id:seller.id,valid_from:iso(-3600000),source:'synthetic_legacy_current'}});
 const scope={mode:'product_assignment',assignment_id:expired.id,assignment_revision:expired.revision,binding_id:expired.binding_id,product_id:product.id};
 const authorization=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,'SIMULATION','fixture',$2,'fixture',$3) RETURNING id",[workspace,scope,iso(3600000)])).rows[0];await pool.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[expired.id,authorization.id]);
 const config=data(await request('GET',`/v1/products/${product.id}/configuration`)),byId=(id:string)=>config.accounts.find((account:Body)=>account.id===id);
 expect(config.connections.assigned_accounts).toBe(4);
 expect(byId(futureAccount.id)).toMatchObject({uses_product:false,effective_assignment:null,assignment_resolution:{state:'HISTORICAL',source:'commercial_assignments',reason:'ASSIGNMENT_NOT_STARTED',assignment_id:future.id,binding_id:future.binding_id,revision:2}});
 expect(byId(expiredAccount.id)).toMatchObject({uses_product:false,effective_assignment:null,authorization_status:'INVALIDATED',authorization_registered:false,assignment_resolution:{state:'HISTORICAL',source:'commercial_assignments',reason:'ASSIGNMENT_EXPIRED'}});
 expect(byId(legacyAccount.id)).toMatchObject({uses_product:true,effective_assignment:{product_id:product.id,binding_id:currentLegacy.id},assignment_resolution:{state:'CURRENT',source:'legacy_binding',reason:'LEGACY_BINDING_CURRENT'}});
 expect(byId(historicalAccount.id)).toMatchObject({uses_product:false,effective_assignment:{product_id:product.id,binding_id:null},assignment_resolution:{state:'HISTORICAL',source:'legacy_account',reason:'ACCOUNT_CONFIGURATION_IS_HISTORICAL'}});
 expect(byId(futureAccount.id).effective_assignment).not.toMatchObject({binding_id:suppressedLegacy.id});
 const futureSetup=data(await request('GET',`/v1/channel-accounts/${futureAccount.id}/setup`));expect(futureSetup).toMatchObject({ready:false,assignments:[],assignment_resolution:{state:'HISTORICAL',source:'commercial_assignments',reason:'ASSIGNMENT_NOT_STARTED',assignment_id:future.id,binding_id:future.binding_id,revision:2}});expect(futureSetup.effective_assignment.product_id).toBeNull();
	 const futureReadiness=data(await request('GET','/v1/readiness')).accounts.find((account:Body)=>account.id===futureAccount.id);expect(futureReadiness.checks.find((check:Body)=>check.key==='assignment')).toMatchObject({status:'BLOCKED',source:'COMMERCIAL_ASSIGNMENT_SNAPSHOT',message:'ASSIGNMENT_NOT_STARTED'});
	 const futureInventory=data(await request('GET',`/v1/channel-inventory?product_id=${product.id}`)).find((account:Body)=>account.id===futureAccount.id);expect(futureInventory.assignments).toEqual([]);
	 const legacySetup=data(await request('GET',`/v1/channel-accounts/${legacyAccount.id}/setup`));expect(legacySetup).toMatchObject({assignment_resolution:{state:'CURRENT',source:'legacy_binding',reason:'LEGACY_BINDING_CURRENT'},effective_assignment:{product_id:product.id,binding_id:currentLegacy.id}});
 const historicalSetup=data(await request('GET',`/v1/channel-accounts/${historicalAccount.id}/setup`));expect(historicalSetup).toMatchObject({ready:false,assignment_resolution:{state:'HISTORICAL',source:'legacy_account',reason:'ACCOUNT_CONFIGURATION_IS_HISTORICAL'}});
	 const preflight=await request('GET',`/v1/assignments/${future.id}/preflight`);expect(preflight.statusCode,preflight.body).toBe(409);expect(preflight.json().error).toMatchObject({code:'ASSIGNMENT_NOT_CURRENT',details:{reason:'ASSIGNMENT_NOT_STARTED'}});
	 await pool.query("INSERT INTO warmup_simulation_runs(workspace_id,execution_workspace,seed,virtual_now,status,input) VALUES($1,$1,1,$2,'PAUSED',$3)",[workspace,iso(3*86400000),{scenario:'numbers-lifecycle'}]);
	 try{
	  const virtualConfig=data(await request('GET',`/v1/products/${product.id}/configuration`)),virtualReadiness=data(await request('GET','/v1/readiness')).accounts.find((account:Body)=>account.id===futureAccount.id),virtualSetup=data(await request('GET',`/v1/channel-accounts/${futureAccount.id}/setup`)),virtualInventory=data(await request('GET',`/v1/channel-inventory?product_id=${product.id}`)).find((account:Body)=>account.id===futureAccount.id),virtualNumber=data(await request('GET',`/v1/numbers/${futureAccount.id}`));
	  expect(virtualConfig.accounts.find((account:Body)=>account.id===futureAccount.id).uses_product).toBe(true);expect(virtualReadiness.checks.find((check:Body)=>check.key==='assignment').status).toBe('CONFIGURED');expect(virtualSetup.assignments.map((item:Body)=>item.id)).toContain(future.id);expect(virtualInventory.assignments.map((item:Body)=>item.id)).toContain(future.id);expect(virtualNumber.sales_readiness.map((item:Body)=>item.assignment_id)).toContain(future.id);
	 }finally{await pool.query("UPDATE warmup_simulation_runs SET status='COMPLETED' WHERE execution_workspace=$1",[workspace]);}
});
it('separates the same contact by account, orders, timers, outbox and attribution; global opt-out still cancels both',async()=>{
 const record=async(id:string)=>(await getRecord(pool,workspace,'channel_account',id))!;
 const incoming=async(account:DomainRecord,text:string)=>withTransaction(c=>materializeMessage(c,account,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity:'opaque:shared-fixture',text,kind:'text',payload:{} } as any,randomUUID()));
 const contact=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'contact',body:{name:'Synthetic shared fixture',identity:'opaque:shared-fixture'}});
 for(const account of accounts.slice(0,2))data(await request('POST','/v1/launch-tests',{account_id:account.id,offer_version_id:offer.id,participants:[{contact_id:contact.id,role:'buyer',own_phone_confirmed:true}],purpose:'Synthetic shared-account isolation rehearsal',expires_at:new Date(Date.now()+3600000).toISOString()}),201);
 const a=(await incoming(await record(accounts[0]!.id),'hola'))!,b=(await incoming(await record(accounts[1]!.id),'hola'))!;expect(a.id).not.toBe(b.id);expect(a.body.contact_id).toBe(b.body.contact_id);expect(a.body.origin.binding_id).not.toBe(b.body.origin.binding_id);
 for(const conv of [a,b])expect(conv.body).toMatchObject({contact_id:contact.id,commercial_classification:'TEST',analytics_excluded_from_creation:true,launch_test_role:'buyer'});
 for(const conv of [a,b])await withTransaction(async c=>{const order=await ensureOrder(c,conv);expect(order!.body.commercial_classification).toBe('TEST');await proposeEffect(c,conv,{kind:'text',text:'synthetic'},'test:'+conv.id);await c.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,payload,logical_key) VALUES($1,'SIMULATION',$2,'followup',now()+interval '2 hours','{}',$3)",[workspace,conv.id,'timer:'+conv.id]);});
 const effects=(await pool.query('SELECT * FROM outbox WHERE workspace_id=$1',[workspace])).rows;expect(effects).toHaveLength(2);expect(new Set(effects.map(e=>e.account_id)).size).toBe(2);expect((await listRecords(pool,workspace,'order','SIMULATION'))).toHaveLength(2);
 const old=await record(accounts[0]!.id);data(await request('POST',`/v1/channel-accounts/${old.id}/deactivate`,{expected_version:old.version,reason:'Only first account'}),202);
 expect((await record(accounts[1]!.id)).version).toBe(2);expect((await getRecord(pool,workspace,'conversation',b.id))!.body.workflow_version_id).toBe(flow.id);
 await incoming(await record(accounts[0]!.id),'baja');expect((await pool.query('SELECT status FROM outbox WHERE workspace_id=$1',[workspace])).rows.every(r=>r.status==='CANCELLED')).toBe(true);expect((await pool.query('SELECT status FROM timers WHERE workspace_id=$1',[workspace])).rows.every(r=>r.status==='CANCELLED')).toBe(true);
});
it('publishes a later product/flow revision without moving pinned accounts or historical conversations; TEST activity stays outside revenue',async()=>{
 const previous=data(await request('GET',`/v1/workflows/${flow.id}`));
 const draft=data(await request('POST',`/v1/workflows/${flow.id}/versions`,{expected_version:previous.version,changes:{name:'Synthetic later flow',entry_node_id:'finish',nodes:[{id:'finish',type:'end',config:{}}]}}),201);
 const next=data(await request('POST',`/v1/workflows/${draft.id}/publish`,{expected_version:draft.version}));
 const current=data(await request('GET',`/v1/products/${product.id}`));const version=data(await request('POST',`/v1/products/${product.id}/versions`,{expected_version:current.version,changes:{workflow_template_version_id:next.id}}),201);
 data(await request('POST',`/v1/products/${product.id}/transition`,{expected_version:version.version,status:'PUBLISHED'}));
 for(const a of accounts){const setup=data(await request('GET',`/v1/channel-accounts/${a.id}/setup`));expect(setup.effective_assignment.workflow_version_id).toBe(flow.id);}
 const conversations=await listRecords(pool,workspace,'conversation','SIMULATION');expect(conversations).toHaveLength(2);expect(conversations.every(c=>c.body.workflow_version_id===flow.id)).toBe(true);
 const all=data(await request('GET',`/v1/reports/summary?product_id=${product.id}`));expect(all.counts.sales).toBe(0);expect(all.counts.orders).toBe(0);
 for(const a of accounts){const report=data(await request('GET',`/v1/reports/summary?product_id=${product.id}&account_id=${a.id}`));expect(report.counts.sales).toBe(0);expect(report.counts.orders).toBe(0);}
 expect(await listRecords(pool,workspace,'product','SIMULATION')).toHaveLength(1);
});
it('archives and restores without destroying historical IDs, and resolves later provider settings without rebuilding seller',async()=>{
 const inUse=data(await request('GET',`/v1/workflows/${flow.id}`));expect((await request('POST',`/v1/workflows/${flow.id}/archive`,{expected_version:inUse.version,archived:true,reason:'Referenced resources require recovery plan'})).statusCode).toBe(409);
 const freshDraft=data(await request('POST','/v1/workflows',{name:'Independent removable flow',product_id:product.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}),201);const current=data(await request('POST',`/v1/workflows/${freshDraft.id}/publish`,{expected_version:freshDraft.version}));
 const retired=data(await request('POST',`/v1/workflows/${current.id}/archive`,{expected_version:current.version,archived:true,reason:'Synthetic retirement test'}));
 expect(data(await request('GET','/v1/workflows')).some((r:Body)=>r.id===current.id)).toBe(false);expect(data(await request('GET',`/v1/workflows/${current.id}`)).status).toBe('PUBLISHED');
 expect((await request('POST','/v1/workflows',{name:'Illegal archived reference',product_id:product.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{workflow_version_id:current.id}}]})).statusCode).toBe(400);
 data(await request('POST',`/v1/workflows/${current.id}/archive`,{expected_version:retired.version,archived:false,reason:'Restore verified historical version'}));
 const before=await getRecord(pool,workspace,'agent',seller.id);await withTransaction(c=>saveIntegrationSetting(c,workspace,'SIMULATION','openai:default',{expected_version:0,label:'Synthetic settings only',enabled:true,config:{base_url:'https://api.openai.com/v1',model:'synthetic-model-no-call',max_cost_minor:20,input_cost_per_million_minor:1,output_cost_per_million_minor:2},secrets:{api_key:'synthetic-not-a-real-key'},clear_secrets:[],reason:'Only configuration resolution fixture'},'test'));
 expect(await salesAiConfiguration(pool,workspace,'SIMULATION',before!.body)).toMatchObject({configured:true,state:'CONFIGURED_UNEVALUATED',agent:{model:'synthetic-model-no-call',max_cost_minor:20}});expect((await getRecord(pool,workspace,'agent',seller.id))!.version).toBe(before!.version);
 expect(await listRecords(pool,workspace,'ai_run','SIMULATION')).toHaveLength(0);
});

it('restores a legacy status-archived product as a visible draft without republishing or replacing its history',async()=>{
 const draft=data(await request('POST','/v1/products',{name:'Synthetic legacy archive'}),201);
 const published=data(await request('POST',`/v1/products/${draft.id}/transition`,{expected_version:draft.version,status:'PUBLISHED'}));
 const archived=data(await request('POST',`/v1/products/${draft.id}/transition`,{expected_version:published.version,status:'ARCHIVED'}));
 expect(archived.status).toBe('ARCHIVED');expect(archived.archived_at).toBeUndefined();
 expect(data(await request('GET','/v1/products')).some((r:Body)=>r.id===draft.id)).toBe(false);
 const key=randomUUID(),body={expected_version:archived.version,archived:false,reason:'Restore legacy product for review only'};
 const restored=data(await request('POST',`/v1/products/${draft.id}/archive`,body,cookie,key));
 expect(restored).toMatchObject({id:draft.id,status:'DRAFT',version:archived.version+1});expect(restored.archived_at).toBeUndefined();expect(restored.archive_reason).toBeUndefined();
 expect(data(await request('POST',`/v1/products/${draft.id}/archive`,body,cookie,key))).toEqual(restored);
 expect(data(await request('GET',`/v1/products/${draft.id}`))).toMatchObject({status:'DRAFT',version:restored.version});
 expect(data(await request('GET','/v1/products')).find((r:Body)=>r.id===draft.id)?.status).toBe('DRAFT');
 expect(data(await request('GET','/v1/products?status=PUBLISHED')).some((r:Body)=>r.id===draft.id)).toBe(false);
 const history=(await pool.query('SELECT version,body FROM record_versions WHERE workspace_id=$1 AND record_id=$2 ORDER BY version',[workspace,draft.id])).rows;
 expect(history.map(r=>r.body.status)).toEqual(['DRAFT','PUBLISHED','ARCHIVED','DRAFT']);
});
it('keeps resource-scoped commercial configuration inside the allowed product assignment',async()=>{
 const scopedAccount=data(await request('POST','/v1/channel-accounts',{name:'Synthetic scoped account',provider:'simulator'}),201),visibleAssignment=data(await request('POST','/v1/assignments',{...assignment(scopedAccount),expected_version:0}),201);
 const otherProduct=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Synthetic restricted product',status:'PUBLISHED'}}),binding=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'binding',body:{account_id:scopedAccount.id,product_id:otherProduct.id,offer_version_id:offer.id,workflow_version_id:flow.id,agent_version_id:seller.id,entry_rules:[{kind:'keyword',value:'private-route'}],evidence:'private-evidence',valid_from:new Date(Date.now()-60000).toISOString(),source:'synthetic_rbac_fixture'}});
 const hiddenAssignment=(await pool.query("INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id,revision,state) VALUES($1,'SIMULATION',$2,$3,$4,1,'ACTIVE') RETURNING id",[workspace,scopedAccount.id,otherProduct.id,binding.id])).rows[0];
 await pool.query("INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,0,$2,'ACTIVE','fixture','Synthetic historical scope must remain hidden')",[visibleAssignment.id,binding.id]);
 const resources=[product.id,offer.id,flow.id,seller.id,...(product.asset_ids??[]),scopedAccount.id],grant=data(await request('POST','/v1/service-tokens',{name:'Synthetic scoped commercial reader',scopes:['products:read','channels:read','assignments:read'],allowed_environments:['SIMULATION'],resource_ids:resources,expires_at:new Date(Date.now()+3600000).toISOString()}),201);
 const response=await app.inject({method:'GET',url:`/v1/products/${product.id}/configuration?environment=SIMULATION`,headers:{authorization:'Bearer '+grant.token}}),config=data(response);
 expect(config.accounts).toHaveLength(1);expect(config.accounts[0].id).toBe(scopedAccount.id);expect(config.accounts[0].assignments.map((item:Body)=>item.product_id)).toEqual([product.id]);expect(JSON.stringify(config)).not.toContain(otherProduct.id);
 const visibleHistory=data(await app.inject({method:'GET',url:`/v1/assignments/${visibleAssignment.id}/history?environment=SIMULATION`,headers:{authorization:'Bearer '+grant.token}}));expect(visibleHistory).toHaveLength(1);expect(visibleHistory[0]).toMatchObject({revision:1,binding_id:visibleAssignment.binding_id});expect(JSON.stringify(visibleHistory)).not.toContain('Synthetic historical scope must remain hidden');
 const restricted=data(await request('POST','/v1/service-tokens',{name:'Synthetic product and account only',scopes:['products:read','channels:read','assignments:read'],allowed_environments:['SIMULATION'],resource_ids:[otherProduct.id,scopedAccount.id],expires_at:new Date(Date.now()+3600000).toISOString()}),201),headers={authorization:'Bearer '+restricted.token};
 const hidden=data(await app.inject({method:'GET',url:`/v1/products/${otherProduct.id}/configuration?environment=SIMULATION`,headers}));expect(hidden.accounts).toHaveLength(1);expect(hidden.accounts[0]).toMatchObject({id:scopedAccount.id,assignments:[],effective_assignment:null,assignment_resolution:{state:'NO_DATA',source:'commercial_assignments',reason:'ASSIGNMENT_NOT_VISIBLE'}});
 const setup=data(await app.inject({method:'GET',url:`/v1/channel-accounts/${scopedAccount.id}/setup?environment=SIMULATION`,headers}));expect(setup).toMatchObject({assignments:[],effective_assignment:{product_id:null,offer_version_id:null,workflow_version_id:null,agent_version_id:null},assignment_resolution:{source:'commercial_assignments',reason:'ASSIGNMENT_NOT_VISIBLE'}});
 const scopedReadiness=data(await app.inject({method:'GET',url:'/v1/readiness?environment=SIMULATION',headers}));const scopedAccountReadiness=scopedReadiness.accounts.find((account:Body)=>account.id===scopedAccount.id);expect(scopedAccountReadiness.checks.find((check:Body)=>check.key==='assignment')).toMatchObject({status:'UNAVAILABLE',message:'ASSIGNMENT_NOT_VISIBLE_OR_MISSING'});
 expect((await app.inject({method:'GET',url:`/v1/channel-accounts/${scopedAccount.id}/setup?environment=SIMULATION&assignment_id=${hiddenAssignment.id}`,headers})).statusCode).toBe(404);
 const assignmentList=data(await app.inject({method:'GET',url:'/v1/assignments?environment=SIMULATION',headers}));expect(assignmentList).toEqual([]);
 for(const suffix of ['', '/history', '/preflight'])expect((await app.inject({method:'GET',url:`/v1/assignments/${hiddenAssignment.id}${suffix}?environment=SIMULATION`,headers})).statusCode).toBe(404);
 const inventory=data(await app.inject({method:'GET',url:`/v1/channel-inventory?environment=SIMULATION&product_id=${otherProduct.id}`,headers}));expect(inventory).toHaveLength(1);expect(inventory[0]).toMatchObject({id:scopedAccount.id,assignments:[]});
 for(const secret of [offer.id,flow.id,seller.id,'private-route','private-evidence'])for(const value of [hidden,setup,assignmentList,inventory,scopedReadiness])expect(JSON.stringify(value)).not.toContain(secret);
});
it('resolves the uniquely assigned offer across a sibling product revision',async()=>{
 const root=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Lineage root product',status:'PUBLISHED'}}),sibling=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'product',body:{name:'Lineage sibling revision',status:'PUBLISHED',series_id:root.id,source_version_id:root.id}}),asset=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'asset',body:{name:'Lineage delivery',kind:'link',status:'READY',url:'https://example.invalid/lineage'}}),agent=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'agent',body:{name:'Lineage seller',product_id:root.id,status:'PUBLISHED',provider:'deterministic',knowledge:'Synthetic lineage',instructions:'Synthetic lineage'}}),workflow=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'workflow',body:{name:'Lineage flow',product_id:root.id,status:'PUBLISHED',agent_version_id:agent.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}}),siblingOffer=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'offer',body:{name:'Sibling pinned offer',product_id:sibling.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:1000,workflow_version_id:workflow.id,agent_version_id:agent.id,fulfillment:[{asset_id:asset.id,release_on:'commitment_accepted'}]}}),account=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:'Lineage account',provider:'simulator',status:'WORKING',sending_enabled:false}}),binding=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'binding',body:{account_id:account.id,product_id:root.id,offer_version_id:siblingOffer.id,workflow_version_id:workflow.id,agent_version_id:agent.id,entry_rules:[],valid_from:new Date(Date.now()-60_000).toISOString(),source:'lineage_configuration_fixture'}});
 await pool.query("INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id,revision,state) VALUES($1,'SIMULATION',$2,$3,$4,1,'ACTIVE')",[workspace,account.id,root.id,binding.id]);
 const config=data(await request('GET',`/v1/products/${root.id}/configuration`));expect(config.offer.id).toBe(siblingOffer.id);expect(config.offer_selection).toEqual({state:'ASSIGNED_CURRENT',offer_id:siblingOffer.id});expect(config.accounts.find((item:Body)=>item.id===account.id)).toMatchObject({uses_product:true,effective_assignment:{product_id:root.id,offer_version_id:siblingOffer.id}});
});
