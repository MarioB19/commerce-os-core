// Browser contract for the staged profile form. All API responses are synthetic;
// external network requests are denied and this does not mount it in the app.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';

const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{ProfileSettings}from'./src/components/profile-settings.tsx';function Fixture(){const[state,setState]=useState({selection:{workspaceId:'first',version:1},role:'owner'});window.chooseProfile=setState;return <ProfileSettings {...state}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:web,sourcefile:'profile-settings-fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const html='<!doctype html><html lang="es"><meta charset="utf-8"><title>Datos del perfil aislado</title><body><main id="root"></main><script src="/fixture.js"></script></body></html>';
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}else{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;let browser;
const profile=(id,state='ACTIVE')=>({id,business_name:id==='first'?'Negocio Uno':'Negocio Dos',timezone:'America/Mexico_City',version:1,state,number_limit:20,product_limit:10,daily_conversation_limit:100});
const checks=[];
try{
 browser=await chromium.launch({headless:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 let rows={first:profile('first'),second:profile('second')},posts=[],gets=[],mode='success',release;
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();
  if(url.pathname!=='/v2/profile')return route.continue();
  assert.equal(url.search,'');const headers=request.headers(),id=headers['x-commerce-profile-id'];assert.ok(rows[id]);assert.match(headers['x-commerce-profile-version'],/^[1-9][0-9]*$/);assert.equal(headers.authorization,undefined);
  if(request.method()==='GET'){gets.push({id,version:headers['x-commerce-profile-version']});return route.fulfill({json:{data:rows[id]}});}
  assert.equal(request.method(),'PATCH');const body=request.postDataJSON();posts.push({id,body});
  if(mode==='lost')return route.abort('failed');
  if(mode==='delayed')await new Promise(resolve=>{release=resolve;});
  const result={id,business_name:body.businessName,timezone:body.timezone,version:body.expectedVersion+1,changed:true};rows[id]={...rows[id],business_name:result.business_name,timezone:result.timezone,version:result.version};
  return route.fulfill({json:{data:result}});
 });
 await page.goto(base);await expect(page.getByLabel('Nombre del negocio')).toHaveValue('Negocio Uno');await expect(page.getByLabel('Zona horaria')).toHaveValue('America/Mexico_City');assert.deepEqual(gets,[{id:'first',version:'1'}]);checks.push('profile_read_uses_exact_selection_fence');
 await page.getByLabel('Nombre del negocio').fill('Nombre nuevo');mode='delayed';
 await page.getByRole('button',{name:'Guardar datos'}).evaluate(button=>{button.click();button.click();});await expect.poll(()=>posts.length).toBe(1);release();
 await expect(page.getByRole('status')).toHaveText('Datos del negocio guardados.');assert.deepEqual(posts[0],{id:'first',body:{expectedVersion:1,businessName:'Nombre nuevo',timezone:'America/Mexico_City'}});checks.push('double_submit_sends_one_versioned_patch');
 mode='lost';await page.getByLabel('Nombre del negocio').fill('Guardado incierto');await page.getByRole('button',{name:'Guardar datos'}).click();await expect(page.getByRole('alert')).toContainText('Actualiza los datos');await expect(page.getByLabel('Nombre del negocio')).toBeDisabled();await expect(page.getByRole('button',{name:'Guardar datos'})).toBeDisabled();assert.equal(posts.length,2);checks.push('lost_response_blocks_repeated_save');
 rows.first={...rows.first,business_name:'Estado confirmado',version:3};mode='success';const before=gets.length;await page.getByRole('button',{name:'Actualizar datos'}).click();await expect(page.getByLabel('Nombre del negocio')).toHaveValue('Estado confirmado');await expect(page.getByRole('button',{name:'Guardar datos'})).toBeEnabled();assert.equal(gets.length,before+1);assert.equal(posts.length,2);checks.push('fresh_get_restores_authoritative_version_without_replay');
 mode='delayed';await page.getByLabel('Nombre del negocio').fill('Respuesta antigua');await page.getByRole('button',{name:'Guardar datos'}).click();await expect.poll(()=>posts.length).toBe(3);
 await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:'second',version:2},role:'owner'}));await expect(page.getByLabel('Nombre del negocio')).toHaveValue('Negocio Dos');release();
 await expect.poll(()=>rows.first.business_name).toBe('Respuesta antigua');await expect(page.getByLabel('Nombre del negocio')).toHaveValue('Negocio Dos');await expect(page.getByText('Datos del negocio guardados.')).toHaveCount(0);checks.push('old_profile_write_response_cannot_replace_current_profile');
 await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:'second',version:2},role:'viewer'}));await expect(page.getByLabel('Nombre del negocio')).toBeDisabled();await expect(page.getByRole('button',{name:'Guardar datos'})).toHaveCount(0);await expect(page.getByText('La persona dueña del perfil puede editar estos datos.')).toBeVisible();checks.push('viewer_has_read_only_business_form');
 rows.second={...rows.second,state:'SUSPENDED'};await page.evaluate(()=>window.chooseProfile({selection:{workspaceId:'second',version:3},role:'owner'}));await expect(page.getByText('Este perfil está suspendido.',{exact:false})).toBeVisible();await expect(page.getByLabel('Nombre del negocio')).toBeDisabled();await expect(page.getByRole('button',{name:'Guardar datos'})).toHaveCount(0);assert.equal(posts.length,3);checks.push('suspended_profile_keeps_read_only_visibility');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PROFILE_SETTINGS_BROWSER_CONTRACT_PASS',checks,synthetic_fixture:true,production_activation:false}));
}finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
