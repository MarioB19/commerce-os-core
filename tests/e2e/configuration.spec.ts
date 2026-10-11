import { test, expect, type Page } from "@playwright/test";

// Every API request is intercepted. These UI checks cannot contact a provider or change a database.
const ids = { workspace: "11111111-1111-4111-8111-111111111111", user: "22222222-2222-4222-8222-222222222222", account: "33333333-3333-4333-8333-333333333333", product: "44444444-4444-4444-8444-444444444444", offer: "55555555-5555-4555-8555-555555555555", workflow: "66666666-6666-4666-8666-666666666666", contact: "77777777-7777-4777-8777-777777777777" };
const defaultOperations = { dispatch_frozen: true, real_sends_enabled: false, allow_real_operations: false, allow_channel_onboarding: true, contact_messages_per_minute: 1, channel_account_concurrency: 1 };
async function fixture(page: Page, role = "owner") {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const settings = { version: 7, body: { ...defaultOperations }, updated_at: "2026-09-06T12:00:00.000Z" };
  const profile = { key: "openai:default", type: "openai", reference: "default", label: "IA de prueba", version: 1, enabled: true, config: { base_url: "https://api.openai.com/v1" }, secrets: { api_key: { configured: true } } };
  const account = { id: ids.account, name: "Número de prueba UI", provider: "waha", status: "WORKING", sending_enabled: false, version: 1 };
  const setup = { account_version: 1, configuration_version: 7, sending_enabled: false, options: {
    products: [{ id: ids.product, lineage_id: ids.product, name: "Producto de prueba", version: 1 }],
    offers: [{ id: ids.offer, lineage_id: ids.offer, name: "Oferta publicada de prueba", product_id: ids.product, product_lineage_id: ids.product, version: 1, status: "PUBLISHED" }, { id: "draft", name: "Oferta borrador excluida", product_id: ids.product, status: "DRAFT" }],
    workflows: [{ id: ids.workflow, name: "Flujo publicado de prueba", product_id: ids.product, product_lineage_id: ids.product, offer_version_id: ids.offer, offer_lineage_id: ids.offer, status: "PUBLISHED", version: 1 }], agents: [], gateways: [{ id: "WAHA_UI", name: "Conexión de prueba", provider: "waha" }],
  }, effective_assignment: { gateway_ref: "WAHA_UI", binding_id: "internal-binding-not-a-form-field" } as Record<string, unknown>, checks: [{ key: "assignment", label: "Asignación compatible", ok: false }], ready: false, blockers: ["Asignación compatible"], authorization: null as null | Record<string, unknown> };
  await page.addInitScript(({ workspace, user }) => sessionStorage.setItem(`commerce-environment:${workspace}:${user}`, "REAL"), ids);
  await page.route("**/v1/**", async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown = [];
    if (request.method() !== "GET") {
      const body = request.postDataJSON() as Record<string, unknown> ?? {};
      requests.push({ path, body });
      if (path === "/v1/settings/operations") { Object.assign(settings.body, body.changes); settings.version++; data = settings; }
      else if (path.startsWith("/v1/settings/integrations/")) { profile.version++; data = profile; }
      else if (path.endsWith("/setup")) {
        const { expected_version: _revision, reason: _reason, environment: _environment, ...assignment } = body;
        setup.effective_assignment = assignment; setup.ready = true; setup.blockers = []; setup.checks[0]!.ok = true; setup.account_version++; account.version++; data = { account };
      } else if (path.endsWith("/activate")) { setup.sending_enabled = true; account.sending_enabled = true; setup.account_version++; account.version++; data = { account, command_id: "synthetic-command" }; }
      else if (path.endsWith("/authorize")) { setup.account_version++; account.version++; setup.authorization = { id: "synthetic-authorization", expires_at: body.expires_at, scope: { max_messages: body.max_messages, contact_ids: body.contact_ids, allow_automation: body.allow_automation }, revoked_at: null }; data = { authorization: setup.authorization, account }; }
      else if (path === "/v1/service-tokens") data = { id: "synthetic-token", token: "synthetic-ui-token-not-a-real-credential" };
      else if (path === "/v1/assets" || path.endsWith("/complete")) data = { id: "88888888-8888-4888-8888-888888888888", name: "Portal sintético", kind: "access", status: "READY" };
      else if (path.endsWith("/offers")) data = { id: ids.offer, name: body.name, status: "DRAFT", ...body };
      else { await route.fulfill({ status: 400, json: { error: { code: "UNEXPECTED_FIXTURE_MUTATION", message: "Acción fuera del fixture" } } }); return; }
    } else if (path.endsWith('/configuration')) data = {configuration_published:false,accounts:[],offer:null,workflow:null,seller:null,connections:{assigned_accounts:0,sales_ai:{configured:false,state:'PROVIDER_PENDING',model:null}}};
    else if (path.endsWith("/assistant")) data = {product:setup.options.products[0],next_actions:[],resources:[],assignments:[],proposals:[]};
    else if (path === "/v1/me") data = { user: { id: ids.user, name: "Operador sintético", email: "fixture@example.invalid" }, workspace_id: ids.workspace, role, permissions: ["sales:read", "sales:operate"], environment: "REAL" };
    else if (path === "/v1/settings/operations") data = settings;
    else if (path === "/v1/settings/launch") data = {
      environment: "REAL", configuration_version: settings.version, release_hold: false, release_hold_at: null,
      policy_open: !settings.body.dispatch_frozen && settings.body.real_sends_enabled && settings.body.allow_real_operations,
      workspace_paused: false, observed_at: settings.updated_at,
      summary: { operating: 0, attention: 0, blocked: 0 }, numbers: [],
    };
    else if (path === "/v1/settings/integrations") data = { definitions: [{ type: "openai", label: "Inteligencia artificial", multiple: false, reference_help: "", config_fields: [{ name: "base_url", label: "Destino de IA", type: "select", required: true, options: ["https://api.openai.com/v1"] }], secret_fields: [{ name: "api_key", label: "Clave de IA", required: true }] }], profiles: [profile] };
    else if (path === "/v1/system/status") data = { services: [{ name: "api", status: "READY" }], controls: [] };
    else if (path === "/v1/channel-accounts") data = [account];
    else if (path.endsWith("/setup")) data = setup;
    else if (path === "/v1/contacts") data = [{ id: ids.contact, name: "Contacto sintético con permiso" }];
    else if (path === "/v1/products") data = setup.options.products;
    else if (path === `/v1/products/${ids.product}`) data = setup.options.products[0];
    else if (path === "/v1/assets") data = [{ id: "88888888-8888-4888-8888-888888888888", name: "Portal sintético", kind: "access", status: "READY" }];
    await route.fulfill({ json: { data, ...(path.endsWith("/materials")?{meta:{next_cursor:null,limit:30}}:{}) } });
  });
  return { requests, setup, account };
}

