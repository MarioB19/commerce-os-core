import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,withTransaction,decrypt} from '../../packages/db/src/index.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {collectionInstructions} from '../../packages/domain/src/catalog/variant-document.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {roleExecutor} from '../support/database-role.js';

// V7 F4 (RF-05.a/b, RF-06.a/d/f, RF-08.a/b/c, ISO-CATALOG, CONT-VERSION): one
// product, a Mexico variant built from the base flow and seller, both payment
// methods, publication, a number that sells it, new conversations pinned to
// the release current at their start, an independent copy for Colombia and a
// second profile that sees none of it. Nothing is sent to a provider.
const A='variants-'+randomUUID(),B='variants-other-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const withRole=roleExecutor(pool);
let app:Awaited<ReturnType<typeof createApp>>;const cookies:Record<string,string>={};
const call=(profile:string,method:string,path:string,body?:unknown,key=randomUUID())=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie:cookies[profile]!,'idempotency-key':key}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
async function inProfile<T>(scope:string,work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[scope]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
async function login(profile:string){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Dueña '+profile.slice(0,8),email,password,workspace_id:profile,role:'owner'});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookies[profile]=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
}
/** Synthetic CLABE with a valid check digit (never a real account). */
function clabe(prefix17:string){const w=[3,7,1];let s=0;for(let i=0;i<17;i++)s+=(Number(prefix17[i])*w[i%3]!)%10;return prefix17+String((10-(s%10))%10);}
const MX={market:'México',country:'MX',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
const CO={market:'Colombia',country:'CO',currency:'COP',language:'es-CO',timezone:'America/Bogota'};
beforeAll(async()=>{await fixtureProfiles({id:A,numbers:5},{id:B,numbers:5});app=await createApp();await login(A);await login(B);});
afterAll(async()=>{await app.close();await pool.end();});

it('builds, publishes, sells and copies a variant without mixing markets or profiles',async()=>{
 // Parent + Mexico variant from the base flow and initial seller (RF-17.e path).
 const created=data(await call(A,'POST','/v2/products',{name:'Curso sintético',description:'Producto de prueba',variant:{name:'México',locale:MX}}),201);
 const productId=created.product.id;let v=created.variant;
 expect(v.state).toBe('NEEDS_SETUP');expect(v.document.sale.base).toBe('conversation');expect(v.document.sale.seller.name).toBe('Asesor');
 expect(v.missing.map((m:{code:string})=>m.code).sort()).toEqual(['collection','materials','offer_price','publish']);
 const asset=await inProfile(A,async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','asset',$2) RETURNING id",[A,{name:'Guía sintética',kind:'link',url:'https://example.com/guia',status:'READY'}])).rows[0].id);
 // Oferta y materiales.
 v=data(await call(A,'PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{name:'Curso sintético',price_minor:9700,tiers:[],fulfillment:[{asset_id:asset,release_on:'receipt_approved'}],billing_delay_seconds:1800,positive_payment_unlocks_all:false,legacy:{}}}));
 // Cobro: SPEI and a link; neither CLABE nor URL ever comes back.
 const account18=clabe('01218000011835971');
 const saved=await call(A,'PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'Banco sintético',holder:'Titular sintético',clabe:account18},links:[{label:'Pago con tarjeta',provider:'stripe',url:'https://pay.example.com/curso?ref=abc'}],instructions:'Envía tu comprobante por aquí.',expected_reference:'CURSO97',expected_concept:'Pago curso'}});
 v=data(saved);expect(saved.body).not.toContain(account18);expect(saved.body).not.toContain('ref=abc');expect(saved.body).not.toContain('Titular sintético');
 expect(v.document.collection).toMatchObject({spei:{bank:'Banco sintético',last4:account18.slice(-4)},links:[{label:'Pago con tarjeta',provider:'stripe',host:'pay.example.com'}]});
 expect((await call(A,'PUT',`/v2/variants/${v.id}/collection`,{expected_version:v.version,value:{spei:{bank:'X',holder:'Y',clabe:'012180000118359710'},links:[],instructions:''}})).statusCode).toBe(400);
 expect(v.missing.map((m:{code:string})=>m.code)).toEqual(['publish']);
 // Publication: idempotent replay returns the same release.
 const key=randomUUID(),body={expected_version:v.version,document_sha256:v.document_sha256};
 const first=data(await call(A,'POST',`/v2/variants/${v.id}/publish`,body,key)),replay=data(await call(A,'POST',`/v2/variants/${v.id}/publish`,body,key));
 expect(replay.release).toEqual(first.release);expect(first.release.revision).toBe(1);expect(first.applies_to).toBe('NEW_CONVERSATIONS');
 v=first.variant;expect(v.state).toBe('READY_TO_ASSIGN');expect(v.unpublished_changes).toBe(false);
 // The materialized offer, seller and collection keep the market and the language.
 const release=await inProfile(A,async c=>(await c.query('SELECT body FROM market_releases WHERE id=$1',[first.release.id])).rows[0].body);
 const [offer,seller,bank]=await inProfile(A,async c=>Promise.all(['offer','agent','bank_profile'].map(async(kind,i)=>(await c.query('SELECT body FROM records WHERE id=$1 AND kind=$2',[[release.configuration.offer.id,release.configuration.seller.id,release.configuration.collection.id][i],kind])).rows[0].body)));
 expect(offer).toMatchObject({currency:'MXN',base_amount_minor:9700,status:'PUBLISHED',variant_id:v.id,language:'es-MX',payment_profile_version_id:release.configuration.collection.id});
 expect(seller).toMatchObject({provider:'profile',language:'es-MX',product_id:productId});expect(seller.style.language).toContain('español');
 expect(JSON.stringify(bank)).not.toContain(account18);
 const text=collectionInstructions({bank,secret:JSON.parse(decrypt(bank.secret_ciphertext)),price:'97.00',currency:'MXN'})!;
 expect(text).toContain(`CLABE ${account18}`);expect(text).toContain('Pago con tarjeta: https://pay.example.com/curso?ref=abc');expect(text).toContain('97.00 MXN');
 // RF-09.d: the buyer sees what to write, and the receipt rules compare against it.
 expect(bank).toMatchObject({expected_reference:'CURSO97',expected_concept:'Pago curso',language:'es-MX'});expect(text).toContain('Referencia: CURSO97');expect(text).toContain('Concepto: Pago curso');

 // Números: one human act; the number follows the variant.
 const number=await inProfile(A,async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING *",[A,{name:'Ventas MX',provider:'simulator',status:'WORKING'}])).rows[0]);
 const assigned=data(await call(A,'POST',`/v2/variants/${v.id}/numbers`,{account_id:number.id,sell:true}));
 expect(assigned).toMatchObject({sells:true,paused:false});
 expect(data(await call(A,'GET',`/v2/variants/${v.id}`)).state).toBe('SELLING');
 expect(data(await call(A,'GET',`/v2/variants/${v.id}/numbers`)).find((n:{account_id:string})=>n.account_id===number.id)).toMatchObject({sells_this:true,same_product:null});
 expect(data(await call(A,'GET',`/v2/number-variants?offer_id=${release.configuration.offer.id}`))).toEqual([expect.objectContaining({account_id:number.id,sells:[expect.objectContaining({variant_id:v.id,offer_id:release.configuration.offer.id})]})]);
 const grant=await inProfile(A,async c=>(await c.query("SELECT state FROM continuous_authorizations WHERE workspace_id=$1 AND account_id=$2",[A,number.id])).rows);
 expect(grant).toHaveLength(1);expect(grant[0].state.source).toMatchObject({kind:'COMMERCIAL_ASSIGNMENT',assignmentId:assigned.assignment_id});

 // New conversations start on the current release; open ones keep theirs (RF-06.f).
 const inbound=(identity:string)=>withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity,kind:'text',text:'Hola, me interesa',payload:{}},randomUUID())));
 const firstChat=(await inbound('opaque:cliente-1'))!;
 expect(firstChat.body).toMatchObject({variant_id:v.id,release_id:first.release.id,offer_version_id:release.configuration.offer.id,agent_version_id:release.configuration.seller.id,workflow_version_id:release.configuration.flow.id});
 expect(await inProfile(A,async c=>(await c.query('SELECT release_id FROM market_journey_snapshots WHERE journey_id=$1',[firstChat.id])).rows)).toEqual([{release_id:first.release.id}]);
 v=data(await call(A,'PUT',`/v2/variants/${v.id}/offer`,{expected_version:v.version,value:{...v.document.offer,price_minor:12900}}));
 expect(v.unpublished_changes).toBe(true);expect(v.state).toBe('SELLING');
 const second=data(await call(A,'POST',`/v2/variants/${v.id}/publish`,{expected_version:v.version,document_sha256:v.document_sha256}));
 const release2=await inProfile(A,async c=>(await c.query('SELECT body FROM market_releases WHERE id=$1',[second.release.id])).rows[0].body);
 // Unchanged parts are reused; only the offer is a new version.
 expect(release2.configuration.seller.id).toBe(release.configuration.seller.id);expect(release2.configuration.collection.id).toBe(release.configuration.collection.id);
 expect(release2.configuration.offer.id).not.toBe(release.configuration.offer.id);
 const secondChat=(await inbound('opaque:cliente-2'))!;
 expect(secondChat.body).toMatchObject({release_id:second.release.id,offer_version_id:release2.configuration.offer.id});
 const again=(await inbound('opaque:cliente-1'))!;expect(again.id).toBe(firstChat.id);expect(again.body.offer_version_id).toBe(release.configuration.offer.id);

 // Duplicar a Colombia: independent draft, nothing local invented, no number.
 const copy=data(await call(A,'POST',`/v2/variants/${v.id}/duplicate`,{name:'Colombia',locale:CO}),201);
 expect(copy).toMatchObject({numbers_copied:0,publication_authorized:false,state:'NEEDS_SETUP',numbers:[]});
 expect(copy.document.collection).toEqual({spei:null,links:[],instructions:'Envía tu comprobante por aquí.',legacy_profile_id:null});
 expect(copy.document.pending_review).toHaveLength(6);expect(copy.document.offer.price_minor).toBe(12900);
 expect((await call(A,'PUT',`/v2/variants/${copy.id}/collection`,{expected_version:copy.version,value:{spei:{bank:'B',holder:'H',clabe:account18},links:[],instructions:''}})).json().error.code).toBe('COLLECTION_SPEI_REQUIRES_MXN');
 const copyEdited=data(await call(A,'PUT',`/v2/variants/${copy.id}/offer`,{expected_version:copy.version,value:{...copy.document.offer,price_minor:4500000}}));
 expect(copyEdited.document.offer.price_minor).toBe(4500000);expect(data(await call(A,'GET',`/v2/variants/${v.id}`)).document_sha256).toBe(v.document_sha256);
 const incomplete=await call(A,'POST',`/v2/variants/${copy.id}/publish`,{expected_version:copyEdited.version,document_sha256:copyEdited.document_sha256});
 expect(incomplete.statusCode).toBe(409);expect(incomplete.json().error.code).toBe('VARIANT_INCOMPLETE');
 const products=data(await call(A,'GET','/v2/products'));
 expect(products.find((p:{id:string})=>p.id===productId).variants.map((x:{name:string;state:string})=>[x.name,x.state])).toEqual([['México','SELLING'],['Colombia','NEEDS_SETUP']]);

 // ISO: another profile sees nothing and cannot act on it.
 expect((await call(B,'GET',`/v2/variants/${v.id}`)).statusCode).toBe(404);
 expect(data(await call(B,'GET','/v2/products')).some((p:{id:string})=>p.id===productId)).toBe(false);
 expect((await call(B,'POST',`/v2/variants/${v.id}/numbers`,{account_id:number.id,sell:false})).statusCode).toBe(404);

 // Removing the number retires the relation and its grant; then it can be archived.
 expect((await call(A,'POST',`/v2/variants/${v.id}/archive`,{expected_version:second.variant.version})).json().error.code).toBe('VARIANT_HAS_ACTIVE_NUMBERS');
 expect(data(await call(A,'GET',`/v2/variants/${v.id}/numbers/${number.id}/impact`))).toMatchObject({open_conversations:2});
 expect(data(await call(A,'POST',`/v2/variants/${v.id}/numbers`,{account_id:number.id,sell:false}))).toMatchObject({sells:false});
 const after=await inProfile(A,async c=>({a:(await c.query('SELECT state FROM commercial_assignments WHERE id=$1',[assigned.assignment_id])).rows[0].state,
  g:(await c.query("SELECT state->>'revokedAt' AS revoked FROM continuous_authorizations WHERE workspace_id=$1 AND account_id=$2",[A,number.id])).rows[0].revoked}));
 expect(after.a).toBe('RETIRED');expect(after.g).not.toBeNull();
 const current=data(await call(A,'GET',`/v2/variants/${v.id}`));
 expect(data(await call(A,'POST',`/v2/variants/${v.id}/archive`,{expected_version:current.version})).state).toBe('ARCHIVED');
 const history=data(await call(A,'GET',`/v2/variants/${v.id}/history`));
 expect(history.releases.map((r:{revision:number})=>r.revision)).toEqual([2,1]);
 expect(history.events.map((e:{event:string})=>e.event)).toContain('ARCHIVED');
},120000);

it('inherits Spin for existing offers, new products and variants, and freezes each published order destination',async()=>{
 const card1={card_number:'4242424242424242',holder:'Titular ficticio uno'};
 const card2={card_number:'4000000000000002',holder:'Titular ficticio dos'};
 const products=[];
 for(let n=1;n<=8;n++){
  const created=data(await call(A,'POST','/v2/products',{name:'Oferta de prueba '+n,variant:{name:'México',locale:MX}}),201);
  products.push(created);
 }
 const endpoint='/v2/profile/spin';
 expect(data(await call(A,'GET',endpoint))).toEqual({revision:0,last4:null});
 data(await call(A,'PUT',endpoint,{expected_revision:0,card:card1}));
 for(const product of products){
  const saved=data(await call(A,'GET','/v2/variants/'+product.variant.id));
  expect(saved.document.collection).toMatchObject({spin_mode:'profile',spin:{last4:'4242'}});
 }
 const ninth=data(await call(A,'POST','/v2/products',{name:'Producto nueve',variant:{name:'México',locale:MX}}),201);
 let v=ninth.variant;
 expect(v.document.collection.spin).toMatchObject({last4:'4242'});
 const extra=data(await call(A,'POST','/v2/variants',{product_id:ninth.product.id,name:'Segunda variante',locale:MX}),201);
 expect(extra.document.collection.spin).toMatchObject({last4:'4242'});
 const bank={bank:'Banco ficticio',holder:'Titular ficticio',clabe:clabe('01218000011835971')};
 const collection={spei:bank,links:[],instructions:''};
 const custom=data(await call(A,'PUT','/v2/variants/'+extra.id+'/collection',{expected_version:extra.version,value:{...collection,spin:card1}}));
 const disabled=data(await call(A,'PUT','/v2/variants/'+products[0].variant.id+'/collection',{expected_version:data(await call(A,'GET','/v2/variants/'+products[0].variant.id)).version,value:{...collection,spin:null}}));
 v=data(await call(A,'PUT','/v2/variants/'+v.id+'/collection',{expected_version:v.version,value:collection}));
 const asset=await inProfile(A,async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','asset',$2) RETURNING id",[A,{name:'Material sintético',kind:'link',url:'https://example.invalid/base',status:'READY'}])).rows[0].id);
 v=data(await call(A,'PUT','/v2/variants/'+v.id+'/offer',{expected_version:v.version,value:{...v.document.offer,price_minor:9700,accept_positive_contributions:true,fulfillment:[{asset_id:asset,release_on:'receipt_approved'}]}}));
 const published=data(await call(A,'POST','/v2/variants/'+v.id+'/publish',{expected_version:v.version,document_sha256:v.document_sha256}));
 const number=await inProfile(A,async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING *",[A,{name:'Simulador local',provider:'simulator',status:'WORKING'}])).rows[0]);
 data(await call(A,'POST','/v2/variants/'+v.id+'/numbers',{account_id:number.id,sell:true}));
 const {ensureOrder}=await import('../../apps/automation-worker/src/workflows.js');
 const {spinDepositLink}=await import('../../packages/db/src/spin-deposit-slip.js');
 const newOrder=async(identity:string)=>withRole('commerce_automation',()=>withTransaction(async c=>{
  const chat=(await materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity,kind:'text',text:'Hola',payload:{}},randomUUID()))!;
  const order=(await ensureOrder(c,chat))!;
  return new URL(spinDepositLink(origin,A,'REAL',chat.id,order.id,order.body.payment_profile_version_id)).hash.slice(1);
 }));
 const readSlip=(token:string)=>app.inject({method:'POST',url:'/v2/customer/spin-deposit',payload:{token}});
 const oldToken=await newOrder('opaque:noveno-1');
 expect((await readSlip(oldToken)).json()).toMatchObject({spin:card1,spei:bank});
 const result=await call(A,'PUT',endpoint,{expected_revision:1,card:card2,apply_to_published:true});
 expect(data(result)).toMatchObject({revision:2,last4:'0002'});
 expect(result.body).not.toContain(card2.card_number);
 expect((await call(A,'PUT',endpoint,{expected_revision:1,card:card1})).statusCode).toBe(409);
 const draft=data(await call(A,'GET','/v2/variants/'+v.id));
 expect(draft.version).toBeGreaterThan(published.variant.version);
 expect(draft.unpublished_changes).toBe(false);
 expect(data(result).variants_published).toBe(1);
 expect((await readSlip(oldToken)).json()).toMatchObject({spin:card1,spei:bank});
 expect((await readSlip(await newOrder('opaque:noveno-2'))).json()).toMatchObject({spin:card2,spei:bank});
 expect((await readSlip(oldToken+'x')).statusCode).toBe(404);
 expect(data(await call(A,'GET','/v2/variants/'+custom.id)).document.collection.spin).toMatchObject({last4:'4242'});
 expect(data(await call(A,'GET','/v2/variants/'+disabled.id)).document.collection.spin).toBeUndefined();
 expect(data(await call(B,'GET',endpoint))).toEqual({revision:0,last4:null});
 const isolated=data(await call(B,'POST','/v2/products',{name:'Perfil independiente',variant:{name:'México',locale:MX}}),201);
 expect(isolated.variant.document.collection.spin).toBeUndefined();
},120000);

it('opens the published simulation slip from a newly created Mexican product without copying a live destination',async()=>{
 const {withProfileTransaction}=await import('../../packages/db/src/profile-context.js');
 const {bindProfileEnvironment}=await import('../../packages/db/src/profile-environment.js');
 const {captureVariantJourney,currentVariantRelease}=await import('../../packages/db/src/variant-workspace.js');
 const {spinDepositLink}=await import('../../packages/db/src/spin-deposit-slip.js');
 const simulate=async(method:string,path:string,body?:object)=>app.inject({method:method as 'GET',url:path+'?environment=SIMULATION',payload:body,headers:{cookie:cookies[A]!,origin,'idempotency-key':randomUUID()}});
 const fake={card_number:'5555555555554444',holder:'Titular simulado'};
 data(await simulate('PUT','/v2/profile/spin',{expected_revision:0,card:fake}));
 const p=data(await simulate('POST','/v2/products',{name:'Noveno producto simulado',variant:{name:'México',locale:MX}}),201);
 let v=p.variant;
 expect(v.document.collection.spin).toMatchObject({last4:'4444'});
 const seed=(kind:string,body:object)=>withProfileTransaction(pool,A,async db=>{
  await bindProfileEnvironment(db,'SIMULATION');
  return (await db.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'SIMULATION',$2,$3) RETURNING id",[A,kind,body])).rows[0].id as string;
 });
 const asset=await seed('asset',{kind:'link',url:'https://example.invalid/kit',status:'READY'});
 v=data(await simulate('PUT','/v2/variants/'+v.id+'/offer',{expected_version:v.version,value:{...v.document.offer,price_minor:9700,fulfillment:[{asset_id:asset,release_on:'receipt_approved'}]}}));
 v=data(await simulate('PUT','/v2/variants/'+v.id+'/collection',{expected_version:v.version,value:{spei:{bank:'Simulado',holder:'Titular simulado',clabe:clabe('01218000011835971')},links:[],instructions:''}}));
 data(await simulate('POST','/v2/variants/'+v.id+'/publish',{expected_version:v.version,document_sha256:v.document_sha256}));
 const token=await withProfileTransaction(pool,A,async db=>{
  await bindProfileEnvironment(db,'SIMULATION');
  const release=(await currentVariantRelease(db,'SIMULATION',v.id))!;
  const bindingId=await seed('binding',{status:'SIMULATED'}),accountId=await seed('channel_account',{provider:'simulator',status:'PAUSED'}),contactId=await seed('contact',{name:'Prueba local'});
  const journeyId=await seed('conversation',{account_id:accountId,contact_id:contactId,binding_id:bindingId});
  await captureVariantJourney(db,'SIMULATION',{journeyId,accountId,contactId,bindingId,release});
  const bank=release.configuration.collection.id;
  const order=await seed('order',{conversation_id:journeyId,payment_profile_version_id:bank,currency:'MXN',status:'COMMITTED',receipt_status:'NONE'});
  return new URL(spinDepositLink(origin,A,'SIMULATION',journeyId,order,bank)).hash.slice(1);
 });
 const response=await app.inject({method:'POST',url:'/v2/customer/spin-deposit',payload:{token}});
 expect(response.statusCode,response.body).toBe(200);
 expect(response.json().spin.card_number).toBe('0000000000000000');
 expect(response.json().spei.clabe).toBe('000000000000000000');
 expect(response.body).not.toContain(fake.card_number);
},120000);
