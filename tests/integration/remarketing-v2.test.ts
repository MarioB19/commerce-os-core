import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {buyerExcluded,hash,openRemarketingCycle,pool,putRecord,reserveRemarketingAttempt,setRemarketingAttemptStatus,withTransaction} from '../../packages/db/src/index.js';
import {recognizeReceipt} from '../../packages/db/src/receipt-sales.js';
import {createDefaultRemarketingPolicy,replaceRemarketingDurations,setRemarketingSlotEnabled,normalizeRemarketingPolicy} from '../../packages/domain/src/sales/remarketing.js';
import {salesAgreementRecipeV1} from '../../packages/domain/src/sales/sales-recipe-v2.js';
import type {Body,DomainRecord} from '../../packages/contracts/src/index.js';
import {processAgents} from '../../apps/automation-worker/src/agents.js';
import {acceptCustomerResponse,processConfirmedSchedules,processTimers} from '../../apps/automation-worker/src/workflows.js';
import {armFollowups} from '../../apps/automation-worker/src/workflow-timing.js';

const workspace='remarketing-v2-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://127.0.0.1:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,contact:DomainRecord,conversation:DomainRecord,cycle:Body,targetOffer:DomainRecord,virtualNow:string;
const record=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind,body});
const realRecord=(kind:string,body:Body)=>putRecord(pool,{workspaceId:workspace,environment:'REAL',kind,body});
const stage=(asset_id:string,text:string)=>({medium:'audio' as const,asset_id,text});

async function request(method:'GET'|'POST',path:string,body?:Body,key=randomUUID(),authorization?:string){
 const url=path+(path.includes('?')?'&':'?')+'environment=SIMULATION';
 return app.inject({method,url,headers:{origin,cookie,'idempotency-key':key,...(authorization?{authorization}:{})},...(body?{payload:{...body,environment:'SIMULATION'}}:{})});
}
function data(response:any,status=200){expect(response.statusCode,response.body).toBe(status);return response.json().data;}

beforeAll(async()=>{
 app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic remarketing owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.201',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);cookie=login.cookies.map(value=>`${value.name}=${value.value}`).join('; ');
 virtualNow='2026-09-20T18:00:00.000Z';const simulation=await record('simulation',{virtual_now:virtualNow,status:'RUNNING'}),account=await record('channel_account',{name:'Synthetic one',provider:'simulator',status:'WORKING'});contact=await record('contact',{name:'Synthetic buyer',identity:'opaque:'+randomUUID()});
 const product=await record('product',{name:'Synthetic product',status:'PUBLISHED'}),assets=[] as DomainRecord[];for(let index=0;index<6;index++)assets.push(await record('asset',{name:'Reminder '+index,kind:'file',mime_type:'audio/mpeg',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),status:'READY'}));
 const stages:any=[
  {awaiting_agreement:stage(assets[0]!.id,'Agreement one'),awaiting_payment:stage(assets[1]!.id,'Payment one')},
  {awaiting_agreement:stage(assets[2]!.id,'Agreement two'),awaiting_payment:stage(assets[3]!.id,'Payment two')},
  {awaiting_agreement:stage(assets[4]!.id,'Agreement three'),awaiting_payment:stage(assets[5]!.id,'Payment three')},
 ];
 const initial=createDefaultRemarketingPolicy(stages);const initialOffer=await record('offer',{name:'Initial offer',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,sales_flow:{entry_aliases:['Synthetic product'],recipe:salesAgreementRecipeV1(),remarketing:initial}});
 let custom=replaceRemarketingDurations(initial,[{quantity:45,unit:'minutes'},{quantity:6,unit:'hours'},{quantity:36,unit:'hours'}]);custom=setRemarketingSlotEnabled(custom,custom.slots[1]!.id,true,true);custom=setRemarketingSlotEnabled(custom,custom.slots[2]!.id,true,true);custom={...custom,slots:custom.slots.map(slot=>slot.position===3?{...slot,stages:{...slot.stages,awaiting_agreement:{...slot.stages.awaiting_agreement,text:'Replacement content that is not authorized for the open cycle'}}}:slot)};
 targetOffer=await record('offer',{...initialOffer.body,name:'Reprogrammed offer',sales_flow:{...initialOffer.body.sales_flow,remarketing:custom}});
 conversation=await record('conversation',{account_id:account.id,contact_id:contact.id,product_id:product.id,offer_version_id:initialOffer.id,simulation_id:simulation.id,last_inbound_at:virtualNow,status:'OPEN'});
 const anchor=new Date(Date.parse(virtualNow)-8*3600_000).toISOString();cycle=await withTransaction(client=>openRemarketingCycle(client,conversation,{policySnapshot:normalizeRemarketingPolicy(initial),stage:'AGREEMENT',anchorAt:anchor,maxAttempts:1}));
 const fired=randomUUID();await pool.query("INSERT INTO timers(id,workspace_id,environment,conversation_id,kind,payload,due_at,logical_key,status) VALUES($1,$2,'SIMULATION',$3,'followup',$4,$5,$6,'FIRED')",[fired,workspace,conversation.id,{cycle_id:cycle.id,slot_id:'remarketing_1',stage:'AGREEMENT'},new Date(Date.parse(anchor)+45*60_000).toISOString(),'fired:'+randomUUID()]);
 const reserved=await withTransaction(client=>reserveRemarketingAttempt(client,{cycleId:cycle.id,workspaceId:workspace,environment:'SIMULATION',contactId:contact.id,slotId:'remarketing_1',conversationId:conversation.id,timerId:fired,stage:'AGREEMENT'}));await setRemarketingAttemptStatus(pool,{attemptId:reserved.attempt!.id,workspaceId:workspace,environment:'SIMULATION'},'SENT',{synthetic:true});cycle=reserved.cycle!;
 conversation=await putRecord(pool,{id:conversation.id,version:conversation.version,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{...conversation.body,followup_plan:{key:'remarketing:synthetic',status:'SCHEDULED',cycle_id:cycle.id,workflow_runtime_version:'synthetic-v1',policy_snapshot:cycle.policy_snapshot,stage:'awaiting_agreement'}}});
 await pool.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,'SIMULATION',$2,'followup',$3,$4,$5)",[workspace,conversation.id,{cycle_id:cycle.id,slot_id:'remarketing_2'},new Date(Date.parse(anchor)+8*3600_000).toISOString(),'pending-old:'+randomUUID()]);
});
afterAll(async()=>{await app.close();await pool.end();});

