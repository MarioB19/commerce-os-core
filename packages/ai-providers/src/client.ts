import { AiError, integer, profileId, requireAi, type AdmissionPort, type CredentialPort, type ErrorCode,
  type Input, type Model, type Outcome, type Provider, type Scope, type Usage } from './contracts.js';
import { measuredCost, quote, validateModel } from './catalog.js';
import * as protocol from './protocol.js';

const MAX_RESPONSE = 1024 * 1024;
const MAX_REQUEST = 8 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
const AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/webm'];

export type Invocation<T> = { state: 'SUCCEEDED'; value: T; outcome: Extract<Outcome, { state: 'SUCCEEDED' }> }
  | { state: 'REJECTED' | 'UNCERTAIN'; code: ErrorCode; outcome?: Outcome };
interface Ports { credentials: CredentialPort; admission: AdmissionPort; fetcher?: typeof fetch; clock?: () => number }

function validateInput(scope: Scope, input: Input): void {
  requireAi(profileId(scope.workspaceId) && profileId(scope.profileId) && profileId(scope.variantId)
    && (scope.conversationId === undefined || profileId(scope.conversationId))
    && UUID.test(scope.attemptId) && typeof scope.task === 'string' && /^[a-z][a-z0-9._-]{0,63}$/.test(scope.task)
    && ['REAL', 'SIMULATION'].includes(scope.environment), 'CONFIGURATION');
  requireAi(input && ['chat', 'vision', 'audio'].includes(input.capability)
    && typeof input.instructions === 'string' && Buffer.byteLength(input.instructions) <= 65536
    && typeof input.text === 'string' && Buffer.byteLength(input.text) <= 524288, 'INPUT_LIMIT');
  if (input.capability === 'chat') requireAi(input.media === undefined && input.text.length > 0, 'CAPABILITY');
  else requireAi(input.media && input.media.bytes instanceof Uint8Array && input.media.bytes.byteLength > 0
    && input.media.bytes.byteLength <= 4 * 1024 * 1024
    && (input.capability === 'vision' ? IMAGE_TYPES : AUDIO_TYPES).includes(input.media.mimeType), 'INPUT_LIMIT');
}

async function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AiError('NETWORK_UNKNOWN');
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new AiError('NETWORK_UNKNOWN'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    requireAi(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'application/json', 'OUTPUT_REJECTED');
    const size = response.headers.get('content-length');
    requireAi(size === null || /^\d{1,10}$/.test(size) && Number(size) <= MAX_RESPONSE, 'RESPONSE_LIMIT');
    requireAi(response.body, 'OUTPUT_REJECTED');
  } catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const next = await bounded(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength; requireAi(total <= MAX_RESPONSE, 'RESPONSE_LIMIT'); chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new AiError('OUTPUT_REJECTED'); }
}

/** No ambient credentials or implicit retry. An admission adapter must own durable intents. */
export class ProviderAdapter {
  constructor(readonly provider: Provider, private readonly ports: Ports) {}

