// Synthetic browser contract; all API routes are fulfilled in this process.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ProfileCatalog}from'./src/components/profile-catalog.tsx';function Fixture(){const[state,setState]=useState({selection:{workspaceId:'first',version:1},environment:'REAL'});window.chooseProfile=setState;return <ProfileCatalog {...state}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:web,sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Catálogo</title><body><main id="root"></main><script src="/fixture.js"></script></body></html>');}else{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const row=(name,environment='REAL',version=2,n=1)=>({id:id(n),name,description:'Descripción pública',version,environment,created_at:'2026-10-12T00:00:00Z',updated_at:'2026-10-12T00:00:00Z'});
const calls=[],checks=[];let browser,mode='normal',release;
try{
 browser=await chromium.launch({headless:true,channel:'chromium'});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/v2/catalog/'))return route.continue();
  assert.equal(request.method(),'GET');const headers=request.headers(),profile=headers['x-commerce-profile-id'];assert.ok(['first','second'].includes(profile));assert.equal(headers.authorization,undefined);
  calls.push({profile,version:headers['x-commerce-profile-version'],path:url.pathname,query:Object.fromEntries(url.searchParams)});
  const currentMode=mode;if(currentMode==='delayed')await new Promise(resolve=>{release=resolve;});
  if(currentMode==='rejected')return route.fulfill({status:403,json:{private:'not rendered'}});
  if(currentMode==='lost')return route.abort('failed');
  const environment=url.searchParams.get('environment'),name=profile+' '+environment;
  if(url.pathname.endsWith('/versions'))return route.fulfill({json:{data:[row(name,environment,2),row(name+' anterior',environment,1)],meta:{limit:20,hasMore:false}}});
  if(url.pathname.endsWith(id(1)))return route.fulfill({json:{data:row(name,environment)}});
  const offset=Number(url.searchParams.get('offset')),data=currentMode==='pages'&&!offset?Array.from({length:20},(_,i)=>row(name+' '+i,environment,2,i+1)):[row(name,environment)];
  return route.fulfill({json:{data,meta:{hasMore:currentMode==='pages'&&!offset,limit:20,offset}}});
 });
 await page.goto(base);await expect(page.getByRole('heading',{name:'first REAL',exact:true})).toBeVisible();checks.push('cookie_fence_scoped_list');
 await page.getByRole('button',{name:'Ver first REAL',exact:true}).click();await expect(page.getByText('Detalle del recurso')).toBeVisible();
 await page.getByRole('button',{name:'Versiones de first REAL'}).click();await expect(page.getByText('Historial de versiones')).toBeVisible();await expect(page.getByRole('heading',{name:'first REAL anterior'})).toBeVisible();checks.push('detail_and_history_same_profile');
 mode='delayed';await page.getByRole('button',{name:'Consultar de nuevo'}).click();await expect.poll(()=>typeof release).toBe('function');await expect(page.getByRole('heading',{name:'first REAL',exact:true})).toHaveCount(0);
 mode='normal';await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:'second',version:2},environment:'REAL'}));await expect(page.getByRole('heading',{name:'second REAL',exact:true})).toBeVisible();release();release=undefined;await expect(page.getByRole('heading',{name:'first REAL anterior'})).toHaveCount(0);checks.push('late_previous_selection_cannot_replace_current_data');
 await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:'second',version:2},environment:'SIMULATION'}));await expect(page.getByRole('heading',{name:'second SIMULATION',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'second REAL',exact:true})).toHaveCount(0);checks.push('environment_switch_clears_other_data');
 mode='delayed';await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:'second',version:2},environment:'REAL'}));await expect.poll(()=>typeof release).toBe('function');const oldRelease=release;release=undefined;
 await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:'second',version:2},environment:'SIMULATION'}));await expect.poll(()=>typeof release).toBe('function');await expect(page.getByRole('heading',{name:'second SIMULATION',exact:true})).toHaveCount(0);oldRelease();mode='normal';release();release=undefined;await expect(page.getByRole('heading',{name:'second SIMULATION',exact:true})).toBeVisible();checks.push('return_to_previous_context_requires_new_read');
 mode='rejected';const before=calls.length;await page.getByRole('button',{name:'Consultar de nuevo'}).click();await expect(page.getByRole('alert')).toContainText('ya no está vigente');await expect(page.getByRole('heading',{name:'second SIMULATION',exact:true})).toHaveCount(0);assert.equal(calls.length,before+1);checks.push('authority_rejection_clears_data_no_retry');
 mode='normal';await page.getByRole('button',{name:'Consultar de nuevo'}).click();await expect(page.getByRole('heading',{name:'second SIMULATION',exact:true})).toBeVisible();await page.getByLabel('Buscar por nombre o descripción').fill('a&workspace=first');await page.getByRole('button',{name:'Buscar',exact:true}).click();await expect.poll(()=>calls.at(-1).query.q).toBe('a&workspace=first');assert.equal(calls.at(-1).profile,'second');assert.equal(calls.at(-1).query.workspace,undefined);checks.push('search_does_not_override_profile');
 mode='pages';await page.getByRole('button',{name:'Consultar de nuevo'}).click();await expect(page.getByRole('button',{name:'Página siguiente'})).toBeEnabled();await page.getByRole('button',{name:'Página siguiente'}).click();await expect(page.getByRole('button',{name:'Página anterior'})).toBeEnabled();await expect(page.getByRole('button',{name:'Página siguiente'})).toBeDisabled();assert.equal(calls.at(-1).query.offset,'20');checks.push('bounded_explicit_page');
 const count=calls.length;await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:null,version:3},environment:'REAL'}));await expect(page.getByText('Elige un perfil para consultar el catálogo.')).toBeVisible();assert.equal(calls.length,count);await expect(page.getByRole('heading',{name:'second SIMULATION',exact:true})).toHaveCount(0);checks.push('no_selection_no_catalog_request');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({state:'PROFILE_CATALOG_BROWSER_CONTRACT_PASS',checks,synthetic_only:true,application_mounted:false}));
}finally{release?.();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