it('lets the channel runtime revalidate and record an existing attempt without granting cycle creation',async()=>{
 const attempt=(await pool.query('SELECT id FROM commercial_remarketing_attempts WHERE cycle_id=$1 ORDER BY reserved_at LIMIT 1',[cycle.id])).rows[0];
 expect(attempt?.id).toBeTruthy();
 await withTransaction(async client=>{
  await client.query('SET LOCAL ROLE commerce_channel');
  expect((await client.query('SELECT status FROM commercial_remarketing_cycles WHERE id=$1',[cycle.id])).rowCount).toBe(1);
  expect((await client.query('SELECT 1 FROM commercial_buyer_exclusions WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3',[workspace,'SIMULATION',contact.id])).rowCount).toBe(0);
  const locked=(await client.query(
   `SELECT a.id,c.status AS cycle_status
    FROM commercial_remarketing_attempts a JOIN commercial_remarketing_cycles c ON c.id=a.cycle_id
    WHERE a.id=$1 AND a.cycle_id=$2 AND a.workspace_id=$3 AND a.environment='SIMULATION' FOR SHARE`,
   [attempt.id,cycle.id,workspace],
  )).rows[0];
  expect(locked).toMatchObject({id:attempt.id,cycle_status:'OPEN'});
  await client.query("UPDATE commercial_remarketing_attempts SET metadata=metadata||$2::jsonb,updated_at=now() WHERE id=$1",[attempt.id,{channel_role_probe:true}]);
 });
 expect((await pool.query('SELECT metadata FROM commercial_remarketing_attempts WHERE id=$1',[attempt.id])).rows[0].metadata).toMatchObject({channel_role_probe:true});
 await expect(withTransaction(async client=>{
  await client.query('SET LOCAL ROLE commerce_channel');
  await client.query(
   `INSERT INTO commercial_remarketing_cycles(workspace_id,environment,contact_id,source_conversation_id,source_offer_version_id,policy_snapshot,max_attempts,stage,anchor_at)
    VALUES($1,'SIMULATION',$2,$3,$4,'{}',0,'AGREEMENT',now())`,
   [workspace,contact.id,conversation.id,cycle.source_offer_version_id],
  );
 })).rejects.toThrow('permission denied');
 expect((await pool.query("SELECT has_column_privilege('commerce_channel','commercial_remarketing_cycles','id','UPDATE') AS id_lock,has_column_privilege('commerce_channel','commercial_remarketing_cycles','status','UPDATE') AS status_mutation")).rows[0]).toEqual({id_lock:true,status_mutation:false});
});

it('previews and explicitly reprograms only unstarted future slots without restoring quota or bursting overdue work',async()=>{
 const preview=data(await request('POST',`/v1/remarketing-cycles/${cycle.id}/reprogram/preview`,{offer_version_id:targetOffer.id}));
 expect(preview).toMatchObject({cycle_revision:cycle.revision,consumed_attempts:1,current_maximum:1,target_maximum:3,effective_maximum:3,commercial_delay_changes_channel_permission:false});
 expect(preview.slots.map((slot:Body)=>[slot.id,slot.disposition])).toEqual([['remarketing_1','PRESERVE_CONSUMED'],['remarketing_2','SKIP_OVERDUE'],['remarketing_3','SCHEDULE']]);
 expect(preview.slots[2].transport).toBe('OUTSIDE_24H_REQUIRES_ELIGIBLE_TEMPLATE_OR_NEW_INBOUND');
	 const limitedToken=randomBytes(32).toString('hex');
	 await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments) VALUES($1,'catalog-only-reprogrammer','Catalog only',$2,$3,now()+interval '1 hour',$4)",[workspace,hash(limitedToken),JSON.stringify(['offers:read','offers:write','sales:read']),JSON.stringify(['SIMULATION'])]);
	 const productsReaderToken=randomBytes(32).toString('hex');
	 await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments) VALUES($1,'remarketing-products-reader','Products and sales reader',$2,$3,now()+interval '1 hour',$4)",[workspace,hash(productsReaderToken),JSON.stringify(['products:read','sales:read']),JSON.stringify(['SIMULATION'])]);
	 const deniedList=await request('GET','/v1/remarketing-cycles',undefined,randomUUID(),'Bearer '+productsReaderToken);
	 expect(deniedList.statusCode,deniedList.body).toBe(403);expect(deniedList.json().error.code).toBe('FORBIDDEN');
	 const denied=await request('POST',`/v1/remarketing-cycles/${cycle.id}/reprogram`,{offer_version_id:targetOffer.id,expected_revision:preview.cycle_revision,preview_hash:preview.preview_hash,previewed_at:preview.previewed_at},randomUUID(),'Bearer '+limitedToken);
 expect(denied.statusCode,denied.body).toBe(403);expect(denied.json().error.code).toBe('FORBIDDEN');
 expect((await pool.query('SELECT revision FROM commercial_remarketing_cycles WHERE id=$1',[cycle.id])).rows[0].revision).toBe(cycle.revision);
 const applied=data(await request('POST',`/v1/remarketing-cycles/${cycle.id}/reprogram`,{offer_version_id:targetOffer.id,expected_revision:preview.cycle_revision,preview_hash:preview.preview_hash,previewed_at:preview.previewed_at}));expect(applied).toMatchObject({applied:true,scheduled:1,skipped_overdue:1,consumed_attempts:1});
 const stored=(await pool.query('SELECT * FROM commercial_remarketing_cycles WHERE id=$1',[cycle.id])).rows[0];expect(stored).toMatchObject({max_attempts:3,consumed_attempts:1,source_offer_version_id:cycle.source_offer_version_id,revision:cycle.revision+1});
 const attempts=(await pool.query('SELECT slot_id,status FROM commercial_remarketing_attempts WHERE cycle_id=$1',[cycle.id])).rows;expect(attempts).toEqual([{slot_id:'remarketing_1',status:'SENT'}]);
 const timers=(await pool.query("SELECT status,payload,due_at FROM timers WHERE workspace_id=$1 AND payload->>'cycle_id'=$2 ORDER BY due_at",[workspace,cycle.id])).rows;expect(timers.filter((timer:Body)=>timer.status==='PENDING').map((timer:Body)=>timer.payload.slot_id)).toEqual(['remarketing_3']);expect(timers.find((timer:Body)=>timer.status==='PENDING')?.payload.text).toBe('Agreement three');expect(timers.filter((timer:Body)=>timer.payload.slot_id==='remarketing_2').every((timer:Body)=>timer.status==='CANCELLED')).toBe(true);
 expect(data(await request('GET',`/v1/remarketing-cycles?contact_id=${contact.id}&status=OPEN`))).toHaveLength(1);
});

