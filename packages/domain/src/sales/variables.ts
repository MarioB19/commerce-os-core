const aliases: Record<string, string> = { grade: 'grado', interest: 'interes' };

export function canonicalSalesVariable(name: string): string {
  return aliases[name] ?? name;
}

/** Published English aliases remain readable; canonical values win on collisions. */
export function canonicalSalesVariables(input: Record<string, unknown> = {}): Record<string, unknown> {
  const result = { ...input };
  for (const [legacy, canonical] of Object.entries(aliases)) {
    if (!Object.hasOwn(result, canonical) && Object.hasOwn(result, legacy)) result[canonical] = result[legacy];
    delete result[legacy];
  }
  return result;
}
