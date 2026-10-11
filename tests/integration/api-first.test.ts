import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord} from '../../packages/db/src/index.js';

const workspace='api-first-'+randomUUID(),origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string,token:string,tokenId:string;
const scopes=['products:read','products:write','products:publish','offers:read','offers:write','offers:publish','workflows:read','workflows:draft','workflows:publish'];
const simulationUrl=(url:string)=>url+(url.includes('environment=')?'':(url.includes('?')?'&':'?')+'environment=SIMULATION');
const owner=(method:any,url:string,payload?:any,key=randomUUID())=>app.inject({method,url:simulationUrl(url),payload,headers:{origin,cookie,'idempotency-key':key}});
const service=(method:any,url:string,payload?:any,key=randomUUID(),credential=token)=>app.inject({method,url:simulationUrl(url),payload,headers:{authorization:'Bearer '+credential,'idempotency-key':key}});
const data=(result:any,status=200)=>{expect(result.statusCode,result.body).toBe(status);return result.json().data;};
const definition=(name='API flow')=>({name,entry_node_id:'start',nodes:[{id:'start',type:'entry',config:{},next:'end'},{id:'end',type:'end',config:{}}]});

beforeAll(async()=>{
 app=await createApp();const email='api-first-'+randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic API owner',email,password,workspace_id:workspace,role:'owner'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.21',payload:{email,password},headers:{origin}});expect(login.statusCode).toBe(200);
 cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
 const created=data(await owner('POST','/v1/service-tokens',{name:'Catalog automation',scopes,allowed_environments:['SIMULATION','REAL'],expires_at:new Date(Date.now()+3600000).toISOString()}),201);token=created.token;tokenId=created.id;
});
afterAll(async()=>{await app.close();await pool.end();});

