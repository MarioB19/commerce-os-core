import {fixtureRequest,useSimulationFixtureTransport} from "./support/simulation-fixture-transport.js";
import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prepareRateBudget } from "./support/rate-budget.js";
test.beforeEach(async ({page}) => { await useSimulationFixtureTransport(page); });
test.beforeEach(async ({ request }, info) => { await prepareRateBudget(request, info); });
const environment = "SIMULATION";
let sessionCookies:
  Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>> | undefined;
async function login(page: Page) {
  if (sessionCookies) {
    await page.context().addCookies(sessionCookies);
    await page.goto("/home");
    await expect(
      page.getByRole("heading", { name: /Todo conectado/ }),
    ).toBeVisible();
    return;
  }
  const response = await fixtureRequest(page).post('/api/auth/sign-in/email', {
    data: { email: process.env.BOOTSTRAP_EMAIL, password: process.env.BOOTSTRAP_PASSWORD },
    headers: { Origin:process.env.E2E_BASE_URL??'http://127.0.0.1:5173' },
  });
  expect(response.status()).toBe(200);
  await page.goto('/home');
  await expect(
    page.getByRole("heading", { name: /Todo conectado/ }),
  ).toBeVisible();
  sessionCookies = await page.context().cookies();
}
async function post(page: Page, path: string, body: unknown) {
  const response = await fixtureRequest(page).post("/v1" + path, {
    headers: {
      "Idempotency-Key": randomUUID(),
      Origin: process.env.E2E_BASE_URL??"http://127.0.0.1:5173",
    },
    data: { ...(body as Record<string,unknown>), environment },
  });
  expect(response.ok(), `${path}: ${response.status()}`).toBeTruthy();
  return (await response.json()).data;
}
test("login, persistent catalog, draft offer and isolated real environment", async ({
  page,
}) => {
  await login(page);
  await page.screenshot({
    path: "test-results/home-desktop.png",
    fullPage: true,
  });
  await page.goto("/catalog");
  await page
    .getByRole("button", { name: "Nuevo producto", exact: true })
    .click();
  const modal = page.getByRole("dialog");
  const productName = `Producto UI ${randomUUID().slice(0, 6)}`;
  await modal.getByLabel("Nombre del producto").fill(productName);
  await modal
    .getByLabel("Descripción", { exact: true })
    .fill("Producto ficticio para verificar el catálogo compartido.");
  await modal.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect(
    page.getByRole("button", { name: new RegExp(productName) }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: new RegExp(productName) }).click();
  await page.getByRole("link", { name: "Oferta y materiales", exact: true }).click();
  await page.getByRole("button", { name: "Nueva oferta", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Nombre de la oferta")
    .fill("Oferta UI versionada");
  await page.getByRole("dialog").getByLabel("Precio total").fill("129.00");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(
    page.getByRole("region", { name: /^Oferta, Precio, Estado/ }).getByText("Oferta UI versionada", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/catalog-desktop.png",
    fullPage: true,
  });
  await expect(page.getByLabel("Entorno de datos")).toHaveCount(0);
  await expect(page.getByLabel("Contexto comercial: Operación real")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading",{name:productName,exact:true})).toBeVisible();
});
test("graph draft persists, validates, publishes and experimental modules explain their limits", async ({
  page,
}) => {
  await login(page);
  await page.goto("/sales/flows");
  await page.getByRole("button", { name: "Nuevo flujo", exact: true }).click();
  const name = `Flujo UI ${randomUUID().slice(0, 6)}`;
  await page.getByRole("dialog").getByLabel("Nombre del flujo").fill(name);
  await page
    .getByRole("button", { name: "Crear borrador", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.locator(".react-flow__node")).toHaveCount(5);
  await page.getByRole("button", { name: "Validar", exact: true }).click();
  await expect(page.getByText("Recorrido válido. Puedes probarlo.")).toBeVisible();
  await page.locator('.flow-context summary').click();
  await page.locator('.flow-context').getByLabel('Nombre del flujo').fill(name+' editado');
  await page.locator('.editor-top summary').click();
  await page.getByRole('button',{name:'Publicar versión interna',exact:true}).click();
  await expect(page.getByText(/Versión publicada · sólo lectura/)).toBeVisible();
  await page.locator('.flow-context summary').click();
  await expect(page.locator('.flow-context').getByLabel('Nombre del flujo')).toBeDisabled();
  await page.screenshot({path:'test-results/flow-desktop.png',fullPage:true});
  await page.getByRole('link',{name:'← Flujos comerciales'}).click();
  await expect(page.getByText(name+' editado',{exact:true})).toHaveCount(2);
  await page.goto('/intelligence');
  await expect(page.getByRole('heading',{name:'Inteligencia',exact:true})).toBeVisible();
  await expect(page.getByText('Las señales de anuncios no demuestran ventas.',{exact:true})).toBeVisible();
  await page.goto('/studio');
  await expect(page.getByRole('heading',{name:'Archivo de materiales',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Generar|Renderizar/})).toHaveCount(0);
  await page.screenshot({
    path: "test-results/experimental-desktop.png",
    fullPage: true,
  });
});
test("simulated conversation is visible, human control is immediate, consent is evidenced", async ({
  page,
}) => {
  await login(page);
  const name = `Contacto UI ${randomUUID().slice(0, 6)}`;
  const account = await post(page, "/channel-accounts", {
    environment,
    name: `Línea ${name}`,
    provider: "simulator",
  });
  const product = await post(page, "/products", {
    environment,
    name: `Oferta ${name}`,
    initial_offer: {
      currency: "MXN",
      base_amount_minor: 9900,
      fulfillment: [],
    },
  });
  const run = await post(page, "/simulations", {
    account_id: account.id,
    offer_version_id: product.initial_offer.id,
    contact_name: name,
  });
  await expect
    .poll(
      async () => {
        const response = await fixtureRequest(page).get("/v1/simulations/" + run.id);
        return (await response.json()).data.status;
      },
      { timeout: 30000 },
    )
    .toMatch(/READY|ACTIVE|RUNNING|COMPLETED/);
  const conversations = await fixtureRequest(page).get(
    "/v1/conversations?environment=SIMULATION&account_id=" + account.id,
  );
  const conversation = (await conversations.json()).data[0];
  expect(conversation?.id).toBeTruthy();
  await page.goto("/sales/inbox?conversation=" + conversation.id);
  await expect(page.locator(".chat-header h2")).toHaveText(name);
  await page
    .getByRole("button", { name: "Tomar control", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retomar automatización", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Venta y permiso", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Registrar evidencia", exact: true })
    .click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Propósito").fill("marketing");
  await modal.getByLabel("Fuente").fill("Prueba UI ficticia");
  await modal.getByLabel("Fecha observada").fill("2026-09-05T10:30");
  await modal
    .getByLabel("Evidencia del permiso")
    .fill("Evidencia sintética de consentimiento para prueba local.");
  await modal.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(modal).toBeHidden();
  await page.screenshot({
    path: "test-results/inbox-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Registrar baja global", exact: true })
    .click();
  await expect
    .poll(async () => {
      const response = await fixtureRequest(page).get(
        "/v1/conversations/" + conversation.id,
      );
      const data = (await response.json()).data;
      return (
        data.contact?.status === "SUPPRESSED" ||
        data.contact?.opt_out ||
        data.contact?.suppressed
      );
    })
    .toBeTruthy();
});
test("imports preview, message campaign draft, navigation and responsive screen", async ({
  page,
}) => {
  await login(page);
  await page.goto("/sales/leads");
  await page.getByRole("button", { name: "Importar contactos" }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Fuente del archivo").fill("Fixture sintético E2E");
  await modal
    .getByLabel("Filas a importar")
    .fill(
      JSON.stringify([
        { external_id: "ui-" + randomUUID(), name: "Contacto importado UI" },
      ]),
    );
  await modal.getByRole("button", { name: "Validar y previsualizar" }).click();
  await expect(
    modal.getByRole("button", { name: "Confirmar importación" }),
  ).toBeVisible();
  await modal.getByRole("button", { name: "Confirmar importación" }).click();
  await expect(modal).toBeHidden();
  await page.goto("/sales/campaigns");
  await expect(
    page.getByRole("heading", { name: "Seguimientos con permiso" }),
  ).toBeVisible();
  const campaignAccount = await post(page, "/channel-accounts", {
    environment,
    name: `Línea campaña UI ${randomUUID().slice(0, 6)}`,
    provider: "simulator",
  });
  await page.reload();
  await page
    .getByRole("button", { name: "Crear borrador", exact: true })
    .click();
  const campaignName = `Campaña UI ${randomUUID().slice(0, 6)}`;
  await page
    .getByRole("dialog")
    .getByLabel("Nombre de la campaña")
    .fill(campaignName);
  await page
    .getByRole("dialog")
    .getByLabel("Número de origen")
    .selectOption(campaignAccount.id);
  await page
    .getByRole("dialog")
    .getByLabel("Mensaje", { exact: true })
    .fill("Mensaje ficticio de prueba, en borrador.");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText(campaignName, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: `Abrir ${campaignName}` }).click();
  await page.getByRole("button", { name: "Previsualizar audiencia" }).click();
  await expect(
    page.getByText("Destinatarios, exclusiones y motivos", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancelar pendientes" }).click();
  await page.getByRole("button", { name: "Cerrar", exact: true }).click();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: campaignName })
      .getByText("Cancelado", { exact: true }),
  ).toBeVisible();
  for (const [route, heading] of [
    ["/campaigns", "Campañas"],
    ["/sales/channels/whatsapp", "Mis números"],
    ["/sales/orders", "Cada cobro, con evidencia"],
    ["/results", "Hechos para decidir mejor"],
    ["/settings", "Configuración de tu operación"],
  ]) {
    await page.goto(route!);
    await expect(
      page.getByRole("heading", { name: heading!, exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => ({
        route,
        errors: await page.locator(".error-state").allTextContents(),
      }))
      .toEqual({ route, errors: [] });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/home");
  await expect(
    page.getByRole("heading", { name: /Todo conectado/ }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBeTruthy();
  await page.screenshot({
    path: "test-results/home-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Abrir menú" }).click();
  await expect(
    page.getByRole("navigation", { name: "Navegación principal" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Productos y ofertas", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Productos y ofertas", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "test-results/catalog-mobile.png",
    fullPage: true,
  });
});
test("unauthenticated direct route requires individual login; public signup remains closed", async ({
  page,
}) => {
  await page.goto("/sales/orders");
  await expect(
    page.getByRole("heading", { name: "Bienvenido de nuevo" }),
  ).toBeVisible();
  const response = await fixtureRequest(page).post("/api/auth/sign-up/email", {
    data: {},
  });
  expect(response.status()).toBe(403);
  await page.screenshot({
    path: "test-results/login-desktop.png",
    fullPage: true,
  });
});

test("web payment rehearsal records approved amount as TEST without real income or bank reconciliation", async ({
  page,
}) => {
  await login(page);
  const suffix = randomUUID().slice(0, 6);
  async function asset(name: string) {
    const content = Buffer.from(
      `Evidencia sintética ${name} ${suffix}. No constituye una transacción real.`,
    );
    const record = await post(page, "/assets", {
      environment,
      name,
      kind: "file",
      mime_type: "text/plain",
      size_bytes: content.length,
    });
    const uploaded = await fixtureRequest(page).put(`/v1/assets/${record.id}/content`, {
      headers: {
        "Idempotency-Key": randomUUID(),
        Origin: process.env.E2E_BASE_URL??"http://127.0.0.1:5173",
      },
      data: { base64: content.toString("base64") },
    });
    expect(uploaded.ok()).toBeTruthy();
    await post(page, `/assets/${record.id}/complete`, {});
    return record;
  }
  const receiptAsset = await asset(`Comprobante UI ${suffix}`);

  const account = await post(page, "/channel-accounts", {
    environment,
    name: `Línea cobro UI ${suffix}`,
    provider: "simulator",
  });
  const product = await post(page, "/products", {
    environment,
    name: `Producto cobro UI ${suffix}`,
    initial_offer: {
      currency: "MXN",
      base_amount_minor: 9900,
      fulfillment: [],
    },
  });
  const run = await post(page, "/simulations", {
    account_id: account.id,
    offer_version_id: product.initial_offer.id,
    contact_name: `Venta UI ${suffix}`,
  });
  await expect
    .poll(
      async () => {
        const r = await fixtureRequest(page).get(`/v1/simulations/${run.id}`);
        return (await r.json()).data.conversation_id;
      },
      { timeout: 30000 },
    )
    .toBeTruthy();
  const sim = (
    await (await fixtureRequest(page).get(`/v1/simulations/${run.id}`)).json()
  ).data;
  await page.goto(`/sales/inbox?conversation=${sim.conversation_id}`);
  await page
    .getByRole("button", { name: "Venta y permiso", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Registrar compromiso", exact: true })
    .click();
  await expect
    .poll(async () => {
      const r = await fixtureRequest(page).get(
        `/v1/conversations/${sim.conversation_id}`,
      );
      return (await r.json()).data.order?.status;
    })
    .toBe("COMMITTED");
  await page
    .getByRole("button", { name: "Registrar comprobante", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("Evidencia privada")
    .selectOption(receiptAsset.id);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Guardar", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect
    .poll(async () => {
      const r = await fixtureRequest(page).get(
        `/v1/conversations/${sim.conversation_id}`,
      );
      return (await r.json()).data.order?.receipt_id;
    })
    .toBeTruthy();
  const detail = (
    await (
      await fixtureRequest(page).get(`/v1/conversations/${sim.conversation_id}`)
    ).json()
  ).data;
  // The owner must review the current evidence, after the initial assessment.
  // The concurrency suite separately proves that stale evidence is rejected and
  // an already accepted review cannot be invalidated by a late analysis result.
  await expect.poll(async () => {
    const response = await fixtureRequest(page).get(`/v1/receipts/${detail.order.receipt_id}`);
    expect(response.status()).toBe(200);
    return (await response.json()).data.analysis_status;
  }).toBe('HUMAN_REQUIRED');
  await page.goto(`/sales/orders?order=${detail.order.id}`);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: `Abrir ${detail.order.receipt_id}` })
    .click();
  await expect(page.getByRole('button',{name:'Ver evidencia privada ↗',exact:true})).toBeVisible();
  const access=(await (await fixtureRequest(page).get(`/v1/receipts/${detail.order.receipt_id}/access?environment=SIMULATION`)).json()).data;
  expect((await fixtureRequest(page).get(access.url)).status()).toBe(200);
  expect((await fixtureRequest(page).get(access.url.replace('SIMULATION','REAL'))).status()).toBe(403);
  await page
    .getByRole("button", { name: "Registrar revisión", exact: true })
    .click();
  const review = page.getByRole("dialog").last();
  await review.getByLabel("Decisión", { exact: true }).selectOption("APPROVED");
  await review.getByLabel("Importe aceptado", { exact: true }).fill("99.00");
  await review.getByLabel("Moneda observada por revisión humana").fill("MXN");
  await review
    .getByLabel("Motivo y evidencia")
    .fill("Revisión documental humana de evidencia sintética en simulación.");
  await review.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect
    .poll(async () => {
      const r = await fixtureRequest(page).get(`/v1/orders/${detail.order.id}`);
      return (await r.json()).data.status;
    })
    .toBe("RECEIPT_APPROVED");
  await expect(
    page.getByRole("dialog").getByText("Documento aprobado", { exact: true }),
  ).toBeVisible();
  const recognized=(await (await fixtureRequest(page).get(`/v1/orders/${detail.order.id}`)).json()).data;
  expect(recognized.sale_status).toBe('TEST');
  expect(recognized.sale_amount_minor).toBe(0);
  expect(recognized.test_approved_amount_minor).toBe(9900);
  expect(recognized.reconciliation_status).toBe('UNRECONCILED');
  await expect(page.getByRole('button',{name:'Conciliar movimiento',exact:true})).toHaveCount(0);
  await page.screenshot({path:'test-results/order-receipt-sale.png',fullPage:true});
  await page.goto("/results");
  await expect(
    page.getByRole("heading", { name: "Hechos para decidir mejor" }),
  ).toBeVisible();
  await expect(page.locator(".funnel-chart")).toContainText("Venta por comprobante");
  await page.screenshot({
    path: "test-results/results-desktop.png",
    fullPage: true,
  });
});


test("human workflow approval records the exact reviewed node from inbox", async ({ page }) => {
  await login(page);
  const suffix = randomUUID().slice(0, 6);
  const account = await post(page, "/channel-accounts", { environment, name: `Approval ${suffix}`, provider: "simulator" });
  const product = await post(page, "/products", { environment, name: `Approval ${suffix}`, initial_offer: { currency: "MXN", base_amount_minor: 100, fulfillment: [] } });
  const draft = await post(page, "/workflows", { environment, name: `Approval ${suffix}`, entry_node_id: "review", nodes: [
    { id: "review", type: "approval", config: {}, next: "complete" },
    { id: "complete", type: "end", config: {} },
  ] });
  const published = await post(page, `/workflows/${draft.id}/publish`, { expected_version: draft.version });
  const simulation = await post(page, "/simulations", { account_id: account.id, offer_version_id: product.initial_offer.id, workflow_version_id: published.id, contact_name: `Aprobación ${suffix}` });
  let conversationId: string;
  await expect.poll(async () => {
    const run = (await (await fixtureRequest(page).get(`/v1/simulations/${simulation.id}`)).json()).data;
    conversationId = run.conversation_id;
    if (!conversationId) return undefined;
    return (await (await fixtureRequest(page).get(`/v1/conversations/${conversationId}`)).json()).data.flow_state?.status;
  }, { timeout: 30000 }).toBe("HUMAN_REVIEW");
  await page.goto(`/sales/inbox?conversation=${conversationId!}`);
  await page.getByRole("button", { name: "Venta y permiso", exact: true }).click();
  await page.getByRole("button", { name: "Aprobar paso del flujo", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Motivo de la aprobación").fill("Contexto sintético revisado para continuar el flujo de prueba.");
  await modal.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(modal).toBeHidden();
  await expect.poll(async () => (await (await fixtureRequest(page).get(`/v1/conversations/${conversationId}`)).json()).data.flow_state?.status).toBe("FINISHED");
  await expect(page.getByRole("button", { name: "Aprobar paso del flujo", exact: true })).toHaveCount(0);
  const detail = (await (await fixtureRequest(page).get(`/v1/conversations/${conversationId!}`)).json()).data;
  expect(detail.events.some((event: { event_type: string; payload: { node_id?: string; workflow_version_id?: string; reason?: string } }) => event.event_type === "workflow.step_approved" && event.payload.node_id === "review" && event.payload.workflow_version_id === published.id && event.payload.reason?.includes("Contexto sintético"))).toBeTruthy();
});
