import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool, putRecord,withTransaction,readOperationalSettings,writeOperationalSettings} from '../../packages/db/src/index.js';
import {buildChannelServer} from '../../apps/channel-worker/src/server.js';
import {processChannelCommands,recordHealth,acquireOwnership} from '../../apps/channel-worker/src/lifecycle.js';
import {gateDispatch} from '../../apps/channel-worker/src/dispatch.js';
import {SimulatorProvider,WahaProvider,ProviderError} from '../../packages/messaging/src/index.js';
import type {ProviderFactory} from '../../apps/channel-worker/src/providers.js';

const workspace = 'qr-audit-' + randomUUID();
const origin = (process.env.TRUSTED_ORIGINS ?? 'http://localhost:5173').split(',')[0]!;
let app: FastifyInstance, cookie: string, accountId: string;
const servers:FastifyInstance[]=[];
async function policy(changes:Record<string,unknown>){await withTransaction(async c=>{const current=await readOperationalSettings(c,workspace,'REAL',{lock:'update'});await writeOperationalSettings(c,workspace,'REAL',current.version,{...current.body,...changes},'synthetic-onboarding-test');});}
async function channel(factory:ProviderFactory) {
  const server=await buildChannelServer(factory);servers.push(server);
  process.env.CHANNEL_INTERNAL_URL=await server.listen({host:'127.0.0.1',port:0});
  process.env.INTERNAL_SERVICE_TOKEN=randomBytes(24).toString('hex');
  process.env.ALLOW_CHANNEL_ONBOARDING='true';process.env.ALLOW_REAL_OPERATIONS='false';process.env.REAL_SENDS_ENABLED='false';process.env.DISPATCH_FROZEN='true';
  await policy({allow_channel_onboarding:true});return server;
}
const getQr=(id=accountId,headers:Record<string,string>={cookie})=>app.inject(explicitFixtureEnvironment({method:'GET',url:`/v1/channel-accounts/${id}/qr?environment=REAL`,headers}));
beforeAll(async () => {
  app = await createApp();
  const email = randomUUID() + '@example.invalid', password = randomBytes(24).toString('base64url');
  await provisionUser({name:'Synthetic QR audit', email, password, workspace_id:workspace, role:'owner'});
  const login = await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.26',payload:{email,password},headers:{origin}}));
  cookie = (Array.isArray(login.headers['set-cookie']) ? login.headers['set-cookie'] : [login.headers['set-cookie']]).filter(Boolean).map(x => String(x).split(';')[0]).join('; ');
  accountId = (await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Synthetic isolated account',provider:'waha',gateway_ref:'QR_'+randomUUID().replaceAll('-','').toUpperCase(),sending_enabled:false}})).id;
});
afterAll(async () => {for(const server of servers)await server.close();await app.close();await pool.end();});

describe('Channel onboarding environment contract', () => {
  it('reproduces NOT_FOUND before the worker when the UI omits REAL', async () => {
    for (const [method,path,payload] of [['GET','qr',undefined],['POST','commands',{type:'connect'}]] as const) {
      const response = await app.inject(explicitFixtureEnvironment({method,url:`/v1/channel-accounts/${accountId}/${path}`,payload,headers:{cookie,origin,'idempotency-key':randomUUID()}}));
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
    const explicit = await app.inject(explicitFixtureEnvironment({method:'POST',url:`/v1/channel-accounts/${accountId}/commands?environment=REAL`,payload:{type:'connect'},headers:{cookie,origin,'idempotency-key':randomUUID()}}));
    expect(explicit.statusCode).toBe(202);
    expect(explicit.json().data.environment).toBe('REAL');
    const command = (await pool.query('SELECT status FROM commands WHERE id=$1',[explicit.json().data.id])).rows[0];
    expect(command.status).toBe('PENDING');
    expect((await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].count).toBe('0');
  });
  it('traces provider 404 as missing session through authenticated API and worker without persisting raw responses',async()=>{
    const provider=new SimulatorProvider();provider.qr=async()=>{throw new ProviderError('PROVIDER_HTTP_404',404);};
    await channel(()=>provider);
    const response=await getQr();expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({code:'SESSION_NOT_FOUND',diagnostic:{operation:'get_qr',retryable:true,technical_intervention:false,account_status:'UNKNOWN'}});
    expect(response.json().error.diagnostic.diagnostic_id).toBeTruthy();
    const logs=(await pool.query("SELECT payload FROM domain_events WHERE workspace_id=$1 AND event_type='channel.qr_failed'",[workspace])).rows;
    expect(logs.find(r=>r.payload.diagnostic_id===response.json().error.diagnostic.diagnostic_id)?.payload).toMatchObject({code:'SESSION_NOT_FOUND',stage:'channel_worker',upstream_http_status:409,provider_http_status:404});
    expect(JSON.stringify(logs)).not.toContain(process.env.INTERNAL_SERVICE_TOKEN);
    expect(response.headers['cache-control']).toContain('no-store');
  });
  it('authorizes onboarding independently from sending, never persists QR, and denies other workspaces or anonymous callers',async()=>{
    const provider=new SimulatorProvider();let calls=0;const material='iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';provider.qr=async()=>{calls++;return {mimeType:'image/png',data:material,expiresAt:new Date(Date.now()+15_000).toISOString()};};
    const server=await channel(()=>provider);
    expect((await getQr(accountId,{})).statusCode).toBe(401);
    const scoped=await server.inject(explicitFixtureEnvironment({method:'GET',url:`/accounts/${accountId}/qr`,headers:{authorization:'Bearer '+process.env.INTERNAL_SERVICE_TOKEN,'x-workspace-id':'other-workspace'}}));
    expect(scoped.statusCode).toBe(404);expect(calls).toBe(0);
    await policy({allow_channel_onboarding:false});expect((await getQr()).statusCode).toBe(403);expect(calls).toBe(0);
    await policy({allow_channel_onboarding:true});expect((await getQr()).statusCode).toBe(200);expect(calls).toBe(1);
    const persisted=await pool.query('SELECT payload FROM domain_events WHERE workspace_id=$1',[workspace]);
    expect(JSON.stringify(persisted.rows)).not.toContain(material);
    expect((await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].count).toBe('0');
  });
  it('freezes a failed lifecycle and identity change without affecting another account',async()=>{
    const bad=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Failed isolated fixture',provider:'waha',gateway_ref:'QR_'+randomUUID().replaceAll('-','').toUpperCase(),status:'SCAN_QR_CODE',sending_enabled:false}});
    const good=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Healthy isolated fixture',provider:'waha',gateway_ref:'QR_'+randomUUID().replaceAll('-','').toUpperCase(),status:'WORKING',identity_fingerprint:'previous-synthetic-identity'}});
    await acquireOwnership(good,'onboarding-test-owner');await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[good.id]);
    const response=await app.inject(explicitFixtureEnvironment({method:'POST',url:`/v1/channel-accounts/${bad.id}/commands?environment=REAL`,payload:{type:'connect'},headers:{cookie,origin,'idempotency-key':randomUUID()}}));
    const provider=new SimulatorProvider();provider.lifecycle=async()=>{throw new ProviderError('PROVIDER_HTTP_401',401);};
    await processChannelCommands(100,()=>provider,'onboarding-test-owner');
    const result=(await pool.query('SELECT * FROM commands WHERE id=$1',[response.json().data.id])).rows[0];expect(result.status).toBe('FAILED');expect(result.result.error).toBe('GATEWAY_AUTH_REJECTED');
    expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[bad.id])).rows[0].frozen).toBe(true);
    expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[good.id])).rows[0].frozen).toBe(false);
    provider.health=async()=>[{dimension:'session',status:'OK',value:'WORKING',source:'provider_read',scope:'account',availability:'supported',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()},{dimension:'transport',status:'OK',value:{identity_verified:true,identity_fingerprint:'changed-synthetic-identity'},source:'provider_read',scope:'account',availability:'supported',observedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()}];
    await recordHealth(good,()=>provider);
    expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[good.id])).rows[0].frozen).toBe(true);
    const state=(await pool.query('SELECT body FROM records WHERE id=$1',[good.id])).rows[0].body;expect(state.identity_verified).toBe(false);expect(state.identity_conflict).toBe(true);
    const restoredSignals=await provider.health();provider.health=async()=>restoredSignals.map(s=>s.dimension==='transport'?{...s,value:{identity_verified:true,identity_fingerprint:'previous-synthetic-identity'}}:s);
    await recordHealth(good,()=>provider);
    const restored=(await pool.query('SELECT body FROM records WHERE id=$1',[good.id])).rows[0].body;expect(restored.identity_verified).toBe(true);expect(restored.identity_conflict).toBe(false);
    expect((await pool.query('SELECT frozen FROM session_ownership WHERE account_id=$1',[good.id])).rows[0].frozen).toBe(true);
  });
  it('rejects concurrent duplicate gateway registration and conflicting edits',async()=>{
    const ref='QR_'+randomUUID().replaceAll('-','').toUpperCase();
    const create=(name:string,gateway_ref=ref)=>app.inject(explicitFixtureEnvironment({method:'POST',url:'/v1/channel-accounts?environment=REAL',payload:{name,provider:'waha',gateway_ref},headers:{cookie,origin,'idempotency-key':randomUUID()}}));
    const attempts=await Promise.all([create('Concurrent synthetic A'),create('Concurrent synthetic B')]);expect(attempts.map(x=>x.statusCode).sort()).toEqual([201,409]);
    const rejected=attempts.find(x=>x.statusCode===409)!;expect(rejected.json().error.code).toBe('CHANNEL_GATEWAY_ALREADY_ASSIGNED');
    const other=(await create('Other synthetic gateway',ref+'_OTHER')).json().data;
    const edit=await app.inject(explicitFixtureEnvironment({method:'PATCH',url:`/v1/channel-accounts/${other.id}?environment=REAL`,payload:{expected_version:other.version,gateway_ref:ref},headers:{cookie,origin,'idempotency-key':randomUUID()}}));expect(edit.statusCode).toBe(409);
  });
  it('requires verified identity at the final deterministic dispatch gate even if operational flags were enabled',async()=>{
    const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Identity gate synthetic',provider:'waha',gateway_ref:'QR_'+randomUUID().replaceAll('-','').toUpperCase(),status:'WORKING',identity_verified:false,sending_enabled:true}});
    const contact=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'contact',body:{name:'Synthetic gate contact'}});
    const conversation=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'conversation',body:{account_id:account.id,contact_id:contact.id}});
    await acquireOwnership(account,'identity-test-owner');await pool.query('UPDATE session_ownership SET frozen=false WHERE account_id=$1',[account.id]);
    const previous={DISPATCH_FROZEN:process.env.DISPATCH_FROZEN,REAL_SENDS_ENABLED:process.env.REAL_SENDS_ENABLED,ALLOW_REAL_OPERATIONS:process.env.ALLOW_REAL_OPERATIONS};
    try{await policy({dispatch_frozen:false,real_sends_enabled:true,allow_real_operations:true});const decision=await gateDispatch(pool,{workspace_id:workspace,environment:'REAL',account_id:account.id,contact_id:contact.id,conversation_id:conversation.id,expires_at:new Date(Date.now()+60_000),payload:{actor_kind:'human'}},'identity-test-owner');expect(decision).toEqual({allowed:false,reason:'CONNECTED_IDENTITY_NOT_CONFIRMED'});}
    finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
  });
  it.skipIf(!process.env.QR_GATEWAY_URL)('reaches an actual ephemeral PNG through API, channel and the pinned WAHA container without scanning',async()=>{
    const provider=new WahaProvider({baseUrl:process.env.QR_GATEWAY_URL!,apiKey:process.env.QR_GATEWAY_KEY!,session:'default',engine:'GOWS',timeoutMs:10_000});
    await channel(()=>provider);
    const account=await putRecord(pool,{workspaceId:workspace,environment:'REAL',kind:'channel_account',body:{name:'Disposable real gateway verification',provider:'waha',gateway_ref:'QR_'+randomUUID().replaceAll('-','').toUpperCase(),sending_enabled:false}});
    const command=await app.inject(explicitFixtureEnvironment({method:'POST',url:`/v1/channel-accounts/${account.id}/commands?environment=REAL`,payload:{type:'connect'},headers:{cookie,origin,'idempotency-key':randomUUID()}}));expect(command.statusCode).toBe(202);
    await processChannelCommands(100,()=>provider,'onboarding-test-owner');
    let ready=false;for(let attempt=0;attempt<30;attempt++){const signals=await recordHealth(account,()=>provider);if(signals.some(s=>s.dimension==='session'&&s.value==='SCAN_QR_CODE')){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,1000));}
    expect(ready,'Gateway must really reach SCAN_QR_CODE').toBe(true);
    const response=await getQr(account.id);expect(response.statusCode).toBe(200);const qr=response.json().data;expect(qr.mimeType).toBe('image/png');expect(Buffer.from(qr.data,'base64').subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');expect(Date.parse(qr.expiresAt)).toBeGreaterThan(Date.now());
    const persisted=JSON.stringify((await pool.query('SELECT payload FROM domain_events WHERE workspace_id=$1',[workspace])).rows);expect(persisted.includes(qr.data)).toBe(false);
    expect((await pool.query('SELECT count(*) FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].count).toBe('0');
  });
});
