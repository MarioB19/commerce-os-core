import {roleExecutor} from '../support/database-role.js';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {hash,pool} from '../../packages/db/src/index.js';
import {channelIdentityHash} from '../../packages/db/src/commercial-assignments.js';
import {processNumberOperations} from '../../apps/channel-worker/src/number-operations.js';
import {processChannelCommands,heartbeatOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {processWarmup} from '../../apps/automation-worker/src/warmup.js';
import {providerFor,type ProviderFactory} from '../../apps/channel-worker/src/providers.js';
import {dispatchOutbox} from '../../apps/channel-worker/src/dispatch.js';
import {processInbound} from '../../apps/automation-worker/src/inbound.js';
const withRole=roleExecutor(pool);
const workspace='numbers-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:Awaited<ReturnType<typeof createApp>>,cookie:string;
const call=(method:any,url:string,body?:any,key=randomUUID())=>withRole('commerce_api',()=>app.inject({method,url:url+(url.includes('?')?'&':'?')+'environment=SIMULATION',payload:body,headers:{origin,cookie,'idempotency-key':key}}));
const data=(r:any,status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
beforeAll(async()=>{app=await createApp();const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Numbers test',email,password,workspace_id:workspace,role:'owner'});const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});expect(login.statusCode,login.body).toBe(200);cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');});
afterAll(async()=>{await app.close();await pool.end();});
it('creates and connects own numbers through durable HTTP operations, versions and readback',async()=>{
 const start=new Date();start.setUTCDate(start.getUTCDate()-18);start.setUTCHours(10,0,0,0);
 let clock=data(await call('POST','/v1/number-simulation',{action:'create',at:start.toISOString()}));
 const ids:string[]=[];
 for(let n=0;n<5;n++){
  const input={alias:'Equipo '+n,responsible:'Operador interno',device_ref:'Dispositivo '+n},key=randomUUID(),created=data(await call('POST','/v1/numbers',input,key),202);expect(data(await call('POST','/v1/numbers',input,key),202)).toEqual(created);ids.push(created.id);
  await withRole('commerce_channel',()=>processNumberOperations());expect(data(await call('GET','/v1/number-operations/'+created.operation_id)).state).toBe('SUCCEEDED');
  let account=data(await call('GET','/v1/numbers/'+created.id));
  const observed=data(await call('POST','/v1/numbers/'+created.id+'/observe-identity',{expected_version:account.version}),202);await withRole('commerce_channel',()=>processNumberOperations());expect(data(await call('GET','/v1/number-operations/'+observed.operation_id)).state).toBe('SUCCEEDED');
  account=data(await call('GET','/v1/numbers/'+created.id));
  data(await call('POST','/v1/numbers/'+created.id+'/confirm-identity',{expected_version:account.version,ownership_confirmed:true,name:input.alias,about:'Pruebas internas propias'}));
  account=data(await call('GET','/v1/numbers/'+created.id));
  if(n===0){expect((await call('POST','/v1/channel-accounts/'+created.id+'/commands',{type:'check_health'})).statusCode).toBe(400);expect((await call('POST','/v1/channel-accounts/'+created.id+'/commands',{type:'check_health',expected_version:account.version+1})).statusCode).toBe(409);}
  data(await call('POST','/v1/channel-accounts/'+created.id+'/commands',{type:'connect',expected_version:account.version,reason:'Conexión de adaptador aislado'}),202);
 }
 await withRole('commerce_channel',()=>processChannelCommands(20));for(const id of ids){const s=data(await call('GET','/v1/channel-accounts/'+id+'/session'));data(await call('PATCH','/v1/channel-accounts/'+id+'/session',{expected_version:s.revision,operational_pause:false,reason:'Permiso explícito sólo para ensayo'}));}
 data(await call('POST','/v1/number-simulation/groups',{name:'Grupo propio de prueba',account_ids:ids.slice(0,3)}));
 data(await call('POST','/v1/number-simulation/groups',{name:'Segundo grupo propio',account_ids:ids.slice(3)}));
 const refresh=data(await call('POST','/v1/number-groups/refresh',{account_ids:ids}),202);await withRole('commerce_channel',()=>processNumberOperations());const refreshResult=data(await call('GET','/v1/number-operations/'+refresh.operation_id));expect(refreshResult.state,JSON.stringify(refreshResult.result)).toBe('SUCCEEDED');
 const groups=data(await call('GET','/v1/number-groups'));expect(groups).toHaveLength(2);
 const contents=[];for(let n=0;n<12;n++){const draft=data(await call('POST','/v1/number-library',{label:'Prueba propia '+n,ownership_confirmed:true,turns:Array.from({length:6},(_,i)=>({kind:'text',text:'Ensayo interno '+n+' turno '+i}))}));contents.push(data(await call('POST','/v1/number-library/'+draft.id+'/approve',{expected_version:draft.version,confirmation:'APPROVE_OWN_TEST_CONTENT'})).approved_content_id);}
 let program=data(await call('POST','/v1/number-programs',{name:'Programa propio de prueba',topology:'group',group_id:groups.find((g:any)=>g.name==='Grupo propio de prueba').id,account_ids:ids.slice(0,3),content_ids:contents,profile:{name:'Quince días',timezone:'UTC',start_hour:0,end_hour:23,jitter_seconds:0},expires_at:new Date(start.getTime()+40*86400000).toISOString()}));
 for(const id of ids){const account=data(await call('GET','/v1/numbers/'+id));data(await call('POST','/v1/numbers/'+id+'/observe-identity',{expected_version:account.version}),202);}await withRole('commerce_channel',()=>processNumberOperations());
 const review=data(await call('POST','/v1/number-programs/'+program.id+'/commands',{expected_version:program.version,action:'review',reason:'Revisión de grupo propio'}));expect(review.ready,JSON.stringify(review.reasons)).toBe(true);
 program=data(await call('POST','/v1/number-programs/'+program.id+'/commands',{expected_version:review.version,action:'authorize',review:review.review,confirmation:'AUTHORIZE_REVIEWED_PROGRAM',reason:'Autorización de ensayo aislado'}));
 program=data(await call('POST','/v1/number-programs/'+program.id+'/commands',{expected_version:program.version,action:'activate',review:program.review,confirmation:'ACTIVATE_REVIEWED_PROGRAM',reason:'Activación de ensayo aislado'}));
 const automaticPreparation=data(await call('GET','/v1/numbers/'+ids[0]+'/preparation'));expect(automaticPreparation).toMatchObject({policy_version:'standard-15d/v2',declarations:[],progress:{day:1,automatic_days:0,required_automatic_days:14,manual:null}});
 let second=data(await call('POST','/v1/number-programs',{name:'Segundo programa independiente',topology:'group',group_id:groups.find((g:any)=>g.name==='Segundo grupo propio').id,account_ids:ids.slice(3),content_ids:contents,profile:{name:'Quince días',timezone:'UTC',start_hour:0,end_hour:23,jitter_seconds:0},expires_at:new Date(start.getTime()+40*86400000).toISOString()}));
 for(const action of ['review','authorize','activate'])second=data(await call('POST','/v1/number-programs/'+second.id+'/commands',{expected_version:second.version,action,reason:'Ensayo de segundo grupo',...(action==='authorize'?{review:second.review,confirmation:'AUTHORIZE_REVIEWED_PROGRAM'}:action==='activate'?{review:second.review,confirmation:'ACTIVATE_REVIEWED_PROGRAM'}:{})}));
 await withRole('commerce_channel',()=>heartbeatOwnership());await withRole('commerce_automation',()=>processWarmup());
 clock=data(await call('POST','/v1/number-simulation',{action:'advance',seconds:60,expected_version:clock.version}));
 for(const id of ids){const account=data(await call('GET','/v1/numbers/'+id));data(await call('POST','/v1/numbers/'+id+'/observe-identity',{expected_version:account.version}),202);}await withRole('commerce_channel',()=>processNumberOperations());
 const refreshed=data(await call('GET','/v1/numbers/'+ids[0]));expect(refreshed.connection).toMatchObject({state:'CONNECTED',canonical_state:'CONNECTED',status:'READY',cause:'CONNECTED'});expect(refreshed.primary_state).not.toBe('PENDING');
 // A failed provider read must yield the next batch to an independent group.
 // The scheduler orders never-considered effects by creation time. Age only
 // this fixture's scheduling metadata; outcomes still come from dispatch/ingress.
 await pool.query("UPDATE outbox SET created_at='2000-01-01' WHERE workspace_id=$1 AND account_id=ANY($2::text[])",[workspace,ids.slice(0,3)]);
 const unavailable:ProviderFactory=async account=>{const provider=await providerFor(account);return ids.slice(0,3).includes(account.id)?new Proxy(provider,{get(target,key){if(key==='group')return async()=>{throw new Error('SYNTHETIC_GROUP_READ_UNAVAILABLE');};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}}):provider;};
 await withRole('commerce_channel',()=>dispatchOutbox(1,unavailable));
 const failedRead=(await pool.query("SELECT id,status,attempts,result,updated_at FROM outbox WHERE workspace_id=$1 AND result->>'reason'='GROUP_OBSERVATION_FAILED'",[workspace])).rows;
 // The production batch is global; earlier suites can fill more than one batch.
 const backlog=(await pool.query("SELECT count(*)::int n FROM outbox WHERE status IN('READY','BLOCKED')")).rows[0].n;
 expect(failedRead).toHaveLength(1);expect(failedRead[0]).toMatchObject({status:'BLOCKED',attempts:0});
 await new Promise(resolve=>setTimeout(resolve,10));
 await withRole('commerce_channel',()=>dispatchOutbox(backlog+100,unavailable));
 const repeatedFailedRead=(await pool.query('SELECT status,attempts,result,updated_at FROM outbox WHERE id=$1',[failedRead[0].id])).rows[0];
 expect(repeatedFailedRead).toEqual({status:failedRead[0].status,attempts:failedRead[0].attempts,result:failedRead[0].result,updated_at:failedRead[0].updated_at});
 let progressed=false;
 for(let cycle=0;cycle<backlog+2&&!progressed;cycle++){
  await withRole('commerce_channel',()=>heartbeatOwnership());
  await withRole('commerce_channel',()=>dispatchOutbox(1,unavailable));
  await withRole('commerce_automation',()=>processInbound(100));
  progressed=!!(await pool.query("SELECT 1 FROM outbox WHERE workspace_id=$1 AND account_id=ANY($2::text[]) AND status='DELIVERED' LIMIT 1",[workspace,ids.slice(3)])).rowCount;
 }
 const dispatchDiagnostics=(await pool.query('SELECT status,attempts,result FROM outbox WHERE workspace_id=$1',[workspace])).rows;
 expect(progressed,JSON.stringify({backlog,dispatchDiagnostics})).toBe(true);
 expect((await pool.query('SELECT 1 FROM outbox WHERE workspace_id=$1 AND account_id=ANY($2::text[]) AND attempts>0',[workspace,ids.slice(0,3)])).rowCount).toBe(0);
 await withRole('commerce_channel',()=>dispatchOutbox(100));
 await withRole('commerce_automation',()=>processInbound(100));
 const result=(await pool.query("SELECT status,attempts,result FROM outbox WHERE workspace_id=$1",[workspace])).rows;
 expect(result.some(r=>r.status==='DELIVERED'),JSON.stringify(result)).toBe(true);expect(result.every(r=>r.attempts<=1)).toBe(true);
 expect((await pool.query("SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind IN('contact','order','conversation')",[workspace])).rows[0].n).toBe(0);
 // A changed membership invalidates only its concrete program and stops unsent turns.
 data(await call('POST','/v1/number-simulation/groups',{name:'Grupo propio de prueba',account_ids:ids.slice(0,2)}));
 data(await call('POST','/v1/number-groups/refresh',{account_ids:ids}),202);await withRole('commerce_channel',()=>processNumberOperations());
 expect(data(await call('GET','/v1/number-programs/'+program.id)).status).toBe('PAUSED');expect(data(await call('GET','/v1/number-programs/'+second.id)).status).toBe('ACTIVE');
 const before=(await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND attempts>0 AND account_id=ANY($2::text[])",[workspace,ids.slice(0,3)])).rows[0].n;
 clock=data(await call('POST','/v1/number-simulation',{action:'advance',seconds:120,expected_version:clock.version}));
 for(const id of ids){const account=data(await call('GET','/v1/numbers/'+id));data(await call('POST','/v1/numbers/'+id+'/observe-identity',{expected_version:account.version}),202);}await withRole('commerce_channel',()=>processNumberOperations());
 await withRole('commerce_channel',()=>dispatchOutbox(100));await withRole('commerce_automation',()=>processInbound(100));
 expect((await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND attempts>0 AND account_id=ANY($2::text[])",[workspace,ids.slice(0,3)])).rows[0].n).toBe(before);
 expect((await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND status IN('SENT','DELIVERED') AND account_id=ANY($2::text[])",[workspace,ids.slice(3)])).rows[0].n).toBeGreaterThan(1);
 // Accepted transport timeout retains uncertainty, content and admission, without retry.
 data(await call('POST','/v1/number-simulation/groups',{name:'Segundo grupo propio',account_ids:ids.slice(3),fault:'accepted_timeout'}));
 data(await call('POST','/v1/number-simulation',{action:'advance',seconds:180,expected_version:clock.version}));
 for(const id of ids.slice(3)){const account=data(await call('GET','/v1/numbers/'+id));data(await call('POST','/v1/numbers/'+id+'/observe-identity',{expected_version:account.version}),202);}await withRole('commerce_channel',()=>processNumberOperations());
 await withRole('commerce_channel',()=>dispatchOutbox(100));await withRole('commerce_automation',()=>processInbound(100));await withRole('commerce_channel',()=>dispatchOutbox(100));
 const uncertain=(await pool.query("SELECT id,attempts FROM outbox WHERE workspace_id=$1 AND status='UNKNOWN'",[workspace])).rows;expect(uncertain).toHaveLength(1);expect(uncertain[0].attempts).toBe(1);
 await withRole('commerce_channel',()=>dispatchOutbox(100));expect((await pool.query('SELECT attempts,status FROM outbox WHERE id=$1',[uncertain[0].id])).rows[0]).toMatchObject({attempts:1,status:'UNKNOWN'});
 second=data(await call('GET','/v1/number-programs/'+second.id));const cancelled=await call('POST','/v1/number-programs/'+second.id+'/commands',{expected_version:second.version,action:'cancel',reason:'No cancelar incertidumbre'});expect(cancelled.statusCode).toBe(409);expect(cancelled.json().error.code).toBe('RECONCILIATION_REQUIRED');


});
it('denies every new management family to a reader and does not leak resources across workspaces',async()=>{
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');await provisionUser({name:'Read-only observer',email,password,workspace_id:workspace,role:'viewer'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email,password}});expect(login.statusCode).toBe(200);const readerCookie=[login.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 const accounts=data(await call('GET','/v1/numbers')),programs=data(await call('GET','/v1/number-programs')),library=data(await call('GET','/v1/number-library')),id=accounts[0].id,program=programs[0],content=library[0];
 const writes:[string,string,any][]=[
  ['POST','/v1/numbers',{alias:'Not permitted',responsible:'Reader',device_ref:'Reader device'}],
  ['PATCH','/v1/numbers/'+id,{alias:'Not permitted',responsible:'Reader',device_ref:'Reader device',expected_version:accounts[0].version}],
  ['POST','/v1/numbers/'+id+'/observe-identity',{expected_version:accounts[0].version}],
  ['POST','/v1/numbers/'+id+'/link-access',{}],
  ['POST','/v1/numbers/'+id+'/confirm-identity',{expected_version:accounts[0].version,ownership_confirmed:true,name:'Reader',about:'No permission'}],
  ['POST','/v1/numbers/'+id+'/preparation',{expected_version:accounts[0].version,action:'start',timezone:'UTC'}],
  ['POST','/v1/numbers/batch',{items:[{key:'one',action:'create',body:{alias:'Reader',responsible:'Reader',device_ref:'Reader'}}]}],
  ['POST','/v1/number-groups/refresh',{account_ids:[id]}],
  ['POST','/v1/number-programs',{}],
  ...['review','authorize','activate','pause','resume','cancel','revoke','archive','restore'].map(action=>['POST','/v1/number-programs/'+program.id+'/commands',{expected_version:program.version,action,reason:'Reader must not mutate'}] as [string,string,any]),
  ['POST','/v1/number-library/seed',{}],['POST','/v1/number-library',{}],
  ['PATCH','/v1/number-library/'+content.id,{}],
  ['POST','/v1/number-library/'+content.id+'/approve',{expected_version:content.version,confirmation:'APPROVE_OWN_TEST_CONTENT'}],
  ['POST','/v1/number-capacity',{action:'prepare',count:20,reason:'Reader must not prepare'}],
  ['POST','/v1/number-capacity/inventory',{observed_at:new Date().toISOString(),slots:[]}]
 ];
 for(const [method,url,payload]of writes){const response=await app.inject({method:method as any,url:url+'?environment=SIMULATION',payload,headers:{origin,cookie:readerCookie,'idempotency-key':randomUUID()}});expect(response.statusCode,url+' '+response.body).toBe(403);}
 expect(data(await call('GET','/v1/numbers')).map((a:any)=>[a.id,a.version])).toEqual(accounts.map((a:any)=>[a.id,a.version]));
 const otherEmail=randomUUID()+'@example.invalid';await provisionUser({name:'Other tenant',email:otherEmail,password,workspace_id:'other-'+randomUUID(),role:'owner'});const otherLogin=await app.inject({method:'POST',url:'/api/auth/sign-in/email',headers:{origin},payload:{email:otherEmail,password}}),otherCookie=[otherLogin.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
 for(const path of ['/v1/numbers/'+id,'/v1/numbers/'+id+'/preparation','/v1/number-programs/'+program.id,'/v1/number-programs/'+program.id+'/evidence']){const response=await app.inject({method:'GET',url:path+'?environment=SIMULATION',headers:{cookie:otherCookie,origin}});expect(response.statusCode,path).toBe(404);}
});

it('pages and filters twenty numbers before a bounded batch projection',async()=>{
 const ids=Array.from({length:20},()=>randomUUID()),bindingIds=Array.from({length:20},()=>randomUUID()),assignmentIds=Array.from({length:20},()=>randomUUID()),productId=randomUUID(),hiddenOfferId=randomUUID(),hiddenWorkflowId=randomUUID();
 await pool.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'SIMULATION','product',$3)",[productId,workspace,{name:'Budget product',status:'PUBLISHED'}]);
 await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body)
  SELECT account_id,$1,'SIMULATION','channel_account',jsonb_build_object(
   'name','Budget batch '||lpad((position-1)::text,2,'0'),'responsible','Operador interno',
   'device_ref','Budget device '||position,'provider','simulator','session','default',
   'status','NEW','sending_enabled',false,'identity_verified',false
  ) FROM unnest($2::uuid[]) WITH ORDINALITY seeded(account_id,position)`,[workspace,ids]);
 await pool.query("UPDATE records SET body=body||'{\"provider\":\"waha\"}'::jsonb,version=version+1 WHERE id=$1",[ids[18]]);
 await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body) VALUES
  ($1,$2,'SIMULATION','offer',$3),($4,$2,'SIMULATION','workflow',$5)`,[
  hiddenOfferId,workspace,{name:'Scoped offer',product_id:productId,status:'PUBLISHED'},
  hiddenWorkflowId,{name:'Scoped workflow',product_id:productId,offer_version_id:hiddenOfferId,status:'PUBLISHED'},
 ]);
 await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body)
  SELECT binding_id,$1,'SIMULATION','binding',jsonb_build_object(
   'account_id',account_id::text,'product_id',$4::text,'valid_from','2026-01-01T00:00:00.000Z',
   'source','bounded-list-fixture','evidence','Synthetic integration assignment','confidence','confirmed'
  )||CASE WHEN position=18 THEN jsonb_build_object('offer_version_id',$5::text,'workflow_version_id',$6::text) ELSE '{}'::jsonb END
  FROM unnest($2::uuid[],$3::uuid[]) WITH ORDINALITY seeded(account_id,binding_id,position)`,[workspace,ids,bindingIds,productId,hiddenOfferId,hiddenWorkflowId]);
 await pool.query(`INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id)
  SELECT assignment_id,$1,'SIMULATION',account_id,$5,binding_id FROM unnest($2::uuid[],$3::uuid[],$4::uuid[]) seeded(account_id,binding_id,assignment_id)`,[workspace,ids,bindingIds,assignmentIds,productId]);
 const futureProductId=randomUUID(),futureBindingId=randomUUID(),futureAssignmentId=randomUUID();
 await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body) VALUES
  ($1,$2,'SIMULATION','product',$3),
  ($4,$2,'SIMULATION','binding',$5)`,[futureProductId,workspace,{name:'Future product',status:'PUBLISHED'},futureBindingId,{account_id:ids[19],product_id:futureProductId,valid_from:'2099-01-01T00:00:00.000Z',source:'future-list-fixture',evidence:'Synthetic future assignment',confidence:'confirmed'}]);
	 await pool.query("INSERT INTO commercial_assignments(id,workspace_id,environment,account_id,product_id,binding_id) VALUES($1,$2,'SIMULATION',$3,$4,$5)",[futureAssignmentId,workspace,ids[19],futureProductId,futureBindingId]);
	 const lineageProductId=randomUUID(),lineageProductRevisionId=randomUUID(),lineageOfferId=randomUUID(),lineageOfferRevisionId=randomUUID(),lineageWorkflowId=randomUUID(),lineageBindingId=randomUUID();
	 await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body) VALUES
	  ($1,$6,'SIMULATION','product',$7),($2,$6,'SIMULATION','product',$8),
	  ($3,$6,'SIMULATION','offer',$9),($4,$6,'SIMULATION','offer',$10),($5,$6,'SIMULATION','workflow',$11)`,[
	  lineageProductId,lineageProductRevisionId,lineageOfferId,lineageOfferRevisionId,lineageWorkflowId,workspace,
	  {name:'Lineage product v1',status:'PUBLISHED'},
	  {name:'Lineage product v2',status:'PUBLISHED',series_id:lineageProductId,source_version_id:lineageProductId},
	  {name:'Lineage offer v1',product_id:lineageProductId,status:'PUBLISHED'},
	  {name:'Lineage offer v2',product_id:lineageProductId,status:'PUBLISHED',series_id:lineageOfferId,source_version_id:lineageOfferId},
	  {name:'Lineage workflow',product_id:lineageProductId,offer_version_id:lineageOfferId,status:'PUBLISHED',entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]},
	 ]);
	 await pool.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'SIMULATION','binding',$3)",[lineageBindingId,workspace,{account_id:ids[16],product_id:lineageProductRevisionId,offer_version_id:lineageOfferRevisionId,workflow_version_id:lineageWorkflowId,valid_from:'2026-01-02T00:00:00.000Z',source:'lineage-list-fixture',evidence:'Synthetic lineage assignment',confidence:'confirmed',assignment_id:assignmentIds[16],assignment_revision:1}]);
	 await pool.query('UPDATE commercial_assignments SET product_id=$2,binding_id=$3 WHERE id=$1',[assignmentIds[16],lineageProductRevisionId,lineageBindingId]);
	 await pool.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'SIMULATION','binding',$2)",[workspace,{account_id:ids[15],product_id:productId,offer_version_id:hiddenOfferId,valid_from:'2026-01-03T00:00:00.000Z',valid_to:'not-a-timestamp',source:'malformed-legacy-fixture',evidence:'Synthetic malformed legacy validity'}]);
	 const effectiveNow=new Date((await pool.query("SELECT COALESCE((SELECT virtual_now FROM warmup_simulation_runs WHERE execution_workspace=$1 AND input->>'scenario'='numbers-lifecycle' AND status IN('RUNNING','PAUSED')),now()) current_time",[workspace])).rows[0].current_time);
 await pool.query("UPDATE records SET body=body||'{\"sending_enabled\":true,\"identity_verified\":true}'::jsonb,version=version+1 WHERE id=$1",[ids[19]]);
 await pool.query("UPDATE channel_sessions SET desired_state='RUNNING',observed_state='CONNECTED',auth_state='VERIFIED',operational_pause=false,last_health_at=$2,provider_observed_at=$2,health_expires_at=$3 WHERE account_id=$1",[ids[19],new Date(effectiveNow.getTime()-1000),new Date(effectiveNow.getTime()+60000)]);
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'bounded-list-fixture',1,false,now()+interval '1 hour')",[ids[19],workspace]);
 const authorizedAccount=(await pool.query('SELECT * FROM records WHERE id=$1',[ids[19]])).rows[0],scope={mode:'product_assignment',assignment_id:assignmentIds[19],assignment_revision:1,binding_id:bindingIds[19],product_id:productId,account_ids:[ids[19]],channel_identity_hash:channelIdentityHash(authorizedAccount),max_messages:10};
 const authorization=(await pool.query("INSERT INTO operation_authorizations(workspace_id,environment,actor_id,scope,config_hash,expires_at,configuration_version) VALUES($1,'SIMULATION','bounded-list-fixture',$2,'fixture',now()+interval '1 hour',0) RETURNING id",[workspace,scope])).rows[0];
 await pool.query('UPDATE commercial_assignments SET authorization_id=$2 WHERE id=$1',[assignmentIds[19],authorization.id]);
 await pool.query(`INSERT INTO records(workspace_id,environment,kind,body) VALUES
  ($1,'SIMULATION','health_signal',$2),($1,'SIMULATION','health_signal',$3),($1,'SIMULATION','health_signal',$4)`,[workspace,
  {account_id:ids[19],dimension:'session',scope:'account',status:'OK',source:'provider_read',observed_at:new Date(effectiveNow.getTime()-1000).toISOString(),expires_at:new Date(effectiveNow.getTime()+60000).toISOString()},
  {account_id:ids[19],dimension:'session',scope:'account',status:'BLOCKED',source:'provider_read',observed_at:new Date(effectiveNow.getTime()+60000).toISOString(),expires_at:new Date(effectiveNow.getTime()+120000).toISOString()},
  {account_id:ids[18],dimension:'session',scope:'account',status:'OK',source:'provider_read',observed_at:new Date(effectiveNow.getTime()-1000).toISOString(),expires_at:new Date(effectiveNow.getTime()+60000).toISOString()}]);
 const measured=async(url:string,headers?:Record<string,string>)=>{
  const traces:Array<{sql:string;values:any[]}>=[],target=Object.getPrototypeOf(pool) as any,original=target.query;
  target.query=function(...args:any[]){const config=args[0],sql=typeof config==='string'?config:String(config?.text??''),values=(Array.isArray(args[1])?args[1]:config?.values??[]) as any[];traces.push({sql,values});return original.apply(this,args);};
  try{const response=headers?await withRole('commerce_api',()=>app.inject({method:'GET',url:url+(url.includes('?')?'&':'?')+'environment=SIMULATION',headers})):await call('GET',url);return{response,traces};}finally{target.query=original;}
 };
 const page=await measured('/v1/numbers?q=Budget%20batch&limit=3');expect(page.response.statusCode,page.response.body).toBe(200);
 const envelope=page.response.json();expect(envelope.meta).toMatchObject({total:20,next_offset:3,counters_scope:'page',page_count:3});expect(envelope.data).toHaveLength(3);expect(envelope.data.every((item:any)=>item.alias.startsWith('Budget batch '))).toBe(true);expect(Object.values(envelope.meta.counters).reduce((sum:any,value:any)=>sum+value,0)).toBe(3);
 expect(page.traces.length).toBeLessThanOrEqual(24);
 const pagedAccounts=page.traces.find(trace=>trace.sql.includes("kind='channel_account'")&&trace.sql.includes('LIMIT $5 OFFSET $6')),sessionBatch=page.traces.find(trace=>trace.sql.includes('FROM channel_sessions WHERE'));
 expect(pagedAccounts,page.traces.map(trace=>trace.sql.slice(0,120)).join('\n')).toBeTruthy();expect(sessionBatch?.values[2]).toHaveLength(3);
	 const all=await measured('/v1/numbers?q=Budget%20batch&limit=20');expect(all.response.statusCode,all.response.body).toBe(200);expect(all.response.json().data).toHaveLength(20);expect(all.response.json().meta).toMatchObject({total:20,counters_scope:'page',page_count:20});expect(all.traces.length).toBeLessThanOrEqual(25);
 expect(all.traces.find(trace=>trace.sql.includes('FROM channel_sessions WHERE'))?.values[2]).toHaveLength(20);
 expect(all.traces.find(trace=>trace.sql.includes('JOIN records b ON b.id=a.binding_id'))?.values[2]).toHaveLength(20);
 expect(all.traces.filter(trace=>trace.sql.includes('id=ANY($3::uuid[])')&&trace.sql.includes('kind=ANY($4::text[])'))).toHaveLength(1);
 const exact=await measured('/v1/numbers?q=Budget%20batch%2019&limit=1');expect(exact.response.statusCode,exact.response.body).toBe(200);
 expect(exact.response.json()).toMatchObject({data:[{alias:'Budget batch 19'}],meta:{total:1,next_offset:null,counters_scope:'page',page_count:1}});expect(exact.traces.length).toBeLessThanOrEqual(24);
 expect(exact.traces.find(trace=>trace.sql.includes('FROM channel_sessions WHERE'))?.values[2]).toHaveLength(1);
 const listed=exact.response.json().data[0];expect(listed.sales_readiness).toHaveLength(1);expect(listed.sales_readiness[0].product_id).toBe(productId);expect(listed.sales_readiness[0].checks.map((check:any)=>check.code)).not.toContain('health');expect(listed.sales_readiness[0].checks.map((check:any)=>check.code)).toContain('assignment');
		 const detail=data(await call('GET','/v1/numbers/'+ids[19]));expect(detail.sales_readiness).toHaveLength(1);expect(detail.sales_readiness.some((item:any)=>item.assignment_id===futureAssignmentId)).toBe(false);expect(listed.sales_readiness[0].ready).toBe(false);expect(listed.sales_readiness[0].ready).toBe(detail.sales_readiness.find((item:any)=>item.assignment_id===assignmentIds[19]).ready);
		 await pool.query('UPDATE session_ownership SET frozen=true WHERE workspace_id=$1 AND account_id=$2',[workspace,ids[19]]);const frozenListed=data(await call('GET','/v1/numbers?q=Budget%20batch%2019&limit=1'))[0],frozenDetail=data(await call('GET','/v1/numbers/'+ids[19])),frozenSetup=data(await call('GET','/v1/channel-accounts/'+ids[19]+'/setup'));expect(frozenListed.primary_state).toBe('ATTENTION');expect(frozenDetail.primary_state).toBe('ATTENTION');expect(frozenListed.sales_readiness[0].checks.map((check:any)=>check.code)).toContain('ownership');expect(frozenDetail.sales_readiness[0].checks.map((check:any)=>check.code)).toContain('ownership');expect(frozenSetup.checks.find((check:any)=>check.key==='ownership').ok).toBe(false);await pool.query('UPDATE session_ownership SET frozen=false WHERE workspace_id=$1 AND account_id=$2',[workspace,ids[19]]);
	 const lineageListed=data(await call('GET','/v1/numbers?q=Budget%20batch%2016&limit=1'))[0],lineageDetail=data(await call('GET','/v1/numbers/'+ids[16]));
	 expect(lineageListed.sales_readiness[0].checks.map((check:any)=>check.code)).not.toContain('assignment');expect(lineageDetail.sales_readiness[0].checks.map((check:any)=>check.code)).not.toContain('assignment');
	 await pool.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'SIMULATION','health_signal',$2)",[workspace,{account_id:ids[18],dimension:'restriction',scope:'account',status:'BLOCKED',source:'provider_read',observed_at:new Date(effectiveNow.getTime()-120000).toISOString(),expires_at:new Date(effectiveNow.getTime()-60000).toISOString()}]);
	 const expiredRestrictionList=data(await call('GET','/v1/numbers?q=Budget%20batch%2018&limit=1'))[0],expiredRestrictionDetail=data(await call('GET','/v1/numbers/'+ids[18]));expect(expiredRestrictionList.reason_code).not.toBe('CONFIRMED_RESTRICTION');expect(expiredRestrictionDetail.reason_code).not.toBe('CONFIRMED_RESTRICTION');
 const wahaBefore=data(await call('GET','/v1/numbers?q=Budget%20batch%2018&limit=1'));expect(wahaBefore[0].sales_readiness[0].checks.map((check:any)=>check.code)).toContain('health');
 await pool.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'SIMULATION','health_signal',$2)",[workspace,{account_id:ids[18],dimension:'restriction',scope:'account',status:'OK',source:'provider_read',value:{latest_read:{timelock:true,capping:true}},observed_at:new Date(effectiveNow.getTime()-500).toISOString(),expires_at:new Date(effectiveNow.getTime()+60000).toISOString()}]);
 const wahaAfter=data(await call('GET','/v1/numbers?q=Budget%20batch%2018&limit=1'));expect(wahaAfter[0].sales_readiness[0].checks.map((check:any)=>check.code)).not.toContain('health');
	 const scopedToken=randomBytes(32).toString('base64url');await pool.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at,allowed_environments,resource_ids) VALUES($1,'bounded-list-reader','Bounded list reader',$2,$3,now()+interval '1 hour',$4,$5)",[workspace,hash(scopedToken),JSON.stringify(['channels:read']),JSON.stringify(['SIMULATION']),JSON.stringify([ids[17],productId])]);
	 for(const path of ['/v1/numbers?q=Budget%20batch%2017&limit=1','/v1/numbers/'+ids[17]]){const scoped=await measured(path,{authorization:'Bearer '+scopedToken});expect(scoped.response.statusCode,scoped.response.body).toBe(200);const payload=scoped.response.json(),number=path.includes('?')?payload.data[0]:payload.data;expect(number).toMatchObject({id:ids[17],sales_readiness:[]});for(const hidden of [hiddenOfferId,hiddenWorkflowId]){expect(JSON.stringify(payload)).not.toContain(hidden);expect(JSON.stringify(scoped.traces.map(trace=>trace.values))).not.toContain(hidden);}}
	 const scopedSetup=await measured('/v1/numbers/'+ids[17]+'/setup',{authorization:'Bearer '+scopedToken});expect(scopedSetup.response.statusCode,scopedSetup.response.body).toBe(200);const productStep=scopedSetup.response.json().data.steps.find((step:any)=>step.key==='PRODUCT');expect(productStep.evidence).toMatchObject({assignment_count:0,valid_assignment_count:0});for(const hidden of [hiddenOfferId,hiddenWorkflowId])expect(JSON.stringify(scopedSetup.response.json())).not.toContain(hidden);
 const state=await measured('/v1/numbers?q=Budget%20batch&state=PENDING&limit=3');expect(state.response.statusCode,state.response.body).toBe(200);expect(state.response.json().meta).toMatchObject({total:19,counters_scope:'page',page_count:3});expect(Object.values(state.response.json().meta.counters).reduce((sum:any,value:any)=>sum+value,0)).toBe(3);expect(state.traces.find(trace=>trace.sql.includes("kind='channel_account'")&&trace.sql.includes('LIMIT $5'))?.values[4]).toBe(101);
 const overflowIds=Array.from({length:101},()=>randomUUID());await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body) SELECT account_id,$1,'SIMULATION','channel_account',jsonb_build_object('name','State overflow '||position,'provider','simulator') FROM unnest($2::uuid[]) WITH ORDINALITY seeded(account_id,position)`,[workspace,overflowIds]);
 const overflow=await measured('/v1/numbers?q=State%20overflow&state=PENDING&limit=1');expect(overflow.response.statusCode,overflow.response.body).toBe(422);expect(overflow.response.json().error.code).toBe('STATE_FILTER_TOO_BROAD');expect(overflow.traces.some(trace=>trace.sql.includes('FROM channel_sessions WHERE'))).toBe(false);
});
