import { chromium, expect } from '@playwright/test';
import { applyLocalEnv } from './local-env.mjs';
import { readFileSync } from 'node:fs';
applyLocalEnv();
const base=process.env.E2E_BASE_URL??'http://127.0.0.1:5173';
if(!['127.0.0.1','localhost'].includes(new URL(base).hostname))throw new Error('LOCAL_ONLY');
const fixture=JSON.parse(readFileSync('docs/evidence/sales-review-fixtures.json','utf8'));
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({baseURL:base,viewport:{width:1440,height:1050}});
 const login=await context.request.post('/api/auth/sign-in/email',{data:{email:process.env.BOOTSTRAP_EMAIL,password:process.env.BOOTSTRAP_PASSWORD},headers:{Origin:base}});
 if(!login.ok())throw new Error('LOGIN_FAILED');
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`/sales/flows/${fixture.ids.preescolar.flow}`);
 await page.locator('.react-flow__node').first().waitFor();
 await page.getByLabel('Buscar paso',{exact:true}).fill('decision');
 await page.locator('.search-results button').first().click();
 await page.getByLabel('Buscar paso',{exact:true}).fill('');
 await page.getByRole('button',{name:'Centrar selección'}).click();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:'docs/evidence/screenshots/sales-map-1440.png',fullPage:true});
 await page.setViewportSize({width:360,height:900});
 await page.getByRole('button',{name:'Pasos',exact:true}).click();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:'docs/evidence/screenshots/sales-review-mobile.png',fullPage:true});
 await page.setViewportSize({width:1440,height:1050});
 await page.goto(`/sales/agents/${fixture.ids.preescolar.agent}`);
 await page.locator('.seller-wizard').waitFor();
 await page.getByRole('button',{name:'3 Cómo responde'}).click();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:'docs/evidence/screenshots/sales-seller-config.png',fullPage:true});
 await page.getByRole('button',{name:'5 Probar y revisar'}).click();
 await page.getByLabel('Flujo para la prueba').selectOption(fixture.ids.preescolar.flow);
 await page.getByRole('button',{name:'Iniciar prueba',exact:true}).click();
 for(const text of ['segundo','¿Qué incluye?','¿Y eso?']){
  await page.getByLabel('Cliente de prueba',{exact:true}).fill(text);
  await page.getByRole('button',{name:'Probar respuesta'}).click();
  await page.getByRole('button',{name:'Reiniciar prueba'}).waitFor();
  await expect(page.getByRole('button',{name:'Reiniciar prueba'})).toBeEnabled();
 }
 await expect(page.getByRole('log')).toContainText('Usó el historial reciente');
 await page.locator('.test-transcript').evaluate(el=>el.scrollTop=el.scrollHeight);
 await page.getByLabel('Cliente de prueba',{exact:true}).blur();
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:'docs/evidence/screenshots/sales-seller-test.png',fullPage:true});
 console.log(JSON.stringify({browser_errors:errors,fixtures_only:true}));
 if(errors.length)process.exitCode=1;
}finally{await browser.close();}
