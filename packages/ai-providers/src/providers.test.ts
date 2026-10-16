import { describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter, GoogleAdapter, OpenAIAdapter, ProviderAdapter, measuredCost, quote, resolveModel,
  validateModel, type AdmissionPort, type Input, type Model, type Outcome, type ProfileConfiguration,
  type Provider, type Scope } from './index.js';

const NOW = Date.parse('2026-10-11T23:00:00Z');
const SCOPE: Scope = { workspaceId: 'workspace-fixture', profileId: 'profile-fixture', variantId: 'mx-fixture',
  conversationId: 'conversation-fixture', attemptId: '11111111-1111-4111-8111-111111111111', task: 'seller.reply', environment: 'SIMULATION' };
const RESERVATION = '22222222-2222-4222-8222-222222222222';
const INPUT: Input = { capability: 'chat', instructions: 'Return a JSON proposal only.', text: 'Synthetic input' };
function model(provider: Provider = 'openai'): Model {
  return { provider, model: 'synthetic-reviewed-model', revision: 'fixture-v1',
    responseModels: ['synthetic-reviewed-model'],
    transport: provider === 'openai' ? 'responses' : provider === 'anthropic' ? 'messages' : 'generateContent',
    capabilities: provider === 'google' ? ['chat', 'vision', 'audio'] : ['chat', 'vision'],
    inputTokenCeiling: 100, outputTokenCeiling: 40,
    price: { version: 'synthetic-price-v1', validFrom: '2026-10-11T00:00:00Z', validUntil: '2026-10-12T00:00:00Z',
      currency: 'USD', input: 1_000_000, output: 2_000_000, cacheRead: 500_000, cacheWrite: 1_250_000, audioInput: 3_000_000 } };
}
function raw(provider: Provider = 'openai'): Record<string, any> {
  if (provider === 'anthropic') return { model: 'synthetic-reviewed-model', type: 'message', role: 'assistant', stop_reason: 'end_turn',
    content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 2 } };
  if (provider === 'google') return { modelVersion: 'synthetic-reviewed-model', candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '{"ok":true}' }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
  return { model: 'synthetic-reviewed-model', status: 'completed', output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '{"ok":true}' }] }],
    usage: { input_tokens: 10, output_tokens: 2 } };
}
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

function fixture(provider: Provider = 'openai') {
  const events: string[] = []; const outcomes: Outcome[] = [];
  const admission: AdmissionPort = {
    reserve: vi.fn(async () => { events.push('reserve'); return { effect: 'SEND_ONCE' as const, reservationId: RESERVATION }; }),
    beforeSend: vi.fn(async () => { events.push('fence'); }),
    record: vi.fn(async (_scope, _id, outcome) => { events.push('record'); outcomes.push(outcome); }),
  };
  const credentials = { acquire: vi.fn(async () => { events.push('key'); return {
    workspaceId: SCOPE.workspaceId, profileId: SCOPE.profileId, environment: SCOPE.environment, provider, version: 3, key: 'synthetic-key-fixture' }; }) };
  const fetcher = vi.fn<typeof fetch>(async () => { events.push('post'); return jsonResponse(raw(provider)); });
  let moment = NOW;
  const ports = { credentials, admission, fetcher, clock: () => moment };
  const adapter = provider === 'openai' ? new OpenAIAdapter(ports) : provider === 'anthropic' ? new AnthropicAdapter(ports) : new GoogleAdapter(ports);
  const options = { scope: structuredClone(SCOPE), model: model(provider), input: structuredClone(INPUT),
    budgetMicrousd: 1000, timeoutMs: 1000, parse: (value: string): { ok: boolean } => {
      const parsed = JSON.parse(value); if (typeof parsed.ok !== 'boolean' || Object.keys(parsed).length !== 1) throw new Error('synthetic parser detail'); return parsed;
    } };
  return { adapter, options, events, admission, credentials, fetcher, outcomes, clock: (now: number) => { moment = now; } };
}

