import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const activities = JSON.parse(await readFile(path.join(root, "data/activities.json"), "utf8"));
const manifest = JSON.parse(await readFile(path.join(root, "data/commerce-os-product-manifest.json"), "utf8"));
const ids = new Set(activities.map(({ id }) => id));
const grades = new Set(activities.map(({ grado }) => grado));
const fields = new Set(activities.map(({ campo }) => campo));

const failures = [];
if (manifest.schemaVersion !== 2) failures.push(`Se esperaba schemaVersion 2 del manifiesto; hay ${manifest.schemaVersion}.`);
if (manifest.pricingMxnCents?.positivePaymentUnlocksAll !== true) failures.push("El manifiesto debe declarar que cualquier pago positivo abre el paquete completo.");
if (manifest.pricingMxnCents?.minimumUnlockAmount !== 1) failures.push("El monto mínimo de desbloqueo debe ser un centavo, no un umbral comercial.");
for (const obsoleteKey of ["core", "kitTotal", "madrinaTotalExclusiveThreshold"]) {
  if (obsoleteKey in (manifest.pricingMxnCents || {})) failures.push(`El manifiesto conserva el umbral obsoleto ${obsoleteKey}.`);
}
if (activities.length !== 480) failures.push(`Se esperaban 480 actividades; hay ${activities.length}.`);
if (ids.size !== 480) failures.push(`Se esperaban 480 IDs únicos; hay ${ids.size}.`);
if (grades.size !== 9) failures.push(`Se esperaban 9 grados; hay ${grades.size}.`);
if (fields.size !== 4) failures.push(`Se esperaban 4 campos; hay ${fields.size}.`);
const original = JSON.parse(await readFile(path.join(root, "editorial/preschool-original.json"), "utf8"));
if (JSON.stringify(activities.filter((a) => a.grado.includes("preescolar"))) !== JSON.stringify(original)) failures.push("Se alteró el contenido preescolar original.");
for (const grade of grades) {
  const count = activities.filter((a) => a.grado === grade).length;
  if (count !== (grade.includes("preescolar") ? 120 : 20)) failures.push(`Cantidad incorrecta para ${grade}: ${count}`);
}
for (const item of activities) {
  for (const key of ["id", "grado", "campo", "titulo", "proposito", "observacion"]) {
    if (!item[key]) failures.push(`${item.id || "sin-id"}: falta ${key}.`);
  }
  if (!Array.isArray(item.pasos) || item.pasos.length < 3) failures.push(`${item.id}: pasos incompletos.`);
}

const required = [
  "app/page.tsx",
  "app/privacidad/page.tsx",
  "app/acceso/page.tsx",
  "app/herramientas/planeacion/page.tsx",
  "app/herramientas/kit-grupo/page.tsx",
  "app/herramientas/material-aula/page.tsx",
  "app/api/acceso/route.ts",
  "app/api/descargas/[slug]/route.ts",
  "components/LogoutButton.tsx",
  "lib/auth.ts"
];
for (const file of required) {
  try { await stat(path.join(root, file)); } catch { failures.push(`Falta ${file}.`); }
}

const source = await Promise.all(required.filter((file) => file.endsWith(".tsx")).map((file) => readFile(path.join(root, file), "utf8")));
const joined = source.join("\n").toLocaleLowerCase("es");
for (const phrase of ["avalado por la sep", "aprobado por la sep", "oficial de la sep"]) {
  if (joined.includes(phrase)) failures.push(`Afirmación prohibida detectada: ${phrase}.`);
}

const pdfs = (await readdir(path.join(root, "private/pdfs"))).filter((name) => name.endsWith(".pdf"));
if (pdfs.length !== 10) failures.push(`Se esperaban 10 PDFs privados; hay ${pdfs.length}.`);
const publicFiles = await readdir(path.join(root, "public"), { recursive: true });
if (publicFiles.some((name) => String(name).endsWith(".pdf"))) failures.push("Hay PDFs dentro de public/; deben servirse detrás del acceso.");

const kitSource = await readFile(path.join(root, "components/GroupKitTool.tsx"), "utf8");
for (const promise of ["Diplomas", "Medallas de logro", "Pasaportes de avances"]) {
  if (!kitSource.includes(promise)) failures.push(`El Kit no contiene la promesa: ${promise}.`);
}

for (const file of ["app/herramientas/page.tsx", "app/herramientas/planeacion/page.tsx", "app/herramientas/material-aula/page.tsx", "app/herramientas/kit-grupo/page.tsx"]) {
  const pageSource = await readFile(path.join(root, file), "utf8");
  if (!pageSource.includes("getAccessSession")) failures.push(`${file}: falta autorización junto al dato o herramienta protegida.`);
}

const downloadsSource = await readFile(path.join(root, "lib/downloads.ts"), "utf8");
const downloadSlugs = [...downloadsSource.matchAll(/\{\s*slug:\s*"([^"]+)"/g)].map((match) => match[1]);
const expectedDownloadSlugs = ["paquete-completo", ...Array.from({ length: 8 }, (_, index) => `bono-${index + 1}`)];
if (downloadSlugs.length !== 9) {
  failures.push(`Se esperaban 9 PDFs en el catálogo autenticado; hay ${downloadSlugs.length}.`);
}
if (downloadSlugs.join("|") !== expectedDownloadSlugs.join("|")) {
  failures.push(`El catálogo autenticado debe contener el paquete y sus ocho bonos ampliados para ambos niveles; contiene: ${downloadSlugs.join(", ") || "ninguno"}.`);
}
if (downloadSlugs.includes("calendario")) {
  failures.push("El obsequio Calendario debe permanecer fuera del catálogo descargable del portal.");
}
if (!pdfs.includes("calendario-del-ciclo.pdf")) {
  failures.push("El PDF privado del Calendario debe conservarse para su entrega externa por ClicChat.");
}

for (const item of activities.filter((a) => a.grado.includes("primaria"))) {
  if (!item.fuente || item.revisionPedagogica !== "PENDIENTE") failures.push(`${item.id}: falta fuente o estado editorial honesto.`);
}
for (const match of downloadsSource.matchAll(/fileName: "([^"]+)"/g)) {
  const bytes = await readFile(path.join(root, "private/pdfs", match[1]));
  if (bytes.subarray(0,5).toString() !== "%PDF-") failures.push(`${match[1]} no es un PDF.`);
}
const envExample = await readFile(path.join(root, ".env.example"), "utf8");
if (/^MCL_SESSION_SECRET=.+$/m.test(envExample)) failures.push(".env.example no debe contener un secreto de sesión copiable.");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("Validación correcta: pago positivo abre todo, 480 actividades, 9 grados, 4 campos, 9 descargas, 10 PDFs privados, rutas y copy base.");