describe('API-first catalog using real auth, HTTP handlers and isolated PostgreSQL',()=>{
 it('creates, versions, validates, publishes and relates resources without business effects',async()=>{
  const key=randomUUID(),payload={name:'API-first product',references:[{label:'Specification',url:'https://example.invalid/product'}]};
  const product=data(await service('POST','/v1/products',payload,key),201);
  expect(data(await service('GET','/v1/products/'+product.id)).name).toBe(payload.name);
  expect(data(await service('POST','/v1/products',payload,key),201).id).toBe(product.id);
  expect((await service('POST','/v1/products',{...payload,name:'Changed'},key)).statusCode).toBe(409);
  // Owner prepares payment references; automation only receives opaque IDs.
  const bank=data(await owner('POST','/v1/bank-profiles',{name:'Synthetic bank',bank:'Fixture',holder:'Synthetic holder',account_number:'0000'}),201);
  const policy=data(await owner('POST','/v1/receipt-policies',{name:'Synthetic policy'}),201);
  const asset=data(await service('POST','/v1/assets',{name:'Synthetic material',kind:'link',url:'https://example.invalid/material'}),201);
  const offerInput={currency:'MXN',base_amount_minor:9900,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,fulfillment:[{asset_id:asset.id,release_on:'receipt_approved'}]};
  const offerKey=randomUUID(),offer=data(await service('POST',`/v1/products/${product.id}/offers`,offerInput,offerKey),201);
  expect(data(await service('POST',`/v1/products/${product.id}/offers`,offerInput,offerKey),201).id).toBe(offer.id);
  const workflow=data(await service('POST','/v1/workflows',{...definition(),product_id:product.id,offer_version_id:offer.id}),201);
  expect(data(await service('POST',`/v1/workflows/${workflow.id}/validate`,{}))).toMatchObject({valid:true,errors:[],issues:[]});
  const publishKey=randomUUID(),published=data(await service('POST',`/v1/workflows/${workflow.id}/publish`,{expected_version:1},publishKey));
  expect(published).toMatchObject({status:'PUBLISHED',product_id:product.id,offer_version_id:offer.id,sending_enabled:false});
  expect(data(await service('POST',`/v1/workflows/${workflow.id}/publish`,{expected_version:1},publishKey)).id).toBe(published.id);
  expect((await service('POST',`/v1/workflows/${workflow.id}/publish`,{expected_version:1})).statusCode).toBe(409);
  const revisedOffer=data(await service('POST',`/v1/offers/${offer.id}/versions`,{expected_version:1,changes:{workflow_version_id:published.id,base_amount_minor:10900}}),201);
  const publishedOffer=data(await service('POST',`/v1/offers/${revisedOffer.id}/publish`,{expected_version:1}));
  expect(publishedOffer.status).toBe('PUBLISHED');expect(publishedOffer.workflow_version_id).toBe(published.id);
  expect(data(await service('GET',`/v1/offers/${offer.id}`)).base_amount_minor).toBe(9900);
  expect(data(await service('GET',`/v1/offers/${publishedOffer.id}/versions`))).toHaveLength(3);
  expect(data(await service('GET',`/v1/workflows/${published.id}/versions`))).toHaveLength(2);
  const patched=data(await service('PATCH',`/v1/products/${product.id}`,{expected_version:1,workflow_template_version_id:published.id,asset_ids:[asset.id]}));
  const active=data(await service('POST',`/v1/products/${product.id}/transition`,{expected_version:patched.version,status:'PUBLISHED'}));expect(active.status).toBe('PUBLISHED');
  const revision=data(await service('POST',`/v1/products/${product.id}/versions`,{expected_version:active.version,changes:{description:'Next internal revision'}}),201);expect(revision.status).toBe('DRAFT');
  const history=data(await service('GET',`/v1/products/${product.id}/versions`));expect(history).toHaveLength(4);expect(history.some((row:any)=>row.status==='PUBLISHED')).toBe(true);
  // The same collection endpoint is consumed by the browser; browser E2E adds visual assertion.
  expect(data(await owner('GET','/v1/products?q=API-first%20product')).some((row:any)=>row.id===product.id)).toBe(true);
  for(const table of ['outbox','commands','operation_authorizations'])expect((await pool.query(`SELECT count(*)::int total FROM ${table} WHERE workspace_id=$1`,[workspace])).rows[0].total).toBe(0);
  expect((await pool.query("SELECT count(*)::int total FROM records WHERE workspace_id=$1 AND kind IN ('message','message_campaign','acquisition_campaign','ad_set','ad','conversion')",[workspace])).rows[0].total).toBe(0);
  const events=(await pool.query('SELECT actor,payload FROM domain_events WHERE workspace_id=$1',[workspace])).rows;
  expect(events.some(row=>row.actor.type==='service')).toBe(true);expect(JSON.stringify(events)).not.toContain(token);
 });
 it('protects order and execution references when newer offers and workflows are published',async()=>{
  const product=data(await service('POST','/v1/products',{name:'Pinned product'}),201);
  const offer=data(await service('POST',`/v1/products/${product.id}/offers`,{currency:'MXN',base_amount_minor:1500}),201);
  const flow=data(await service('POST','/v1/workflows',definition('Pinned workflow')),201);
  const published=data(await service('POST',`/v1/workflows/${flow.id}/publish`,{expected_version:1}));
  const order=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'order',body:{product_id:product.id,offer_version_id:offer.id,workflow_version_id:published.id,offer_snapshot:offer}});
  const next=data(await service('POST',`/v1/workflows/${published.id}/versions`,{expected_version:1,changes:{name:'Next workflow'}}),201);
  data(await service('POST',`/v1/workflows/${next.id}/publish`,{expected_version:1}));
  data(await service('POST',`/v1/offers/${offer.id}/versions`,{expected_version:1,changes:{base_amount_minor:2500}}),201);
  const saved=(await pool.query('SELECT body FROM records WHERE id=$1',[order.id])).rows[0].body;
  expect(saved).toMatchObject({offer_version_id:offer.id,workflow_version_id:published.id,offer_snapshot:{base_amount_minor:1500}});
 });
 it('rejects scope escalation, draft publication, secrets, channels and workspace injection',async()=>{
  const scoped=data(await owner('POST','/v1/service-tokens',{name:'Draft only',scopes:['products:read','products:write','offers:write','workflows:draft'],allowed_environments:['SIMULATION','REAL'],expires_at:new Date(Date.now()+3600000).toISOString()}),201).token;
  const flow=data(await service('POST','/v1/workflows',definition('Draft only'),randomUUID(),scoped),201);
  expect((await service('POST',`/v1/workflows/${flow.id}/publish`,{expected_version:1},randomUUID(),scoped)).statusCode).toBe(403);
  for(const[method,url,payload]of [['POST','/v1/channel-accounts',{}],['POST','/v1/service-tokens',{}],['POST','/v1/operation-authorizations',{}],['POST','/v1/conversations/'+randomUUID()+'/commands',{type:'send_message',text:'Blocked'}],['POST','/v1/orders/'+randomUUID()+'/reconcile',{}]] as Array<[string,string,any]>)expect((await service(method,url,payload)).statusCode).toBe(403);
  const bankMetadata=data(await service('GET','/v1/bank-profiles'));expect(JSON.stringify(bankMetadata)).not.toMatch(/secret_ciphertext|account_number|holder/);
  const minimal=data(await owner('POST','/v1/service-tokens',{name:'Products only',scopes:['products:write'],allowed_environments:['SIMULATION','REAL'],expires_at:new Date(Date.now()+3600000).toISOString()}),201).token;
  expect((await service('POST','/v1/products',{name:'Offer bypass',initial_offer:{currency:'MXN',base_amount_minor:100}},randomUUID(),minimal)).statusCode).toBe(403);
  expect((await service('POST','/v1/products',{name:'Forged workspace',workspace_id:'forged'})).statusCode).toBe(400);
  const foreign=await putRecord(pool,{workspaceId:'other-'+randomUUID(),environment:'SIMULATION',kind:'product',body:{name:'Other workspace'}});
  expect((await service('GET','/v1/products/'+foreign.id)).statusCode).toBe(404);
  expect((await service('POST','/v1/workflows',{...definition('Foreign ref'),product_id:foreign.id})).statusCode).toBe(400);
  const real=data(await service('POST','/v1/products?environment=REAL',{name:'Explicit real metadata'}),201);
  expect((await service('GET','/v1/products/'+real.id)).statusCode).toBe(404);
  expect((await service('GET','/v1/products/'+real.id+'?environment=REAL')).statusCode).toBe(200);
 });
 it('validates amounts, currency, workflow invariants, scoped references and state transitions',async()=>{
  const product=data(await service('POST','/v1/products',{name:'Validation'}),201);
  for(const patch of [{currency:'ZZZ',base_amount_minor:1},{currency:'MXN',base_amount_minor:-1},{currency:'MXN',base_amount_minor:0.5}])expect((await service('POST',`/v1/products/${product.id}/offers`,patch)).statusCode).toBe(400);
  const invalid=data(await service('POST','/v1/workflows/validate',{...definition(),entry_node_id:'missing'}));expect(invalid.valid).toBe(false);expect(invalid.issues[0]).toMatchObject({code:'WORKFLOW_INVARIANT',path:'nodes'});
  expect((await service('POST','/v1/products',{name:'Bad asset',asset_ids:[randomUUID()]})).statusCode).toBe(400);
  expect((await service('POST','/v1/products',{name:'Bad flow',workflow_template_version_id:randomUUID()})).statusCode).toBe(400);
  expect((await service('POST',`/v1/products/${product.id}/transition`,{expected_version:1,status:'DRAFT'})).statusCode).toBe(409);
  const duplicate=data(await service('POST',`/v1/products/${product.id}/duplicate`,{name:'Duplicated'}));expect(duplicate.id).not.toBe(product.id);
 });
 it('serializes concurrent same-key creation and stale updates',async()=>{
  const key=randomUUID(),body={name:'Concurrent creation'},created=await Promise.all([service('POST','/v1/products',body,key),service('POST','/v1/products',body,key)]);
  const id=data(created[0],201).id;expect(data(created[1],201).id).toBe(id);
  const updates=await Promise.all([service('PATCH','/v1/products/'+id,{expected_version:1,name:'A'}),service('PATCH','/v1/products/'+id,{expected_version:1,name:'B'})]);expect(updates.map(x=>x.statusCode).sort()).toEqual([200,409]);
 });
 it('keeps duplicate lineage separate and restores only a version of the same workflow',async()=>{
  const draft=data(await service('POST','/v1/workflows',definition('History')),201),first=data(await service('POST',`/v1/workflows/${draft.id}/publish`,{expected_version:1}));
  const revision=data(await service('POST',`/v1/workflows/${first.id}/versions`,{expected_version:1,changes:{name:'History v2'}}),201),second=data(await service('POST',`/v1/workflows/${revision.id}/publish`,{expected_version:1}));
  const restored=data(await service('POST',`/v1/workflows/${second.id}/rollback`,{version_id:first.id,expected_version:1}));expect(restored.id).not.toBe(first.id);expect(restored.restored_from_version_id).toBe(first.id);
  const duplicate=data(await service('POST',`/v1/workflows/${first.id}/duplicate`,{name:'Independent flow'}));expect(data(await service('GET',`/v1/workflows/${duplicate.id}/versions`))).toHaveLength(1);
  expect((await service('POST',`/v1/workflows/${duplicate.id}/rollback`,{version_id:first.id,expected_version:1})).statusCode).toBe(409);
  const legacyDuplicate=await putRecord(pool,{workspaceId:workspace,environment:'SIMULATION',kind:'workflow',body:{...definition('Legacy duplicate'),status:'DRAFT',parent_id:first.id}});
  expect(data(await service('GET',`/v1/workflows/${legacyDuplicate.id}/versions`))).toHaveLength(1);
  expect((await service('POST',`/v1/workflows/${legacyDuplicate.id}/rollback`,{version_id:first.id,expected_version:1})).statusCode).toBe(409);
 });
 it('documents complete automation request schemas, scopes and response codes',async()=>{
  const spec=(await app.inject({method:'GET',url:'/v1/openapi.json'})).json();
  for(const path of ['/v1/products/{id}/versions','/v1/offers/{id}/versions','/v1/workflows/{id}/versions'])expect(spec.paths[path]).toHaveProperty('get');
  expect(spec.paths['/v1/workflows/{id}/publish'].post['x-required-service-scopes']).toContain('workflows:publish');
  expect(spec.paths['/v1/service-tokens'].post.requestBody.content['application/json'].schema.properties.scopes.items.enum).toContain('offers:publish');
  expect(spec.paths['/v1/products'].post.responses).toHaveProperty('201');expect(spec.paths['/v1/products'].post.responses).toHaveProperty('403');
 });
 it('supports publication-only credentials without granting draft creation',async()=>{
  const draft=data(await service('POST','/v1/workflows',definition('Publication scope')),201);
  const publisher=data(await owner('POST','/v1/service-tokens',{name:'Internal publisher',scopes:['workflows:publish'],allowed_environments:['SIMULATION','REAL'],expires_at:new Date(Date.now()+3600000).toISOString()}),201).token;
  expect((await service('POST','/v1/workflows',definition('Denied create'),randomUUID(),publisher)).statusCode).toBe(403);
  expect(data(await service('POST',`/v1/workflows/${draft.id}/publish`,{expected_version:1},randomUUID(),publisher)).status).toBe('PUBLISHED');
 });
 it('revokes immediately and rejects expired credentials',async()=>{
  expect(data(await owner('DELETE','/v1/service-tokens/'+tokenId))).toMatchObject({revoked:true});expect((await service('GET','/v1/products')).statusCode).toBe(401);
  const expiring=data(await owner('POST','/v1/service-tokens',{name:'Expiry test',scopes:['products:read'],allowed_environments:['SIMULATION','REAL'],expires_at:new Date(Date.now()+3600000).toISOString()}),201);
  await pool.query("UPDATE service_tokens SET expires_at=now()-interval '1 second' WHERE id=$1",[expiring.id]);
  expect((await service('GET','/v1/products',undefined,randomUUID(),expiring.token)).statusCode).toBe(401);
 });
});
