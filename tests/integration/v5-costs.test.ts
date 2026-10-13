import {it,expect,afterAll} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {pool,putRecord,hash} from '../../packages/db/src/index.js';
import {createApp} from '../../apps/api/src/app.js';
import {costSummary} from '../../apps/api/src/costs.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
afterAll(async()=>pool.end());
it('separates persisted costs, uncertainty and currencies; does not attribute global Intelligence or diagnostics to a product',async()=>{
 const workspace='v5-costs-'+randomUUID(),base={workspaceId:workspace,environment:'SIMULATION' as const};
 await fixtureProfiles(workspace);// V7 F2: the fixture workspace is an adopted profile.
 const a=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic A'}}),b=await putRecord(pool,{...base,kind:'product',body:{name:'Synthetic B'}});
 const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Synthetic contact'}}),account=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Virtual',provider:'simulator'}});
 const ca=await putRecord(pool,{...base,kind:'conversation',body:{product_id:a.id,contact_id:contact.id,account_id:account.id}}),cb=await putRecord(pool,{...base,kind:'conversation',body:{product_id:b.id,contact_id:contact.id,account_id:account.id}});
 await putRecord(pool,{...base,kind:'ai_run',body:{conversation_id:ca.id,status:'COMPLETED',provider:'openai',usage:{input_tokens:12,output_tokens:4,cost_minor:7},context_snapshot:{secret_customer_data:'MUST_NOT_BE_IN_REPORT'}}});
 await putRecord(pool,{...base,kind:'ai_run',body:{conversation_id:cb.id,status:'FAILED',provider:'openai'}});
 const budget=randomUUID(),operation=randomUUID(),competing=randomUUID(),analysis=randomUUID();
 await pool.query("INSERT INTO creative_budgets(id,workspace_id,environment,provider,limit_usd,max_units,authorization_source,actor_id,expires_at) VALUES($1,$2,'SIMULATION','openai',5,1000,'fixture','fixture',now()+interval '1 hour')",[budget,workspace]);
 await pool.query("INSERT INTO creative_provider_operations(id,workspace_id,environment,actor_id,provider,kind,operation_key,request_hash,request,budget_id,status,estimated_cost,confirmed_cost,units) VALUES($1::uuid,$2,'SIMULATION','fixture','openai','openai.analyze',$1::text,'fixture','{}',$3,'CONFIRMED',0.01,0.004,10)",[operation,workspace,budget]);
 await pool.query("INSERT INTO intelligence_offers(id,workspace_id,environment,group_key,title) VALUES($1,$2,'SIMULATION','fixture','Observed competing offer')",[competing,workspace]);
 await pool.query("INSERT INTO intelligence_analyses(id,workspace_id,environment,offer_id,content_hash,prompt_version,model,status,provider_operation_id,requested_by) VALUES($1,$2,'SIMULATION',$3,'fixture','v5','fixture','COMPLETED',$4,'fixture')",[analysis,workspace,competing,operation]);
 await pool.query("INSERT INTO intelligence_analysis_batches(id,analysis_id,workspace_id,environment,batch_index,evidence,content_hash,status,provider_operation_id) VALUES($1,$2,$3,'SIMULATION',0,'[]','fixture','COMPLETED',$4)",[randomUUID(),analysis,workspace,operation]);
 await pool.query("INSERT INTO integration_diagnostics(id,workspace_id,environment,profile_key,profile_version,actor_id,operation_key,request_hash,capability,status,estimated_cost_usd) VALUES($1,$2,'SIMULATION','openai:default',1,'fixture','fixture','fixture','responses.structured','UNKNOWN',0.02)",[randomUUID(),workspace]);
 const scoped=await costSummary(pool,workspace,'SIMULATION',{product_id:a.id});expect(scoped.entries).toHaveLength(1);expect(scoped.entries[0]).toMatchObject({source:'SELLER_AI',currency:null,unit:'MINOR',estimated:7,confirmed:null,unknown:true});expect(scoped.coverage.status).toBe('PARTIAL');expect(JSON.stringify(scoped)).not.toContain('MUST_NOT_BE_IN_REPORT');
 const all=await costSummary(pool,workspace,'SIMULATION');expect(all.entries).toHaveLength(4);expect(all.entries.filter(e=>e.source==='INTELLIGENCE_ANALYSIS')).toHaveLength(1);expect(all.totals.find(t=>t.currency==='USD')).toMatchObject({confirmed:0.004,estimated:0.03,reserved:0.02,unknown_operations:1});
 const credential=randomBytes(32).toString('hex');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,resource_ids,allowed_environments,expires_at) VALUES($1,'fixture','Scoped costs',$2,$3,$4,$5,now()+interval '1 hour')",[workspace,hash(credential),JSON.stringify(['reports:read']),JSON.stringify([a.id,ca.id]),JSON.stringify(['SIMULATION'])]);
 const app=await createApp(),get=(suffix:string)=>app.inject({method:'GET',url:'/v1/costs?environment=SIMULATION'+suffix,headers:{authorization:'Bearer '+credential}});
 try{expect((await get('')).statusCode).toBe(403);expect((await get('&product_id='+b.id)).statusCode).toBe(404);const response=await get('&conversation_id='+ca.id);expect(response.statusCode,response.body).toBe(200);expect(response.json().data.entries).toHaveLength(1);expect((await get('&product_id='+a.id+'&conversation_id='+cb.id)).statusCode).toBe(404);}finally{await app.close();}
});
