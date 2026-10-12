// Isolated real-browser contract test. Does not mount the selector in the app,
// open a database, run Docker or contact external services.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ProfileSelector}from'./src/components/profile-selector.tsx';createRoot(document.getElementById('root')).render(<ProfileSelector onConfirmed={value=>window.confirmed=value}/>);`,resolveDir:web,sourcefile:'profile-selector-fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const html='<!doctype html><html lang="es"><meta charset="utf-8"><title>Selector aislado</title><body><main id="root"></main><script src="/fixture.js"></script></body></html>';
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}else{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
const profile=(id,state='ACTIVE',selected=false)=>({id,businessName:id==='first'?'Negocio Uno':'Negocio Dos',state,timezone:'America/Mexico_City',role:id==='first'?'owner':'viewer',membershipVersion:1,selected});
const checks=[];
try{
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 let data={profiles:[profile('first'),profile('second','SUSPENDED')],selection:{workspaceId:null,version:0}},posts=[],gets=0,mode='success';
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();
  if(url.pathname==='/v2/me/profiles'){gets++;assert.equal(url.search,'');return route.fulfill({json:{data}});}
  if(url.pathname==='/v2/me/profile-selection'){
   const input=request.postDataJSON();posts.push(input);assert.equal(request.method(),'POST');assert.equal(url.search,'');
   if(mode==='lost')return route.abort('failed');
   await new Promise(resolve=>setTimeout(resolve,100));return route.fulfill({json:{data:{workspaceId:input.workspaceId,version:input.expectedVersion+1}}});
  }
  return route.continue();
 });
 await page.goto(base);await expect(page.getByRole('heading',{name:'Elige el perfil de tu negocio'})).toBeVisible();
 await expect(page.getByRole('combobox')).toHaveValue('');await expect(page.getByRole('button',{name:'Cambiar a este perfil'})).toBeDisabled();
 await expect(page.getByRole('option',{name:'Negocio Uno · Dueño'})).toHaveCount(1);checks.push('explicit_selection_and_role_labels');
 await page.getByRole('combobox').selectOption('second');await expect(page.getByText('Este perfil está suspendido.',{exact:false})).toBeVisible();checks.push('suspended_state_is_visible');
 await page.getByRole('combobox').selectOption('first');await page.getByRole('button',{name:'Cambiar a este perfil'}).evaluate(button=>{button.click();button.click();});
 await expect.poll(()=>page.evaluate(()=>window.confirmed)).toEqual({workspaceId:'first',version:1});assert.deepEqual(posts,[{workspaceId:'first',expectedVersion:0}]);checks.push('double_submit_is_one_cas_request');
 posts=[];mode='lost';await page.reload();await page.getByRole('combobox').selectOption('first');await page.getByRole('button',{name:'Cambiar a este perfil'}).click();
 await expect(page.getByRole('alert')).toContainText('Actualiza los perfiles');await expect(page.getByRole('combobox')).toBeDisabled();await expect(page.getByRole('button',{name:'Cambiar a este perfil'})).toBeDisabled();assert.equal(posts.length,1);checks.push('unknown_result_blocks_replay');
 data={profiles:[profile('first','ACTIVE',true),profile('second')],selection:{workspaceId:'first',version:1}};mode='success';const previousGets=gets;
 await page.getByRole('button',{name:'Actualizar perfiles'}).click();await expect(page.getByRole('combobox')).toBeEnabled();await expect(page.getByText('Perfil actual:',{exact:false})).toContainText('Negocio Uno');assert.equal(gets,previousGets+1);
 await page.getByRole('button',{name:'Continuar con este perfil'}).click();await expect.poll(()=>page.evaluate(()=>window.confirmed)).toEqual({workspaceId:'first',version:1});assert.equal(posts.length,1);checks.push('readback_recovers_committed_selection_without_second_post');
 data={profiles:[],selection:{workspaceId:null,version:0}};await page.reload();await expect(page.getByText('No tienes acceso a un perfil.',{exact:false})).toBeVisible();await expect(page.getByRole('combobox')).toHaveCount(0);checks.push('empty_membership_has_no_default_profile');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PROFILE_SELECTOR_BROWSER_CONTRACT_PASS',checks,synthetic_fixture:true,production_activation:false}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