test("owner changes operational mode with explicit review and a versioned request", async ({ page }) => {
  const { requests } = await fixture(page);
  await page.goto("/settings");
  await page.getByLabel("Modo de operación", { exact: true }).selectOption("enabled");
  await page.getByLabel("Motivo del cambio", { exact: true }).fill("Habilitación sintética acotada");
  const save = page.getByRole("button", { name: "Guardar modo y límites" });
  await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: /Confirmo que las cuentas activas/ }).check();
  await save.click();
  await expect(page.getByText("Operación permitida", { exact: true })).toBeVisible();
  expect(requests[0]).toMatchObject({ path: "/v1/settings/operations", body: { expected_version: 7, environment: "REAL", changes: { dispatch_frozen: false, real_sends_enabled: true, allow_real_operations: true } } });
});

test("integration secret is cleared on close and omission preserves the existing credential", async ({ page }) => {
  const { requests } = await fixture(page);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Editar conexión IA de prueba" }).click();
  let modal = page.getByRole("dialog");
  await modal.getByLabel("Clave de IA · Configurada").fill("synthetic-value-never-sent");
  await modal.getByRole("button", { name: "Cerrar", exact: true }).click();
  await page.getByRole("button", { name: "Editar conexión IA de prueba" }).click();
  modal = page.getByRole("dialog");
  await expect(modal.getByLabel("Clave de IA · Configurada")).toHaveValue("");
  await modal.getByLabel("Motivo del cambio").fill("Mantener la credencial existente");
  await modal.getByRole("button", { name: "Guardar conexión" }).click();
  await expect(modal).toBeHidden();
  expect(requests).toHaveLength(1);
  expect(requests[0]!.body).toMatchObject({ expected_version: 1, secrets: {}, clear_secrets: [] });
  expect(JSON.stringify(requests)).not.toContain("synthetic-value-never-sent");
});

