import { createHash } from "node:crypto";

const value = process.env.MCL_INPUT;
if (!value) {
  console.error("Falta MCL_INPUT. Lee OPERACION_VERCEL.md para capturarlo sin guardarlo en archivos.");
  process.exit(1);
}
const normalized = value.normalize("NFKC").trim().toLocaleUpperCase("es-MX");
if (!normalized) {
  console.error("El código está vacío.");
  process.exit(1);
}
console.log(createHash("sha256").update(normalized, "utf8").digest("hex"));
