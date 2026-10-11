import { chromium } from '@playwright/test';
import { applyLocalEnv } from './local-env.mjs';
import { writeFileSync } from 'node:fs';
applyLocalEnv();
const phase=process.argv[2] || 'before';
const baseURL=process.env.E2E_BASE_URL??'http://127.0.0.1:5173';
const browser=await chromium.launch();
const page=await browser.newPage();
await page.goto(baseURL);
await page.getByLabel('Correo electrónico').fill(process.env.BOOTSTRAP_EMAIL);
await page.getByLabel('Contraseña',{exact:true}).fill(process.env.BOOTSTRAP_PASSWORD);
await page.getByRole('button',{name:'Entrar a Commerce OS'}).click();
await page.getByRole('heading',{name:/Todo conectado/}).waitFor();
const samples=[];
for(const [width,height] of [[1280,720],[1366,768],[1440,900],[1920,1080],[1280,540],[768,1024],[390,844],[640,360]]){
 await page.setViewportSize({width,height});
 for(const route of ['home','sales/channels/whatsapp']){
  await page.goto(new URL('/'+route,baseURL).href);
  await page.locator('main h1').waitFor();
  await page.locator('.loading').first().waitFor({state:'hidden'});
  if(width<=760)await page.getByRole('button',{name:'Abrir menú',exact:true}).click();
  const metrics=await page.evaluate(()=>{
    const rect=s=>{const e=document.querySelector(s);const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight};};
    return {viewport:{width:innerWidth,height:innerHeight},pageOverflow:document.documentElement.scrollWidth>innerWidth,sidebar:rect('.sidebar'),nav:rect('[aria-label="Navegación principal"]'),logout:rect('[aria-label="Cerrar sesión"]')};
  });
  samples.push({phase,route,...metrics});
  await page.screenshot({path:`docs/evidence/ui-audit/${phase}-${route.replaceAll('/','-')}-${width}x${height}.png`});
 }
}
writeFileSync(`docs/evidence/ui-audit/${phase}.json`,JSON.stringify(samples,null,2)+'\n');
console.log(JSON.stringify(samples));
await browser.close();