  async invoke<T>(options: { scope: Scope; model: Model; input: Input; budgetMicrousd: number;
    timeoutMs: number; parse: (text: string) => T; signal?: AbortSignal }): Promise<Invocation<T>> {
    let reservationId: string | undefined; let providerStarted = false;
    let measured: { usage: Usage; costMicrousd?: number } | undefined;
    let model: Model | undefined; let scope: Scope | undefined;
    const clock = this.ports.clock ?? Date.now;
    try {
      // Detach caller-owned objects before any asynchronous boundary.
      scope = structuredClone(options.scope); model = structuredClone(options.model);
      const input = structuredClone(options.input);
      const parse = options.parse;
      validateInput(scope, input);
      requireAi(model.provider === this.provider && model.capabilities.includes(input.capability), 'CAPABILITY');
      requireAi(integer(options.timeoutMs) && options.timeoutMs > 0 && options.timeoutMs <= 60000, 'CONFIGURATION');
      const deadline = AbortSignal.timeout(options.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      requireAi(!signal.aborted, 'AUTHORITY');
      const estimate = quote(scope.profileId, model, options.budgetMicrousd, clock());
      const wire = protocol.request(model, input);
      requireAi(wire.bytes <= MAX_REQUEST, 'INPUT_LIMIT');
      // Hash semantic input rather than the random multipart boundary. The
      // durable record needs provenance without retaining prompts or media.
      const requestIdentity = protocol.requestIdentity(model,input,wire.bytes);
      const grant = await bounded(this.ports.admission.reserve(structuredClone(scope), structuredClone(estimate), structuredClone(requestIdentity)), signal);
      requireAi(grant && ['SEND_ONCE', 'ALREADY_ATTEMPTED'].includes(grant.effect)
        && typeof grant.reservationId === 'string' && UUID.test(grant.reservationId), 'AUTHORITY');
      if (grant.effect === 'ALREADY_ATTEMPTED') return { state: 'UNCERTAIN', code: 'ALREADY_ATTEMPTED' };
      reservationId = grant.reservationId;
      const credential = await bounded(this.ports.credentials.acquire(structuredClone(scope), this.provider), signal);
      requireAi(credential && credential.workspaceId === scope.workspaceId && credential.profileId === scope.profileId
        && credential.environment === scope.environment && credential.provider === this.provider
        && integer(credential.version) && credential.version > 0
        && typeof credential.key === 'string' && credential.key.length > 0 && credential.key.length <= 8192
        && !/\s/.test(credential.key), 'CREDENTIAL_SCOPE');
      const headers = { ...wire.headers };
      if (this.provider === 'openai') headers.Authorization = 'Bearer ' + credential.key;
      else headers[this.provider === 'anthropic' ? 'x-api-key' : 'x-goog-api-key'] = credential.key;
      // No I/O between this final authority check and the single provider POST.
      await bounded(this.ports.admission.beforeSend(structuredClone(scope), structuredClone(estimate), reservationId,
        { request: structuredClone(requestIdentity), credentialVersion: credential.version }), signal);
      validateModel(model, clock()); requireAi(!signal.aborted, 'AUTHORITY');
      providerStarted = true;
      const response = await bounded((this.ports.fetcher ?? fetch)(wire.url, { method: 'POST', headers,
        body: wire.body, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        // A timeout/server error can follow execution or charging. Never infer
        // a conclusive rejection, free usage or permission to retry from it.
        const rejected = [400, 401, 403, 404, 413, 415, 422, 429].includes(response.status);
        throw new AiError(rejected ? 'HTTP_REJECTED' : 'HTTP_UNKNOWN');
      }
      const data = await readJson(response, signal);
      const usage = protocol.usage(model, data);
      measured = { usage };
      requireAi(input.capability !== 'audio' || usage.audioInput > 0, 'USAGE_MISSING');
      protocol.validateResponseModel(model, data);
      const costMicrousd = measuredCost(model, usage); measured = { usage, costMicrousd };
      const inputTotal = BigInt(usage.input) + BigInt(usage.audioInput) + BigInt(usage.cacheRead) + BigInt(usage.cacheWrite);
      requireAi(inputTotal <= BigInt(model.inputTokenCeiling) && usage.output <= model.outputTokenCeiling
        && costMicrousd <= estimate.maximumMicrousd, 'USAGE_EXCEEDED');
      let value: T;
      try { value = parse(protocol.output(model, data)); }
      catch { throw new AiError('OUTPUT_REJECTED'); }
      const outcome: Extract<Outcome, { state: 'SUCCEEDED' }> = { state: 'SUCCEEDED', usage, costMicrousd, priceVersion: model.price.version };
      try { await bounded(this.ports.admission.record(structuredClone(scope), reservationId, structuredClone(outcome)), AbortSignal.timeout(5000)); }
      catch { return { state: 'UNCERTAIN', code: 'RECORD_UNKNOWN', outcome }; }
      return { state: 'SUCCEEDED', value, outcome };
    } catch (error) {
      const code = error instanceof AiError ? error.code : providerStarted ? 'NETWORK_UNKNOWN' : 'AUTHORITY';
      const state = providerStarted && code !== 'HTTP_REJECTED' && code !== 'OUTPUT_REJECTED' ? 'UNCERTAIN' : 'REJECTED';
      if (!reservationId || !scope || !model) return { state, code };
      const outcome: Outcome = { state, code, ...measured, priceVersion: model.price.version };
      try { await bounded(this.ports.admission.record(structuredClone(scope), reservationId, structuredClone(outcome)), AbortSignal.timeout(5000)); }
      catch { return { state: 'UNCERTAIN', code: 'RECORD_UNKNOWN', outcome }; }
      return { state, code, outcome };
    }
  }
}

export class OpenAIAdapter extends ProviderAdapter { constructor(ports: Ports) { super('openai', ports); } }
export class AnthropicAdapter extends ProviderAdapter { constructor(ports: Ports) { super('anthropic', ports); } }
export class GoogleAdapter extends ProviderAdapter { constructor(ports: Ports) { super('google', ports); } }