test("guided number setup saves compatible versions then activates and authorizes a bounded audience", async ({ page }) => {
  const { requests } = await fixture(page);
  await page.goto("/settings/channels/advanced");
  await page.getByRole("button", { name: /Número de prueba UI/ }).click();
  await page.getByRole("button", { name: "Configuración comercial",exact:true }).click();
  const modal = page.getByRole("dialog");
  await expect(modal.getByRole("button", { name: "Habilitar este número" })).toBeDisabled();
  await modal.getByLabel("Producto de este número").selectOption(ids.product);
  await expect(modal.getByLabel("Oferta publicada", { exact: true }).locator("option")).toHaveCount(2);
  await modal.getByLabel("Oferta publicada", { exact: true }).selectOption(ids.offer);
  await modal.getByLabel("Flujo publicado", { exact: true }).selectOption(ids.workflow);
  await modal.getByLabel("Motivo de la asignación").fill("Asignación de prueba sintética");
  await modal.getByRole("button", { name: "Guardar asignación" }).click();
  await expect(modal.getByText("Listo", { exact: true })).toBeVisible();
  expect(requests[0]!.body).toMatchObject({ expected_version: 1, product_id: ids.product, offer_version_id: ids.offer, workflow_version_id: ids.workflow, agent_version_id: null, gateway_ref: "WAHA_UI" });
  expect(requests[0]!.body).not.toHaveProperty("binding_id");
  await modal.getByLabel("Motivo de habilitación o desactivación").fill("Validación sintética sin envíos");
  await modal.getByRole("checkbox", { name: /Revisé la configuración/ }).check();
  await modal.getByRole("button", { name: "Habilitar este número" }).click();
  await expect(modal.getByText("Número habilitado", { exact: true })).toBeVisible();
  await modal.getByRole("button", { name: "Definir alcance autorizado" }).click();
  await modal.getByRole("checkbox", { name: "Contacto sintético con permiso" }).check();
  await modal.getByLabel("Propósito y motivo de la autorización").fill("Prueba manual para contacto sintético");
  const authorize = modal.getByRole("button", { name: "Autorizar este alcance" });
  await expect(authorize).toBeDisabled();
  await modal.getByRole("checkbox", { name: /Confirmo estos destinatarios/ }).check();
  await expect(authorize).toBeEnabled();
  await authorize.click();
  await expect(modal.getByRole("button", { name: "Revocar autorización" })).toBeVisible();
  expect(requests.at(-1)!.body).toMatchObject({ expected_version: 3, configuration_version: 7, confirmation: "AUTHORIZE_REAL_SCOPE", contact_ids: [ids.contact], max_messages: 1, allow_automation: false });
  expect(requests.map((entry) => entry.path)).toEqual([`/v1/channel-accounts/${ids.account}/setup`, `/v1/channel-accounts/${ids.account}/activate`, `/v1/channel-accounts/${ids.account}/authorize`]);
});

test("operator sees configuration ownership without credential or enable controls", async ({ page }) => {
  await fixture(page, "operator");
  await page.goto("/settings");
  await expect(page.getByText(/El administrador gestiona el modo de operación/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Guardar modo y límites" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "API y tokens" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Editar conexión IA de prueba" })).toHaveCount(0);
});

