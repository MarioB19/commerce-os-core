import { expect, type APIRequestContext, type TestInfo } from '@playwright/test';
import { setTimeout } from 'node:timers/promises';

// The API keeps its production limit of 300 requests/minute. Intensive browser
// scenarios share loopback IP; start each scenario with room for its full journey.
// This waits before the test and never retries a mutation or hides a 429 inside it.
export async function prepareRateBudget(request: APIRequestContext, info: TestInfo) {
  // /livez belongs to the web preview. Use a public API route so headers come
  // from Fastify's limiter, exactly as the scenario's /v1 calls do.
  const health = await request.get('/v1/openapi.json');
  const remaining = Number(health.headers()['x-ratelimit-remaining']);
  expect(Number.isFinite(remaining), 'API rate-limit headers must be observable').toBe(true);
  if (health.status() === 429 || (Number.isFinite(remaining) && remaining < 240)) {
    const seconds = Number(health.headers()['retry-after'] ?? health.headers()['x-ratelimit-reset']);
    expect(Number.isFinite(seconds) && seconds >= 0 && seconds <= 60).toBe(true);
    info.setTimeout(info.timeout + 65000);
    console.log(`Respetando ventana HTTP antes del escenario: ${seconds}s`);
    await setTimeout(seconds * 1000 + 100);
  } else expect(health.status()).toBe(200);
}