describe('provider contracts: synthetic only', () => {
  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    it(`${provider}: one POST after durable reservation and final authority, native usage retained`, async () => {
      const f = fixture(provider); const result = await f.adapter.invoke(f.options);
      expect(result.state).toBe('SUCCEEDED'); expect(f.events).toEqual(['reserve', 'key', 'fence', 'post', 'record']);
      expect(f.outcomes[0]).toMatchObject({ usage: { input: 10, output: 2 }, costMicrousd: 14 });
      expect(f.fetcher).toHaveBeenCalledTimes(1);
      const [url, init] = f.fetcher.mock.calls[0];
      expect(String(url)).not.toContain('synthetic-key-fixture'); expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit'); expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)); expect(body.stream).not.toBe(true);
      expect(body.service_tier ?? body.serviceTier).toBe(provider === 'openai' ? 'default' : provider === 'anthropic' ? 'standard_only' : 'standard');
      expect(body.tools ?? []).toEqual([]); expect(JSON.stringify(body)).not.toContain('synthetic-key-fixture');
    });
    it(`${provider}: in-memory vision is serialized without remote URLs`, async () => {
      const f = fixture(provider); f.options.input = { ...INPUT, capability: 'vision', media: { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' } };
      expect((await f.adapter.invoke(f.options)).state).toBe('SUCCEEDED');
      expect(String(f.fetcher.mock.calls[0][1]?.body)).toContain('AQID');
      expect(String(f.fetcher.mock.calls[0][1]?.body)).not.toContain('http');
    });
  }
  it('OpenAI transcription uses bounded bytes multipart and measured audio usage', async () => {
    const f = fixture(); f.options.model.transport = 'transcriptions'; f.options.model.capabilities = ['audio'];
    f.options.input = { ...INPUT, capability: 'audio', media: { bytes: new Uint8Array([1, 2]), mimeType: 'audio/wav' } };
    f.fetcher.mockResolvedValue(jsonResponse({ text: '{"ok":true}', usage: { input_tokens: 10, input_token_details: { audio_tokens: 8 }, output_tokens: 2 } }));
    expect((await f.adapter.invoke(f.options)).state).toBe('SUCCEEDED');
    const [url, init] = f.fetcher.mock.calls[0]; expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init?.body).toBeInstanceOf(FormData); expect(f.outcomes[0]).toMatchObject({ costMicrousd: 30, usage: { input: 2, audioInput: 8 } });
  });
  it('Gemini audio and reasoning usage remain distinct', async () => {
    const f = fixture('google'); f.options.input = { ...INPUT, capability: 'audio', media: { bytes: new Uint8Array([1]), mimeType: 'audio/mpeg' } };
    const value = raw('google'); value.usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 2, thoughtsTokenCount: 3,
      promptTokensDetails: [{ modality: 'TEXT', tokenCount: 2 }, { modality: 'AUDIO', tokenCount: 8 }] };
    f.fetcher.mockResolvedValue(jsonResponse(value)); expect((await f.adapter.invoke(f.options)).state).toBe('SUCCEEDED');
    expect(f.outcomes[0]).toMatchObject({ costMicrousd: 36, usage: { input: 2, audioInput: 8, output: 5 } });
  });
  it('unrequested Gemini tool billing or conflicting totals never disappear from usage', async () => {
    for (const extra of [{ toolUsePromptTokenCount: 1 }, { totalTokenCount: 999 }]) {
      const f = fixture('google'); const value = raw('google'); Object.assign(value.usageMetadata, extra);
      f.fetcher.mockResolvedValue(jsonResponse(value));
      expect(await f.adapter.invoke(f.options)).toMatchObject({ state: 'UNCERTAIN', code: 'USAGE_INVALID' });
    }
  });
  it('a priority response is not charged using standard prices', async () => {
    const f = fixture(); const value = raw(); value.service_tier = 'priority'; f.fetcher.mockResolvedValue(jsonResponse(value));
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'OUTPUT_REJECTED', outcome: { usage: { input: 10 } } });
    expect(f.outcomes[0]).not.toHaveProperty('costMicrousd');
  });
  it('Anthropic cache write and read tokens are charged with separate dated rates', async () => {
    const f = fixture('anthropic'); const value = raw('anthropic');
    value.usage = { input_tokens: 2, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
    f.fetcher.mockResolvedValue(jsonResponse(value)); await f.adapter.invoke(f.options);
    expect(f.outcomes[0]).toMatchObject({ costMicrousd: 13, usage: { cacheRead: 3, cacheWrite: 4 } });
  });
  it('unknown network outcome never falls back or retries', async () => {
    const f = fixture(); f.fetcher.mockRejectedValue(new Error('synthetic-secret-response-detail'));
    const result = await f.adapter.invoke(f.options);
    expect(result).toMatchObject({ state: 'UNCERTAIN', code: 'NETWORK_UNKNOWN' });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret'); expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.outcomes[0].state).toBe('UNCERTAIN');
  });
  it('new adapter instance cannot re-send a durable consumed attempt', async () => {
    const f = fixture(); vi.mocked(f.admission.reserve).mockResolvedValue({ effect: 'ALREADY_ATTEMPTED', reservationId: RESERVATION });
    expect(await f.adapter.invoke(f.options)).toEqual({ state: 'UNCERTAIN', code: 'ALREADY_ATTEMPTED' });
    expect(f.credentials.acquire).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.admission.record).not.toHaveBeenCalled();
  });
  for (const field of ['workspaceId', 'profileId', 'provider', 'environment'] as const) {
    it(`credential ${field} mismatch rejects before POST`, async () => {
      const f = fixture(); const credential = await f.credentials.acquire();
      f.events.length = 0; Object.assign(credential, { [field]: 'foreign-fixture' }); f.credentials.acquire.mockResolvedValue(credential);
      expect((await f.adapter.invoke(f.options))).toMatchObject({ state: 'REJECTED', code: 'CREDENTIAL_SCOPE' });
      expect(f.fetcher).not.toHaveBeenCalled(); expect(f.outcomes[0].state).toBe('REJECTED');
    });
  }
  it('authority revoked during key read prevents POST and preserves reservation', async () => {
    const f = fixture(); vi.mocked(f.admission.beforeSend).mockRejectedValue(new Error('private revocation'));
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'AUTHORITY' }); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.admission.record).toHaveBeenCalledTimes(1);
  });
  it('the final fence receives the exact acquired key revision and original request hash', async () => {
    const f = fixture(); await f.adapter.invoke(f.options);
    const request = vi.mocked(f.admission.reserve).mock.calls[0][2];
    expect(request).toMatchObject({ capability: 'chat', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(request)).not.toContain(INPUT.text);
    expect(vi.mocked(f.admission.beforeSend).mock.calls[0][3]).toEqual({ request, credentialVersion: 3 });
  });
  it('a credential without a version cannot cross the final fence', async () => {
    const f = fixture(); const key = await f.credentials.acquire(); key.version = 0; f.credentials.acquire.mockResolvedValue(key);
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'CREDENTIAL_SCOPE' });
    expect(f.admission.beforeSend).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('expiry during final authority lookup prevents provider I/O', async () => {
    const f = fixture(); vi.mocked(f.admission.beforeSend).mockImplementation(async () => { f.clock(Date.parse(f.options.model.price.validUntil)); });
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'PRICE_EXPIRED' }); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('budget is checked before credential/reservation', async () => {
    const f = fixture(); f.options.budgetMicrousd = 1;
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'BUDGET' }); expect(f.admission.reserve).not.toHaveBeenCalled(); expect(f.credentials.acquire).not.toHaveBeenCalled();
  });
  it('error HTTP body is neither read nor exposed and not retried', async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response('synthetic-secret', { status: 429 }));
    const result = await f.adapter.invoke(f.options); expect(result).toMatchObject({ state: 'REJECTED', code: 'HTTP_REJECTED' });
    expect(JSON.stringify(result)).not.toContain('synthetic-secret'); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([408, 500, 502, 504])('HTTP %s preserves uncertainty and the single attempt', async (status) => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response('synthetic-secret', { status }));
    const result = await f.adapter.invoke(f.options);
    expect(result).toMatchObject({ state: 'UNCERTAIN', code: 'HTTP_UNKNOWN' });
    expect(f.outcomes[0]).toMatchObject({ state: 'UNCERTAIN', code: 'HTTP_UNKNOWN' });
    expect(f.outcomes[0]).not.toHaveProperty('costMicrousd');
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.admission.reserve).toHaveBeenCalledTimes(1);
  });
  it('missing usage is uncertain, never a zero-cost success', async () => {
    const f = fixture(); const value = raw(); delete value.usage; f.fetcher.mockResolvedValue(jsonResponse(value));
    expect((await f.adapter.invoke(f.options))).toMatchObject({ state: 'UNCERTAIN', code: 'USAGE_MISSING' });
    expect(f.outcomes[0]).not.toHaveProperty('costMicrousd');
  });
  it('invalid token count rejects without manufacturing measured usage', async () => {
    const f = fixture(); const value = raw(); value.usage.input_tokens = -1; f.fetcher.mockResolvedValue(jsonResponse(value));
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'USAGE_INVALID' });
  });
  it('a token overrun preserves actual usage and cost without releasing a proposal', async () => {
    const f = fixture(); const value = raw(); value.usage.input_tokens = 400;
    f.fetcher.mockResolvedValue(jsonResponse(value));
    expect(await f.adapter.invoke(f.options)).toMatchObject({ state: 'UNCERTAIN', code: 'USAGE_EXCEEDED',
      outcome: { usage: { input: 400, output: 2 }, costMicrousd: 404 } });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  for (const provider of ['openai', 'anthropic', 'google'] as const) {
    it(`${provider}: another native model cannot inherit the reviewed price`, async () => {
      const f = fixture(provider); const value = raw(provider);
      value[provider === 'google' ? 'modelVersion' : 'model'] = 'foreign-model-fixture';
      f.fetcher.mockResolvedValue(jsonResponse(value));
      const result = await f.adapter.invoke(f.options);
      expect(result).toMatchObject({ code: 'OUTPUT_REJECTED', outcome: { usage: { input: 10 } } });
      expect(f.outcomes[0]).not.toHaveProperty('costMicrousd'); expect(result).not.toHaveProperty('value');
    });
  }
  it('truncated/refusal output retains real usage but is never a proposal', async () => {
    const f = fixture(); const value = raw(); value.status = 'incomplete'; f.fetcher.mockResolvedValue(jsonResponse(value));
    expect((await f.adapter.invoke(f.options))).toMatchObject({ state: 'REJECTED', code: 'OUTPUT_REJECTED' });
    expect(f.outcomes[0]).toMatchObject({ costMicrousd: 14 });
  });
  it('schema parser rejection retains billable usage', async () => {
    const f = fixture(); f.options.parse = () => { throw new Error('raw-secret-parser-detail'); };
    const result = await f.adapter.invoke(f.options); expect(result).toMatchObject({ code: 'OUTPUT_REJECTED', outcome: { costMicrousd: 14 } });
    expect(JSON.stringify(result)).not.toContain('raw-secret');
  });
  it('provider tools cannot become executable output', async () => {
    const f = fixture('anthropic'); const value = raw('anthropic'); value.content = [{ type: 'tool_use', name: 'send' }];
    f.fetcher.mockResolvedValue(jsonResponse(value)); expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'OUTPUT_REJECTED' });
  });
  it('body size limit applies when Content-Length is absent', async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }));
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'RESPONSE_LIMIT' });
  });
  it('invalid response headers cancel the unread body', async () => {
    const f = fixture(); const cancel = vi.fn();
    f.fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/html' } }));
    expect(await f.adapter.invoke(f.options)).toMatchObject({ code: 'OUTPUT_REJECTED' }); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('absolute timeout also ends a fetch double which ignores AbortSignal', async () => {
    const f = fixture(); f.options.timeoutMs = 20; f.fetcher.mockImplementation(() => new Promise(() => {}));
    expect((await f.adapter.invoke(f.options))).toMatchObject({ state: 'UNCERTAIN', code: 'NETWORK_UNKNOWN' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('uncertain persistence never releases a successful proposal', async () => {
    const f = fixture(); vi.mocked(f.admission.record).mockRejectedValue(new Error('lost record'));
    const result = await f.adapter.invoke(f.options); expect(result).toMatchObject({ state: 'UNCERTAIN', code: 'RECORD_UNKNOWN' });
    expect(result).not.toHaveProperty('value'); expect(f.admission.record).toHaveBeenCalledTimes(1);
  });
  it('caller mutation during key read cannot alter profile, provider, price or payload', async () => {
    const f = fixture(); const key = await f.credentials.acquire(); f.events.length = 0;
    f.credentials.acquire.mockImplementation(async () => { f.options.scope.profileId = 'other'; f.options.model.price.output = 1; f.options.input.text = 'changed'; return key; });
    expect((await f.adapter.invoke(f.options))).toMatchObject({ state: 'SUCCEEDED', outcome: { costMicrousd: 14 } });
    expect(String(f.fetcher.mock.calls[0][1]?.body)).not.toContain('changed');
    expect(vi.mocked(f.admission.record).mock.calls[0][0].profileId).toBe(SCOPE.profileId);
    expect(vi.mocked(f.admission.record).mock.calls[0][0].conversationId).toBe(SCOPE.conversationId);
  });
});

describe('capability routing and dated monetary bounds', () => {
  function profile(): ProfileConfiguration { return { profileId: 'fixture', version: 1, default: { provider: 'anthropic', model: 'synthetic-reviewed-model' },
    variants: {}, capabilityFallbacks: [], configuredProviders: ['anthropic'] }; }
  it('unsupported audio goes to human, never an invented Anthropic capability', () => {
    expect(resolveModel(profile(), 'mx', 'audio', [model('anthropic')], NOW)).toEqual({ state: 'HUMAN_REQUIRED', code: 'CAPABILITY_NOT_CONFIGURED' });
    const changed = model('anthropic'); changed.capabilities = ['audio']; expect(() => validateModel(changed, NOW)).toThrow('CAPABILITY');
  });
  it('cross-provider fallback needs that profile configured key and explicit selection', () => {
    const p = profile(); p.capabilityFallbacks = [{ provider: 'google', model: 'synthetic-reviewed-model' }];
    const models = [model('anthropic'), model('google')];
    expect(resolveModel(p, 'mx', 'audio', models, NOW).state).toBe('HUMAN_REQUIRED');
    p.configuredProviders = ['anthropic', 'google'];
    expect(resolveModel(p, 'mx', 'audio', models, NOW)).toMatchObject({ state: 'MODEL', selection: 'capability-fallback', model: { provider: 'google' } });
  });
  it('variant override and same-provider compatible model precede complementary provider', () => {
    const p = profile(); const audio = model(); audio.model = 'synthetic-transcription'; audio.transport = 'transcriptions'; audio.capabilities = ['audio'];
    p.variants = { mx: { provider: 'openai', model: 'synthetic-reviewed-model' } };
    p.configuredProviders = ['openai', 'google']; p.capabilityFallbacks = [{ provider: 'google', model: 'synthetic-reviewed-model' }, audio];
    expect(resolveModel(p, 'mx', 'audio', [model(), audio, model('google')], NOW)).toMatchObject({ state: 'MODEL', model: { provider: 'openai', model: 'synthetic-transcription' } });
  });
  it('quote reserves conservative model ceilings and ceil microUSD once', () => {
    expect(quote('fixture', model(), 1000, NOW).maximumMicrousd).toBe(380);
    const m = model(); m.price.input = 1; m.price.output = 1;
    expect(measuredCost(m, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, audioInput: 0 })).toBe(1);
  });
  it('stale prices or duplicate model identities fail closed', () => {
    expect(() => resolveModel(profile(), 'mx', 'chat', [model('anthropic')], NOW + 86400000)).toThrow('PRICE_EXPIRED');
    expect(() => resolveModel(profile(), 'mx', 'chat', [model('anthropic'), model('anthropic')], NOW)).toThrow('CONFIGURATION');
  });
  it('a local timezone date cannot silently extend a price window', () => {
    const m = model(); m.price.validUntil = '2026-10-12T00:00:00';
    expect(() => validateModel(m, NOW)).toThrow('PRICE_EXPIRED');
  });
  it('unknown measured usage categories do not disappear from accounting', () => {
    expect(() => measuredCost(model(), { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, audioInput: 0, extra: 1 } as any)).toThrow('USAGE_INVALID');
  });
  it('ambient global fetch is optional but there is no ambient credential fallback', () => {
    expect(ProviderAdapter.prototype).not.toHaveProperty('apiKey');
    expect(resolveModel({ ...profile(), configuredProviders: [] }, 'mx', 'chat', [model('anthropic')], NOW)).toEqual({ state: 'HUMAN_REQUIRED', code: 'KEY_NOT_CONFIGURED' });
  });
});