test("limited API token is delivered once and cleared when its dialog closes", async ({ page }) => {
  const { requests } = await fixture(page);
  await page.goto("/settings");
  await page.getByRole("link", { name: "API y tokens" }).click();
  await page.getByRole("button", { name: "Crear acceso API" }).click();
  let modal = page.getByRole("dialog");
  await modal.getByLabel("Nombre del servicio").fill("Asistente sintético de consulta");
  await modal.getByRole("checkbox", { name: "Consultar productos", exact: true }).check();
  await modal.getByRole("button", { name: "Crear credencial limitada" }).click();
  await expect(modal.getByLabel("Credencial nueva")).toHaveValue("synthetic-ui-token-not-a-real-credential");
  await modal.getByRole("button", { name: "Guardé la credencial, cerrar" }).click();
  await page.getByRole("button", { name: "Crear acceso API" }).click();
  modal = page.getByRole("dialog");
  await expect(modal.getByLabel("Credencial nueva")).toHaveCount(0);
  expect(requests[0]!.body).toMatchObject({ scopes: ["products:read"] });
});

test("portal code is cleared on close and submitted only in the protected delivery reference", async ({ page }) => {
  const { requests } = await fixture(page);
  await page.goto("/catalog");
  await page.getByRole("button", { name: /Archivos y accesos/ }).click();
  await page.getByRole("button", { name: "Agregar material" }).click();
  let modal = page.getByRole("dialog");
  await modal.getByLabel("Tipo de entrega").selectOption("portal");
  await modal.getByLabel("Código de acceso al portal").fill("discarded-synthetic-code");
  await modal.getByRole("button", { name: "Cerrar", exact: true }).click();
  await page.getByRole("button", { name: "Agregar material" }).click();
  modal = page.getByRole("dialog");
  await modal.getByLabel("Tipo de entrega").selectOption("portal");
  await expect(modal.getByLabel("Código de acceso al portal")).toHaveValue("");
  await modal.getByLabel("Nombre del material").fill("Acceso sintético privado");
  await modal.getByLabel("Dirección HTTPS").fill("https://example.com/portal");
  await modal.getByLabel("Código de acceso al portal").fill("synthetic-access-code");
  await modal.getByLabel("Instrucciones para acceder").fill("Introduce el código de prueba.");
  await modal.getByRole("button", { name: "Guardar material" }).click();
  await expect(modal).toBeHidden();
  expect(requests[0]!.body).toMatchObject({ kind: "access", adapter: "link", name: "Acceso sintético privado" });
  expect(requests[0]!.body).not.toHaveProperty("url");
  expect(JSON.parse(String(requests[0]!.body.delivery_reference))).toEqual({ url: "https://example.com/portal", code: "synthetic-access-code", instructions: "Introduce el código de prueba." });
  expect(JSON.stringify(requests)).not.toContain("discarded-synthetic-code");
});

