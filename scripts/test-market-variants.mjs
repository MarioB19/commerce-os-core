// Browser contract over synthetic responses. Every non-loopback request is blocked.
// This fixture does not prove database persistence, mounting or commercial effects.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{MarketVariants}from'./src/components/market-variants.tsx';const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');const ref=n=>({id:id(n),revision:1,sha256:'a'.repeat(64)});const options=['offer','flow','seller','collection','material'].map((kind,i)=>({kind,label:kind+' fixture',ref:ref(i+10)}));function Fixture(){const[state,setState]=useState({selection:{workspaceId:'first',version:1},environment:'REAL',role:'owner',profileState:'ACTIVE',product:{id:id(1),version:1,name:'Producto sintético'}});window.chooseContext=setState;const catalog={workspaceId:state.catalogMismatch?'other':state.selection.workspaceId,selectionVersion:state.selection.version,environment:state.environment,productId:state.product.id,options};return <MarketVariants {...state} catalog={catalog}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:web,sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Variantes</title><body><main id="root"></main><script src="/fixture.js"></script></body></html>');}else{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const ref=n=>({id:id(n),revision:1,sha256:'a'.repeat(64)}),locale={market:'México',currency:'MXN',language:'es-MX',timezone:'America/Mexico_City'};
const configuration={offer:ref(10),flow:ref(11),seller:ref(12),collection:ref(13),remarketing:ref(10),materials:[ref(14)]};
const fields={locale,amount_minor:1001,configuration};
const draft=()=>({id:id(2),family_id:id(1),version:1,draft:structuredClone(fields),draft_sha256:'b'.repeat(64),current_release_id:null,source_release_id:null,release_revision:0});
const checks=[],pageErrors=[];let browser;
async function fixture(){
 const context=await browser.newContext(),page=await context.newPage(),calls=[],pending=[];
 page.on('pageerror',error=>pageErrors.push(error.message));
 const model={draft:draft(),mode:'normal',receipts:new Map(),calls,pending};
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/v2/market/'))return route.continue();
  const headers=req.headers(),profile=headers['x-commerce-profile-id'];assert.ok(['first','second'].includes(profile));assert.equal(headers.authorization,undefined);
  const body=req.postDataJSON(),call={method:req.method(),path:url.pathname,query:Object.fromEntries(url.searchParams),headers,body};calls.push(call);
  const mode=model.mode;if(mode==='delay'){await new Promise(resolve=>pending.push(resolve));}
  if(mode==='read-error'&&call.method==='GET')return route.fulfill({status:403,json:{private:'must not appear'}});
  if(call.path.includes('/operations/')){
   const stored=model.receipts.get(call.path.split('/').at(-1));return stored?route.fulfill({json:{data:stored}}):route.fulfill({status:404,json:{error:{code:'MARKET_NOT_FOUND',message:'MARKET_NOT_FOUND'}}});
  }
  if(call.method==='GET'){
   const item=structuredClone(model.draft);item.draft.locale.market=profile==='second'?'Chile':item.draft.locale.market;
   if(call.path==='/v2/market/variants')return route.fulfill({json:{data:[item],meta:{has_more:false,next:null}}});
   return route.fulfill({json:{data:item}});
  }
  assert.match(headers['idempotency-key'],/^[a-f0-9-]{36}$/);assert.equal(call.query.environment,'REAL');
  if(mode==='lost-before')return route.abort('failed');
  let result;
  if(call.path.endsWith('/families'))result={id:body.product_id};
  else if(call.path.endsWith('/copy')){
   result={...draft(),id:id(4),draft:{...structuredClone(model.draft.draft),locale:body.locale},source_release_id:body.source_release_id,source_release:{id:body.source_release_id,revision:1,sha256:'c'.repeat(64)},pending_review:['language','price_currency','collection','flow_seller','remarketing','materials'],publication_authorized:false};model.draft=result;
  }else if(call.path.endsWith('/releases')){
   assert.equal(body.expected_version,model.draft.version);assert.equal(body.draft_sha256,model.draft.draft_sha256);assert.equal(body.reviewed_fields.length,6);
   const variant={...model.draft,version:model.draft.version+1,current_release_id:id(3),release_revision:1};model.draft=variant;
   result={variant,release:{id:id(3),scope:{workspace_id:profile,environment:'REAL'},family_id:id(1),variant_id:id(2),revision:1,...variant.draft},sha256:'c'.repeat(64),effects_authorized:false};
  }else{
   model.draft={...draft(),...(call.method==='PUT'?{version:model.draft.version+1}:{}),draft:body.fields};result=model.draft;
  }
  model.receipts.set(headers['idempotency-key'],structuredClone(result));
  if(mode==='lost-after')return route.abort('failed');
  return route.fulfill({json:{data:result}});
 });
 await page.goto(base);await expect(page.getByRole('button',{name:'México · es-MX · MXN'})).toBeVisible();
 return{context,page,model};
}
async function check(name,run){const f=await fixture();try{await run(f);checks.push(name);}finally{for(const release of f.model.pending)release();await f.context.close();}}
async function open(page){await page.getByRole('button',{name:'México · es-MX · MXN'}).click();await expect(page.getByRole('heading',{name:'Editar borrador'})).toBeVisible();}
try{
 browser=await chromium.launch({headless:true,channel:'chromium'});
 await check('cookie_fence_readonly_until_explicit_action',async({page,model})=>{
  assert.equal(model.calls.length,1);assert.equal(model.calls[0].method,'GET');assert.equal(model.calls[0].headers['x-commerce-profile-version'],'1');assert.equal(model.calls[0].query.family_id,id(1));
  await open(page);await expect(page.getByLabel('Precio en MXN')).toHaveValue('10.01');await expect(page.getByRole('button',{name:'Publicar versión comercial',exact:true})).toBeDisabled();
 });
 await check('six_reviews_required_and_any_edit_invalidates_them',async({page,model})=>{
  await open(page);const boxes=page.getByRole('checkbox');for(let i=0;i<6;i++)await boxes.nth(i).check();
  await expect(page.getByRole('button',{name:'Publicar versión comercial',exact:true})).toBeEnabled();
  await page.getByLabel('Precio en MXN').fill('10.02');for(let i=0;i<6;i++)await expect(boxes.nth(i)).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Publicar versión comercial',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Guardar borrador'}).click();await expect(page.getByRole('button',{name:'Guardar borrador'})).toBeDisabled();
  assert.equal(model.calls.at(-1).method,'PUT');assert.equal(model.calls.at(-1).body.fields.amount_minor,1002);assert.equal(model.calls.at(-1).body.expected_version,1);
 });
 await check('publication_uses_saved_hash_and_copy_remains_unreviewed_draft',async({page,model})=>{
  await open(page);for(let i=0;i<6;i++)await page.getByRole('checkbox').nth(i).check();
  await page.getByRole('button',{name:'Publicar versión comercial',exact:true}).click();await expect(page.getByRole('heading',{name:'Copiar la versión publicada a otro mercado'})).toBeVisible();
  await page.getByLabel('Mercado destino').fill('Chile');await page.getByLabel('Moneda destino').fill('CLP');await page.getByLabel('Idioma destino').fill('es-CL');await page.getByLabel('Zona horaria destino').fill('America/Santiago');
  await page.getByRole('button',{name:'Crear copia como borrador'}).click();await expect(page.getByLabel('Mercado',{exact:true})).toHaveValue('Chile');
  await expect(page.getByRole('button',{name:'Publicar versión comercial',exact:true})).toBeDisabled();assert.equal(model.calls.at(-1).body.source_release_id,id(3));
 });
 await check('lost_committed_response_only_reconciles_without_write_retry',async({page,model})=>{
  model.mode='lost-after';await page.getByRole('button',{name:'Preparar producto para variantes'}).click();await expect(page.getByRole('alert')).toContainText('no está confirmado');
  const writes=()=>model.calls.filter(call=>call.method!=='GET');assert.equal(writes().length,1);await expect(page.getByRole('button',{name:'Reenviar la misma solicitud'})).toHaveCount(0);
  model.mode='normal';await page.getByRole('button',{name:'Comprobar operación'}).click();await expect(page.getByText('Operación confirmada.')).toBeVisible();assert.equal(writes().length,1);
  assert.equal(model.calls.at(-1).path,'/v2/market/operations/'+writes()[0].headers['idempotency-key']);
 });
 await check('404_requires_human_same_uuid_resend',async({page,model})=>{
  model.mode='lost-before';await page.getByRole('button',{name:'Preparar producto para variantes'}).click();await expect(page.getByRole('alert')).toBeVisible();const first=model.calls.at(-1);
  model.mode='normal';await page.getByRole('button',{name:'Comprobar operación'}).click();await expect(page.getByRole('button',{name:'Reenviar la misma solicitud'})).toBeVisible();
  assert.equal(model.calls.filter(c=>c.method!=='GET').length,1);await page.getByRole('button',{name:'Reenviar la misma solicitud'}).click();await expect(page.getByRole('button',{name:'Nueva variante'})).toBeVisible();
  const last=model.calls.at(-1);assert.equal(last.headers['idempotency-key'],first.headers['idempotency-key']);assert.deepEqual(last.body,first.body);
 });
 await check('profile_switch_discards_late_response',async({page,model})=>{
  model.mode='delay';await page.getByRole('button',{name:'Consultar variantes',exact:true}).click();await expect.poll(()=>model.pending.length).toBe(1);
  model.mode='normal';await page.evaluate(()=>window.chooseContext({selection:{workspaceId:'second',version:2},environment:'REAL',role:'owner',profileState:'ACTIVE',product:{id:'00000000-0000-4000-8000-000000000001',version:1,name:'Producto sintético'}}));
  await expect(page.getByRole('button',{name:'Chile · es-MX · MXN'})).toBeVisible();model.pending.shift()();await expect(page.getByRole('button',{name:'México · es-MX · MXN'})).toHaveCount(0);
 });
 await check('viewer_has_no_mutation_controls',async({page,model})=>{
  await page.evaluate(()=>window.chooseContext({selection:{workspaceId:'first',version:1},environment:'REAL',role:'viewer',profileState:'ACTIVE',product:{id:'00000000-0000-4000-8000-000000000001',version:1,name:'Producto sintético'}}));
  await expect(page.getByText('Consulta disponible. Este perfil o tu rol no permite modificar variantes.')).toBeVisible();await expect(page.getByRole('button',{name:'Nueva variante'})).toHaveCount(0);await open(page);
  await expect(page.getByRole('button',{name:'Guardar borrador'})).toBeDisabled();assert.ok(model.calls.every(c=>c.method==='GET'));
 });
 await check('catalog_selection_mismatch_causes_zero_request',async({page,model})=>{
  const before=model.calls.length;await page.evaluate(()=>window.chooseContext({selection:{workspaceId:'second',version:2},environment:'SIMULATION',role:'owner',profileState:'ACTIVE',product:{id:'00000000-0000-4000-8000-000000000001',version:1,name:'Producto sintético'},catalogMismatch:true}));
  await expect(page.getByText('Actualizando el catálogo del perfil seleccionado…')).toBeVisible();assert.equal(model.calls.length,before);
 });
 await check('read_rejection_clears_prior_data_without_automatic_retry',async({page,model})=>{
  model.mode='read-error';const before=model.calls.length;await page.getByRole('button',{name:'Consultar variantes',exact:true}).click();
  await expect(page.getByText('No se pudo confirmar la consulta. Puedes volver a consultar.')).toBeVisible();await expect(page.getByRole('button',{name:'México · es-MX · MXN'})).toHaveCount(0);assert.equal(model.calls.length,before+1);await expect(page.getByText('must not appear')).toHaveCount(0);
 });
 assert.deepEqual(pageErrors,[]);console.log(JSON.stringify({state:'MARKET_VARIANTS_BROWSER_CONTRACT_PASS',checks,synthetic_only:true,application_mounted:false}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
