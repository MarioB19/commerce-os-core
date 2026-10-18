// Mounted profile entrypoint with synthetic loopback responses; no external sales.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{ProfileApplication}from'./src/components/profile-application.tsx';createRoot(document.getElementById('root')).render(<ProfileApplication path={location.pathname} login={()=><main><h1>Inicia sesión</h1></main>}/>);`,resolveDir:web,sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Ventas del perfil</title><body><div id="root"></div><script src="/fixture.js"></script></body></html>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const id=n=>'30000000-0000-4000-8000-'+String(n).padStart(12,'0'),at='2026-10-12T00:00:00Z';
let diagnosticPage;
let workspace='a',version=1,role='operator',profileState='ACTIVE',mode='normal',browser,delayDetail=false,releaseDetail;
const calls=[],checks=[],commands=new Map(),errors=[];
const boot=()=>({user:{id:'u',name:'Operador sintético',email:'u@example.test'},profile:{profiles:['a','b'].map(id=>({id,businessName:'Empresa '+id,state:profileState,timezone:'UTC',role,membershipVersion:1,selected:id===workspace})),selection:{workspaceId:workspace,version}}});
const record=(n,extra={})=>({id:id(n),version:1,environment:'REAL',created_at:at,updated_at:at,...extra});
const message='Texto privado sintético para el cliente';
try{
 browser=await chromium.launch({headless:true,channel:'chromium'});const context=await browser.newContext(),page=await context.newPage();diagnosticPage=page;page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/v1/')&&!url.pathname.startsWith('/v2/'))return route.continue();
  if(url.pathname==='/v2/me')return route.fulfill({json:{data:boot()}});
  if(url.pathname==='/v2/platform/access')return route.fulfill({json:{data:{admin:false}}});
  // V7 shell reads (Inicio summary, month goal): answered as absent data so the page renders without business facts.
  if(['/v2/home','/v2/variants','/v2/goals','/v2/results','/v2/alerts'].some(p=>url.pathname===p||url.pathname.startsWith(p+'/')))return route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'Sin datos'}}});
  const call={path:url.pathname,method:req.method(),headers:req.headers(),body:req.postDataJSON(),query:Object.fromEntries(url.searchParams)};calls.push(call);
  assert.equal(call.headers['x-commerce-profile-id'],workspace);assert.equal(call.headers['x-commerce-profile-version'],String(version));assert.equal(call.headers.authorization,undefined);
  if(url.pathname.startsWith('/v1/sales-operations/')){
   if(mode==='html404')return route.fulfill({status:404,contentType:'text/html',body:'<html>missing</html>'});
   const key=url.pathname.split('/').at(-1),command=commands.get(workspace+':'+key);
   return command?route.fulfill({json:{data:{key,operation:url.searchParams.get('operation'),resource_id:url.searchParams.get('resource_id'),command}}}):route.fulfill({status:404,json:{error:{code:'SALES_OPERATION_NOT_FOUND',message:'SALES_OPERATION_NOT_FOUND'}}});
  }
  if(req.method()==='POST'){
   assert.equal(call.body.environment,'REAL');assert.equal(call.body.authorization_id,undefined);const key=call.headers['idempotency-key'];assert.match(key,/^[a-f0-9-]{36}$/);
   const raw=await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('commerce:sales-pending:')).map(k=>sessionStorage.getItem(k)).join(''));
   assert.ok(raw.includes(key));assert.ok(!raw.includes(message));assert.ok(!raw.includes('text":'));assert.ok(!raw.includes('reason":'));
   if(mode==='lost-before')return route.abort('failed');
   const resource=url.pathname.split('/')[3],command={id:id(50+commands.size),workspace_id:workspace,environment:'REAL',kind:url.pathname.endsWith('/review')?'receipt_review':'conversation_command',resource_id:resource,actor_id:'u',idempotency_key:key,status:'PENDING',payload:call.body,result:{},created_at:at,updated_at:at};commands.set(workspace+':'+key,command);
   if(mode==='lost-after')return route.abort('failed');
   return route.fulfill({status:202,json:{data:url.pathname.endsWith('/controls')?{workspace_id:workspace,environment:'REAL',scope_type:'conversation',scope_id:resource,paused:!!call.body.paused,takeover:!!call.body.takeover,suppressed:false,version:1,command_id:command.id}:command}});
  }
  assert.equal(url.searchParams.get('environment'),'REAL');
  if(url.pathname==='/v1/conversations')return route.fulfill({json:{data:[record(1,{name:'Consulta de '+workspace,status:'OPEN'})],meta:{total:url.searchParams.get('q')?1:21}}});
  if(url.pathname==='/v1/conversations/'+id(1)){
   if(delayDetail){delayDetail=false;await new Promise(resolve=>{releaseDetail=resolve;});}
   return route.fulfill({json:{data:record(1,{name:'Consulta de '+workspace,status:'OPEN',messages:[record(2,{conversation_id:id(1),direction:'inbound',text:'Quiero conocer el producto'})],contact:record(3,{name:'Cliente de '+workspace}),order:record(4,{amount_minor:10000,currency:'MXN',status:'UNPAID'}),offer:null,controls:{paused:false,takeover:false,suppressed:false}})}});
  }
  if(url.pathname==='/v1/receipts')return route.fulfill({json:{data:[record(6,{name:'Comprobante sintético',status:'HUMAN_REVIEW',amount_minor:10000,currency:'MXN'})],meta:{total:1}}});
  if(url.pathname==='/v1/receipts/'+id(6))return route.fulfill({json:{data:record(6,{name:'Comprobante sintético',status:'HUMAN_REVIEW',amount_minor:10000,currency:'MXN',conversation_id:id(1)})}});
  if(url.pathname==='/v1/orders')return route.fulfill({json:{data:[record(4,{name:'Pedido sintético',status:'UNPAID',amount_minor:10000,currency:'MXN'})],meta:{total:1}}});
  if(url.pathname==='/v1/orders/'+id(4))return route.fulfill({json:{data:record(4,{name:'Pedido sintético',status:'UNPAID',amount_minor:10000,currency:'MXN',conversation_id:id(1)})}});
  throw Error('unexpected fixture route '+url.pathname);
 });
 const writes=()=>calls.filter(c=>c.method==='POST'),openConversation=async()=>{await page.getByRole('button',{name:/Consulta de/}).click();await expect(page.getByRole('list',{name:'Mensajes'})).toContainText('Quiero conocer el producto');};
 await page.goto(base+'/sales/inbox');await openConversation();await expect(page.getByText('Cliente de a',{exact:false})).toBeVisible();assert.equal(writes().length,0);checks.push('mounted_selected_profile_conversation_context');assert.deepEqual((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze()).violations,[]);checks.push('conversation_forms_accessible');
 await page.getByRole('button',{name:'Siguiente',exact:true}).click();await expect.poll(()=>calls.filter(c=>c.path==='/v1/conversations').at(-1).query.offset).toBe('20');await page.getByLabel('Buscar conversaciones').fill('Consulta');await page.getByRole('button',{name:'Buscar',exact:true}).click();await expect.poll(()=>calls.filter(c=>c.path==='/v1/conversations').at(-1).query.q).toBe('Consulta');assert.equal(calls.filter(c=>c.path==='/v1/conversations').at(-1).query.offset,'0');checks.push('search_and_page_scoped_without_write');await openConversation();
 mode='lost-after';await page.getByLabel('Mensaje',{exact:true}).fill(message);await page.getByRole('button',{name:'Registrar mensaje',exact:true}).click();await expect(page.getByRole('alert')).toContainText('No se pudo confirmar');const first=writes()[0];assert.equal(writes().length,1);checks.push('durable_private_pointer_before_lost_ack');
 workspace='b';version++;mode='normal';await page.reload();await expect(page.getByRole('button',{name:'Consultar solicitud'})).toHaveCount(0);assert.equal(writes().length,1);checks.push('other_profile_cannot_reconcile_pending');
 workspace='a';version++;await page.reload();await expect(page.getByRole('alert')).toContainText('Hay una solicitud pendiente');await page.getByRole('button',{name:'Consultar solicitud'}).click();await expect(page.getByRole('status').filter({hasText:'aplicación sigue pendiente'}).first()).toBeVisible();assert.equal(writes().length,1);assert.ok(calls.some(c=>c.path==='/v1/sales-operations/'+first.headers['idempotency-key']));checks.push('reload_reconciles_get_only_and_does_not_claim_sent');
 commands.get('a:'+first.headers['idempotency-key']).status='APPLIED';await page.getByRole('button',{name:'Consultar solicitud'}).click();await expect(page.getByRole('status').filter({hasText:'Comando aplicado.'}).first()).toBeVisible();assert.equal(writes().length,1);checks.push('applied_status_refresh_get_only');
 await openConversation();await page.getByLabel('Motivo de la decisión').fill('Atención manual solicitada');await page.getByRole('button',{name:'Pausar automatización'}).click();await expect(page.getByRole('status').filter({hasText:'aplicación sigue pendiente'}).first()).toBeVisible();assert.deepEqual(writes().at(-1).body,{paused:true,reason:'Atención manual solicitada',environment:'REAL'});checks.push('pause_intent_fixed_scope_and_reason');
 // V7 F5: /sales/receipts is the receipt queue (/v2/receipts), covered by its own suites; this contract keeps conversations and orders.
 await page.goto(base+'/sales/inbox');await openConversation();mode='lost-before';await page.getByLabel('Mensaje',{exact:true}).fill(message);await page.getByRole('button',{name:'Registrar mensaje',exact:true}).click();await expect(page.getByRole('alert')).toContainText('No se pudo confirmar');const original=writes().at(-1),count=writes().length;mode='html404';await page.reload();await page.getByRole('button',{name:'Consultar solicitud'}).click();await expect(page.getByRole('button',{name:'Reenviar la misma solicitud'})).toHaveCount(0);assert.equal(writes().length,count);mode='normal';await page.getByRole('button',{name:'Consultar solicitud'}).click();await expect(page.getByRole('alert')).toContainText('No se encontró la solicitud');assert.equal(writes().length,count);await openConversation();await page.getByLabel('Mensaje',{exact:true}).fill('Cambió el texto');await page.getByRole('button',{name:'Reenviar mensaje con la misma referencia'}).click();await expect(page.getByRole('alert')).toContainText('no coinciden');assert.equal(writes().length,count);await page.getByLabel('Mensaje',{exact:true}).fill(message);await page.getByRole('button',{name:'Reenviar mensaje con la misma referencia'}).click();await expect(page.getByRole('status').filter({hasText:'aplicación sigue pendiente'}).first()).toBeVisible();assert.equal(writes().at(-1).headers['idempotency-key'],original.headers['idempotency-key']);assert.deepEqual(writes().at(-1).body,original.body);checks.push('reload_canonical_absence_requires_exact_reentry_and_same_uuid');
 role='viewer';version++;await page.reload();await openConversation();await expect(page.getByRole('button',{name:'Registrar mensaje',exact:true})).toHaveCount(0);await expect(page.getByText('Tu rol permite consultar estos registros.')).toBeVisible();checks.push('viewer_has_no_write_forms');
 role='operator';profileState='SUSPENDED';version++;await page.reload();await openConversation();await expect(page.getByRole('button',{name:'Registrar mensaje',exact:true})).toHaveCount(0);checks.push('suspended_profile_has_no_write_forms');
 profileState='ACTIVE';version++;await page.goto(base+'/sales/orders');await page.getByRole('button',{name:/Pedido sintético/}).click();await expect(page.getByRole('heading',{name:'Pedido sintético'})).toBeVisible();checks.push('orders_readonly_context_mount');
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();assert.deepEqual(axe.violations,[]);assert.doesNotMatch(await page.locator('body').innerText(),/SIMULATION|Simulación|Operación real/);checks.push('accessibility_and_no_runtime_mode_exposure');assert.deepEqual(errors,[]);
 console.log(JSON.stringify({state:'PROFILE_SALES_BROWSER_PASS',checks,synthetic_only:true,application_mounted:true,native_database:false}));
}catch(error){console.error(JSON.stringify({checks,errors,body:await diagnosticPage?.locator('body').innerText()}));throw error;}finally{releaseDetail?.();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
