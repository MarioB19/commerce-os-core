// Actual mounted profile entrypoint; all HTTP responses below are synthetic loopback.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{ProfileApplication}from'./src/components/profile-application.tsx';createRoot(document.getElementById('root')).render(<ProfileApplication path={location.pathname} login={retry=><main><h1>Inicia sesión</h1><button onClick={retry}>Consultar acceso</button></main>}/>);`,resolveDir:web,sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Perfiles Commerce OS</title><body><div id="root"></div><script src="/fixture.js"></script></body></html>');}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;

const id=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0'),product=id(1),ref=n=>({id:id(n),revision:1,sha256:'a'.repeat(64)});
const options=['offer','flow','seller','collection','material'].map((kind,n)=>({kind,label:'Opción '+kind,ref:ref(n+10)}));
const calls=[],checks=[],receipts=new Map();let browser,workspace='a',version=1,mode='normal',adopted=false,draft=null;
const boot=()=>({user:{id:'operator',name:'Cuenta sintética',email:'operator@example.test'},profile:{profiles:['a','b'].map(id=>({id,businessName:'Empresa '+id,state:'ACTIVE',timezone:'UTC',role:'operator',membershipVersion:1,selected:id===workspace})),selection:{workspaceId:workspace,version}}});
try{
 browser=await chromium.launch({headless:true,channel:'chromium'});const page=await browser.newPage(),errors=[];page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/v2/')&&!url.pathname.startsWith('/v1/'))return route.continue();
  const call={path:url.pathname,method:req.method(),headers:req.headers(),body:req.postDataJSON()};calls.push(call);
  assert.ok(!url.pathname.startsWith('/v1/'));
  if(url.pathname==='/v2/me')return route.fulfill({json:{data:boot()}});
  assert.equal(call.headers['x-commerce-profile-id'],workspace);assert.equal(call.headers['x-commerce-profile-version'],String(version));assert.equal(call.headers.authorization,undefined);
  if(url.pathname==='/v2/catalog/products')return route.fulfill({json:{data:[{id:product,name:'Producto sintético',description:'Texto',version:1,environment:'REAL',created_at:'2026-10-12T00:00:00Z',updated_at:'2026-10-12T00:00:00Z'}],meta:{hasMore:false,limit:20,offset:0}}});
  assert.equal(url.searchParams.get('environment'),'REAL');
  if(url.pathname.endsWith('/options'))return mode==='options-error'||workspace==='b'?route.fulfill({status:404,json:{error:{code:'MARKET_NOT_FOUND',message:'MARKET_NOT_FOUND'}}}):route.fulfill({json:{data:{scope:{workspace_id:workspace,environment:'REAL'},product:{id:product,name:'Producto sintético',version:1,adopted},options}}});
  if(url.pathname.includes('/operations/')){if(mode==='proxy-404')return route.fulfill({status:404,contentType:'text/html',body:'<html>Not found</html>'});const result=receipts.get(url.pathname.split('/').at(-1));return result?route.fulfill({json:{data:result}}):route.fulfill({status:404,json:{error:{code:'MARKET_NOT_FOUND',message:'MARKET_NOT_FOUND'}}});}
  if(req.method()==='GET')return url.pathname==='/v2/market/variants'?route.fulfill({json:{data:draft?[draft]:[],meta:{has_more:false,next:null}}}):route.fulfill({json:{data:draft}});
  const key=call.headers['idempotency-key'];assert.match(key,/^[a-f0-9-]{36}$/);
  const entries=await page.evaluate(()=>Object.keys(sessionStorage).filter(k=>k.startsWith('commerce:market-pending:')).map(k=>JSON.parse(sessionStorage.getItem(k))));assert.ok(entries.some(v=>v.command.operation_id===key));
  if(mode==='lost-before')return route.abort('failed');
  let result;
  if(url.pathname==='/v2/market/families'){adopted=true;result={id:product};}
  else if(url.pathname.endsWith('/releases')){assert.equal(call.body.draft_sha256,draft.draft_sha256);assert.equal(call.body.reviewed_fields.length,6);draft={...draft,version:draft.version+1,current_release_id:id(3),release_revision:1};result={variant:draft,release:{id:id(3),scope:{workspace_id:workspace,environment:'REAL'},family_id:product,variant_id:id(2),revision:1,...draft.draft},sha256:'c'.repeat(64),effects_authorized:false};}
  else{draft={id:id(2),family_id:product,version:1,draft:call.body.fields,draft_sha256:'b'.repeat(64),current_release_id:null,source_release_id:null,release_revision:0};result=draft;}
  receipts.set(key,structuredClone(result));if(mode==='lost-after')return route.abort('failed');return route.fulfill({json:{data:result}});
 });
 const writes=()=>calls.filter(c=>c.method!=='GET');
 await page.goto(base+'/products');await page.getByRole('link',{name:'Variantes de Producto sintético'}).click();await expect(page.getByRole('heading',{name:'Variantes de Producto sintético'})).toBeVisible();assert.equal(writes().length,0);assert.ok(calls.some(c=>c.path.endsWith('/options')));checks.push('product_link_mounts_scoped_options_without_mutation');
 mode='lost-after';await page.getByRole('button',{name:'Preparar producto para variantes'}).click();await expect(page.getByRole('alert')).toContainText('no está confirmado');const pendingKey=writes()[0].headers['idempotency-key'];assert.equal(writes().length,1);checks.push('operation_persisted_before_post_and_lost_ack_preserved');
 mode='normal';workspace='b';version++;await page.reload();await expect(page.getByRole('alert')).toContainText('No se pudieron confirmar');await expect(page.getByRole('button',{name:'Comprobar operación'})).toHaveCount(0);assert.equal(writes().length,1);checks.push('foreign_profile_cannot_consume_pending_operation');
 workspace='a';version++;await page.reload();await expect(page.getByRole('alert')).toContainText('Hay una operación pendiente');assert.equal(writes().length,1);await page.getByRole('button',{name:'Comprobar operación'}).click();await expect(page.getByText('Operación confirmada.')).toBeVisible();assert.equal(calls.at(-1).path,'/v2/market/operations/'+pendingKey);assert.equal(writes().length,1);checks.push('return_and_reload_reconciles_same_uuid_get_only');
 await page.getByRole('button',{name:'Nueva variante'}).click();await page.getByLabel('Precio en MXN').fill('100.00');
 for(const[label,index]of[['Oferta y seguimiento',10],['Flujo',11],['Vendedor',12],['Cobro',13],['Materiales',14]])await page.getByRole(index===14?'listbox':'combobox',{name:new RegExp('^'+label)}).selectOption(id(index)+':1');
 await page.getByRole('button',{name:'Guardar borrador'}).click();await expect(page.getByRole('heading',{name:'Editar borrador'})).toBeVisible();assert.equal(writes().length,2);assert.deepEqual(writes()[1].body.fields.configuration,{offer:ref(10),flow:ref(11),seller:ref(12),collection:ref(13),remarketing:ref(10),materials:[ref(14)]});checks.push('draft_uses_only_projected_immutable_refs');
 await expect(page.getByRole('button',{name:'Publicar versión comercial',exact:true})).toBeDisabled();for(let n=0;n<6;n++)await page.getByRole('checkbox').nth(n).check();await page.getByRole('button',{name:'Publicar versión comercial',exact:true}).click();await expect(page.getByRole('heading',{name:'Copiar la versión publicada a otro mercado'})).toBeVisible();assert.equal(writes().length,3);checks.push('all_reviews_publish_saved_version_without_assignment_calls');
 mode='lost-before';await page.getByRole('button',{name:'Preparar producto para variantes'}).click();await expect(page.getByRole('alert')).toContainText('no está confirmado');const absent=writes().at(-1);mode='proxy-404';await page.reload();await page.getByRole('button',{name:'Comprobar operación'}).click();await expect(page.getByRole('alert')).toContainText('Todavía no se pudo confirmar');await expect(page.getByRole('button',{name:'Reenviar la misma solicitud'})).toHaveCount(0);assert.equal(writes().length,4);checks.push('reload_proxy404_never_enables_write');mode='normal';await page.getByRole('button',{name:'Comprobar operación'}).click();await expect(page.getByRole('button',{name:'Reenviar la misma solicitud'})).toBeVisible();assert.equal(writes().length,4);await page.getByRole('button',{name:'Reenviar la misma solicitud'}).click();await expect(page.getByRole('button',{name:'Nueva variante'})).toBeVisible();assert.equal(writes().length,5);assert.equal(writes().at(-1).headers['idempotency-key'],absent.headers['idempotency-key']);assert.deepEqual(writes().at(-1).body,absent.body);checks.push('absent_receipt_manual_resend_preserves_uuid_after_reload');
 mode='options-error';await page.reload();await expect(page.getByRole('alert')).toContainText('No se pudieron confirmar');await expect(page.getByRole('button',{name:'Nueva variante'})).toHaveCount(0);assert.equal(writes().length,5);checks.push('options_failure_hides_form_without_fallback');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({state:'PRODUCT_VARIANT_ENTRYPOINT_BROWSER_PASS',checks,synthetic_only:true,application_mounted:true,native_database:false}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
