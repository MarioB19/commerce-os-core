import { integer, profileId, requireAi, type Capability, type Model, type ProfileConfiguration, type Quote, type Selection, type Usage } from './contracts.js';

const transports = { openai: ['responses', 'transcriptions'], anthropic: ['messages'], google: ['generateContent'] } as const;
export function validateModel(model: Model, now: number): void {
  requireAi(model && Object.hasOwn(transports, model.provider) && typeof model.model === 'string'
    && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model.model)
    && typeof model.revision === 'string' && model.revision.length > 0 && model.revision.length <= 128, 'CONFIGURATION');
  requireAi((transports[model.provider] as readonly string[]).includes(model.transport)
    && Array.isArray(model.capabilities) && model.capabilities.length > 0
    && new Set(model.capabilities).size === model.capabilities.length
    && model.capabilities.every(c => ['chat', 'vision', 'audio'].includes(c)), 'CAPABILITY');
  requireAi(Array.isArray(model.responseModels) && model.responseModels.length > 0 && model.responseModels.length <= 8
    && new Set(model.responseModels).size === model.responseModels.length
    && model.responseModels.every(m => typeof m === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(m)), 'CONFIGURATION');
  requireAi(!(model.provider === 'anthropic' && model.capabilities.includes('audio'))
    && !(model.transport === 'responses' && model.capabilities.includes('audio'))
    && !(model.transport === 'transcriptions' && model.capabilities.some(c => c !== 'audio')), 'CAPABILITY');
  requireAi(integer(model.inputTokenCeiling) && model.inputTokenCeiling > 0 && model.inputTokenCeiling <= 2_000_000
    && integer(model.outputTokenCeiling) && model.outputTokenCeiling > 0 && model.outputTokenCeiling <= 128_000, 'CONFIGURATION');
  const p = model.price;
  requireAi(p && p.currency === 'USD' && typeof p.version === 'string' && p.version.length > 0 && p.version.length <= 128
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'audioInput'].every(k => integer(p[k as keyof typeof p]))
    && p.input > 0 && p.output > 0, 'CONFIGURATION');
  const start = Date.parse(p.validFrom); const end = Date.parse(p.validUntil);
  requireAi(typeof p.validFrom === 'string' && typeof p.validUntil === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(p.validFrom)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(p.validUntil)
    && Number.isFinite(now) && Number.isFinite(start) && Number.isFinite(end) && start <= now && now < end, 'PRICE_EXPIRED');
}
function same(a: Selection, b: Selection): boolean { return a.provider === b.provider && a.model === b.model; }
export type Resolution = { state: 'MODEL'; model: Model; selection: 'default' | 'variant' | 'capability-fallback'; keyStatus: 'configured-not-verified-here' }
  | { state: 'HUMAN_REQUIRED'; code: 'KEY_NOT_CONFIGURED' | 'CAPABILITY_NOT_CONFIGURED' };
export function resolveModel(profile: ProfileConfiguration, variantId: string, capability: Capability,
  catalog: readonly Model[], now: number): Resolution {
  requireAi(profileId(profile.profileId) && profileId(variantId) && integer(profile.version) && profile.version > 0
    && Array.isArray(profile.configuredProviders) && Array.isArray(profile.capabilityFallbacks), 'CONFIGURATION');
  requireAi(catalog.length <= 100 && new Set(catalog.map(m => `${m.provider}/${m.model}`)).size === catalog.length, 'CONFIGURATION');
  const primary = Object.hasOwn(profile.variants, variantId) ? profile.variants[variantId] : profile.default;
  requireAi(primary && typeof primary.provider === 'string' && typeof primary.model === 'string', 'CONFIGURATION');
  const options = [primary, ...profile.capabilityFallbacks.filter(s => s.provider === primary.provider),
    ...profile.capabilityFallbacks.filter(s => s.provider !== primary.provider)];
  let hasKey = false;
  for (const selected of options) {
    if (!profile.configuredProviders.includes(selected.provider)) continue;
    hasKey = true;
    const model = catalog.find(m => same(m, selected));
    if (!model) continue;
    validateModel(model, now);
    if (!model.capabilities.includes(capability)) continue;
    return { state: 'MODEL', model: structuredClone(model), selection: same(selected, primary)
      ? Object.hasOwn(profile.variants, variantId) ? 'variant' : 'default' : 'capability-fallback', keyStatus: 'configured-not-verified-here' };
  }
  return { state: 'HUMAN_REQUIRED', code: hasKey ? 'CAPABILITY_NOT_CONFIGURED' : 'KEY_NOT_CONFIGURED' };
}
function money(numerator: bigint): number {
  const rounded = (numerator + 999_999n) / 1_000_000n;
  requireAi(rounded <= BigInt(Number.MAX_SAFE_INTEGER), 'BUDGET');
  return Number(rounded);
}
export function quote(profile: string, model: Model, maximumMicrousd: number, now: number): Quote {
  requireAi(profileId(profile) && integer(maximumMicrousd), 'CONFIGURATION'); validateModel(model, now);
  const p = model.price;
  const inputRate = Math.max(p.input, p.audioInput, p.cacheRead, p.cacheWrite);
  const maximum = money(BigInt(model.inputTokenCeiling) * BigInt(inputRate)
    + BigInt(model.outputTokenCeiling) * BigInt(p.output));
  requireAi(maximum <= maximumMicrousd, 'BUDGET');
  return { profileId: profile, provider: model.provider, model: model.model, modelRevision: model.revision,
    priceVersion: p.version, maximumMicrousd: maximum, currency: 'USD',
    maximumInputTokens: model.inputTokenCeiling, maximumOutputTokens: model.outputTokenCeiling };
}
export function measuredCost(model: Model, usage: Usage): number {
  requireAi(usage && Object.keys(usage).length === 5
    && ['input', 'output', 'cacheRead', 'cacheWrite', 'audioInput'].every(k => integer(usage[k as keyof Usage])), 'USAGE_INVALID');
  // Measured usage remains billable even when the provider exceeds admission.
  let amount = 0n;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'audioInput'] as const) {
    requireAi(usage[k] === 0 || model.price[k] > 0, 'CONFIGURATION');
    amount += BigInt(usage[k]) * BigInt(model.price[k]);
  }
  return money(amount);
}
