import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord} from '../../packages/db/src/index.js';

const workspace='home-permissions-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const cookies:Record<string,string>={},ids:Record<string,string>={};
let app:Awaited<ReturnType<typeof createApp>>,actor='';

beforeAll(async()=>{
 app=await createApp();
 // V7 F2 (D-23): memberships are owner/operator/viewer. Historical reconciler is
 // adopted as operator, analyst as viewer, and a former member has no active
 // membership (the historical 403 for a role without home access).
 for(const [who,role] of [['owner','owner'],['operator','operator'],['reconciler','operator'],['analyst','viewer'],['viewer','viewer'],['former','viewer']] as const){
  const email=`home-${who}-${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url'),user=await provisionUser({name:`Home ${who}`,email,password,workspace_id:workspace,role});
  ids[who]=user.id;if(who==='owner')actor=user.id;
  const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin},remoteAddress:`192.0.2.${20+Object.keys(cookies).length}`});expect(login.statusCode,login.body).toBe(200);
  cookies[who]=login.cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join('; ');
 }
 const channel=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Canal restringido',provider:'waha',status:'DISCONNECTED',sending_enabled:false}});
 await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'conversation',body:{status:'OPEN',stage:'HUMAN_REVIEW',flow_state:{status:'HUMAN_REVIEW'}}});
 await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'receipt',body:{status:'HUMAN_REVIEW'}});
 await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,result,idempotency_key) VALUES($1,'REAL','channel_command',$2,$3,$4,'FAILED',$5,$6)",[workspace,channel.id,actor,{type:'connect'},{remote_outcome:'UNKNOWN'},randomUUID()]);
});
afterAll(async()=>{await app.close();await pool.end();});

const summary=async(role:string)=>{
 const response=await app.inject({method:'GET',url:'/v1/home/operations-summary?environment=REAL',headers:{origin,cookie:cookies[role]}});
 expect(response.statusCode,response.body).toBe(200);return response.json().data;
};

it('returns only sections and destinations readable by each reporting role',async()=>{
 const owner=await summary('owner');expect(owner.sections.map((section:any)=>section.key)).toEqual(['numbers','sales','operations','capacity']);
 expect(owner.sections.find((section:any)=>section.key==='operations').queue).toEqual(expect.arrayContaining([expect.objectContaining({reason_code:'REMOTE_OUTCOME_UNKNOWN',href:'/settings?section=audit'}),expect.objectContaining({reason_code:'REAL_POLICY_FROZEN',href:'/settings'})]));
 expect(owner.priority.href).toBe('/settings?section=audit');

 const viewer=await summary('viewer');expect(viewer.sections.map((section:any)=>section.key)).toEqual(['numbers','sales','capacity']);
 const viewerSales=viewer.sections.find((section:any)=>section.key==='sales');expect(viewerSales.summary.metrics.receipts_review).toBe(0);expect(viewerSales.queue.every((item:any)=>item.reason_code!=='RECEIPT_HUMAN_REVIEW')).toBe(true);

 const analyst=await summary('analyst');expect(analyst.sections.map((section:any)=>section.key)).toEqual(['numbers','sales','capacity']);
 expect(analyst.sections.find((section:any)=>section.key==='sales').queue.every((item:any)=>item.reason_code!=='RECEIPT_HUMAN_REVIEW')).toBe(true);

 for(const role of ['operator','reconciler']){const result=await summary(role);expect(result.sections.map((section:any)=>section.key)).toEqual(['numbers','sales','operations','capacity']);expect(result.sections.find((section:any)=>section.key==='operations').queue).toEqual(expect.arrayContaining([expect.objectContaining({reason_code:'REMOTE_OUTCOME_UNKNOWN',href:'/settings?section=audit'}),expect.objectContaining({reason_code:'REAL_POLICY_FROZEN',href:'/settings'})]));}
 await pool.query('UPDATE memberships SET active=false WHERE user_id=$1 AND workspace_id=$2',[ids.former,workspace]);
 const denied=await app.inject({method:'GET',url:'/v1/home/operations-summary?environment=REAL',headers:{origin,cookie:cookies.former}});expect(denied.statusCode).toBe(403);
 },60000);

it('separates policy-held effects from technical blockers without changing either',async()=>{
 const isolated='home-held-'+randomUUID(),email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Home held-effects fixture',email,password,workspace_id:isolated,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}}),cookie=login.cookies.map(item=>`${item.name}=${item.value}`).join('; ');
 const insert=async(reason:string)=>pool.query(`INSERT INTO outbox(id,workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,status,config_hash,result,expires_at) VALUES($1,$2,'REAL',$3,$4,$5,$6,'{}','BLOCKED','fixture',$7,now()+interval '1 hour')`,[randomUUID(),isolated,randomUUID(),randomUUID(),randomUUID(),randomUUID(),{reason}]);
 await insert('REAL_OPERATION_NOT_ENABLED');await insert('CAUSAL_PREDECESSOR_UNRESOLVED');
 const read=async()=>{const response=await app.inject({method:'GET',url:'/v1/home/operations-summary?environment=REAL',headers:{origin,cookie}});expect(response.statusCode,response.body).toBe(200);return response.json().data.sections.find((section:any)=>section.key==='operations');};
 const held=await read();expect(held).toMatchObject({status:'REQUIRES_ATTENTION',summary:{primary:'REAL congelado',secondary:'2 efectos retenidos por autorización/política.',metrics:{blocked:2,retained:2,technical_blocked:0}}});expect(held.queue).toEqual(expect.arrayContaining([expect.objectContaining({reason_code:'REAL_POLICY_FROZEN'}),expect.objectContaining({reason_code:'RETAINED_EFFECTS'})]));
 await insert('CHANNEL_HEALTH_BLOCKED');const technical=await read();expect(technical).toMatchObject({status:'BLOCKED',summary:{primary:'1 bloqueo técnico',metrics:{blocked:3,retained:2,technical_blocked:1}}});expect(technical.queue).toEqual(expect.arrayContaining([expect.objectContaining({reason_code:'TECHNICAL_EFFECT_BLOCKED'})]));
	 await pool.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,payload,status,idempotency_key) VALUES($1,'REAL','fixture_operation',$2,'fixture','{}','PENDING',$3)",[isolated,randomUUID(),randomUUID()]);const mixed=await read();expect(mixed).toMatchObject({status:'BLOCKED',summary:{primary:'1 bloqueo técnico',metrics:{pending:1,technical_blocked:1}}});
 expect((await pool.query("SELECT count(*)::int n FROM outbox WHERE workspace_id=$1 AND status='BLOCKED'",[isolated])).rows[0].n).toBe(3);
});

it('surfaces expired ownership even when provider health remains connected and fresh',async()=>{
 const channel=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Lease fixture',provider:'waha',status:'WORKING',identity_verified:true}});
 await pool.query("UPDATE channel_sessions SET observed_state='CONNECTED',last_health_at=now(),health_expires_at=now()+interval '2 minutes' WHERE account_id=$1",[channel.id]);
 await pool.query("INSERT INTO session_ownership(account_id,workspace_id,owner_id,generation,frozen,lease_expires_at) VALUES($1,$2,'fixture-worker',1,false,now()-interval '1 hour')",[channel.id,workspace]);
 const result=await summary('owner');
 expect(result.sections.find((section:any)=>section.key==='numbers').queue).toContainEqual(expect.objectContaining({id:channel.id,reason_code:'OWNERSHIP_EXPIRED',priority:'HIGH'}));
 expect(result.sections.find((section:any)=>section.key==='capacity').queue).toContainEqual(expect.objectContaining({reason_code:'OWNERSHIP_EXPIRED'}));
});


it('reports worker progress failures even when its heartbeat is freshly written',async()=>{
 const body={service:'channel-worker',status:'BLOCKED',observed_at:new Date().toISOString(),expires_at:new Date(Date.now()+60_000).toISOString()};
 const heartbeat=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'service_heartbeat',body});
 const blocked=(await summary('owner')).sections.find((section:any)=>section.key==='operations');
 expect(blocked.queue).toContainEqual(expect.objectContaining({reason_code:'CHANNEL_WORKER_BLOCKED',priority:'HIGH'}));
 expect(blocked.summary.metrics.channel_worker.ready).toBe(false);
 await putRecord(pool,{id:heartbeat.id,version:heartbeat.version,workspaceId:workspace,environment:'REAL',kind:'service_heartbeat',body:{...body,status:'OK'}});
 const recovered=(await summary('owner')).sections.find((section:any)=>section.key==='operations');
 expect(recovered.summary.metrics.channel_worker.ready).toBe(true);
 expect(recovered.queue.some((item:any)=>String(item.reason_code).startsWith('CHANNEL_WORKER'))).toBe(false);
});
