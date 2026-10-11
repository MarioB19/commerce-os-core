import {retirementRequest} from '../../apps/web/src/lib/catalog-retirement.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,getRecord,listRecords,withTransaction,hash} from '../../packages/db/src/index.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {recognizeReceipt} from '../../packages/db/src/receipt-sales.js';
import {ensureOrder} from '../../apps/automation-worker/src/workflows.js';
import {proposeEffect} from '../../apps/automation-worker/src/shared.js';
import {assignmentGate,listAssignments} from '../../packages/db/src/commercial-assignments.js';
import {gateDispatch} from '../../apps/channel-worker/src/dispatch.js';
import {saveAssignment,assignmentInput} from '../../apps/api/src/product-assignments.js';
import {principalMap} from '../../apps/api/src/context.js';
import type {FastifyRequest} from 'fastify';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
const workspace='v5-routing-'+randomUUID(),base={workspaceId:workspace,environment:'SIMULATION' as const},origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,token:string;const products:Body[]=[],accounts:DomainRecord[]=[],relationships:Body[]=[];
const request=(method:any,url:string,payload?:Body,key:string=randomUUID(),service=false)=>app.inject({method,url:url+(url.includes('?')?'&':'?')+'environment=SIMULATION',payload,headers:{origin,...(service?{authorization:'Bearer '+token}:{cookie}),'idempotency-key':key}});
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
const input=(account:number,product:number,overrides:Body={})=>({account_id:accounts[account]!.id,product_id:products[product]!.product.id,offer_version_id:products[product]!.offer.id,workflow_version_id:products[product]!.workflow.id,agent_version_id:products[product]!.agent.id,entry_rules:(product?['quiero b','Mi Ciclo B']:['quiero a','costura']).map(value=>({kind:'keyword',value})),expected_version:0,reason:'Synthetic approved route',...overrides});
const inbound=(account:number,text:string,extra:Body={},at=new Date().toISOString())=>withTransaction(c=>materializeMessage(c,accounts[account]!,{key:randomUUID(),type:'message',providerAt:at,identity:'opaque:same-customer',text,kind:'text',payload:{},...extra},randomUUID()));
beforeAll(async()=>{app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Synthetic V5 owner',email,password,workspace_id:workspace,role:'owner'});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.93',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);cookie=login.cookies.map(c=>`${c.name}=${c.value}`).join('; ');token=randomBytes(32).toString('hex');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments) VALUES($1,'synthetic-service','V5 scoped API',$2,$3,now()+interval '1 hour',$4)",[workspace,hash(token),JSON.stringify(['assignments:read','assignments:write','channels:read','products:read','workflows:read','workflows:draft','workflows:publish']),JSON.stringify(['SIMULATION'])]);
for(const name of ['A','B']){const product=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic '+name,status:'PUBLISHED'}});const agent=await putRecord(pool,{...base,kind:'agent',body:{name:'Seller '+name,product_id:product.id,status:'PUBLISHED',provider:'deterministic',knowledge:'Knowledge '+name,instructions:'Approved '+name}});const workflow=await putRecord(pool,{...base,kind:'workflow',body:{name:'Flow '+name,product_id:product.id,agent_version_id:agent.id,status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}});const offer=await putRecord(pool,{...base,kind:'offer',body:{name:'Offer '+name,product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:name==='A'?9700:23000,workflow_version_id:workflow.id,agent_version_id:agent.id,fulfillment:[]}});products.push({product,agent,workflow,offer});}
for(const name of ['one','two'])accounts.push(await putRecord(pool,{...base,kind:'channel_account',body:{name,provider:'simulator',status:'WORKING',sending_enabled:false}}));});
afterAll(async()=>{await app.close();await pool.end();});
it('applies 2 products × 2 numbers with independent versions, service permissions, no sends and partial replay',async()=>{
 const key=randomUUID(),body={assignments:[input(0,0),input(0,1),input(1,0),input(1,1,{expected_version:999})]};const partial=data(await request('POST','/v1/assignments/batch',body,key,true),207);expect(partial).toMatchObject({succeeded:3,failed:1,status:'PARTIAL_FAILURE'});expect(data(await request('POST','/v1/assignments/batch',body,key,true),207)).toEqual(partial);
 data(await request('POST','/v1/assignments',input(1,1),randomUUID(),true),201);relationships.push(...data(await request('GET','/v1/assignments',undefined,randomUUID(),true)));expect(relationships).toHaveLength(4);
	 const inventory=data(await request('GET','/v1/channel-inventory?product_id='+products[0]!.product.id,undefined,randomUUID(),true));expect(inventory.every((n:Body)=>n.assignments.length===2)).toBe(true);
	 const readiness=data(await request('GET','/v1/readiness'));for(const account of readiness.accounts)expect(account.checks.find((check:Body)=>check.key==='assignment')).toMatchObject({status:'CONFIGURED',source:'COMMERCIAL_ASSIGNMENT_SNAPSHOT'});
 const setup=data(await request('GET','/v1/channel-accounts/'+accounts[0]!.id+'/setup',undefined,randomUUID(),true));expect(setup.assignments).toHaveLength(2);expect(setup.effective_assignment.product_id).toBeNull();
 expect((await getRecord(pool,workspace,'channel_account',accounts[0]!.id))!.body.offer_version_id).toBeUndefined();expect((await pool.query('SELECT 1 FROM outbox WHERE workspace_id=$1',[workspace])).rowCount).toBe(0);
 const denied=await app.inject({method:'GET',url:'/v1/assignments?environment=REAL',headers:{authorization:'Bearer '+token}});expect(denied.statusCode).toBe(403);
});
it('selects before seller, rejects arbitrary IDs and ambiguous payment; preserves two separate journeys/orders',async()=>{
 const unknown=(await inbound(0,'hola '+products[0]!.product.id))!;expect(unknown.body.routing_state).toBe('PRODUCT_SELECTION_REQUIRED');expect(unknown.body.offer_version_id).toBeUndefined();expect(unknown.body.ai_pending).toBe(false);
 const a=(await inbound(0,'quiero a'))!,b=(await inbound(0,'quiero b'))!;expect(a.id).not.toBe(b.id);expect(a.body.physical_chat_id).toBe(b.body.physical_chat_id);expect(a.body.contact_id).toBe(b.body.contact_id);expect(a.body.agent_version_id).toBe(products[0]!.agent.id);expect(b.body.agent_version_id).toBe(products[1]!.agent.id);
 const oa=await withTransaction(c=>ensureOrder(c,a)),ob=await withTransaction(c=>ensureOrder(c,b));expect(oa!.id).not.toBe(ob!.id);expect(oa!.body.amount_minor).toBe(9700);expect(ob!.body.amount_minor).toBe(23000);expect(oa!.body.assignment_id).not.toBe(ob!.body.assignment_id);
 const ambiguous=(await inbound(0,'ya pagué'))!;expect(ambiguous.body.routing_state).toBe('PRODUCT_SELECTION_REQUIRED');expect(await withTransaction(c=>ensureOrder(c,ambiguous))).toBeUndefined();
 const effectA=await withTransaction(c=>proposeEffect(c,a,{kind:'text',text:'A price'},'v5-a')),effectB=await withTransaction(c=>proposeEffect(c,b,{kind:'text',text:'B price'},'v5-b'));expect(effectA.payload).toMatchObject({product_id:a.body.product_id,assignment_id:a.body.assignment_id,journey_id:a.id,order_id:oa!.id});
 await pool.query("UPDATE outbox SET status='UNKNOWN' WHERE id=$1",[effectA.id]);const blocked=await withTransaction(c=>gateDispatch(c,effectB,'synthetic'));expect(blocked.reason).toBe('SHARED_CHAT_UNRESOLVED_EFFECT');
});
it('matches aliases inside phrases with word boundaries and accepts an assigned product name',async()=>{
 const phrase=(await inbound(0,'Quiero información de COSTÚRA para principiantes',{identity:'opaque:phrase-alias'}))!;expect(phrase.body.product_id).toBe(products[0]!.product.id);expect(phrase.body.routing_state).toBe('RESOLVED');
 const name=(await inbound(0,'Me interesa Synthetic B',{identity:'opaque:written-name'}))!;expect(name.body.product_id).toBe(products[1]!.product.id);expect(name.body.routing_state).toBe('RESOLVED');
 const partial=(await inbound(0,'microcostura',{identity:'opaque:word-boundary'}))!;expect(partial.body.routing_state).toBe('PRODUCT_SELECTION_REQUIRED');expect(partial.body.product_id).toBeUndefined();
});
it('persists clear assigned-product options, rejects generic/media guesses and resolves a written option',async()=>{
 const identity='opaque:written-option';
 const ambiguous=(await inbound(0,'Compara costura con Mi Ciclo B',{identity}))!;
 expect(ambiguous.body).toMatchObject({routing_state:'PRODUCT_SELECTION_REQUIRED',routing_reason:'AMBIGUOUS_EXPLICIT_CHOICE'});
 expect(ambiguous.body.routing_options).toEqual(expect.arrayContaining([
  expect.objectContaining({label:'1. Synthetic A',product_id:products[0]!.product.id}),
  expect.objectContaining({label:'2. Synthetic B',product_id:products[1]!.product.id}),
 ]));
 const stillAmbiguous=(await inbound(0,'Sí',{identity}))!;expect(stillAmbiguous.id).toBe(ambiguous.id);expect(stillAmbiguous.body.routing_state).toBe('PRODUCT_SELECTION_REQUIRED');expect(stillAmbiguous.body.product_id).toBeUndefined();
 const mediaOnly=(await inbound(0,'',{identity:'opaque:media-no-route',kind:'image',media:{providerId:'synthetic-proof',mimeType:'image/png',filename:'comprobante.png'}}))!;expect(mediaOnly.body.routing_state).toBe('PRODUCT_SELECTION_REQUIRED');expect(mediaOnly.body.product_id).toBeUndefined();
 const option=ambiguous.body.routing_options.find((item:Body)=>item.product_id===products[1]!.product.id)!;
 const selected=(await inbound(0,String(option.index),{identity}))!;expect(selected.body.routing_state).toBe('RESOLVED');expect(selected.body.product_id).toBe(products[1]!.product.id);expect(selected.body.assignment_id).toBe(option.assignment_id);
});
it('routes an old reply to its original journey, rejects conflicting evidence and never executes late input',async()=>{
 const a=(await inbound(0,'quiero a'))!;await putRecord(pool,{...base,kind:'message',body:{account_id:accounts[0]!.id,contact_id:a.body.contact_id,conversation_id:a.id,provider_message_id:'known-a-message',direction:'OUTBOUND',text:'A'}});
 const reply=(await inbound(0,'about A',{payload:{context:{id:'known-a-message'}}}))!;expect(reply.id).toBe(a.id);
 const conflict=(await inbound(0,'quiero b',{payload:{context:{id:'known-a-message'}}}))!;expect(conflict.body.routing_state).toBe('PRODUCT_SELECTION_REQUIRED');
 const later=new Date(Date.now()+1000).toISOString();await inbound(0,'quiero b',{},later);const old=(await inbound(0,'old A',{payload:{context:{id:'known-a-message'}}},new Date(Date.now()-1000).toISOString()))!;expect(old.id).toBe(a.id);const messages=await listRecords(pool,workspace,'message','SIMULATION');expect(messages.find(m=>m.body.text==='old A')!.body.late).toBe(true);
});
it('rejects overlapping identical routes only, retires B alone and restores without permissions or timers',async()=>{
 const b=relationships.find(a=>a.account_id===accounts[0]!.id&&a.product_id===products[1]!.product.id)!;
 const conflict=await request('POST','/v1/assignments',input(0,1,{expected_version:b.revision,entry_rules:[{kind:'keyword',value:'quiero a'}]}));expect(conflict.statusCode).toBe(409);
 const retired=data(await request('POST',`/v1/assignments/${b.id}/retire`,{expected_version:b.revision,reason:'Retire B only'}));expect(retired.state).toBe('RETIRED');const a=(await listAssignments(pool,workspace,'SIMULATION',{account_id:accounts[0]!.id,product_id:products[0]!.product.id}))[0]!;expect(a.revision).toBe(1);expect(a.state).toBe('ACTIVE');
 const old=(await listRecords(pool,workspace,'conversation','SIMULATION')).find(j=>j.body.assignment_id===b.id)!;expect(await assignmentGate(pool,old)).toBe('ASSIGNMENT_RETIRED_OR_EXPIRED');
 const restored=data(await request('POST',`/v1/assignments/${b.id}/restore`,{expected_version:retired.revision,reason:'Restore for setup only'}));expect(restored.state).toBe('DRAFT');expect(restored.authorization_id).toBeNull();expect(await assignmentGate(pool,old)).toBe('ASSIGNMENT_RETIRED_OR_EXPIRED');const mounted=data(await request('POST',`/v1/assignments/${b.id}/activate`,{expected_version:restored.revision,reason:'Explicitly mount restored configuration'}));expect(mounted.state).toBe('ACTIVE');expect(mounted.authorization_id).toBeNull();expect(await assignmentGate(pool,old)).toBe('ASSIGNMENT_CHANGED');expect((await pool.query("SELECT status FROM outbox WHERE workspace_id=$1 AND logical_key='v5-a'",[workspace])).rows[0].status).toBe('UNKNOWN');
});
it('retires drafts durably; dependencies and concurrent assignment prevent retiring resources in use',async()=>{
 const draft=await putRecord(pool,{...base,kind:'agent',body:{name:'Disposable draft',product_id:products[0]!.product.id,status:'DRAFT',provider:'deterministic',knowledge:'Review',instructions:'Review'}});const removeRequest=retirementRequest('agents',draft.id,{expected_version:draft.version,currently_archived:false,reason:'Retire draft'});const removed=data(await request('POST','/v1'+removeRequest.path,removeRequest.body));expect(removed.archived_at).toBeTruthy();const restoreRequest=retirementRequest('agents',draft.id,{expected_version:removed.version,currently_archived:true,reason:'Restore draft'});const restored=data(await request('POST','/v1'+restoreRequest.path,restoreRequest.body));expect(restored.archived_at).toBeUndefined();
 const flow=products[0]!.workflow;const deps=data(await request('GET',`/v1/workflows/${flow.id}/dependencies`));expect(deps.blocked).toBe(true);expect(deps.assignments).toHaveLength(2);const denied=await request('POST',`/v1/workflows/${flow.id}/archive`,{expected_version:flow.version,archived:true,reason:'Must not cascade',dependency_hash:deps.dependency_hash,existing_policy:'handoff'});expect(denied.statusCode).toBe(409);expect(denied.json().error.code).toBe('RESOURCE_IN_USE');
});
it('serializes retirement against assignment and publication; restoration does not resurrect jobs',async()=>{
 const workflow=await putRecord(pool,{...base,kind:'workflow',body:{name:'Racing flow',product_id:products[0]!.product.id,status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}});
 const a=relationships.find(r=>r.account_id===accounts[1]!.id&&r.product_id===products[0]!.product.id)!;
 const attempts=await Promise.all([request('POST',`/v1/workflows/${workflow.id}/archive`,{expected_version:workflow.version,archived:true,reason:'Concurrent retirement'}),request('POST','/v1/assignments',input(1,0,{expected_version:a.revision,workflow_version_id:workflow.id}))]);
 expect(attempts.filter(r=>r.statusCode<300)).toHaveLength(1);expect(attempts.some(r=>r.statusCode===409)).toBe(true);
 const current=(await getRecord(pool,workspace,'workflow',workflow.id))!;const assignment=(await listAssignments(pool,workspace,'SIMULATION',{account_id:accounts[1]!.id,product_id:products[0]!.product.id}))[0]!;expect(!!current.body.archived_at&&assignment.body.workflow_version_id===workflow.id).toBe(false);
});
it('keeps two receipt contributions on their own orders and rejects evidence reused across products',async()=>{
 const orders=await listRecords(pool,workspace,'order','SIMULATION');const a=orders.find(o=>o.body.product_id===products[0]!.product.id)!,b=orders.find(o=>o.body.product_id===products[1]!.product.id)!;
 const asset=await putRecord(pool,{...base,kind:'asset',body:{name:'Protected synthetic receipt',kind:'file',status:'READY',storage_key:'fixture-does-not-dispatch',sha256:hash(randomUUID())}});
 const receipt=await putRecord(pool,{...base,kind:'receipt',body:{order_id:a.id,conversation_id:a.body.conversation_id,asset_id:asset.id,status:'APPROVED',extraction:{amount_minor:9700,currency:'MXN',reference:'fixture-a-'+randomUUID()}}});
 await withTransaction(c=>recognizeReceipt(c,receipt,{actor:'test-reviewer',cause:randomUUID()}));
 const duplicate=await putRecord(pool,{...base,kind:'receipt',body:{...receipt.body,order_id:b.id,conversation_id:b.body.conversation_id}});await expect(withTransaction(c=>recognizeReceipt(c,duplicate,{actor:'test-reviewer',cause:randomUUID()}))).rejects.toThrow('DUPLICATE_PAYMENT_EVIDENCE');
 const assetB=await putRecord(pool,{...base,kind:'asset',body:{...asset.body,sha256:hash(randomUUID())}});const receiptB=await putRecord(pool,{...base,kind:'receipt',body:{order_id:b.id,conversation_id:b.body.conversation_id,asset_id:assetB.id,status:'APPROVED',extraction:{amount_minor:23000,currency:'MXN',reference:'fixture-b-'+randomUUID()}}});await withTransaction(c=>recognizeReceipt(c,receiptB,{actor:'test-reviewer',cause:randomUUID()}));
 const contributions=(await pool.query('SELECT order_id,amount_minor FROM payment_contributions WHERE workspace_id=$1 ORDER BY amount_minor',[workspace])).rows;expect(contributions.map(r=>[r.order_id,Number(r.amount_minor)])).toEqual([[a.id,9700],[b.id,23000]]);
});
it('global opt-out cancels all product timers while preserving UNKNOWN',async()=>{
 const a=(await inbound(1,'quiero a'))!,b=(await inbound(1,'quiero b'))!;for(const j of [a,b])await withTransaction(async c=>{await proposeEffect(c,j,{kind:'text',text:'cancel me'},'optout:'+j.id);await c.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key) VALUES($1,'SIMULATION',$2,'followup',now()+interval '1 hour',$3)",[workspace,j.id,'optout:'+j.id]);});await inbound(1,'baja');const rows=(await pool.query("SELECT status FROM outbox WHERE workspace_id=$1 AND logical_key LIKE 'optout:%'",[workspace])).rows;expect(rows.every(r=>r.status==='CANCELLED')).toBe(true);expect((await pool.query("SELECT status FROM timers WHERE workspace_id=$1 AND logical_key LIKE 'optout:%'",[workspace])).rows.every(r=>r.status==='CANCELLED')).toBe(true);expect((await pool.query("SELECT status FROM outbox WHERE workspace_id=$1 AND logical_key='v5-a'",[workspace])).rows[0].status).toBe('UNKNOWN');
});
it('uses production DB role grants for assignment, inbound and dispatch while workers cannot edit configuration',async()=>{
 const req={method:'POST',body:{environment:'SIMULATION'},query:{environment:'SIMULATION'},params:{},headers:{'idempotency-key':randomUUID()},id:randomUUID()} as unknown as FastifyRequest;principalMap.set(req,{user:{id:'synthetic-owner',name:'Synthetic owner',email:''},workspace_id:workspace,role:'owner',permissions:['*'],service:false,scopes:[]});
 try{const current=(await listAssignments(pool,workspace,'SIMULATION',{account_id:accounts[0]!.id,product_id:products[0]!.product.id}))[0]!;await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_api');const changed=await saveAssignment(req,c,assignmentInput.parse(input(0,0,{expected_version:current.revision})));expect(changed.revision).toBe(current.revision+1);});const journey=await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_automation');return(await materializeMessage(c,accounts[0]!,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity:'opaque:runtime-roles',text:'quiero a',kind:'text',payload:{}},randomUUID()))!;});const effect=await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_automation');await ensureOrder(c,journey);return proposeEffect(c,journey,{kind:'text',text:'Scoped fixture'},'runtime-role-'+journey.id);});await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_channel');expect((await gateDispatch(c,effect,'synthetic')).allowed).toBe(false);});for(const role of ['commerce_automation','commerce_channel'])await expect(withTransaction(async c=>{await c.query('SET LOCAL ROLE '+role);await c.query("UPDATE commercial_assignments SET state='RETIRED' WHERE id=$1",[current.id]);})).rejects.toThrow('permission denied');}finally{principalMap.delete(req);}
});
