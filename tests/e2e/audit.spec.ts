import {evidencePath} from '../support/test-evidence-path.js';
import {fixtureRequest,useSimulationFixtureTransport} from "./support/simulation-fixture-transport.js";
import { test, expect, type Page } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { prepareRateBudget } from './support/rate-budget.js';
import {evidencePath} from '../support/evidence.js';
test.beforeEach(async ({page}) => { await useSimulationFixtureTransport(page); });
test.beforeEach(async ({ request }, info) => { await prepareRateBudget(request, info); });

let cookies: Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> | undefined;
async function login(page: Page) {
  if(cookies){await page.context().addCookies(cookies);await page.goto("/home");await expect(page.locator("main h1")).toBeVisible();return;}
  const response = await fixtureRequest(page).post('/api/auth/sign-in/email', { data: { email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD }, headers: { Origin: process.env.E2E_BASE_URL??'http://127.0.0.1:5173' } });
  expect(response.status()).toBe(200);
  cookies = await page.context().cookies();
  await page.goto('/home');
  await expect(page.locator('main h1')).toBeVisible();
}
async function settled(page: Page) {
  await expect(page.locator('main h1')).toBeVisible();
  await expect(page.locator('main .loading')).toHaveCount(0);
}
async function accessible(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze();
  expect(result.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }))).toEqual([]);
}

test('navigation remains reachable at all requested sizes, collapsed and keyboard drawer', async ({ page }) => {
  await login(page);
  for (const [width, height] of [[1280,720],[1366,768],[1440,900],[1920,1080],[1280,540],[768,1024],[390,844],[640,360]]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.goto('/sales/channels/whatsapp');
    await settled(page);
    if (width! <= 760) await page.getByRole('button', { name: 'Abrir menú', exact: true }).click();
    const sidebar = page.locator('.sidebar');
    await expect.poll(async () => sidebar.getByRole('link', {name:'Mis números',exact:true}).evaluate((link) => {
      const item=link.getBoundingClientRect(), region=link.closest('nav')!.getBoundingClientRect();
      return item.top >= region.top && item.bottom <= region.bottom;
    })).toBe(true);
    const bounds = await sidebar.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }));
    expect(bounds.content).toBeLessThanOrEqual(bounds.height + 1);
    await expect(sidebar.getByRole('button', { name: 'Cerrar sesión' })).toBeInViewport();
    for (const label of ['Mis números', 'Configuración', 'Inicio']) {
      const link = sidebar.getByRole('link', { name: label, exact: true });
      await link.focus();
      await expect(link).toBeFocused();
      await expect(link).toBeInViewport();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width! > 760) {
      await sidebar.getByRole('button', { name: 'Contraer menú' }).click();
      await expect(sidebar.getByRole('link', { name: 'Mis números', exact: true })).toHaveAccessibleName('Mis números');
      await expect(sidebar.getByRole('button', { name: 'Cerrar sesión' })).toBeInViewport();
      await page.screenshot({ path: evidencePath(`ui-audit/compact-${width}x${height}.png`) });
      await sidebar.getByRole('button', { name: 'Expandir menú' }).click();
    } else {
      for (let n = 0; n < 24; n++) {
        await page.keyboard.press('Tab');
        expect(await sidebar.evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('button', { name: 'Abrir menú' })).toBeFocused();
      await expect(page.getByRole('navigation', { name: 'Navegación principal' })).toHaveCount(0);
    }
  }
  // 640×360 represents the CSS viewport of a 1280×720 display at 200% browser zoom.
  // Independently exercise 200% text sizing at desktop width.
  await page.setViewportSize({ width:1280, height:720 });
  await page.addStyleTag({ content:'html { font-size:200% !important; } .sidebar a { font-size:1rem !important; }' });
  await page.locator('.sidebar').getByRole('link', { name:'Mis números', exact:true }).focus();
  await expect(page.getByRole('button', { name:'Cerrar sesión' })).toBeInViewport();
});

