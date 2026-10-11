import { readFile } from "node:fs/promises";
const base = new URL(process.env.MCL_BASE_URL || "http://127.0.0.1:3000");
const coreCode = process.env.MCL_CORE_CODE;
const kitCode = process.env.MCL_KIT_CODE;
const fixtureCatalog = JSON.parse(await readFile(new URL("../data/activities.json", import.meta.url), "utf8"));
const sentinels = [0, 179, 359].map((index) => fixtureCatalog[index].titulo);

if (!coreCode || !kitCode) {
  console.error("Define MCL_CORE_CODE y MCL_KIT_CODE solo para esta ejecución.");
  process.exit(1);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function request(path, init = {}) {
  return fetch(new URL(path, base), { redirect: "manual", ...init });
}

async function login(code) {
  const response = await request("/api/acceso", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base.origin },
    body: JSON.stringify({ code }),
  });
  assert(response.status === 200, `Acceso esperado 200; recibido ${response.status}.`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  assert(cookie?.startsWith("mcl_session="), "Falta cookie de sesión.");
  return cookie;
}

const unauthPlan = await request("/herramientas/planeacion");
const unauthBody = await unauthPlan.text();
assert(unauthPlan.status === 307, `Planeación sin sesión debe redirigir; recibió ${unauthPlan.status}.`);
assert(unauthPlan.headers.get("location")?.startsWith("/acceso"), "Redirección de acceso incorrecta.");
assert(sentinels.every((title) => !unauthBody.includes(title)), "El catálogo apareció en la respuesta no autenticada.");

const unauthPdf = await request("/api/descargas/paquete-completo");
assert(unauthPdf.status === 401, `PDF sin sesión debe responder 401; recibió ${unauthPdf.status}.`);

const crossOrigin = await request("/api/acceso", {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: "https://example.invalid", "Sec-Fetch-Site": "cross-site" },
  body: JSON.stringify({ code: coreCode }),
});
assert(crossOrigin.status === 403, `Origen cruzado debe responder 403; recibió ${crossOrigin.status}.`);

const coreCookie = await login(coreCode);
const corePlan = await request("/herramientas/planeacion", { headers: { Cookie: coreCookie } });
const corePlanBody = await corePlan.text();
assert(corePlan.status === 200, `Planeación core debe responder 200; recibió ${corePlan.status}.`);
assert(sentinels.some((title) => corePlanBody.includes(title)), "La sesión core no recibió el catálogo esperado.");

const coreKit = await request("/herramientas/kit-grupo", { headers: { Cookie: coreCookie } });
assert(coreKit.status === 200, `El código histórico Core debe abrir el paquete completo; recibió ${coreKit.status}.`);

for (const slug of ["paquete-completo", ...Array.from({ length: 8 }, (_, i) => `bono-${i + 1}`)]) {
  const response = await request(`/api/descargas/${slug}`, { headers: { Cookie: coreCookie } });
  assert(response.status === 200, `${slug} core debe responder 200; recibió ${response.status}.`);
  assert(new TextDecoder().decode((await response.arrayBuffer()).slice(0,5)) === "%PDF-", `${slug} tiene bytes inválidos.`);
  assert(response.headers.get("content-type") === "application/pdf", `${slug} no respondió como PDF.`);
  assert(response.headers.get("content-disposition")?.startsWith("attachment;"), `${slug} no fuerza descarga.`);
  assert(response.headers.get("cache-control")?.includes("no-store"), `${slug} permite caché no deseado.`);
}

const kitCookie = await login(kitCode);
const kitTool = await request("/herramientas/kit-grupo", { headers: { Cookie: kitCookie } });
assert(kitTool.status === 200, `Kit debe responder 200; recibió ${kitTool.status}.`);

for (const [scope, cookie] of [["core", coreCookie], ["kit", kitCookie]]) {
  const response = await request("/api/descargas/calendario", { headers: { Cookie: cookie } });
  assert(response.status === 404, `calendario con alcance ${scope} debe responder 404; recibió ${response.status}.`);
}

for (const [header, expected] of [["x-frame-options", "DENY"], ["x-robots-tag", "noindex, nofollow, noarchive"]]) {
  assert(kitTool.headers.get(header) === expected, `Header ${header} incorrecto.`);
}

console.log("Smoke HTTP correcto: auth, acceso completo, 9 PDFs, Calendario 404, origen y headers.");
