import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { applyLocalEnv } from './local-env.mjs';
import { writeFileSync } from 'node:fs';
applyLocalEnv();
const baseURL=process.env.E2E_BASE_URL??'http://127.0.0.1:5173';
const browser = await chromium.launch();
const context = await browser.newContext({viewport:{width:1280,height:720},reducedMotion:'reduce'});
const page = await context.newPage();
await page.goto(baseURL);
await page.getByLabel('Correo electrónico').fill(process.env.BOOTSTRAP_EMAIL);
await page.getByLabel('Contraseña',{exact:true}).fill(process.env.BOOTSTRAP_PASSWORD);
await page.getByRole('button',{name:'Entrar a Commerce OS'}).click();
await page.getByRole('heading',{name:/Todo conectado/}).waitFor();
const results=[];
async function check(route,state='page'){
 const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa','best-practice']).analyze();
 results.push({route,state,violations:result.violations.map(({id,impact,description,nodes})=>({id,impact,description,nodes:nodes.map(({target,failureSummary})=>({target,failureSummary}))}))});
}
for(const route of ['/home','/catalog','/sales','/sales/inbox','/sales/leads','/sales/orders','/sales/flows','/sales/campaigns','/sales/channels/whatsapp','/campaigns','/campaigns/meta','/results','/settings','/intelligence','/studio']){
 await page.goto(new URL(route,baseURL).href);await page.locator('main h1').waitFor();await page.waitForTimeout(300);
 await check(route);
 if(route==='/catalog'){
  await page.getByRole('button',{name:'Nuevo producto',exact:true}).click();
  await check(route,'form');
  await page.getByRole('dialog').getByRole('button',{name:'Guardar',exact:true}).click();
  await check(route,'invalid-form');
  await page.keyboard.press('Escape');
 }
}
await page.setViewportSize({width:390,height:844});await page.goto(new URL('/sales/channels/whatsapp',baseURL).href);
await page.getByRole('button',{name:'Abrir menú'}).click();await check('/sales/channels/whatsapp','mobile-menu');
writeFileSync('docs/evidence/ui-audit/accessibility.json',JSON.stringify({measured_at:new Date().toISOString(),source:'Local build and isolated synthetic database',results},null,2)+'\n');
console.log(JSON.stringify(results.map(r=>({route:r.route,state:r.state,violations:r.violations.map(v=>({id:v.id,targets:v.nodes.map(n=>n.target)}))}))));
await browser.close();
