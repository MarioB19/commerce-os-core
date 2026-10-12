import {evidencePath} from '../support/test-evidence-path.js';
import {fixtureRequest,useSimulationFixtureTransport} from "./support/simulation-fixture-transport.js";
import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { randomUUID, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { prepareRateBudget } from "./support/rate-budget.js";
import { evidencePath } from "../support/evidence.js";
const origin = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
let cachedCookies:
  | Awaited<ReturnType<ReturnType<Page["context"]>["cookies"]>>
  | undefined;
test.beforeEach(async ({page}) => { await useSimulationFixtureTransport(page); });
// Drain intercepted responses before Playwright disposes their request context.
test.afterEach(async ({page}) => { await page.unrouteAll({behavior:'wait'}); });
test.beforeEach(async ({ page, request }, info) => {
  await prepareRateBudget(request, info);
  if (cachedCookies) {
    await page.context().addCookies(cachedCookies);
    return;
  }
  const r = await fixtureRequest(page).post("/api/auth/sign-in/email", {
    headers: { Origin: origin },
    data: {
      email: process.env.BOOTSTRAP_EMAIL,
      password: process.env.BOOTSTRAP_PASSWORD,
    },
  });
  expect(r.status()).toBe(200);
  cachedCookies = await page.context().cookies();
});
async function post(page: Page, path: string, body: any) {
  const r = await fixtureRequest(page).post("/v1" + path, {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: { environment: "SIMULATION", ...body },
  });
  expect(r.ok(), await r.text()).toBe(true);
  return (await r.json()).data;
}
async function get(page: Page, id: string) {
  return (await (await fixtureRequest(page).get("/v1/workflows/" + id)).json()).data;
}
async function fixture(page: Page, environment = "SIMULATION") {
  const create = (page: Page, path: string, body: any) => post(page, path, { ...body, environment });
  const suffix = randomUUID().slice(0, 6),
    product = await create(page, "/products", {
      name: "Producto revisión " + suffix,
      knowledge: [
        {
          id: "contents",
          topic: "contents",
          title: "Qué incluye",
          content: "Cuaderno exclusivo A de prueba",
          source: "Fixture sintético aprobado",
        },
      ],
    }),
    offer = await create(page, `/products/${product.id}/offers`, {
      name: "Oferta de prueba",
      currency: "MXN",
      base_amount_minor: 9700,
    }),
    agent = await create(page, "/agents", {
      name: "Vendedor guiado " + suffix,
      product_id: product.id,
      offer_version_id: offer.id,
    });
  const flow = await create(page, "/workflows", {
    name: "Recorrido visual " + suffix,
    product_id: product.id,
    offer_version_id: offer.id,
    agent_version_id: agent.id,
    entry_node_id: "start",
    nodes: [
      { id: "start", type: "entry", config: {}, next: "message" },
      {
        id: "message",
        type: "message",
        config: { text: "Presentación de prueba" },
        next: "commitment",
      },
      { id: "commitment", type: "commitment", config: {}, next: "wait" },
      { id: "wait", type: "wait", config: { seconds: 60 }, next: "branch" },
      {
        id: "branch",
        type: "condition",
        config: {
          field: "customer_text",
          operator: "contains",
          value: "acepto",
        },
        branches: { true: "receipt", false: "end" },
      },
      { id: "receipt", type: "receipt", config: {}, next: "end" },
      { id: "end", type: "end", config: {} },
    ],
  });
  return { product, offer, agent, flow };
}
async function select(page: Page, id: string) {
  await page.getByLabel("Buscar paso", { exact: true }).fill(id);
  await page
    .locator(".search-results")
    .getByRole("button")
    .filter({ hasText: id })
    .first()
    .click();
}
async function stored(
  page: Page,
  id: string,
  predicate: (body: any) => boolean,
) {
  await expect.poll(async () => predicate(await get(page, id))).toBe(true);
}
test("map and steps edit one graph, autosave on selection/reload and undo connected deletion", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/sales/flows/" + f.flow.id);
  await expect(page.locator(".react-flow__node")).toHaveCount(7);
  await select(page, "end");
  await expect(page.locator("#step-inspector-heading")).toHaveText("end");
  await expect(page.locator("#step-inspector-heading")).toBeFocused();
  await select(page, "message");
  await page
    .getByRole("textbox", { name: "Texto o descripción", exact: true })
    .fill("Edición conservada del primer paso");
  await select(page, "wait");
  await page.getByLabel("Espera en minutos").fill("2");
  await select(page, "message");
  await expect(
    page.getByRole("textbox", { name: "Texto o descripción", exact: true }),
  ).toHaveValue("Edición conservada del primer paso");
  await stored(
    page,
    f.flow.id,
    (r) =>
      r.nodes.find((n: any) => n.id === "wait").config.seconds === 120 &&
      r.nodes
        .find((n: any) => n.id === "message")
        .config.text.includes("conservada"),
  );
  await page.reload();
  await expect(page.locator("#step-inspector-heading")).toHaveText("message");
  await expect(
    page.getByRole("textbox", { name: "Texto o descripción", exact: true }),
  ).toHaveValue("Edición conservada del primer paso");
  await page.getByRole("button", { name: "Pasos", exact: true }).click();
  await page
    .getByRole("button", { name: "Eliminar paso", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirmar cambio" })
    .click();
  await expect(page.locator(".steps-view article")).toHaveCount(6);
  await page.getByRole("button", { name: "Deshacer", exact: true }).click();
  await expect(page.locator(".steps-view article")).toHaveCount(7);
  await stored(
    page,
    f.flow.id,
    (r) =>
      r.nodes.length === 7 &&
      r.nodes.find((n: any) => n.id === "start").next === "message",
  );
  await page.screenshot({
    path: evidencePath("screenshots/sales-steps-edit.png"),
    fullPage: true,
  });
});
test("insertion by click, graph connections and actual dragging preserve execution order", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/sales/flows/" + f.flow.id);
  await page.getByRole("button", { name: "Pasos", exact: true }).click();
  await page
    .locator("#step-start")
    .getByRole("button", { name: "Siguiente → message" })
    .click();
  await page.getByLabel("Tipo a insertar").selectOption("wait");
  await page.getByRole("button", { name: "Insertar aquí" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "start → Esperar un tiempo → message",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Confirmar cambio" })
    .click();
  await page.getByLabel("Nombre visible del paso").fill("Espera insertada");
  await stored(
    page,
    f.flow.id,
    (r) =>
      r.nodes.length === 8 &&
      Object.values(r.editor.labels).includes("Espera insertada"),
  );
  const inserted = await get(page, f.flow.id);
  const newId = inserted.nodes.find((n: any) => n.id.startsWith("paso_")).id;
  expect(inserted.nodes.find((n: any) => n.id === "start").next).toBe(newId);
  expect(inserted.nodes.find((n: any) => n.id === newId).next).toBe("message");
  await page.getByRole("button", { name: "Mapa", exact: true }).click();
  await select(page, "start");
  const node = page.locator('.react-flow__node[data-id="start"]');
  await expect(node).toBeVisible();
  // Search animates the map after selection. Wait for settled screen geometry
  // before taking coordinates; visibility alone can still point at the canvas.
  await node.scrollIntoViewIfNeeded();
  let previousBox = "", stableSamples = 0;
  await expect.poll(async () => {
    const currentBox = JSON.stringify(await node.boundingBox());
    stableSamples = currentBox === previousBox ? stableSamples + 1 : 0;
    previousBox = currentBox;
    return stableSamples;
  }, { intervals: [100] }).toBeGreaterThanOrEqual(3);
  const box = (await node.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)
    ?.closest(".react-flow__node")?.getAttribute("data-id"), point)).toBe("start");
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 110, point.y + 40, { steps: 12 });
  await page.mouse.up();
  await stored(
    page,
    f.flow.id,
    (r) => r.editor.positions.start.x !== inserted.editor.positions.start.x,
  );
  const after = await get(page, f.flow.id);
  expect(after.nodes).toEqual(inserted.nodes);
  await page
    .locator(".step-inspector summary")
    .filter({ hasText: "Posición sin arrastrar" })
    .click();
  await page.getByRole("button", { name: "Derecha", exact: true }).focus();
  await page.keyboard.press("Enter");
  await stored(
    page,
    f.flow.id,
    (r) => r.editor.positions.start.x > after.editor.positions.start.x,
  );
  await expect(page.locator('.save-status')).toHaveText('Borrador guardado');
});
test("concurrent edit and lost network preserve local draft with explicit recovery", async ({
  page,
}) => {
  const f = await fixture(page);
  await page.goto("/sales/flows/" + f.flow.id);
  await select(page, "message");
  const concurrentEdit = await fixtureRequest(page).patch("/v1/workflows/" + f.flow.id, {
    headers: { Origin: origin, "Idempotency-Key": randomUUID() },
    data: { expected_version: 1, name: "Concurrent server title" },
  });
  expect(concurrentEdit.status()).toBe(200);
  await page
    .getByRole("textbox", { name: "Texto o descripción", exact: true })
    .fill("Mis cambios ante conflicto");
  await expect(
    page.getByText(/Otra persona guardó una revisión/),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Texto o descripción", exact: true }),
  ).toHaveValue("Mis cambios ante conflicto");
  await page
    .getByRole("button", { name: "Guardar mis cambios como copia" })
    .click();
  await expect(page).not.toHaveURL(new RegExp(f.flow.id));
  const newId = new URL(page.url()).pathname.split("/").at(-1)!;
  await select(page, "message");
  let abortedSaves = 0;
  await page.route("**/v1/workflows/" + newId + "?**", async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    abortedSaves++;
    await route.abort("failed");
  });
  await page
    .getByRole("textbox", { name: "Texto o descripción", exact: true })
    .fill("Conservar sin conexión");
  await expect(page.getByText(/No pudimos conectar/)).toBeVisible();
  expect(abortedSaves).toBe(1);
  await expect(page.getByRole("textbox", { name: "Texto o descripción", exact: true }))
    .toHaveValue("Conservar sin conexión");
  expect((await get(page, newId)).nodes.find((n: any) => n.id === "message").config.text)
    .toBe("Mis cambios ante conflicto");
  await page.unroute("**/v1/workflows/" + newId + "?**");
  const retryResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === "/v1/workflows/" + newId &&
    response.request().method() === "PATCH",
  );
  await page.getByRole("button", { name: "Reintentar guardado" }).click();
  expect((await retryResponse).status()).toBe(200);
  await stored(
    page,
    newId,
    (r) =>
      r.nodes.find((n: any) => n.id === "message").config.text ===
      "Conservar sin conexión",
  );
  await expect(page.locator(".save-status")).toHaveText("Borrador guardado");
});
test("guided seller preserves advanced instructions; integrated test exposes sources and history", async ({
  page,
}) => {
  await page.unroute("**/v1/**");
  const f = await fixture(page, "REAL");
  await page.goto("/sales/agents/" + f.agent.id);
  await page.getByRole("button", { name: "2 Qué sabe" }).click();
  await page
    .getByRole("textbox", { name: "Hecho aprobado 1", exact: true })
    .fill("Cuaderno exclusivo A de prueba; edición conservada entre secciones");
  await page.getByRole("button", { name: "3 Cómo responde" }).click();
  await page.getByRole("button", { name: "Guardar nueva revisión" }).click();
  await expect(
    page.getByText(/Guarda primero los cambios de Qué sabe/),
  ).toBeVisible();
  await page.getByRole("button", { name: "2 Qué sabe" }).click();
  await expect(
    page.getByRole("textbox", { name: "Hecho aprobado 1", exact: true }),
  ).toHaveValue(
    "Cuaderno exclusivo A de prueba; edición conservada entre secciones",
  );
  await page.getByRole("link", { name: "← Vendedores" }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Hay cambios pendientes",
  );
  await page.getByRole("button", { name: "Volver y guardar" }).click();
  await page
    .getByRole("button", { name: "Guardar conocimiento", exact: true })
    .click();
  await expect(
    page.getByText(
      "Conocimiento guardado en una nueva revisión. Conversaciones anteriores conservan sus fuentes.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "3 Cómo responde" }).click();
  await page
    .getByLabel("Nombre visible del vendedor")
    .fill("Lía revisión guiada");
  await page
    .getByText("Instrucciones y proveedor · avanzado", { exact: true })
    .click();
  await page
    .getByLabel("Instrucciones adicionales")
    .fill("Instrucción adicional conservada");
  await page.getByRole("button", { name: "4 Cuándo pide ayuda" }).click();
  await expect(page.getByLabel("Instrucciones adicionales")).toHaveValue(
    "Instrucción adicional conservada",
  );
  await page.getByRole("button", { name: "Guardar nueva revisión" }).click();
  await expect(page).not.toHaveURL(new RegExp(f.agent.id));
  await page.getByRole("button", { name: "5 Probar y revisar" }).click();
  await page.getByLabel("Flujo para la prueba").selectOption(f.flow.id);
  await page.getByRole("link", { name: "Abrir Pruebas", exact: true }).click();
  await page.getByRole("button", { name: "Activar laboratorio de pruebas" }).click();
  await page.getByRole("button", { name: "Crear copia de prueba" }).click();
  await page
    .getByRole("button", { name: "Iniciar prueba", exact: true })
    .click();
  await expect(page.getByRole("log")).toContainText("Presentación de prueba");
  await page
    .getByLabel("Cliente de prueba", { exact: true })
    .fill("¿Qué incluye?");
  await page.getByRole("button", { name: "Probar respuesta" }).click();
  await expect(page.getByRole("log")).toContainText("Cuaderno exclusivo A");
  await page.getByLabel("Cliente de prueba", { exact: true }).fill("¿Y eso?");
  await page.getByRole("button", { name: "Probar respuesta" }).click();
  await expect(page.getByRole("log")).toContainText(
    "Usó el historial reciente",
  );
  await page
    .getByLabel("Cliente de prueba", { exact: true })
    .fill("Quiero una persona");
  await page.getByRole("button", { name: "Probar respuesta" }).click();
  await expect(page.locator(".test-state")).toContainText(
    "Necesita ayuda humana",
  );
  await expect(
    page.getByText("Evaluar proveedor externo · pendiente"),
  ).toBeVisible();
  await page.screenshot({
    path: evidencePath("screenshots/sales-seller-test.png"),
    fullPage: true,
  });
});
test("100 nodes, search, responsive steps and accessibility checks", async ({
  page,
}) => {
  test.setTimeout(120000);
  const nodes = Array.from({ length: 100 }, (_, i) => ({
    id: "node_" + String(i).padStart(3, "0"),
    type: i === 99 ? "end" : "message",
    config: { text: "Paso sintético " + i },
    ...(i < 99 ? { next: "node_" + String(i + 1).padStart(3, "0") } : {}),
  }));
  const flow = await post(page, "/workflows", {
    name: "Recorrido de 100 pasos " + randomUUID().slice(0, 6),
    entry_node_id: "node_000",
    nodes,
  });
  const begin = Date.now();
  await page.goto("/sales/flows/" + flow.id);
  await expect(page.locator(".react-flow__node")).toHaveCount(100);
  const openedMs = Date.now() - begin;
  await page.getByRole("button", { name: "Autoorganizar" }).click();
  const searchStart = Date.now();
  await select(page, "node_099");
  await expect(page.locator("#step-inspector-heading")).toHaveText("node_099");
  const searchMs = Date.now() - searchStart;
  await page.getByRole("button", { name: "Pasos", exact: true }).click();
  const checks = [];
  for (const width of [1440, 1024, 768, 360, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator(".steps-view")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    expect(overflow, "reflow " + width).toBe(false);
    const axe = await new AxeBuilder({ page }).include("main").analyze();
    expect(
      axe.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
    checks.push({ width, overflow, axe_violations: axe.violations.length });
    await page.screenshot({
      path: evidencePath(`screenshots/sales-steps-${width}.png`),
      fullPage: true,
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByLabel("Nombre visible del paso").focus();
  await page.keyboard.press("Tab");
  expect(
    await page.evaluate(() => document.activeElement !== document.body),
  ).toBe(true);
  writeFileSync(
    evidencePath("sales-visual-browser.json"),
    JSON.stringify(
      {
        opened_100_nodes_ms: openedMs,
        search_last_node_ms: searchMs,
        responsive: checks,
        reduced_motion: true,
        scope:
          "Chromium automatic checks; no claim of full accessibility conformance or human screen reader evaluation.",
      },
      null,
      2,
    ),
  );
});
test("viewer can inspect exact versions without enabling edits or tests", async ({
  page,
  browser,
}) => {
  const f = await fixture(page),
    email = "viewer-" + randomUUID() + "@example.invalid",
    password = randomBytes(24).toString("base64url");
  await post(page, "/users", {
    name: "Synthetic viewer",
    email,
    password,
    role: "viewer",
  });
  const ctx = await browser.newContext({ baseURL: origin });
  expect(
    (
      await ctx.request.post("/api/auth/sign-in/email", {
        headers: { Origin: origin },
        data: { email, password },
      })
    ).status(),
  ).toBe(200);
  const viewer = await ctx.newPage();
  await useSimulationFixtureTransport(viewer);
  await viewer.goto("/sales/flows/" + f.flow.id);
  await expect(viewer.getByLabel("Nombre visible del paso")).toBeDisabled();
  await expect(
    viewer.getByRole("button", { name: "Probar conversación" }),
  ).toBeDisabled();
  await expect(
    viewer.getByRole("button", { name: "Agregar paso", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await fixtureRequest(ctx).patch("/v1/workflows/" + f.flow.id, {
        headers: { Origin: origin, "Idempotency-Key": randomUUID() },
        data: { expected_version: 1, name: "denied" },
      })
    ).status(),
  ).toBe(403);
  await ctx.close();
});

test("published subflow opens with a return path to the selected parent step", async ({
  page,
}) => {
  const f = await fixture(page);
  const sub = await post(page, "/workflows", {
    name: "Subflujo de revisión",
    entry_node_id: "fin",
    nodes: [{ id: "fin", type: "end", config: {} }],
  });
  const publishedSub = await post(page, `/workflows/${sub.id}/publish`, {
    expected_version: 1,
  });
  const parent = await post(page, "/workflows", {
    name: "Recorrido padre de revisión",
    product_id: f.product.id,
    offer_version_id: f.offer.id,
    entry_node_id: "sub",
    nodes: [
      {
        id: "sub",
        type: "subflow",
        config: { workflow_version_id: publishedSub.id },
        next: "fin",
      },
      { id: "fin", type: "end", config: {} },
    ],
  });
  await page.goto(`/sales/flows/${parent.id}?node=sub`);
  await page.getByRole("link", { name: "Abrir subflujo →" }).click();
  await expect(page).toHaveURL(new RegExp(publishedSub.id));
  await expect(page.getByLabel("Nombre visible del paso")).toBeDisabled();
  await page
    .getByRole("link", { name: "← Volver al flujo padre, mismo paso" })
    .click();
  await expect(page).toHaveURL(new RegExp(parent.id));
  await expect(page.locator("#step-inspector-heading")).toHaveText("sub");
});
