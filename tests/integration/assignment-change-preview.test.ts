import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord,hash,getRecord} from '../../packages/db/src/index.js';
import {assignmentGate} from '../../packages/db/src/commercial-assignments.js';
import type {Body} from '../../packages/contracts/src/index.js';

const workspace='change-preview-'+randomUUID(),base={workspaceId:workspace,environment:'SIMULATION' as const};
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string;
beforeAll(async()=>{
  app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
  await provisionUser({name:'Synthetic preview owner',email,password,workspace_id:workspace,role:'owner'});
  const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.212',headers:{origin},payload:{email,password}});
  expect(login.statusCode).toBe(200);cookie=login.cookies.map(c=>c.name+'='+c.value).join('; ');
});
afterAll(async()=>{await app.close();await pool.end();});
const call=(method:any,url:string,payload?:Body,token?:string)=>app.inject({method,url:url+(url.includes('?')?'&':'?')+'environment=SIMULATION',payload,headers:{origin,...(token?{authorization:'Bearer '+token}:{cookie}),'idempotency-key':randomUUID()}});
async function credential(scopes:string[],resources?:string[]){const token=randomBytes(32).toString('hex');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,resource_ids,expires_at,allowed_environments) VALUES($1,'preview-test','Synthetic read only',$2,$3,$4,now()+interval '1 hour',$5)",[workspace,hash(token),JSON.stringify(scopes),resources?JSON.stringify(resources):null,JSON.stringify(['SIMULATION'])]);return token;}
it('previews the exact invalidation without writes and proves the old snapshot remains recorded but cannot continue after replacement',async()=>{
  const product=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic product',status:'PUBLISHED'}});
  const agent=await putRecord(pool,{...base,kind:'agent',body:{name:'Synthetic seller',product_id:product.id,provider:'deterministic',status:'PUBLISHED'}});
  const workflow=await putRecord(pool,{...base,kind:'workflow',body:{name:'Synthetic flow',product_id:product.id,agent_version_id:agent.id,status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]}});
  const offer=await putRecord(pool,{...base,kind:'offer',body:{name:'Synthetic offer',product_id:product.id,workflow_version_id:workflow.id,agent_version_id:agent.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,fulfillment:[]}});
  const account=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Synthetic account',provider:'simulator',sending_enabled:false}});
  const input={account_id:account.id,product_id:product.id,offer_version_id:offer.id,workflow_version_id:workflow.id,agent_version_id:agent.id,expected_version:0,reason:'Synthetic preview configuration'};
  const created=await call('POST','/v1/assignments',input);expect(created.statusCode,created.body).toBe(201);const assignment=created.json().data;
  const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'PRIVATE_CUSTOMER_NAME',identity:'opaque:'+randomUUID()}});
  const conversation=await putRecord(pool,{...base,kind:'conversation',body:{account_id:account.id,contact_id:contact.id,product_id:product.id,assignment_id:assignment.id,assignment_revision:assignment.revision,binding_id:assignment.binding_id,offer_version_id:offer.id,workflow_version_id:workflow.id,agent_version_id:agent.id,status:'OPEN',stage:'COMMITTED',last_customer_text:'PRIVATE_CUSTOMER_MESSAGE'}});
  const timer=(await pool.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key,payload) VALUES($1,'SIMULATION',$2,'followup',now()+interval '1 hour',$3,$4) RETURNING id",[workspace,conversation.id,randomUUID(),{private:'PRIVATE_TIMER_PAYLOAD'}])).rows[0];
  const effects:Body[]=[];
  for(const [status,attempts,payload]of [['READY',0,{kind:'text'}],['BLOCKED',0,{kind:'document',fulfillment_id:randomUUID()}],['UNKNOWN',1,{kind:'text'}],['READY',1,{kind:'text'}]] as const){
    const e=(await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,attempts,config_hash) VALUES($1,'SIMULATION',$2,$3,$4,$5,$6,$7,$8,'synthetic') RETURNING *",[workspace,account.id,conversation.id,contact.id,randomUUID(),{...payload,assignment_id:assignment.id,text:'PRIVATE_EFFECT_PAYLOAD'},status,attempts])).rows[0];effects.push(e);
  }
  const token=await credential(['assignments:read','sales:read']);
  const response=await call('GET',`/v1/assignments/${assignment.id}/change-preview?expected_version=1`,undefined,token);expect(response.statusCode,response.body).toBe(200);
  const preview=response.json().data;
  const spec=(await app.inject({method:'GET',url:'/v1/openapi.json'})).json(),contract=spec.paths['/v1/assignments/{id}/change-preview'].get;
  expect(contract['x-required-service-scopes']).toEqual(['assignments:read','sales:read']);
  expect(contract['x-mcp-tool']).toBe('assignment_transition');
  expect(contract.parameters).toContainEqual(expect.objectContaining({name:'expected_version',in:'query',required:false}));
  expect(preview).toMatchObject({read_only:true,external_effects:false,apply_allowed:false,history_preserved:true,historical_automation_preserved:false,proposed_revision:2,consequences:{authorization_revoked:false,pending_timers_cancelled:1,unsent_messages_cancelled:1,historical_assignment_gate:'ASSIGNMENT_CHANGED',unknown_resent:false}});
  expect(preview.blockers).toEqual(expect.arrayContaining(['OPEN_CONVERSATION_CONTINUITY_REQUIRED','IN_FLIGHT_OR_UNKNOWN_REQUIRES_RECONCILIATION','CUTOVER_DECISION_REQUIRED']));
  expect(preview.conversations).toHaveLength(1);expect(preview.effects).toHaveLength(4);expect(preview.timers[0].id).toBe(timer.id);
  expect(response.body).not.toMatch(/PRIVATE_|opaque:|contact_id|config_hash/);
  expect((await getRecord(pool,workspace,'conversation',conversation.id))!.body).toEqual(conversation.body);
  expect((await pool.query('SELECT * FROM outbox WHERE workspace_id=$1 ORDER BY created_at,id',[workspace])).rows).toEqual(effects);
  expect((await pool.query('SELECT status FROM timers WHERE id=$1',[timer.id])).rows[0].status).toBe('PENDING');
  expect(await assignmentGate(pool,conversation)).toBeNull();
  expect((await call('GET',`/v1/assignments/${assignment.id}/change-preview?expected_version=2`,undefined,token)).statusCode).toBe(409);
  const noSales=await credential(['assignments:read']);expect((await call('GET',`/v1/assignments/${assignment.id}/change-preview`,undefined,noSales)).statusCode).toBe(403);
  const scopedElsewhere=await credential(['assignments:read','sales:read'],[randomUUID()]);expect((await call('GET',`/v1/assignments/${assignment.id}/change-preview`,undefined,scopedElsewhere)).statusCode).toBe(404);
  expect((await app.inject({method:'GET',url:`/v1/assignments/${assignment.id}/change-preview?environment=REAL`,headers:{authorization:'Bearer '+token}})).statusCode).toBe(403);
  const replacement=await call('POST','/v1/assignments',{...input,expected_version:1,reason:'Synthetic verification of the existing replacement contract'});expect(replacement.statusCode,replacement.body).toBe(201);
  expect(await assignmentGate(pool,conversation)).toBe('ASSIGNMENT_CHANGED');
  expect((await getRecord(pool,workspace,'conversation',conversation.id))!.body).toEqual(conversation.body);
  const final=(await pool.query('SELECT id,status FROM outbox WHERE workspace_id=$1 ORDER BY created_at,id',[workspace])).rows;
  expect(final.map(e=>e.status)).toEqual(['CANCELLED','BLOCKED','UNKNOWN','READY']);
  expect((await pool.query('SELECT status FROM timers WHERE id=$1',[timer.id])).rows[0].status).toBe('CANCELLED');
});
