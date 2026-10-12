// Synthetic browser contract. Real PostgreSQL/HTTP evidence is a separate fixture.
// No production mounting, providers, QR, tokens or external network are exercised.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ContinuousAuthorizationPanel}from'./src/components/continuous-authorization.tsx';function Fixture(){const[state,setState]=useState({selection:{workspaceId:'first',version:1},environment:'REAL',canManage:true});window.chooseContext=setState;return <ContinuousAuthorizationPanel {...state}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:web,sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Continuidad</title><main id="root"></main><script src="/fixture.js"></script></html>');}else{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const row=()=>({id:id(1),workspaceId:'first',environment:'REAL',accountId:id(2),source:{kind:'COMMERCIAL_ASSIGNMENT',assignmentId:id(3),assignmentRevision:1,bindingId:id(4)},createdBy:'owner',createdAt:'2026-01-01T00:00:00Z',version:1,humanPaused:false,revokedAt:null,protections:[]});
const storageKey=(profile='first',purpose='commercial',environment='REAL')=>'commerce.continuity.pending.v1:'+JSON.stringify([profile,purpose,environment]);
let browser;const checks=[],pageErrors=[];
async function fixture(){
 const context=await browser.newContext(),page=await context.newPage(),model={row:row(),mode:'normal',receipt:null,calls:[],pending:[],storageBeforePost:[]};
 page.on('pageerror',error=>pageErrors.push(error.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==origin)return route.abort();if(!url.pathname.startsWith('/v2/continuity/'))return route.continue();
  const headers=req.headers(),profile=headers['x-commerce-profile-id'],purpose=url.pathname.split('/')[3];assert.ok(['first','second'].includes(profile));assert.equal(headers.authorization,undefined);
  const body=req.postDataJSON(),call={method:req.method(),path:url.pathname,query:Object.fromEntries(url.searchParams),headers,body};model.calls.push(call);
  const mode=model.mode,environment=body?.environment??url.searchParams.get('environment');
  const current={...structuredClone(model.row),workspaceId:profile,environment,accountId:profile==='second'?id(20):id(2),source:purpose==='warmup'?{kind:'VERIFIED_QR_CONNECTION',connectionId:id(8),identityFingerprint:'a'.repeat(64)}:model.row.source};
  if(req.method()==='POST'){
   const saved=await page.evaluate(key=>sessionStorage.getItem(key),storageKey(profile,purpose,environment));
   assert.ok(saved,'intent must be durable in the tab before POST');const intent=JSON.parse(saved);assert.equal(intent.operationId,body.operationId);assert.equal(intent.action,body.action);assert.equal(intent.expectedVersion,body.expectedVersion);model.storageBeforePost.push(intent);
   if(mode==='lost-before')return route.abort('failed');
   model.row={...current,version:current.version+1,...(body.action==='revoke'?{revokedAt:'2026-01-02T00:00:00Z'}:{humanPaused:body.action==='pause'})};model.receipt=structuredClone(model.row);
   if(mode==='delay-post')await new Promise(resolve=>model.pending.push(resolve));
   if(mode==='lost-after')return route.abort('failed');
   if(mode==='http-503')return route.fulfill({status:503,json:{error:'untrusted provider detail'}});
   return route.fulfill({json:{data:model.receipt}});
  }
  if(mode==='delay-read')await new Promise(resolve=>model.pending.push(resolve));
  if(mode==='read-denied')return route.fulfill({status:403,json:{detail:'must not appear'}});
  if(url.pathname.includes('/operations/'))return route.fulfill({json:{data:model.receipt}});
  return route.fulfill({json:{data:[current],nextAfterId:null}});
 });
 await page.goto(origin);await expect(page.getByRole('button',{name:'Pausar actividad'})).toBeVisible();return{context,page,model};
}
async function check(name,run){const f=await fixture();try{await run(f);checks.push(name);}finally{for(const release of f.model.pending)release();await f.context.close();}}
const writes=model=>model.calls.filter(call=>call.method==='POST');
async function switchProfile(page,profile='second',version=2,environment='REAL',canManage=true){await page.evaluate(value=>window.chooseContext(value),{selection:{workspaceId:profile,version},environment,canManage});}
try{
 browser=await chromium.launch({headless:true,channel:'chromium'});
 await check('cookie_profile_fence_and_no_automatic_write',async({page,model})=>{
  assert.equal(model.calls.length,1);assert.equal(model.calls[0].headers['x-commerce-profile-version'],'1');assert.equal(model.calls[0].query.environment,'REAL');assert.equal(writes(model).length,0);await expect(page.getByText('Autorizada; cada acción comprueba sus condiciones')).toBeVisible();
 });
 await check('intent_before_post_and_pause_keeps_protections',async({page,model})=>{
  model.row.protections=[{reason:'SEND_UNCERTAIN',incidentId:id(7),observedAt:'2026-01-01T00:00:00Z',evidenceSha256:'b'.repeat(64)}];await page.getByRole('button',{name:'Consultar de nuevo'}).click();await expect(page.getByText('Hay un envío pendiente de conciliación.')).toBeVisible();
  await page.getByRole('button',{name:'Pausar actividad'}).click();await expect(page.getByRole('button',{name:'Retirar pausa'})).toBeVisible();
  await page.getByRole('button',{name:'Retirar pausa'}).click();await expect(page.getByText('Pausa retirada. Las protecciones siguen vigentes.')).toBeVisible();await expect(page.getByText('Protegida; actividad detenida')).toBeVisible();await expect(page.getByText('Hay un envío pendiente de conciliación.')).toBeVisible();
  assert.equal(writes(model).length,2);assert.deepEqual(writes(model).map(call=>call.body.action),['pause','resume']);assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),storageKey()),null);
 });
 await check('lost_ack_reload_preserves_intent_and_only_explicit_receipt_read',async({page,model})=>{
  model.mode='lost-after';await page.getByRole('button',{name:'Pausar actividad'}).click();await expect(page.getByRole('alert')).toContainText('No se pudo confirmar');const intent=model.storageBeforePost[0];
  model.mode='normal';await page.reload();await expect(page.getByRole('button',{name:'Consultar resultado pendiente'})).toBeVisible();await expect(page.getByRole('button',{name:'Retirar pausa'})).toBeDisabled();assert.equal(writes(model).length,1);assert.equal(model.calls.filter(call=>call.path.includes('/operations/')).length,0);
  await page.getByRole('button',{name:'Consultar resultado pendiente'}).click();await expect(page.getByText('El resultado de la operación quedó confirmado.')).toBeVisible();assert.equal(writes(model).length,1);assert.ok(model.calls.some(call=>call.path.endsWith('/operations/'+intent.operationId)));
 });
 await check('missing_receipt_never_replays_the_write',async({page,model})=>{
  model.mode='lost-before';await page.getByRole('button',{name:'Pausar actividad'}).click();await expect(page.getByRole('alert')).toBeVisible();model.mode='normal';await page.getByRole('button',{name:'Consultar resultado pendiente'}).click();await expect(page.getByText('Aún no hay un resultado registrado para esta operación. Se conserva sin repetirla.')).toBeVisible();await expect(page.getByRole('button',{name:'Pausar actividad'})).toBeDisabled();assert.equal(writes(model).length,1);assert.notEqual(await page.evaluate(key=>sessionStorage.getItem(key),storageKey()),null);
 });
 await check('receipt_different_action_or_version_keeps_original_pending',async({page,model})=>{
  model.mode='lost-after';await page.getByRole('button',{name:'Pausar actividad'}).click();await expect(page.getByRole('alert')).toBeVisible();model.mode='normal';
  for(const bad of [{humanPaused:false},{version:9}]){model.receipt={...model.row,...bad};await page.getByRole('button',{name:'Consultar resultado pendiente'}).click();await expect(page.getByRole('alert')).toContainText('operación se conserva');assert.notEqual(await page.evaluate(key=>sessionStorage.getItem(key),storageKey()),null);}
  assert.equal(writes(model).length,1);
 });
 await check('profile_read_race_discards_prior_response',async({page,model})=>{
  model.mode='delay-read';await page.getByRole('button',{name:'Consultar de nuevo'}).click();await expect.poll(()=>model.pending.length).toBe(1);model.mode='normal';model.row.humanPaused=true;await switchProfile(page);await expect(page.getByRole('button',{name:'Retirar pausa'})).toBeVisible();model.pending.shift()();await expect(page.getByRole('button',{name:'Pausar actividad'})).toHaveCount(0);assert.equal(writes(model).length,0);
 });
 await check('navigation_during_post_preserves_profile_scoped_pending',async({page,model})=>{
  model.mode='delay-post';await page.getByRole('button',{name:'Pausar actividad'}).click();await expect.poll(()=>model.pending.length).toBe(1);model.mode='normal';await switchProfile(page);await expect(page.getByRole('button',{name:'Retirar pausa'})).toBeVisible();await expect(page.getByRole('button',{name:'Consultar resultado pendiente'})).toHaveCount(0);model.pending.shift()();
  await switchProfile(page,'first',3);await expect(page.getByRole('button',{name:'Consultar resultado pendiente'})).toBeVisible();await expect(page.getByRole('button',{name:'Retirar pausa'})).toBeDisabled();assert.equal(writes(model).length,1);const pending=JSON.parse(await page.evaluate(key=>sessionStorage.getItem(key),storageKey()));assert.equal(pending.operationId,model.storageBeforePost[0].operationId);
 });
 await check('purpose_and_environment_do_not_reuse_another_pending_intent',async({page,model})=>{
  model.mode='lost-before';await page.getByRole('button',{name:'Pausar actividad'}).click();await expect(page.getByRole('alert')).toBeVisible();model.mode='normal';await page.getByLabel('Actividad').selectOption('warmup');await expect(page.getByRole('button',{name:'Pausar actividad'})).toBeEnabled();await expect(page.getByRole('button',{name:'Consultar resultado pendiente'})).toHaveCount(0);assert.ok(model.calls.at(-1).path.includes('/warmup'));
  await page.getByLabel('Actividad').selectOption('commercial');await expect(page.getByRole('button',{name:'Consultar resultado pendiente'})).toBeVisible();await switchProfile(page,'first',2,'SIMULATION');await expect(page.getByRole('button',{name:'Pausar actividad'})).toBeEnabled();await expect(page.getByRole('button',{name:'Consultar resultado pendiente'})).toHaveCount(0);assert.equal(model.calls.at(-1).query.environment,'SIMULATION');assert.equal(writes(model).length,1);
 });
 await check('storage_write_failure_stops_before_network',async({page,model})=>{
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new Error('synthetic storage failure');};});await page.getByRole('button',{name:'Pausar actividad'}).click();await expect(page.getByRole('alert')).toBeVisible();assert.equal(writes(model).length,0);await expect(page.getByRole('button',{name:'Pausar actividad'})).toBeDisabled();
 });
 await check('malformed_saved_intent_blocks_writes_after_reload',async({page,model})=>{
  await page.evaluate(key=>sessionStorage.setItem(key,'{"operation":"command","extra":true}'),storageKey());await page.reload();await expect(page.getByRole('alert')).toContainText('No se pudo recuperar');await expect(page.getByRole('button',{name:'Pausar actividad'})).toBeDisabled();assert.equal(writes(model).length,0);
 });
 await check('uncertain_http_503_retains_pending_without_exposing_body',async({page,model})=>{
  model.mode='http-503';await page.getByRole('button',{name:'Pausar actividad'}).click();await expect(page.getByRole('button',{name:'Consultar resultado pendiente'})).toBeVisible();await expect(page.getByText('untrusted provider detail')).toHaveCount(0);assert.equal(writes(model).length,1);assert.notEqual(await page.evaluate(key=>sessionStorage.getItem(key),storageKey()),null);
 });
 await check('viewer_revocation_and_read_failure_cannot_mutate_or_keep_old_rows',async({page,model})=>{
  await switchProfile(page,'first',2,'REAL',false);await expect(page.getByRole('button',{name:'Pausar actividad'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Revocar autorización'})).toHaveCount(0);
  model.mode='read-denied';await page.getByRole('button',{name:'Consultar de nuevo'}).click();await expect(page.getByRole('alert')).toContainText('No se pudo consultar');await expect(page.getByText('Autorizada; cada acción comprueba sus condiciones')).toHaveCount(0);await expect(page.getByText('must not appear')).toHaveCount(0);assert.equal(writes(model).length,0);
 });
 assert.deepEqual(pageErrors,[]);console.log(JSON.stringify({state:'CONTINUITY_BROWSER_CONTRACT_PASS',checks,synthetic_only:true,application_mounted:false,external_effects:false}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
