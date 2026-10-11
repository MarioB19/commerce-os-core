import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const chunksRoot = path.join(root, ".next/static/chunks");
const activities = JSON.parse(await readFile(path.join(root, "data/activities.json"), "utf8"));
const needles = [activities[0].titulo, activities[179].titulo, activities[359].titulo, activities[360].titulo, activities[459].titulo, activities[479].titulo];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const output = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await walk(target));
    else if (entry.name.endsWith(".js")) output.push(target);
  }
  return output;
}

const leaked = [];
for (const file of await walk(chunksRoot)) {
  const source = await readFile(file, "utf8");
  const matches = needles.filter((needle) => source.includes(needle));
  if (matches.length) leaked.push(`${path.relative(root, file)}: ${matches.join(", ")}`);
}

if (leaked.length) {
  console.error("El catálogo protegido apareció en chunks públicos:\n" + leaked.join("\n"));
  process.exit(1);
}
console.log("Validación de bundle correcta: el catálogo no aparece en chunks públicos.");
