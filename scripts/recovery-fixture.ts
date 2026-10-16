import {insertPersonalToken} from '../packages/db/src/personal-access-tokens.js';
import {provisionUser,createAuth} from '../apps/api/src/auth.js';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pool,putRecord,uuid,encrypt,hash,withTransaction} from '../packages/db/src/index.js';
import {recognizeReceipt} from '../packages/db/src/receipt-sales.js';
import {persistInsightAccount} from '../apps/automation-worker/src/meta-insights.js';
import {proposeEffect} from '../apps/automation-worker/src/shared.js';
import {warmupProfileSchema} from '../packages/domain/src/warmup/policy.js';
try{
 const workspace='recovery-fixture',environment='SIMULATION' as const;
 const email='recovery-'+uuid()+'@example.invalid';
 const user=await provisionUser({email,password:uuid()+uuid(),name:'Synthetic restore user',workspace_id:workspace,role:'owner'});
 await withTransaction(c=>createAuth(c).api.requestPasswordReset({body:{email}}));
 await insertPersonalToken(pool,{workspace_id:workspace,user_id:user.id,name:'Synthetic recovery PAT',allowed_environments:['SIMULATION'],expires_at:new Date(Date.now()+86400000).toISOString()});
 await pool.query("INSERT INTO identity_mail_settings(singleton,version,enabled,config,updated_by) VALUES(true,1,true,$1,$2)",[{mode:'local',host:'localhost',port:2527,tls:'none',from:'security@example.invalid',name:'Commerce OS'},user.id]);

 const category=await putRecord(pool,{workspaceId:workspace,environment,kind:'category',body:{name:'Recovery category',knowledge:[{id:'scope',topic:'audience',title:'Scope',content:'Synthetic source',source:'recovery fixture'}]}});
 const product=await putRecord(pool,{workspaceId:workspace,environment,kind:'product',body:{name:'Recovery product',category_id:category.id,knowledge:[]}});
 const seller=await putRecord(pool,{workspaceId:workspace,environment,kind:'agent',body:{name:'Recovery seller',product_id:product.id,revision:1}});
 await putRecord(pool,{workspaceId:workspace,environment,kind:'flow_evaluation',body:{snapshot:{schema_version:1,mode:'DETERMINISTIC',seller:{product_id:product.id,agent_version_id:seller.id},flow:{editor:{schema_version:1,positions:{node:{x:120,y:240}},labels:{node:'Recovery label'}}}},state:{status:'WAITING',virtual_seconds:60},external_effects:false}});
 const account=await putRecord(pool,{workspaceId:workspace,environment,kind:'channel_account',body:{name:'Synthetic recovery account',provider:'simulator',status:'WORKING'}});
 await pool.query("UPDATE channel_sessions SET recovery_enabled=true,operational_pause=false,desired_state='RUNNING',primary_last_used_at=now() WHERE account_id=$1",[account.id]);
 const contact=await putRecord(pool,{workspaceId:workspace,environment,kind:'contact',body:{name:'Synthetic recovery contact',identity:'lid:recovery'}});
 const conversation=await putRecord(pool,{workspaceId:workspace,environment,kind:'conversation',body:{account_id:account.id,contact_id:contact.id,status:'OPEN'}});
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB3sAAAAASUVORK5CYII=','base64'),key=uuid();
 mkdirSync(join(process.env.PRIVATE_STORAGE_DIR!,'assets'),{recursive:true,mode:0o700});writeFileSync(join(process.env.PRIVATE_STORAGE_DIR!,'assets',key+'.enc'),encrypt(bytes.toString('base64')),{mode:0o600});
 const asset=await putRecord(pool,{workspaceId:workspace,environment,kind:'asset',body:{name:'Recovery evidence',kind:'file',status:'READY',storage_key:key,sha256:hash(bytes),mime_type:'image/png',size_bytes:bytes.length}});
 const order=await putRecord(pool,{workspaceId:workspace,environment,kind:'order',body:{conversation_id:conversation.id,currency:'MXN',offer_snapshot:{currency:'MXN'},commercial_classification:'COMMERCIAL'}});
 const receipt=await putRecord(pool,{workspaceId:workspace,environment,kind:'receipt',body:{order_id:order.id,conversation_id:conversation.id,asset_id:asset.id,status:'APPROVED',extraction:{amount_minor:9700,currency:'MXN'},review:{actor_id:'recovery',at:'2026-09-06T12:00:00Z'}}});
 await withTransaction(c=>recognizeReceipt(c,receipt,{actor:'recovery',cause:uuid(),historical:true,effectiveAt:'2026-09-06T12:00:00Z'}));
 const job=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status) VALUES($1,$2,'recovery',$3,'SYNCED') RETURNING *",[workspace,environment,{from:'2026-09-06',to:'2026-09-06'}])).rows[0];
 const insight={day:'2026-09-06',level:'ad',entity_id:'55',campaign_id:'44',name:'Synthetic recovery ad',campaign_name:'Synthetic recovery campaign',currency:'MXN',timezone:'America/Mexico_City',spend_minor:10000};
 await withTransaction(c=>persistInsightAccount(c,job,{id:'act_123',currency:'MXN',timezone_name:'America/Mexico_City'},[insight,{...insight,level:'campaign',entity_id:'44'}],[]));
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,frozen,lease_expires_at) VALUES($1,$2,'old-owner',false,now()+interval '30 seconds')",[account.id,workspace]);
 await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at) VALUES($1,$2,'synthetic-owner','{}','synthetic',now()+interval '1 day')",[workspace,environment]);
 const effect=await withTransaction(c=>proposeEffect(c,conversation,{kind:'text',text:'Synthetic in flight'},'recovery-inflight'));
 await pool.query("UPDATE outbox SET status='SENDING',claim_id='old-claim',claimed_at=now(),attempts=1 WHERE id=$1",[effect.id]);
 await pool.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key) VALUES($1,$2,$3,'followup',now()+interval '1 day','recovery-timer')",[workspace,environment,conversation.id]);
 const warmupProfile=(await pool.query('INSERT INTO warmup_profiles(workspace_id,environment,config) VALUES($1,$2,$3) RETURNING id',[workspace,environment,warmupProfileSchema.parse({name:'Recovery fixture',timezone:'America/Mexico_City'})])).rows[0];
 const group=(await pool.query('INSERT INTO warmup_pools(workspace_id,environment,profile_id,enabled) VALUES($1,$2,$3,true) RETURNING id',[workspace,environment,warmupProfile.id])).rows[0];
 const identity=(await pool.query("INSERT INTO warmup_identities(workspace_id,environment,account_id,address_fingerprint,address_ciphertext,profile_ciphertext,ownership_evidence,profile_operation_status,profile_attempt_at,profile_review_requested_at) VALUES($1,$2,$3,$4,$5,$6,'Synthetic recovery','APPLYING',now(),now()) RETURNING id",[workspace,environment,account.id,hash('opaque:recovery-owned'),encrypt('opaque:recovery-owned'),encrypt({name:'Own fixture',about:'Restore fixture'})])).rows[0];
 await pool.query("INSERT INTO warmup_states(account_id,workspace_id,environment,pool_id,profile_id,identity_id,status,enrolled_at) VALUES($1,$2,$3,$4,$5,$6,'WARMING',now())",[account.id,workspace,environment,group.id,warmupProfile.id,identity.id]);
 await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at) VALUES($1,'restore-fixture','Synthetic API token',$2,'[\"catalog:read\"]',now()+interval '1 day')",[workspace,hash(uuid())]);
 for(const status of ['PENDING','SENDING'])await pool.query("INSERT INTO operational_alerts(workspace_id,environment,dedupe_key,kind,severity,summary_code,status) VALUES($1,$2,$3,'RECOVERY_FIXTURE','WARNING','RECOVERY_FIXTURE',$3)",[workspace,environment,status]);
 // V7 F8-E: the creative, Inteligencia and diagnostic tables were exported and
 // dropped (0109); a backup of a V7 database no longer carries them.
 const assignment=uuid();
 const binding=await putRecord(pool,{workspaceId:workspace,environment,kind:'binding',body:{account_id:account.id,product_id:product.id,assignment_id:assignment,valid_from:new Date().toISOString()}}),authorization=(await pool.query('SELECT id FROM operation_authorizations WHERE workspace_id=$1',[workspace])).rows[0].id;
 await pool.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id,authorization_id) VALUES($1,$2,$3,$4,$5,$6,$7)",[assignment,workspace,environment,account.id,product.id,binding.id,authorization]);
 await pool.query("INSERT INTO commercial_assignment_history(assignment_id,revision,binding_id,state,actor_id,reason) VALUES($1,1,$2,'ACTIVE',$3,'Synthetic restore history')",[assignment,binding.id,user.id]);
 await pool.query("INSERT INTO warmup_simulation_runs(workspace_id,execution_workspace,seed,virtual_now,input) VALUES($1,$2,1,now(),'{}')",[workspace,workspace+'-simulation']);
 // In-flight control metadata only; restoration must not restart the host actuator.
 await pool.query("INSERT INTO number_operations(workspace_id,environment,actor_id,action,state,input,lease_owner,lease_until) VALUES($1,$2,$3,'EXPAND','PREPARING','{\"count\":20,\"apply\":true}','fixture-agent',now()+interval '1 minute')",[workspace,environment,user.id]);
 await pool.query("INSERT INTO number_capacity_slots(workspace_id,environment,slot,state,readback) VALUES($1,$2,12,'PREPARING','{\"verified\":true}')",[workspace,environment]);
 await pool.query("INSERT INTO warmup_programs(workspace_id,environment,actor_id,name,topology,profile_id,account_ids,status) VALUES($1,$2,$3,'Synthetic group program','group',$4,$5,'ACTIVE')",[workspace,environment,user.id,warmupProfile.id,[account.id]]);
 console.log('Synthetic recovery state created: private asset, in-flight effect, timer, ownership and authorization.');
}finally{await pool.end();}
