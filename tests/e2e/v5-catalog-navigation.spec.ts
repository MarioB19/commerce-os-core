import {test, expect, type Page} from '@playwright/test';
import {closureFixture, closureProduct} from './support/closure-fixture.js';

async function navigateFromMenu(page: Page, label: string) {
  const menu = page.getByRole('button', {name: 'Abrir menú', exact: true});
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('navigation', {name: 'Navegación principal'}).getByRole('link', {name: label, exact: true}).click();
}

for (const width of [1440, 320]) {
  test(`catalog preference preserves every sidebar destination and explicit all-products view at ${width}px`, async ({page}) => {
    const requests = await closureFixture(page);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width, height: 1000});
    await page.goto('/catalog?product=product-fixture');
    await expect(page.getByRole('heading', {name: closureProduct.name, level: 1, exact: true})).toBeVisible();
    for (const [label, destination] of [['Inicio', '/home'], ['Inteligencia', '/intelligence'], ['Campañas', '/campaigns'], ['Ventas', '/sales'], ['Resultados y aprendizaje', '/results'], ['Configuración', '/settings']]) {
      await navigateFromMenu(page, label!);
      await expect(page).toHaveURL(url => url.pathname === destination);
      await expect(page.locator('main h1').first()).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect(page).toHaveURL(url => url.pathname === destination);
      await expect(page.getByRole('heading', {name: closureProduct.name, level: 1, exact: true})).toHaveCount(0);
      await navigateFromMenu(page, 'Productos y ofertas');
      await expect(page).toHaveURL(url => url.pathname === '/catalog' && url.searchParams.get('product') === closureProduct.id);
      await expect(page.getByRole('heading', {name: closureProduct.name, level: 1, exact: true})).toBeVisible();
    }
    await page.getByRole('link', {name: '← Todos los productos', exact: true}).click();
    await expect(page).toHaveURL(url => url.searchParams.has('all') && !url.searchParams.has('product'));
    await expect(page.getByRole('heading', {name: 'Productos y ofertas', level: 1, exact: true})).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', {name: 'Productos y ofertas', level: 1, exact: true})).toBeVisible();
    await expect(page).toHaveURL(url => url.searchParams.has('all') && !url.searchParams.has('product'));
    expect(errors).toEqual([]);
    expect(requests.every(request => request.method === 'GET')).toBe(true);
  });
}