test('all main routes and common forms pass accessibility; errors and draft survive keyboard close', async ({ page }) => {
  test.setTimeout(180000);
  await page.emulateMedia({ reducedMotion:'reduce' });
  await login(page);
  for (const route of ['/home','/catalog','/sales','/sales/inbox','/sales/leads','/sales/orders','/sales/flows','/sales/flows?q=__empty_accessibility__','/sales/agents','/sales/campaigns','/sales/channels/whatsapp','/campaigns','/campaigns/meta','/results','/settings','/intelligence','/studio']) {
    await page.goto(route); await settled(page); await accessible(page);
  }
  await page.goto('/catalog');
  const trigger = page.getByRole('button', { name:'Nuevo producto', exact:true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible(); await accessible(page);
  await modal.getByRole('button', { name:'Guardar', exact:true }).click();
  await expect(modal.getByRole('alert').first()).toContainText('Revisa los siguientes campos');
  await expect(modal.getByLabel('Nombre del producto')).toHaveAttribute('aria-invalid','true');
  await accessible(page);
  await modal.getByLabel('Nombre del producto').fill('Borrador conservado');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(modal.getByLabel('Nombre del producto')).toHaveValue('Borrador conservado');
  await expect(modal.getByLabel('Identificador')).toBeHidden();
  await modal.getByText('Opciones adicionales (1)', { exact:true }).click();
  await expect(modal.getByLabel('Identificador')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Abrir menú'}).click(); await accessible(page);
});

test('API-first service credential creates versioned catalog and flow visible in UI without commercial effects', async ({ page }) => {
  await login(page);
  const db = new pg.Client({connectionString:process.env.DATABASE_URL}); await db.connect();
  const state = async () => (await db.query("SELECT (SELECT count(*) FROM outbox) effects,(SELECT count(*) FROM records WHERE kind IN ('message_campaign','acquisition_campaign','ad','conversion')) commercial")).rows[0];
  const before = await state();
  const suffix = randomUUID().slice(0,8);
  const owner = async (path:string, data:unknown, method='POST') => fixtureRequest(page).fetch('/v1'+path, { method, data, headers:{'Idempotency-Key':randomUUID(),Origin:process.env.E2E_BASE_URL??'http://127.0.0.1:5173'} });
  const created = await owner('/service-tokens', {name:'API audit '+suffix,scopes:['products:read','products:write','offers:read','offers:write','workflows:read','workflows:draft','workflows:publish'],allowed_environments:['SIMULATION'],expires_at:new Date(Date.now()+3600000).toISOString()});
  expect(created.status()).toBe(201);
  const credential = (await created.json()).data;
  const call = (path:string, data?:unknown, key=randomUUID()) => fixtureRequest(page).fetch('/v1'+path, { method:data === undefined ? 'GET':'POST', data, headers:{Authorization:'Bearer '+credential.token,'Idempotency-Key':key} });
  try {
    const productKey=randomUUID(), productBody={name:'API Product '+suffix,environment:'SIMULATION'};
    const productResponse=await call('/products',productBody,productKey);expect(productResponse.status()).toBe(201);
    const product=(await productResponse.json()).data;
    expect((await (await call('/products/'+product.id)).json()).data.id).toBe(product.id);
    expect((await (await call('/products',productBody,productKey)).json()).data.id).toBe(product.id);
    const offerResponse=await call(`/products/${product.id}/offers`,{name:'API Offer '+suffix,currency:'MXN',base_amount_minor:19900});expect(offerResponse.status()).toBe(201);
    const offer=(await offerResponse.json()).data;
    const flowBody={name:'API Flow '+suffix,product_id:product.id,offer_version_id:offer.id,entry_node_id:'end',nodes:[{id:'end',type:'end',config:{}}]};
    const flowKey=randomUUID(), flowResponse=await call('/workflows',flowBody,flowKey);expect(flowResponse.status()).toBe(201);
    const draft=(await flowResponse.json()).data;
    expect((await (await call(`/workflows/${draft.id}/validate`,{})).json()).data.valid).toBe(true);
    const publishKey=randomUUID(), publishedResponse=await call(`/workflows/${draft.id}/publish`,{expected_version:draft.version},publishKey);expect(publishedResponse.status()).toBe(200);
    const published=(await publishedResponse.json()).data;
    expect(published.product_id).toBe(product.id);expect(published.offer_version_id).toBe(offer.id);
    expect((await (await call(`/workflows/${draft.id}/publish`,{expected_version:draft.version},publishKey)).json()).data.id).toBe(published.id);
    expect((await (await call('/workflows',flowBody,flowKey)).json()).data.id).toBe(draft.id);
    for(const path of [`/products/${product.id}/versions`,`/offers/${offer.id}/versions`,`/workflows/${published.id}/versions`])expect((await call(path)).status()).toBe(200);
    await page.goto('/catalog');await page.getByLabel('Buscar productos').fill(productBody.name);
    await page.getByRole('button',{name:new RegExp(productBody.name)}).click();await page.getByRole('link',{name:'Oferta y materiales',exact:true}).click();await expect(page.getByRole('region',{name:/^Oferta, Precio, Estado/}).getByText('API Offer '+suffix,{exact:true})).toBeVisible();
    await page.goto('/sales/flows');await expect(page.getByText(flowBody.name,{exact:true})).toHaveCount(2);
    expect((await call('/channel-accounts',{name:'Forbidden',environment:'REAL',provider:'waha'})).status()).toBe(403);
    expect((await call('/operation-authorizations',{})).status()).toBe(403);
    expect((await call('/service-tokens')).status()).toBe(403);
    const revoked=await owner('/service-tokens/'+credential.id,undefined,'DELETE');expect(revoked.status()).toBe(200);
    expect((await call('/products/'+product.id)).status()).toBe(401);
    expect(await state()).toEqual(before);
  } finally { await owner('/service-tokens/'+credential.id,undefined,'DELETE'); await db.end(); }
});

test('lost API response retries same intent without duplicate product and keeps typed values', async ({ page }) => {
  await login(page); await page.goto('/catalog');
  await page.getByRole('button',{name:'Nuevo producto',exact:true}).click();
  const modal=page.getByRole('dialog'),name='Retry audit '+randomUUID().slice(0,8);
  await modal.getByLabel('Nombre del producto').fill(name);
  const keys:string[]=[]; let lost=true;
  await page.route('**/v1/products?environment=REAL',async route=>{
    if(route.request().method()!=='POST')return route.fallback();
    keys.push(route.request().headers()['idempotency-key']!);
    if(lost){lost=false;await route.fetch({url:route.request().url().replace('environment=REAL','environment=SIMULATION'),postData:JSON.stringify({...route.request().postDataJSON(),environment:'SIMULATION'})});await route.abort('connectionreset');}else await route.fallback();
  });
  await modal.getByRole('button',{name:'Guardar',exact:true}).click();
  await expect(modal.getByRole('alert')).toBeVisible();
  await expect(modal.getByLabel('Nombre del producto')).toHaveValue(name);
  await modal.getByRole('button',{name:'Guardar',exact:true}).click();
  await expect(modal).toBeHidden();expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  const rows=(await (await fixtureRequest(page).get('/v1/products?q='+encodeURIComponent(name))).json()).data;
  expect(rows.filter((row:{name:string})=>row.name===name)).toHaveLength(1);
});

test('role-specific navigation fixture retains identity, environment and all permitted links at short heights',async({page})=>{
  await login(page);
  const session=(await (await fixtureRequest(page).get('/v1/me')).json()).data;
  const roles:Record<string,string[]>={owner:['*'],operator:['read','reports:read'],seller:['catalog:read','sales:assigned'],reconciler:['catalog:read','sales:read','reports:read'],analyst:['catalog:read','reports:read'],viewer:['catalog:read','sales:read']};
  for(const [role,permissions] of Object.entries(roles)){
    await page.route('**/v1/me?**',route=>route.fulfill({json:{data:{...session,role,permissions}}}));
    for(const [width,height] of [[1280,540],[390,667]]){
      await page.setViewportSize({width:width!,height:height!});await page.goto(role==='analyst'?'/home':'/sales');
      if(width!<760)await page.getByRole('button',{name:'Abrir menú'}).click();
      const nav=page.getByRole('navigation',{name:'Navegación principal'});
      await expect(page.getByRole('button',{name:'Cerrar sesión'})).toBeInViewport();
      const sales=nav.getByRole('link',{name:'Ventas',exact:true});
      await expect(sales).toHaveCount(role==='analyst'?0:1);
      const channels=nav.getByRole('link',{name:'Mis números',exact:true});
      await expect(channels).toHaveCount(['owner','operator'].includes(role)?1:0);
      for(const link of await nav.getByRole('link').all()){await link.focus();await expect(link).toBeInViewport();}
      if(width!<760)await page.keyboard.press('Escape');
    }
    await page.unroute('**/v1/me?**');
  }
});
