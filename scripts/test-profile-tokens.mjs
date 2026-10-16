// Synthetic browser contract only. No real token, account, DB, or API is used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,expect} from '@playwright/test';
const web=fileURLToPath(new URL('../apps/web/',import.meta.url));
const bundle=await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ProfileTokens}from'./src/components/profile-tokens.tsx';function Fixture(){const[state,setState]=useState({selection:{workspaceId:'first',version:1},role:'owner',state:'ACTIVE'});window.chooseProfile=setState;return <ProfileTokens {...state}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`,resolveDir:web,sourcefile:'fixture.tsx',loader:'tsx'},bundle:true,write:false,platform:'browser',format:'iife',jsx:'automatic',logLevel:'silent'});
const server=createServer((req,res)=>{if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].contents);}else if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Tokens del perfil</title><body><main id="root"></main><script src="/fixture.js"></script></body></html>');}else{res.statusCode=404;res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0');
const token='cos_pat_'+'s'.repeat(43),otherSecret='cos_pat_'+'t'.repeat(43),stamp='2026-10-12T00:00:00Z';
const metadata=(name,n)=>({id:id(n),userId:'owner-text',name,allowedEnvironments:['REAL'],scopes:['products:read'],expiresAt:'2026-12-01T00:00:00Z',revokedAt:null,version:1,createdAt:stamp});
const rows={first:[metadata('Existente first',1)],second:[metadata('Existente second',2)]},operations=new Map(),calls=[],checks=[];
let browser,mode='normal',release,sequence=10;
try{
 browser=await chromium.launch({headless:true,channel:'chromium'});const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==base)return route.abort();if(!url.pathname.startsWith('/v2/tokens'))return route.continue();
  const headers=request.headers(),profile=headers['x-commerce-profile-id'];assert.ok(['first','second'].includes(profile));assert.equal(headers.authorization,undefined);
  const body=request.method()==='POST'?request.postDataJSON():null;calls.push({method:request.method(),profile,body,path:url.pathname});const currentMode=mode;
  if(request.method()==='POST'){
   if(currentMode==='rejected')return route.fulfill({status:409,json:{error:{code:'PROFILE_TOKEN_VERSION_CONFLICT'}}});
   if(currentMode==='lost-absent')return route.abort('failed');
   if(currentMode==='delayed')await new Promise(resolve=>{release=resolve;});
   assert.ok(body.operationId);let operation=operations.get(profile+body.operationId),secret=null;
   if(!operation){
    if(body.action==='create'||body.action==='rotate'){
     const created={...metadata(body.name,++sequence),scopes:body.scopes,allowedEnvironments:body.allowedEnvironments,expiresAt:body.expiresAt};rows[profile].push(created);
     if(body.action==='rotate'){const old=rows[profile].find(r=>r.id===body.tokenId);assert.equal(old.version,body.expectedVersion);old.revokedAt=stamp;old.version++;}
     operation={id:body.operationId,action:body.action,tokenId:created.id,tokenVersion:1,replacedTokenId:body.action==='rotate'?body.tokenId:null,createdAt:stamp};secret=currentMode==='delayed'?otherSecret:token;
    }else{const old=rows[profile].find(r=>r.id===body.tokenId);assert.equal(old.version,body.expectedVersion);old.revokedAt=stamp;old.version++;operation={id:body.operationId,action:'revoke',tokenId:old.id,tokenVersion:old.version,replacedTokenId:null,createdAt:stamp};}
    operations.set(profile+body.operationId,operation);
   }
   if(currentMode==='lost-found')return route.abort('failed');
   return route.fulfill({status:secret?201:200,json:{data:{operation,token:secret,secretDelivered:secret!==null}}});
  }
  assert.equal(request.method(),'GET');
  if(url.pathname.startsWith('/v2/tokens/operations/')){const op=operations.get(profile+url.pathname.split('/').at(-1));return route.fulfill({status:op?200:404,json:op?{data:op}:{error:{code:'PROFILE_TOKEN_OPERATION_NOT_FOUND'}}});}
  return route.fulfill({json:{data:rows[profile].slice(0,20),meta:{limit:20,offset:0,hasMore:false}}});
 });
 const submit=page.getByRole('button',{name:'Crear token',exact:true}),consult=page.getByRole('button',{name:'Consultar operación y tokens'}),secret=page.getByLabel('Token nuevo');
 const fill=async(name)=>{await page.getByLabel('Nombre del token',{exact:true}).fill(name);await page.getByLabel('Razón',{exact:true}).fill('Prueba explícita de interfaz');};
 const postCount=()=>calls.filter(c=>c.method==='POST').length;
 const choose=async(profile,version=1,role='owner')=>page.evaluate(({profile,version,role})=>window.chooseProfile({selection:{workspaceId:profile,version},role,state:'ACTIVE'}),{profile,version,role});
 await page.goto(base);await expect(submit).toBeEnabled();await expect(page.getByRole('button',{name:'Rotar Existente first',exact:true})).toBeVisible();checks.push('cookie_identity_fixed_profile_metadata');
 await fill('Emitido una vez');const before=postCount();await submit.dblclick();await expect(secret).toHaveText(token);await expect(submit).toBeEnabled();assert.equal(postCount(),before+1);assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);await page.getByRole('button',{name:'Ocultar token'}).click();await expect(secret).toHaveCount(0);await consult.click();await expect(submit).toBeEnabled();await expect(secret).toHaveCount(0);checks.push('one_post_secret_only_in_ram_and_explicit_hide');
 mode='lost-found';await fill('Respuesta perdida');const beforeLost=postCount();await submit.click();await expect(page.getByRole('alert')).toBeVisible();await expect(submit).toBeDisabled();await expect(secret).toHaveCount(0);assert.equal(postCount(),beforeLost+1);mode='normal';await consult.click();await expect(submit).toBeEnabled();await expect(page.getByText('Operación registrada; el secreto no se conserva. Revoca el token si no tienes su copia.')).toBeVisible();assert.equal(postCount(),beforeLost+1);await expect(page.getByRole('button',{name:'Reintentar la misma solicitud'})).toHaveCount(0);checks.push('lost_response_get_found_no_replay_or_secret');
 mode='lost-absent';await fill('Ausente confirmada');await submit.click();await expect(page.getByRole('alert')).toBeVisible();const absent=calls.filter(c=>c.method==='POST').at(-1).body;const beforeAbsent=postCount();mode='normal';await consult.click();const retry=page.getByRole('button',{name:'Reintentar la misma solicitud'});await expect(retry).toBeEnabled();await expect(submit).toBeDisabled();assert.equal(postCount(),beforeAbsent);await retry.click();await expect(secret).toHaveText(token);await expect(submit).toBeEnabled();assert.equal(postCount(),beforeAbsent+1);assert.deepEqual(calls.filter(c=>c.method==='POST').at(-1).body,absent);checks.push('get_absent_allows_only_explicit_identical_retry');
 mode='rejected';await fill('Rechazo conocido');await submit.click();await expect(page.getByRole('alert')).toContainText('rechazada');await expect(submit).toBeDisabled();const beforeReject=postCount();mode='normal';await consult.click();await expect(submit).toBeEnabled();await page.getByLabel('Razón',{exact:true}).fill('Revocar token confirmado');await page.getByRole('button',{name:'Revocar Existente first',exact:true}).click();await expect(submit).toBeEnabled();assert.equal(postCount(),beforeReject+1);await expect(page.getByRole('button',{name:'Revocar Existente first',exact:true})).toBeDisabled();assert.equal(calls.filter(c=>c.method==='POST').at(-1).body.action,'revoke');checks.push('known_rejection_refresh_unblocks_form_and_revoke_cas');
 await page.getByRole('button',{name:'Rotar Emitido una vez',exact:true}).click();await expect(page.getByRole('button',{name:'Confirmar rotación'})).toBeVisible();await page.getByRole('button',{name:'Cancelar rotación'}).click();await expect(submit).toBeEnabled();await page.getByRole('button',{name:'Rotar Emitido una vez',exact:true}).click();await fill('Rotado');await page.getByRole('button',{name:'Confirmar rotación'}).click();await expect(secret).toHaveText(token);await expect(submit).toBeEnabled();const rotation=calls.filter(c=>c.method==='POST').at(-1).body;assert.equal(rotation.action,'rotate');assert.equal(rotation.expectedVersion,1);await expect(page.getByRole('button',{name:'Rotar Emitido una vez',exact:true})).toBeDisabled();checks.push('explicit_rotation_binds_original_version_and_secret_once');
 mode='delayed';await fill('Respuesta de perfil previo');await submit.click();await expect.poll(()=>typeof release).toBe('function');const oldRelease=release;release=undefined;mode='normal';await choose('second',2);await expect(page.getByRole('button',{name:'Rotar Existente second',exact:true})).toBeVisible();await expect(secret).toHaveCount(0);await expect(page.getByLabel('Nombre del token',{exact:true})).toHaveValue('');oldRelease();await expect(submit).toBeEnabled();await expect(secret).toHaveCount(0);await expect(page.getByRole('button',{name:'Rotar Respuesta de perfil previo',exact:true})).toHaveCount(0);checks.push('late_secret_and_result_discarded_after_profile_switch');
 mode='delayed';await fill('Segundo pendiente');await submit.click();await expect.poll(()=>typeof release).toBe('function');const backRelease=release;release=undefined;mode='normal';await choose('first',1);await expect(page.getByRole('button',{name:'Rotar Rotado',exact:true})).toBeVisible();await choose('second',2);await expect(page.getByRole('button',{name:'Rotar Existente second',exact:true})).toBeVisible();backRelease();await expect(submit).toBeEnabled();await expect(secret).toHaveCount(0);checks.push('a_b_a_epoch_does_not_accept_old_post_or_secret');
 await fill('Oculto por rol');await submit.click();await expect(secret).toHaveText(token);await expect(submit).toBeEnabled();const requests=calls.length;await choose('second',2,'viewer');await expect(page.getByText('Solo Dueño administra tokens.')).toBeVisible();await expect(secret).toHaveCount(0);assert.equal(calls.length,requests);checks.push('role_downgrade_hides_secret_and_disables_management');
 assert.deepEqual(errors,[]);console.log(JSON.stringify({state:'PROFILE_TOKEN_BROWSER_CONTRACT_PASS',checks,synthetic_only:true,application_mounted:false}));
}finally{release?.();if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
