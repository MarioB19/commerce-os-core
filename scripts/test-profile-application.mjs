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
const id='10000000-0000-4000-8000-000000000001',calls=[],checks=[];let browser,workspaceId=null,version=0,mode='normal',release;
const profiles=()=>({profiles:[{id:'a',businessName:'Empresa A',state:'ACTIVE',timezone:'UTC',role:'owner',membershipVersion:1,selected:workspaceId==='a'},{id:'b',businessName:'Empresa B',state:'SUSPENDED',timezone:'UTC',role:'viewer',membershipVersion:2,selected:workspaceId==='b'}],selection:{workspaceId,version}});
try{
 browser=await chromium.launch({headless:true,channel:'chromium'});const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(url.origin!==base)return route.abort();
  if(!url.pathname.startsWith('/v2/')&&!url.pathname.startsWith('/v1/'))return route.continue();
  calls.push({path:url.pathname,method:req.method(),headers:req.headers(),body:req.postDataJSON()});
  if(url.pathname.startsWith('/v1/'))throw Error('UNREVIEWED_LEGACY_REQUEST');
  if(url.pathname==='/v2/me'){
   if(mode==='expired')return route.fulfill({status:401,json:{error:{code:'PROFILE_SESSION_EXPIRED'}}});
   return route.fulfill({json:{data:{user:{id:'user',name:'Cuenta sintética',email:'account@example.test'},profile:profiles()}}});
  }
  if(url.pathname==='/v2/me/profiles')return route.fulfill({json:{data:profiles()}});
  if(url.pathname==='/v2/me/profile-selection'){
   assert.equal(req.method(),'POST');const body=req.postDataJSON();assert.deepEqual(Object.keys(body).sort(),['expectedVersion','workspaceId']);assert.equal(body.expectedVersion,version);
   workspaceId=body.workspaceId;version++;
   if(mode==='lost')return route.abort('failed');
   return route.fulfill({json:{data:{workspaceId,version}}});
  }
  if(url.pathname==='/v2/platform/access')return route.fulfill({json:{data:{admin:false}}});
  if(url.pathname==='/v2/products'){
   const profile=req.headers()['x-commerce-profile-id'],current=mode;assert.equal(req.headers()['x-commerce-profile-version'],String(version));assert.equal(profile,workspaceId);
   if(current==='delayed')await new Promise(resolve=>{release=resolve;});
   // Six products show the filter; only the first carries the profile's name.
   return route.fulfill({json:{data:[0,1,2,3,4,5].map(n=>({id:n?id.slice(0,-1)+n:id,name:n?'Otro producto '+n:'Producto '+profile,description:'Descripción',version:1,archived:false,variants:[]}))}});
  }
  // V7 Inicio reads: answered as absent data so the page renders without business facts.
  if(['/v2/home','/v2/onboarding','/v2/variants','/v2/goals','/v2/alerts','/v2/results'].some(p=>url.pathname===p||url.pathname.startsWith(p+'/')))return route.fulfill({status:404,json:{error:{code:'NOT_FOUND',message:'Sin datos'}}});
  throw Error('UNEXPECTED_ROUTE '+url.pathname);
 });
 await page.goto(base+'/products');await expect(page.getByRole('heading',{name:'Tus perfiles',exact:true})).toBeVisible();assert.equal(calls.filter(x=>x.path.startsWith('/v2/products')).length,0);assert.equal(calls.filter(x=>x.method==='POST').length,0);checks.push('no_first_membership_or_business_request');
 await page.getByLabel('Perfil',{exact:true}).selectOption('a');await page.getByRole('button',{name:'Cambiar a este perfil'}).click();await expect(page.getByRole('heading',{name:'Producto a',exact:true})).toBeVisible();assert.equal(calls.filter(x=>x.method==='POST').length,1);assert.ok(calls.filter(x=>x.path==='/v2/me').length>=2);checks.push('one_cas_then_native_read_before_mount');
 await page.getByLabel('Buscar producto').fill('borrador');await page.getByRole('button',{name:'Cambiar perfil',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByLabel('Buscar producto')).toHaveValue('borrador');checks.push('cancel_switch_keeps_draft_and_focus');
 mode='delayed';await page.reload();await expect.poll(()=>typeof release).toBe('function');
 await page.getByRole('button',{name:'Cambiar perfil',exact:true}).click();await page.getByRole('button',{name:'Descartar borradores y elegir perfil'}).click();await expect(page.getByRole('heading',{name:'Tus perfiles',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Producto a',exact:true})).toHaveCount(0);
 mode='normal';await page.getByLabel('Perfil',{exact:true}).selectOption('b');await page.getByRole('button',{name:'Cambiar a este perfil'}).click();await expect(page.getByRole('heading',{name:'Producto b',exact:true})).toBeVisible();release();release=undefined;await expect(page.getByRole('heading',{name:'Producto a',exact:true})).toHaveCount(0);await expect(page.getByLabel('Buscar producto')).toHaveValue('');await expect(page.getByRole('status')).toContainText('suspendido');checks.push('late_previous_profile_cannot_render_and_draft_discarded');
 await page.goto(base+'/settings/employees');await expect(page.getByRole('alert')).toContainText('No tienes permiso');assert.equal(calls.filter(x=>x.path==='/v2/profile/employees').length,0);checks.push('viewer_surface_denied_without_business_request');
 await page.goto(base+'/home');await page.getByRole('button',{name:'Cambiar perfil',exact:true}).click();await page.getByRole('button',{name:'Descartar borradores y elegir perfil'}).click();await page.getByLabel('Perfil',{exact:true}).selectOption('a');mode='lost';const before=calls.filter(x=>x.method==='POST').length;await page.getByRole('button',{name:'Cambiar a este perfil'}).click();await expect(page.getByRole('alert')).toContainText('No se pudo confirmar');await expect(page.getByRole('button',{name:'Cambiar a este perfil'})).toBeDisabled();assert.equal(calls.filter(x=>x.method==='POST').length,before+1);
 mode='normal';await page.getByRole('button',{name:'Actualizar perfiles'}).click();await expect(page.getByRole('button',{name:'Continuar con este perfil'})).toBeEnabled();await page.getByRole('button',{name:'Continuar con este perfil'}).click();await expect(page.getByRole('heading',{name:'Inicio · Empresa A'})).toBeVisible();assert.equal(calls.filter(x=>x.method==='POST').length,before+1);checks.push('lost_cas_only_get_reconcile_no_replay');
 workspaceId=null;version++;await page.goto(base+'/account/security');await expect(page.getByRole('heading',{name:'Seguridad',exact:true})).toBeVisible();await expect(page.getByText('account@example.test',{exact:true})).toBeVisible();checks.push('identity_security_without_selected_profile');
 mode='expired';await page.goto(base+'/products');await expect(page.getByRole('heading',{name:'Inicia sesión'})).toBeVisible();await expect(page.getByRole('heading',{name:'Producto a',exact:true})).toHaveCount(0);checks.push('expired_identity_no_legacy_fallback');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({state:'PROFILE_APPLICATION_BROWSER_PASS',checks,synthetic_only:true,profile_entrypoint_mounted:true,full_v7_navigation:false}));
}finally{release?.();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
