import {test,expect,type Locator,type Page} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
import {copyFile,mkdir} from 'node:fs/promises';
import {closureFixture} from './support/closure-fixture.js';

const evidenceRoot='docs/evidence/commerce-resilience-ux-20260921/ui';

const viewports=[
 {width:1440,height:1050},
 {width:1024,height:900},
 {width:768,height:1000},
 {width:360,height:800},
 {width:320,height:800},
] as const;
const themes=['light','dark'] as const;

type RouteCase={
 slug:string;
 path:string;
 heading:RegExp;
 primary:(page:Page)=>Promise<Locator>;
};

const routes:RouteCase[]=[
 {slug:'home',path:'/home',heading:/Todo conectado/,
  primary:async page=>page.getByRole('link',{name:/Abrir tarea/})},
 {slug:'intelligence',path:'/intelligence',heading:/^Inteligencia$/,
 primary:async page=>{const field=page.getByLabel('Palabras o nicho');await field.fill('evidencia sintética');await expect(page.getByRole('button',{name:/Guardar búsqueda/})).toBeEnabled();return field;}},
 {slug:'catalog',path:'/catalog',heading:/^Productos y ofertas$/,
  primary:async page=>{const product=page.getByRole('button',{name:/Producto de demostración/}).first();await product.click();await expect(page.getByRole('heading',{level:1,name:'Producto de demostración'})).toBeVisible();return page.getByRole('link',{name:'← Todos los productos',exact:true});}},
 {slug:'campaigns',path:'/campaigns',heading:/^Campañas$/,
  primary:async page=>{const period=page.getByLabel('Periodo',{exact:true});await period.selectOption('30');await expect(period).toHaveValue('30');return period;}},
 {slug:'sales',path:'/sales',heading:/Tu operación de ventas/,
  primary:async page=>{const conversations=page.getByRole('link',{name:/^Conversaciones/}).first();await conversations.click();await expect(page).toHaveURL(/\/sales\/inbox/);return page.getByRole('main');}},
 {slug:'results',path:'/results',heading:/Hechos para decidir mejor/,
  primary:async page=>{const grouping=page.getByLabel('Agrupar por');await grouping.selectOption('source_type');await expect(grouping).toHaveValue('source_type');return grouping;}},
 {slug:'settings',path:'/settings',heading:/Configuración de tu operación/,
  primary:async page=>{const audit=page.getByRole('link',{name:'Auditoría'});await audit.click();await expect(page).toHaveURL(/\/settings\?section=audit/);return page.getByRole('main');}},
];

async function assertKeyboardEntry(page:Page){
 await page.reload();
 await expect(page.locator('.skip-link')).toBeAttached();
 await page.keyboard.press('Tab');
 await expect(page.locator('.skip-link')).toBeFocused();
 await page.keyboard.press('Enter');
 await expect(page.getByRole('main')).toBeFocused();
}

async function assertNoOverflow(page:Page){
 await expect.poll(()=>page.evaluate(()=>({
  document:document.documentElement.scrollWidth-window.innerWidth<=1,
  main:(document.querySelector('main')?.scrollWidth??0)-(document.querySelector('main')?.clientWidth??0)<=1,
 }))).toEqual({document:true,main:true});
}