test("offer fulfillment uses material and release selectors with an optional amount", async ({ page }) => {
  const { requests } = await fixture(page);
  await page.goto("/catalog");
  await page.getByRole("button", { name: /Producto de prueba/ }).click();
  await page.getByRole("link", { name: "Oferta y materiales", exact: true }).click();
  await page.getByRole("button", { name: "Nueva oferta", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByLabel("Nombre de la oferta").fill("Oferta sintética con entrega");
  await modal.getByLabel("Precio total").fill("107.01");
  await modal.getByRole("button", { name: "Agregar entrega" }).click();
  await modal.getByLabel("Material de la entrega 1").selectOption("88888888-8888-4888-8888-888888888888");
  await modal.getByLabel("Cuándo liberar la entrega 1").selectOption("receipt_approved");
  await modal.getByLabel("Importe mínimo para entrega 1", { exact: true }).fill("97.00");
  await expect(modal.locator("textarea.code-input")).toHaveCount(0);
  await modal.getByRole("button", { name: "Guardar", exact: true }).click();
  await expect(modal).toBeHidden();
  expect(requests[0]!.body.base_amount_minor).toBe(10701);
  expect(requests[0]!.body.fulfillment).toEqual([{ asset_id: "88888888-8888-4888-8888-888888888888", release_on: "receipt_approved", min_amount_minor: 9700 }]);
});

test("new inbound scope requires review and submits no historical contact identifiers", async ({ page }) => {
  const { requests, setup, account } = await fixture(page);
  setup.ready = true; setup.sending_enabled = true; setup.blockers = []; setup.checks[0]!.ok = true; account.sending_enabled = true;
  setup.effective_assignment = { product_id: ids.product, offer_version_id: ids.offer, workflow_version_id: ids.workflow, gateway_ref: "WAHA_UI" };
  await page.goto("/settings/channels/advanced");
  await page.getByRole("button", { name: /Número de prueba UI/ }).click();
  await page.getByRole("button", { name: "Configuración comercial",exact:true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("button", { name: "Definir alcance autorizado" }).click();
  await modal.getByRole("combobox", { name: "Destinatarios del alcance" }).selectOption("new_inbound");
  await expect(modal.getByText(/No incluye la base histórica/)).toBeVisible();
  await expect(modal.getByLabel("Buscar destinatarios por nombre")).toHaveCount(0);
  await modal.getByRole("checkbox", { name: /Permitir respuestas y seguimientos automáticos/ }).check();
  await modal.getByLabel("Propósito y motivo de la autorización").fill("Atender sólo nuevas consultas sintéticas");
  const authorize = modal.getByRole("button", { name: "Autorizar este alcance" });
  await expect(authorize).toBeDisabled();
  await modal.getByRole("checkbox", { name: /Confirmo estos destinatarios/ }).check();
  await authorize.click();
  await expect(modal.getByRole("button", { name: "Revocar autorización" })).toBeVisible();
  expect(requests[0]!.body).toMatchObject({ recipient_mode: "new_inbound", contact_ids: [], allow_automation: true, max_messages: 1, confirmation: "AUTHORIZE_REAL_SCOPE" });
});

test("assigned number submits its annual grant to the assignment endpoint", async ({ page }) => {
  const { requests, setup, account } = await fixture(page);
  const assignmentId = "99999999-9999-4999-8999-999999999999";
  setup.ready = true; setup.sending_enabled = true; setup.blockers = []; setup.checks[0]!.ok = true; account.sending_enabled = true;
  setup.effective_assignment = { assignment_id: assignmentId, assignment_revision: 4, product_id: ids.product, offer_version_id: ids.offer, workflow_version_id: ids.workflow, gateway_ref: "WAHA_UI" };
  await page.goto("/settings/channels/advanced");
  await page.getByRole("button", { name: /Número de prueba UI/ }).click();
  await page.getByRole("button", { name: "Configuración comercial", exact: true }).click();
  const modal = page.getByRole("dialog");
  await modal.getByRole("button", { name: "Definir alcance autorizado" }).click();
  await modal.getByRole("combobox", { name: "Destinatarios del alcance" }).selectOption("new_inbound");
  await modal.getByLabel("Máximo total de mensajes").fill("250");
  await modal.getByLabel("Vigente hasta").fill(new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 16));
  await modal.getByRole("checkbox", { name: /Permitir respuestas y seguimientos automáticos/ }).check();
  await modal.getByLabel("Propósito y motivo de la autorización").fill("Entradas nuevas durante el plazo aprobado");
  await modal.getByRole("checkbox", { name: /Confirmo estos destinatarios/ }).check();
  await modal.getByRole("button", { name: "Autorizar este alcance" }).click();
  expect(requests[0]).toMatchObject({ path: `/v1/assignments/${assignmentId}/authorize`, body: { expected_version: 4, configuration_version: 7, recipient_mode: "new_inbound", max_messages: 250 } });
  expect(Date.parse(String(requests[0]!.body.expires_at))).toBeGreaterThan(Date.now() + 100 * 86400000);
});