it('cancels on a customer question and rearms only the remaining quota after the seller reply is transport-confirmed',async()=>{
 conversation=(await pool.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION'",[conversation.id,workspace])).rows[0];
 conversation=await putRecord(pool,{id:conversation.id,version:conversation.version,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{...conversation.body,sequence:Number(conversation.body.sequence??0)+1,last_customer_text:'¿Qué incluye?',last_inbound_at:virtualNow,ai_pending:true,flow_state:{node_id:'commitment',stack:[],steps:1,status:'WAITING',variables:{},waiting_for:'commitment',waiting_node_id:'commitment'}}});
 await withTransaction(client=>acceptCustomerResponse(client,conversation,'synthetic-question'));
 conversation=(await pool.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION'",[conversation.id,workspace])).rows[0];
 expect(conversation.body.followup_stop_reason).toBe('CUSTOMER_REPLIED');
 expect((await pool.query("SELECT count(*)::int count FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND kind='followup' AND status='PENDING'",[workspace,conversation.id])).rows[0].count).toBe(0);
 await processAgents(100,{propose:async()=>({proposal:{reply:'Incluye el material descrito en la oferta seleccionada.',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']},usage:{input_tokens:1,output_tokens:1,cost_minor:0},provider:'fixture',model:'fixture'}),receipt:async()=>{throw new Error('UNUSED');}});
 conversation=(await pool.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION'",[conversation.id,workspace])).rows[0];
 expect(conversation.body.followup_stop_reason).toBeUndefined();
 expect(conversation.body.followup_plan).toMatchObject({status:'AWAITING_COLLECTION_ACK',resume_after_customer_reply:true});
 const sellerEffect=(await pool.query('SELECT * FROM outbox WHERE id=$1',[conversation.body.followup_plan.anchor_effect_id])).rows[0];
 expect(sellerEffect.payload.purpose).toBe('seller_reply');
 await pool.query("UPDATE outbox SET status='SENT',provider_message_id='seller-reply-fixture',result=$2,updated_at=$3 WHERE id=$1",[sellerEffect.id,{accepted_at:virtualNow},virtualNow]);
 await processConfirmedSchedules(100);
 conversation=(await pool.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION'",[conversation.id,workspace])).rows[0];
 expect(conversation.body.followup_plan).toMatchObject({status:'SCHEDULED',resume_after_customer_reply:false,anchor_effect_ids:[sellerEffect.id]});
 const pending=(await pool.query("SELECT payload FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND kind='followup' AND status='PENDING' ORDER BY payload->>'slot_id'",[workspace,conversation.id])).rows;
 expect(pending.map(row=>row.payload.slot_id)).toEqual(['remarketing_2','remarketing_3']);
 const stored=(await pool.query('SELECT consumed_attempts,max_attempts,anchor_at FROM commercial_remarketing_cycles WHERE id=$1',[cycle.id])).rows[0];
 expect(stored).toMatchObject({consumed_attempts:1,max_attempts:3});
 expect(new Date(stored.anchor_at).toISOString()).toBe(virtualNow);
});

it('shares one default attempt across products and numbers while replacing pending content without crossing offers',async()=>{
 const sharedContact=await record('contact',{name:'Shared quota contact',identity:'opaque:'+randomUUID()});
 const simulationId=conversation.body.simulation_id;
 const reminderAssets=[] as DomainRecord[];
 for(let index=0;index<6;index++)reminderAssets.push(await record('asset',{name:'Shared reminder '+index,kind:'file',mime_type:'audio/mpeg',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),status:'READY'}));
 const policy=(label:string)=>normalizeRemarketingPolicy(createDefaultRemarketingPolicy([
  {awaiting_agreement:stage(reminderAssets[0]!.id,`${label} agreement one`),awaiting_payment:stage(reminderAssets[1]!.id,`${label} payment one`)},
  {awaiting_agreement:stage(reminderAssets[2]!.id,`${label} agreement two`),awaiting_payment:stage(reminderAssets[3]!.id,`${label} payment two`)},
  {awaiting_agreement:stage(reminderAssets[4]!.id,`${label} agreement three`),awaiting_payment:stage(reminderAssets[5]!.id,`${label} payment three`)},
 ]));
 const policyA=policy('Product A'),policyB=policy('Product B');
 const accountA=await record('channel_account',{name:'Shared number A',provider:'simulator',status:'WORKING'}),accountB=await record('channel_account',{name:'Shared number B',provider:'simulator',status:'WORKING'});
 const productA=await record('product',{name:'Shared product A',status:'PUBLISHED'}),productB=await record('product',{name:'Shared product B',status:'PUBLISHED'});
 const offerA=await record('offer',{name:'Shared offer A',product_id:productA.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,sales_flow:{remarketing:policyA}}),offerB=await record('offer',{name:'Shared offer B',product_id:productB.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:12500,sales_flow:{remarketing:policyB}});
 const makeConversation=async(account:DomainRecord,product:DomainRecord,offer:DomainRecord,label:string)=>{
  const current=await record('conversation',{account_id:account.id,contact_id:sharedContact.id,product_id:product.id,offer_version_id:offer.id,simulation_id:simulationId,last_inbound_at:virtualNow,status:'OPEN',flow_state:{node_id:'commitment',stack:[],steps:1,status:'WAITING',variables:{},waiting_for:'commitment',waiting_node_id:'commitment'}});
  const anchor=(await pool.query(
   `INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash,approval_hash,provider_message_id,result)
    VALUES($1,'SIMULATION',$2,$3,$4,$5,$6,'SENT',$7,$7,$8,$9) RETURNING id`,
   [workspace,account.id,current.id,sharedContact.id,`shared-anchor:${label}:${randomUUID()}`,{kind:'text',purpose:'agreement'},randomBytes(32).toString('hex'),`shared-provider:${label}`,{accepted_at:virtualNow}],
  )).rows[0];
  return putRecord(pool,{id:current.id,version:current.version,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{...current.body,followup_plan:{key:`shared-plan:${label}`,status:'AWAITING_COLLECTION_ACK',anchor_effect_id:anchor.id,workflow_runtime_version:'shared-quota-v1',policy_snapshot:offer.body.sales_flow.remarketing,stage:'awaiting_agreement'}}});
 };
 let conversationA=await makeConversation(accountA,productA,offerA,'a');
 conversationA=await withTransaction(client=>armFollowups(client,conversationA));
 const firstCycle=(await pool.query('SELECT * FROM commercial_remarketing_cycles WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3',[workspace,'SIMULATION',sharedContact.id])).rows[0];
 expect(firstCycle).toMatchObject({source_conversation_id:conversationA.id,source_offer_version_id:offerA.id,max_attempts:1,consumed_attempts:0});
 const timerA=(await pool.query("SELECT * FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND status='PENDING' AND kind='followup'",[workspace,conversationA.id])).rows[0];
 expect(timerA.payload.text).toBe('Product A agreement one');

 let conversationB=await makeConversation(accountB,productB,offerB,'b');
 conversationB=await withTransaction(client=>armFollowups(client,conversationB));
 const switched=(await pool.query('SELECT * FROM commercial_remarketing_cycles WHERE id=$1',[firstCycle.id])).rows[0];
 expect(switched).toMatchObject({source_conversation_id:conversationB.id,source_offer_version_id:offerB.id,max_attempts:1,consumed_attempts:0});
 expect(switched.policy_snapshot.slots[0].id).toBe(firstCycle.policy_snapshot.slots[0].id);
 expect(switched.policy_snapshot.slots[0].stages.awaiting_agreement.text).toBe('Product B agreement one');
 expect((await pool.query('SELECT status FROM timers WHERE id=$1',[timerA.id])).rows[0].status).toBe('CANCELLED');
 const timerB=(await pool.query("SELECT * FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND status='PENDING' AND kind='followup'",[workspace,conversationB.id])).rows[0];
 expect(timerB.payload.text).toBe('Product B agreement one');
 const reserved=await withTransaction(client=>reserveRemarketingAttempt(client,{cycleId:firstCycle.id,workspaceId:workspace,environment:'SIMULATION',contactId:sharedContact.id,slotId:timerB.payload.slot_id,conversationId:conversationB.id,timerId:timerB.id,stage:'AGREEMENT'}));
 expect(reserved.reason).toBeUndefined();expect(reserved.cycle).toMatchObject({max_attempts:1,consumed_attempts:1});
 await setRemarketingAttemptStatus(pool,{attemptId:reserved.attempt!.id,workspaceId:workspace,environment:'SIMULATION'},'SENT',{synthetic:true});
 await pool.query("UPDATE timers SET status='FIRED' WHERE id=$1",[timerB.id]);

 conversationA=await makeConversation(accountA,productA,offerA,'a-return');
 conversationA=await withTransaction(client=>armFollowups(client,conversationA));
 const exhausted=(await pool.query('SELECT * FROM commercial_remarketing_cycles WHERE id=$1',[firstCycle.id])).rows[0];
 expect(exhausted).toMatchObject({source_conversation_id:conversationA.id,source_offer_version_id:offerA.id,max_attempts:1,consumed_attempts:1});
 expect(conversationA.body.followup_plan).toMatchObject({cycle_id:firstCycle.id,status:'DISABLED'});
 expect((await pool.query('SELECT count(*)::int count FROM commercial_remarketing_attempts WHERE cycle_id=$1',[firstCycle.id])).rows[0].count).toBe(1);
 expect((await pool.query("SELECT count(*)::int count FROM timers t JOIN records c ON c.id::text=t.conversation_id WHERE t.workspace_id=$1 AND t.environment='SIMULATION' AND t.kind='followup' AND t.status='PENDING' AND c.body->>'contact_id'=$2",[workspace,sharedContact.id])).rows[0].count).toBe(0);
});

it('advances 45m, 6h and 36h, using an eligible video template or persisting an unconsumed transport block',async()=>{
 const anchorAt='2035-03-04T12:00:00.000Z',anchorMs=Date.parse(anchorAt);
 const simulation=await record('simulation',{virtual_now:anchorAt,status:'RUNNING'});
 const audioAssets=[] as DomainRecord[],videoAssets=[] as DomainRecord[];
 for(let index=0;index<4;index++)audioAssets.push(await record('asset',{name:`Window audio ${index}`,kind:'file',mime_type:'audio/mpeg',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),status:'READY'}));
 for(let index=0;index<2;index++)videoAssets.push(await record('asset',{name:`Window video ${index}`,kind:'file',mime_type:'video/mp4',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),status:'READY'}));
 const policy=(withTemplate:boolean)=>{
  let configured=createDefaultRemarketingPolicy([
   {awaiting_agreement:stage(audioAssets[0]!.id,'Agreement at 45 minutes'),awaiting_payment:stage(audioAssets[1]!.id,'Payment at 45 minutes')},
   {awaiting_agreement:stage(audioAssets[2]!.id,'Agreement at 6 hours'),awaiting_payment:stage(audioAssets[3]!.id,'Payment at 6 hours')},
   {awaiting_agreement:{medium:'video' as const,asset_id:videoAssets[0]!.id,text:'Approved agreement reminder at 36 hours'},awaiting_payment:{medium:'video' as const,asset_id:videoAssets[1]!.id,text:'Approved payment reminder at 36 hours'}},
  ]);
  configured=replaceRemarketingDurations(configured,[{quantity:45,unit:'minutes'},{quantity:6,unit:'hours'},{quantity:36,unit:'hours'}]);
  configured=setRemarketingSlotEnabled(configured,configured.slots[1]!.id,true,true);
  configured=setRemarketingSlotEnabled(configured,configured.slots[2]!.id,true,true);
  if(withTemplate)configured={...configured,slots:configured.slots.map(slot=>slot.position===3?{...slot,stages:{awaiting_agreement:{...slot.stages.awaiting_agreement,template:{name:'agreement_reminder_36h',language:'es_MX',header_kind:'video' as const,approved:true as const}},awaiting_payment:{...slot.stages.awaiting_payment,template:{name:'payment_reminder_36h',language:'es_MX',header_kind:'video' as const,approved:true as const}}}}:slot)};
  return normalizeRemarketingPolicy(configured);
 };
 const setup=async(label:string,withTemplate:boolean)=>{
  const account=await record('channel_account',{name:`Window account ${label}`,provider:'simulator',status:'WORKING'});
  const reminderContact=await record('contact',{name:`Window contact ${label}`,identity:'opaque:'+randomUUID()});
  const product=await record('product',{name:`Window product ${label}`,status:'PUBLISHED'});
  const snapshot=policy(withTemplate);
  const offer=await record('offer',{name:`Window offer ${label}`,product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,sales_flow:{remarketing:snapshot}});
  let current=await record('conversation',{account_id:account.id,contact_id:reminderContact.id,product_id:product.id,offer_version_id:offer.id,simulation_id:simulation.id,last_inbound_at:anchorAt,status:'OPEN'});
  const anchor=(await pool.query(
   `INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash,approval_hash,provider_message_id,result)
    VALUES($1,'SIMULATION',$2,$3,$4,$5,$6,'SENT',$7,$7,$8,$9) RETURNING id`,
   [workspace,account.id,current.id,reminderContact.id,`window-anchor:${label}:${randomUUID()}`,{kind:'text',purpose:'agreement'},randomBytes(32).toString('hex'),`window-anchor-provider:${label}`,{accepted_at:anchorAt}],
  )).rows[0];
  current=await putRecord(pool,{id:current.id,version:current.version,workspaceId:workspace,environment:'SIMULATION',kind:'conversation',body:{...current.body,followup_plan:{key:`window-plan:${label}`,status:'AWAITING_COLLECTION_ACK',anchor_effect_id:anchor.id,workflow_runtime_version:'window-v1',policy_snapshot:snapshot,stage:'awaiting_agreement'}}});
  current=await withTransaction(client=>armFollowups(client,current));
  const opened=(await pool.query('SELECT * FROM commercial_remarketing_cycles WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3',[workspace,'SIMULATION',reminderContact.id])).rows[0];
  expect(opened).toMatchObject({source_conversation_id:current.id,max_attempts:3,consumed_attempts:0});
  return{account,contact:reminderContact,conversation:current,cycle:opened};
 };
 const templated=await setup('template',true),blocked=await setup('blocked',false);
 const setTime=async(seconds:number)=>{await pool.query(`UPDATE records SET body=jsonb_set(body,'{virtual_now}',to_jsonb($2::text),true),version=version+1,updated_at=now() WHERE id=$1`,[simulation.id,new Date(anchorMs+seconds*1000).toISOString()]);};
 const cycleState=async(id:string)=>(await pool.query('SELECT * FROM commercial_remarketing_cycles WHERE id=$1',[id])).rows[0];
 const slotEffects=async(conversationId:string,slotId:string)=>(await pool.query("SELECT * FROM outbox WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND payload->>'purpose'='remarketing' AND payload->>'remarketing_slot_id'=$3 ORDER BY dispatch_sequence",[workspace,conversationId,slotId])).rows;

 await setTime(45*60);await processTimers(1000);
 for(const fixture of [templated,blocked]){
  expect(await cycleState(fixture.cycle.id)).toMatchObject({consumed_attempts:1});
  expect((await slotEffects(fixture.conversation.id,'remarketing_1')).map((effect:Body)=>effect.payload.kind)).toEqual(['audio','text']);
 }
 await setTime(6*3600);await processTimers(1000);
 for(const fixture of [templated,blocked]){
  expect(await cycleState(fixture.cycle.id)).toMatchObject({consumed_attempts:2});
  expect((await slotEffects(fixture.conversation.id,'remarketing_2')).map((effect:Body)=>effect.payload.kind)).toEqual(['audio','text']);
 }
 await setTime(36*3600);await processTimers(1000);

 expect(await cycleState(templated.cycle.id)).toMatchObject({consumed_attempts:3});
 const templateEffects=await slotEffects(templated.conversation.id,'remarketing_3');
 expect(templateEffects).toHaveLength(1);
 expect(templateEffects[0]).toMatchObject({environment:'SIMULATION',status:'READY',attempts:0,payload:{kind:'template',asset_id:videoAssets[0]!.id,text:'Approved agreement reminder at 36 hours',template:{name:'agreement_reminder_36h',language:'es_MX',header_kind:'video',approved:true},template_header_kind:'video',remarketing_template_medium:'video'}});
 expect(templateEffects[0].payload.template_body_text_sha256).toMatch(/^[a-f0-9]{64}$/);
 expect(new Date(templateEffects[0].expires_at).getTime()).toBeGreaterThan(anchorMs+36*3600_000);
 expect((await pool.query("SELECT status FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND payload->>'slot_id'='remarketing_3'",[workspace,templated.conversation.id])).rows[0].status).toBe('FIRED');

 expect(await cycleState(blocked.cycle.id)).toMatchObject({consumed_attempts:2});
 expect(await slotEffects(blocked.conversation.id,'remarketing_3')).toHaveLength(0);
 expect((await pool.query("SELECT count(*)::int count FROM commercial_remarketing_attempts WHERE cycle_id=$1 AND slot_id='remarketing_3'",[blocked.cycle.id])).rows[0].count).toBe(0);
 const blockedTimer=(await pool.query("SELECT status,payload FROM timers WHERE workspace_id=$1 AND environment='SIMULATION' AND conversation_id=$2 AND payload->>'slot_id'='remarketing_3'",[workspace,blocked.conversation.id])).rows[0];
 expect(blockedTimer).toMatchObject({status:'CANCELLED',payload:{transport_status:'BLOCKED',transport_block_reason:'APPROVED_TEMPLATE_REQUIRED',quota_consumed:false}});
 const blockEvent=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND environment='SIMULATION' AND aggregate_id=$2 AND event_type='remarketing.transport_blocked' ORDER BY occurred_at DESC LIMIT 1",[workspace,blocked.conversation.id])).rows[0];
 expect(blockEvent.payload).toMatchObject({slot_id:'remarketing_3',reason:'APPROVED_TEMPLATE_REQUIRED',timer_status:'CANCELLED',quota_consumed:false});
 expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND environment='REAL' AND conversation_id IN($2,$3)",[workspace,templated.conversation.id,blocked.conversation.id])).rows[0].count).toBe(0);
});

it('blocks an otherwise eligible REAL 36h template before quota reservation when provider evidence is missing',async()=>{
 const now=new Date(),anchorAt=new Date(now.getTime()-36*3600_000).toISOString();
 const account=await realRecord('channel_account',{name:'Evidence-gated cloud account',provider:'cloud',status:'WORKING'});
 const evidenceContact=await realRecord('contact',{name:'Evidence-gated contact',identity:'opaque:'+randomUUID(),consent:{evidence:'synthetic-test-consent'}});
 const product=await realRecord('product',{name:'Evidence-gated product',status:'PUBLISHED'});
 const video=await realRecord('asset',{name:'Evidence-gated video',kind:'file',mime_type:'video/mp4',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),status:'READY'});
 let policy=createDefaultRemarketingPolicy([
  {awaiting_agreement:{medium:'video' as const,asset_id:video.id,text:'First reminder'},awaiting_payment:{medium:'video' as const,asset_id:video.id,text:'First reminder'}},
  {awaiting_agreement:{medium:'video' as const,asset_id:video.id,text:'Second reminder'},awaiting_payment:{medium:'video' as const,asset_id:video.id,text:'Second reminder'}},
  {awaiting_agreement:{medium:'video' as const,asset_id:video.id,text:'Exact approved body',template:{name:'evidence_gated_36h',language:'es_MX',header_kind:'video' as const,approved:true as const}},awaiting_payment:{medium:'video' as const,asset_id:video.id,text:'Exact approved body',template:{name:'evidence_gated_36h',language:'es_MX',header_kind:'video' as const,approved:true as const}}},
 ]);
 policy=replaceRemarketingDurations(policy,[{quantity:45,unit:'minutes'},{quantity:6,unit:'hours'},{quantity:36,unit:'hours'}]);
 policy=setRemarketingSlotEnabled(policy,policy.slots[1]!.id,true,true);policy=setRemarketingSlotEnabled(policy,policy.slots[2]!.id,true,true);
 const snapshot=normalizeRemarketingPolicy(policy),offer=await realRecord('offer',{name:'Evidence-gated offer',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700,sales_flow:{remarketing:snapshot}});
 let current=await realRecord('conversation',{account_id:account.id,contact_id:evidenceContact.id,product_id:product.id,offer_version_id:offer.id,last_inbound_at:anchorAt,status:'OPEN'});
 const planKey='real-evidence-plan:'+randomUUID();
 current=await putRecord(pool,{id:current.id,version:current.version,workspaceId:workspace,environment:'REAL',kind:'conversation',body:{...current.body,followup_plan:{key:planKey,status:'SCHEDULED',workflow_runtime_version:'real-evidence-v1',policy_snapshot:snapshot,stage:'awaiting_agreement'}}});
 const opened=await withTransaction(client=>openRemarketingCycle(client,current,{policySnapshot:snapshot,stage:'AGREEMENT',anchorAt,maxAttempts:3}));
 const slot=snapshot.slots[2]!,content=slot.stages.awaiting_agreement,timerId=randomUUID();
 await pool.query("INSERT INTO timers(id,workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,$2,'REAL',$3,'followup',$4,$5,$6)",[timerId,workspace,current.id,{...content,purpose:'remarketing',plan_key:planKey,touch_index:3,slot_id:slot.id,stage:'AGREEMENT',cycle_id:opened.id,anchor_at:anchorAt},new Date(now.getTime()-60_000).toISOString(),'real-evidence:'+randomUUID()]);

 await processTimers(1000);

 const storedTimer=(await pool.query('SELECT status,payload FROM timers WHERE id=$1',[timerId])).rows[0];
 expect(storedTimer).toMatchObject({status:'CANCELLED',payload:{transport_status:'BLOCKED',transport_block_reason:'TEMPLATE_PROVIDER_EVIDENCE_REQUIRED',quota_consumed:false}});
 expect((await pool.query('SELECT consumed_attempts FROM commercial_remarketing_cycles WHERE id=$1',[opened.id])).rows[0].consumed_attempts).toBe(0);
 expect((await pool.query('SELECT count(*)::int count FROM commercial_remarketing_attempts WHERE cycle_id=$1',[opened.id])).rows[0].count).toBe(0);
 expect((await pool.query("SELECT count(*)::int count FROM outbox WHERE workspace_id=$1 AND environment='REAL' AND conversation_id=$2",[workspace,current.id])).rows[0].count).toBe(0);
});

it('never exposes remarketing bank instructions or protected attachments to the seller model',async()=>{
 const suffix=randomUUID(),holder=`TITULAR-BANCARIO-${suffix}`,accountNumber=`646180-SENSITIVE-${suffix}`;
 const simulation=await record('simulation',{virtual_now:virtualNow,status:'RUNNING'}),account=await record('channel_account',{name:'Privacy account',provider:'simulator',status:'WORKING'}),privateContact=await record('contact',{name:'Privacy contact',identity:'opaque:'+randomUUID()}),product=await record('product',{name:'Privacy product',status:'PUBLISHED'}),offer=await record('offer',{name:'Privacy offer',product_id:product.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:9700}),asset=await record('asset',{name:'Protected attachment',kind:'file',mime_type:'image/png',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),status:'READY'}),paymentProfile=await record('bank_profile',{name:'Protected bank',bank:'Synthetic',last4:'0000',secret_ciphertext:'fixture'});
 let privateConversation=await record('conversation',{account_id:account.id,contact_id:privateContact.id,product_id:product.id,offer_version_id:offer.id,simulation_id:simulation.id,last_inbound_at:virtualNow,last_customer_text:'¿Me ayudas con otra duda?',status:'OPEN',stage:'NEW',sequence:1,ai_pending:true});
 const protectedRows=[
  {purpose:'remarketing',text:`${holder}\n${accountNumber}`},
  {purpose:'commercial',payment_profile_version_id:paymentProfile.id,text:`${holder} POR PERFIL ${accountNumber}`},
  {purpose:'commercial',asset_id:asset.id,text:`${holder} EN ADJUNTO ${accountNumber}`},
 ];
 for(const [index,payload] of protectedRows.entries()){
  const effect=(await pool.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash,approval_hash,provider_message_id) VALUES($1,'SIMULATION',$2,$3,$4,$5,$6,'SENT',$7,$7,$8) RETURNING id",[workspace,account.id,privateConversation.id,privateContact.id,`privacy-history:${suffix}:${index}`,{kind:payload.asset_id?'image':'text',...payload},randomBytes(32).toString('hex'),`privacy-provider-${index}`])).rows[0];
  await record('message',{conversation_id:privateConversation.id,contact_id:privateContact.id,account_id:account.id,direction:'OUTBOUND',kind:payload.asset_id?'image':'text',text:payload.text,...(payload.asset_id?{asset_id:payload.asset_id}:{}),status:'SENT',effect_id:effect.id,provider_message_id:`privacy-provider-${index}`});
 }
 let observed:Body|undefined;
 await processAgents(100,{propose:async(_agent,context)=>{if(context.customer_text===privateConversation.body.last_customer_text)observed=context;return{proposal:{reply:'Respuesta sintética.',intent:'question',confidence:1,tool:'none',grounding:['offer_snapshot']},usage:{input_tokens:1,output_tokens:1,cost_minor:0},provider:'fixture',model:'fixture'};},receipt:async()=>{throw new Error('UNUSED');}});
 expect(observed).toBeDefined();
 expect(observed!.history.map((item:Body)=>item.text)).toEqual(['[contenido protegido]','[contenido protegido]','[contenido protegido]']);
 expect(JSON.stringify(observed)).not.toContain(holder);
 expect(JSON.stringify(observed)).not.toContain(accountNumber);
 privateConversation=(await pool.query("SELECT * FROM records WHERE id=$1 AND workspace_id=$2 AND environment='SIMULATION'",[privateConversation.id,workspace])).rows[0];
 const run=await pool.query("SELECT body->'context_snapshot' context FROM records WHERE workspace_id=$1 AND environment='SIMULATION' AND kind='ai_run' AND body->>'conversation_id'=$2 ORDER BY created_at DESC LIMIT 1",[workspace,privateConversation.id]);
 expect(run.rows[0].context.history.map((item:Body)=>item.text)).toEqual(['[contenido protegido]','[contenido protegido]','[contenido protegido]']);
 expect(JSON.stringify(run.rows[0].context)).not.toContain(accountNumber);
});

it('recognizes any positive contributions once, excludes the buyer workspace-wide and cancels every pending contact timer',async()=>{
 const otherAccount=await record('channel_account',{name:'Synthetic two',provider:'simulator',status:'WORKING'}),otherProduct=await record('product',{name:'Other product',status:'PUBLISHED'}),otherOffer=await record('offer',{name:'Other offer',product_id:otherProduct.id,status:'PUBLISHED',currency:'MXN',base_amount_minor:25000});
 const otherConversation=await record('conversation',{account_id:otherAccount.id,contact_id:contact.id,product_id:otherProduct.id,offer_version_id:otherOffer.id,simulation_id:conversation.body.simulation_id,last_inbound_at:virtualNow,status:'OPEN'});
 await pool.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,payload,due_at,logical_key) VALUES($1,'SIMULATION',$2,'followup',$3,$4,$5)",[workspace,otherConversation.id,{purpose:'remarketing'},new Date(Date.parse(virtualNow)+3600_000).toISOString(),'cross-product:'+randomUUID()]);
 let order=await record('order',{conversation_id:otherConversation.id,contact_id:contact.id,account_id:otherAccount.id,product_id:otherProduct.id,offer_version_id:otherOffer.id,currency:'MXN',amount_minor:25000,status:'OFFERED',receipt_status:'NONE',commercial_classification:'COMMERCIAL',offer_snapshot:{...otherOffer.body,positive_payment_unlocks_all:true}});
 for(const [index,amount] of [100,5000].entries()){
  const asset=await record('asset',{name:'Receipt '+index,kind:'file',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),mime_type:'image/png',status:'READY'}),receipt=await record('receipt',{conversation_id:otherConversation.id,order_id:order.id,product_id:otherProduct.id,asset_id:asset.id,status:'APPROVED',commercial_classification:'GENUINE',extraction:{amount_minor:amount,currency:'MXN',source:'human_observation'}});
  const recognized=await withTransaction(client=>recognizeReceipt(client,receipt,{actor:'synthetic-reviewer',cause:receipt.id,paymentKey:index?'additional':'primary'}));order=recognized.order;
 }
 expect(order.body).toMatchObject({sale_status:'RECOGNIZED',sale_amount_minor:5100,sale_definition:'receipt_sales_v1'});expect(await buyerExcluded(pool,{workspace_id:workspace,environment:'SIMULATION',contact_id:contact.id})).toBe(true);
 expect((await pool.query('SELECT count(*)::int count FROM commercial_buyer_exclusions WHERE workspace_id=$1 AND environment=$2 AND contact_id=$3',[workspace,'SIMULATION',contact.id])).rows[0].count).toBe(1);
 expect((await pool.query('SELECT status,close_reason FROM commercial_remarketing_cycles WHERE id=$1',[cycle.id])).rows[0]).toMatchObject({status:'PAID',close_reason:'BUYER_RECOGNIZED'});
 expect((await pool.query("SELECT count(*)::int count FROM timers t JOIN records c ON c.id::text=t.conversation_id WHERE t.workspace_id=$1 AND t.environment='SIMULATION' AND t.kind='followup' AND t.status='PENDING' AND c.body->>'contact_id'=$2",[workspace,contact.id])).rows[0].count).toBe(0);
 await expect(withTransaction(client=>openRemarketingCycle(client,otherConversation,{policySnapshot:cycle.policy_snapshot,stage:'AGREEMENT',anchorAt:virtualNow,maxAttempts:1}))).rejects.toThrow('BUYER_EXCLUDED');
});

it('derives the buyer identity from an imported order conversation when the order predates contact snapshots',async()=>{
 const importedContact=await record('contact',{name:'Imported buyer',identity:'opaque:'+randomUUID()});
 const importedConversation=await record('conversation',{contact_id:importedContact.id,status:'OPEN'});
 const importedOrder=await record('order',{conversation_id:importedConversation.id,currency:'MXN',amount_minor:9700,status:'OFFERED',receipt_status:'NONE',commercial_classification:'COMMERCIAL',offer_snapshot:{positive_payment_unlocks_all:true,fulfillment:[]}});
 const importedAsset=await record('asset',{name:'Imported receipt',kind:'file',storage_key:randomUUID(),sha256:randomBytes(32).toString('hex'),mime_type:'image/png',status:'READY'});
 const importedReceipt=await record('receipt',{conversation_id:importedConversation.id,order_id:importedOrder.id,asset_id:importedAsset.id,status:'APPROVED',commercial_classification:'GENUINE',extraction:{amount_minor:100,currency:'MXN',source:'human_observation'}});
 await withTransaction(client=>recognizeReceipt(client,importedReceipt,{actor:'synthetic-import-reviewer',cause:importedReceipt.id,paymentKey:'primary',historical:true}));
 expect(await buyerExcluded(pool,{workspace_id:workspace,environment:'SIMULATION',contact_id:importedContact.id})).toBe(true);
});