for(const route of routes)for(const theme of themes)test(`${route.slug} preserves hierarchy, reflow and accessibility in ${theme}`,async({page},testInfo)=>{
 const captures:{name:string;temporary:string}[]=[];
 const requests=await closureFixture(page);
 await page.addInitScript(value=>{
  localStorage.setItem('commerce-theme',value);
  localStorage.setItem('commerce-opaque','true');
 },theme);
 await page.emulateMedia({reducedMotion:'reduce',colorScheme:theme});

 for(const viewport of viewports){
  await page.setViewportSize(viewport);
  await page.goto(route.path);
  await expect(page.getByRole('heading',{level:1,name:route.heading})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  const navigation=page.getByRole('navigation',{name:'Navegación principal'}).or(page.getByRole('button',{name:'Abrir menú'}));
  await expect(navigation.first()).toBeVisible();
  await assertNoOverflow(page);
  const audit=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(audit.violations.map(item=>({id:item.id,nodes:item.nodes.map(node=>node.target)}))).toEqual([]);
  if(viewport.width===1440||viewport.width===320){
   const name=`${route.slug}-${theme}-${viewport.width}.png`;
   const temporary=testInfo.outputPath(name);
   await page.screenshot({path:temporary,fullPage:true});
   await testInfo.attach(name,{path:temporary,contentType:'image/png'});
   captures.push({name,temporary});
  }
 }

 await assertKeyboardEntry(page);
 const primary=await route.primary(page);
 await expect(primary).toBeVisible();
 const box=await primary.boundingBox();
 expect(box,`${route.slug} primary task must remain measurable`).not.toBeNull();
 if(await primary.evaluate(element=>['BUTTON','A','INPUT','SELECT'].includes(element.tagName))){
  expect(box!.height,`${route.slug} primary target height`).toBeGreaterThanOrEqual(44);
  expect(box!.width,`${route.slug} primary target width`).toBeGreaterThanOrEqual(44);
 }
 expect(requests.filter(request=>request.method!=='GET'),`${route.slug} visual journey is read-only`).toEqual([]);
 await mkdir(evidenceRoot,{recursive:true});
 await Promise.all(captures.map(capture=>copyFile(capture.temporary,`${evidenceRoot}/${capture.name}`)));
});

test('route matrix uses synthetic content and an isolated no-provider transport',async({page})=>{
 const requests=await closureFixture(page);
 for(const route of routes){
  await page.goto(route.path);
  await expect(page.getByRole('heading',{level:1,name:route.heading})).toBeVisible();
  await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
 }
 expect(requests.every(request=>request.environment==='REAL'&&request.method==='GET')).toBe(true);
});

test('results names the selected segment and exports the same visible cut',async({page})=>{
 const requests=await closureFixture(page);
 await page.goto('/results');
 const grouping=page.getByLabel('Agrupar por');
 await grouping.selectOption('source_type');
 await expect(page.getByRole('cell',{name:/Anuncio/})).toBeVisible();
 await expect(page.getByText('1 conversaciones').first()).toBeVisible();
 await expect(page.getByText(/100 % con origen observado o inferido/).first()).toBeVisible();
 const exportRequest=page.waitForRequest(request=>request.url().includes('/v1/reports/export'));
 await page.getByRole('button',{name:'Exportar este corte'}).click();
 const url=new URL((await exportRequest).url());
 expect(url.searchParams.get('group_by')).toBe('source_type');
 expect(url.searchParams.get('environment')).toBe('REAL');
 expect(requests.filter(request=>request.path==='/v1/reports/summary').at(-1)?.query.group_by).toBe('source_type');
 expect(requests.every(request=>request.method==='GET')).toBe(true);
});

test('seller home keeps a useful sales fallback without requesting report summaries',async({page})=>{
 const requests=await closureFixture(page,{role:'seller',permissions:['catalog:read','sales:assigned','sales:operate']});
 await page.goto('/home');
 await expect(page.getByRole('heading',{level:1,name:/Todo conectado/})).toBeVisible();
 await expect(page.getByText('Contacto ficticio')).toBeVisible();
 await expect(page.getByText('Fuente no disponible').first()).toBeVisible();
 expect(requests.some(request=>request.path==='/v1/home/operations-summary')).toBe(false);
 expect(requests.some(request=>request.path==='/v1/reports/summary')).toBe(false);
});

test('analyst home points its safe fallback to Results without loading restricted sales resources',async({page})=>{
 const requests=await closureFixture(page,{role:'analyst',permissions:['catalog:read','reports:read','reports:export']});
 await page.goto('/home');
 const task=page.getByRole('link',{name:/Abrir tarea/});await expect(task).toHaveAttribute('href','/results');
 await task.click();await expect(page).toHaveURL(/\/results$/);await expect(page.getByRole('heading',{level:1,name:'Hechos para decidir mejor'})).toBeVisible();
 expect(requests.some(request=>['/v1/conversations','/v1/contacts','/v1/incidents','/v1/receipts'].includes(request.path))).toBe(false);
});

test('viewer product preparation uses only the canonical projection for restricted evidence',async({page})=>{
 const requests=await closureFixture(page,{role:'viewer',permissions:['catalog:read','sales:read','reports:read']});
 await page.goto('/catalog');
 await page.getByRole('button',{name:/Producto de demostración/}).first().click();
 await expect(page.getByRole('heading',{name:'Preparación visible parcialmente'})).toBeVisible();
 await expect(page.getByText('Existe una simulación completada y aislada.')).toBeVisible();
 await expect(page.getByText(/2 no visibles/)).toBeVisible();
 expect(requests.some(request=>request.path===`/v1/products/product-fixture/configuration`)).toBe(true);
 expect(requests.some(request=>request.path==='/v1/assignments')).toBe(false);
 expect(requests.some(request=>request.path==='/v1/launch-tests')).toBe(false);
});

test('viewer can inspect results but cannot start an export',async({page})=>{
 const requests=await closureFixture(page,{role:'viewer',permissions:['catalog:read','sales:read','reports:read']});
 await page.goto('/results');
 await expect(page.getByRole('heading',{level:1,name:'Hechos para decidir mejor'})).toBeVisible();
 await expect(page.getByText(/exportación está reservada a owner y analyst/)).toBeVisible();
 await expect(page.getByRole('button',{name:'Exportar este corte'})).toHaveCount(0);
 expect(requests.some(request=>request.path==='/v1/reports/export')).toBe(false);
});
