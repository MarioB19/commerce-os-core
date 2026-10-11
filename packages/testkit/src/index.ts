export class VirtualClock {
  constructor(private value = Date.UTC(2026, 8, 5, 12)) {}
  now(): Date { return new Date(this.value); }
  advance(seconds: number): Date {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Clock advances must be finite and nonnegative');
    this.value += seconds * 1000;
    return this.now();
  }
}
export async function eventually<T>(read: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs=10000): Promise<T> {
  const start=performance.now();
  while (true) {
    const value=await read();
    if (predicate(value)) return value;
    if (performance.now()-start>timeoutMs) throw new Error('Expected durable state was not reached');
    await new Promise(resolve=>setTimeout(resolve,50));
  }
}
export function percentile(values: number[], quantile: number): number {
  if (!values.length) throw new Error('No observations');
  const ordered=[...values].sort((a,b)=>a-b);
  return ordered[Math.max(0,Math.ceil(ordered.length*quantile)-1)]!;
}
