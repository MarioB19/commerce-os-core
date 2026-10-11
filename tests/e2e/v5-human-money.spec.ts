import { test, expect, type Page } from '@playwright/test';
import { closureFixture } from './support/closure-fixture.js';

// Every request is intercepted. This verifies the UI/API boundary, without providers or database writes.
async function receiptFixture(page: Page, currency = 'MXN') {
  await closureFixture(page);
  const writes: Record<string, unknown>[] = [];
  const receipt = { id: 'receipt-money', order_id: 'order-money', version: 9, status: 'HUMAN_REVIEW', extraction: { amount_minor: 9901, currency } };
  await page.route('**/v1/orders/order-money?**', route => route.fulfill({ json: { data: { id: 'order-money', version: 1, amount_minor: 9901, currency, status: 'RECEIPT_RECEIVED', sale_amount_minor: 0 } } }));
  await page.route('**/v1/receipts?**', route => route.fulfill({ json: { data: [receipt], meta: { total: 1 } } }));
  await page.route('**/v1/receipts/receipt-money/review?**', route => {
    const body = route.request().postDataJSON();
    writes.push(body);
    return route.fulfill({ json: { data: { id: 'command-money', status: 'PENDING' } } });
  });
  await page.goto('/sales/orders?order=order-money');
  await page.getByRole('dialog').getByRole('button', { name: 'Abrir receipt-money', exact: true }).click();
  await page.getByRole('button', { name: 'Registrar revisión', exact: true }).click();
  const form = page.getByRole('dialog').last();
  await form.getByLabel('Decisión', { exact: true }).selectOption('APPROVED');
  await form.getByLabel('Motivo y evidencia').fill('Evidencia sintética para comprobar captura monetaria.');
  return { form, writes };
}

test('receipt accepts currency units and preserves the exact minor amount without rounding invalid precision', async ({ page }) => {
  const { form, writes } = await receiptFixture(page);
  const amount = form.getByLabel('Importe aceptado', { exact: true });
  await expect(amount).toHaveAttribute('step', '0.01');
  await expect(amount).toHaveAttribute('min', '0.01');
  await amount.fill('107.005');
  await form.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect(form.getByText('Usa un importe positivo de hasta dos decimales.')).toBeVisible();
  expect(writes).toHaveLength(0);
  await amount.fill('107.01');
  await form.getByLabel('Moneda observada por revisión humana').fill('MXN');
  await form.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ decision: 'APPROVED', amount_minor: 10701, currency: 'MXN', expected_version: 9 });
  expect(writes[0]).not.toHaveProperty('amount');
});

test('blank accepted amount and currency leave extracted evidence untouched in the review request', async ({ page }) => {
  const { form, writes } = await receiptFixture(page, 'USD');
  await expect(form.getByLabel('Importe aceptado', { exact: true })).toHaveValue('');
  await expect(form.getByLabel('Moneda observada por revisión humana')).toHaveValue('');
  await expect(form).toContainText('Si se omite, se conserva el importe extraído');
  await form.getByRole('button', { name: 'Guardar', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ decision: 'APPROVED', expected_version: 9 });
  expect(writes[0]).not.toHaveProperty('amount');
  expect(writes[0]).not.toHaveProperty('amount_minor');
  expect(writes[0]).not.toHaveProperty('currency');
  await expect(page.getByRole('dialog').getByRole('cell', { name: /99\.01/ })).toBeVisible();
});

test('document policy uses currency units and preserves its one-cent default and blank omission', async ({ page }) => {
  await closureFixture(page);
  const writes: Record<string, unknown>[] = [];
  await page.route('**/v1/receipt-policies?**', route => {
    if (route.request().method() === 'GET') return route.fallback();
    const body = route.request().postDataJSON();
    writes.push(body);
    return route.fulfill({ json: { data: { id: 'policy-money', ...body } } });
  });
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Cobro protegido', exact: true }).click();
  for (const value of ['97.01', '', '0.01']) {
    await page.getByRole('button', { name: 'Agregar política', exact: true }).click();
    const form = page.getByRole('dialog');
    const amount = form.getByLabel('Importe mínimo legible', { exact: true });
    await expect(amount).toHaveValue('0.01');
    await expect(amount).toHaveAttribute('step', '0.01');
    await form.getByLabel('Nombre', { exact: true }).fill('Política documental sintética');
    if (!writes.length) {
      await amount.fill('1.005');
      await form.getByRole('button', { name: 'Guardar', exact: true }).click();
      await expect(form.getByText('Usa un importe mínimo positivo de hasta dos decimales.')).toBeVisible();
      expect(writes).toHaveLength(0);
    }
    await amount.fill(value);
    await form.getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(form).toBeHidden();
  }
  expect(writes).toHaveLength(3);
  expect(writes[0]).toMatchObject({ min_amount_minor: 9701 });
  expect(writes[1]).not.toHaveProperty('min_amount_minor');
  expect(writes[2]).toMatchObject({ min_amount_minor: 1 });
  expect(writes.every(body => !('min_amount' in body))).toBe(true);
});
