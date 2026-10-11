import {test, expect} from '@playwright/test';
import {AxeBuilder} from '@axe-core/playwright';
import {closureFixture, closureFlow, closureProduct} from './support/closure-fixture.js';

test('a shared flow requires an explicit published offer and snapshots only that selection', async ({page}) => {
  const requests = await closureFixture(page);
  await page.setViewportSize({width:320,height:1000});
  await page.route('**/v1/workflows?environment=REAL*', route => route.fulfill({json:{data:[{...closureFlow,offer_version_id:undefined}]}}));
  const offer = {name:'Oferta elegida',product_id:closureProduct.id,workflow_version_id:closureFlow.id,status:'PUBLISHED',version:4};
  await page.route('**/v1/products/product-fixture/offers?environment=REAL', route => route.fulfill({json:{data:[
    {...offer,id:'first-offer',name:'Primera oferta'},
    {...offer,id:'chosen-offer'},
    {...offer,id:'foreign-offer',product_id:'another-product',name:'Oferta ajena'},
    {...offer,id:'draft-offer',status:'DRAFT',name:'Oferta borrador'},
    {...offer,id:'other-flow',workflow_version_id:'another-flow',name:'Otro recorrido'},
  ]}}));
  await page.goto('/settings/tests?workflow=flow-fixture');
  await page.getByRole('button',{name:'Activar laboratorio de pruebas',exact:true}).click();
  const choice = page.getByLabel('Oferta que quieres ensayar');
  await expect(choice).toBeVisible();
  await expect(choice).toHaveValue('');
  await expect(choice.locator('option')).toHaveCount(3);
  const copy=page.getByRole('button',{name:'Crear copia de prueba',exact:true});
  await expect(copy).toBeDisabled();
  expect(requests.filter(r=>r.method!=='GET')).toHaveLength(0);
  await choice.selectOption('chosen-offer');
  await expect(copy).toBeEnabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:test.info().outputPath("laboratory-offer-320-light.png"),fullPage:true});
  await copy.click();
  await expect(page.getByText('Copia de prueba creada.',{exact:false})).toBeVisible();
  const mutations=requests.filter(r=>r.method!=='GET');
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({path:'/v1/simulation-snapshots',environment:'SIMULATION',body:{workflow_version_id:closureFlow.id,expected_version:2,offer_version_id:'chosen-offer',expected_offer_version:4,environment:'SIMULATION'}});
});

test('product laboratory scopes its source query and reload leaves the session inactive', async ({page}) => {
  const requests=await closureFixture(page);
  await page.goto('/catalog?product=product-fixture&tab=tests');
  await page.getByRole('button',{name:'Activar laboratorio de pruebas',exact:true}).click();
  await expect(page.getByLabel('Versión comercial de origen')).toBeVisible();
  await expect.poll(()=>requests.filter(r=>r.path==='/v1/workflows'&&r.environment==='REAL').length).toBeGreaterThan(0);
  const flowRequest=page.waitForRequest(request=>new URL(request.url()).pathname==='/v1/workflows'&&new URL(request.url()).searchParams.get('product_id')===closureProduct.id);
  await page.reload();
  await page.getByRole('button',{name:'Activar laboratorio de pruebas',exact:true}).click();
  await flowRequest;
  await expect(page.getByLabel('Versión comercial de origen')).toHaveValue('');
  expect(requests.filter(r=>r.method!=='GET')).toHaveLength(0);
});
