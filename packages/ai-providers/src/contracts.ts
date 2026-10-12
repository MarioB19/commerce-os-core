export type Provider = 'openai' | 'anthropic' | 'google';
export type Capability = 'chat' | 'vision' | 'audio';
export type Transport = 'responses' | 'transcriptions' | 'messages' | 'generateContent';
export interface Selection { provider: Provider; model: string }
export interface Price {
  version: string; validFrom: string; validUntil: string; currency: 'USD';
  // Integer microUSD per million tokens; no floating monetary arithmetic.
  input: number; output: number; cacheRead: number; cacheWrite: number; audioInput: number;
}
export interface Model extends Selection {
  revision: string; transport: Transport; capabilities: readonly Capability[];
  // Native response identities covered by this reviewed price, including a
  // dated snapshot when the request uses an alias. Not supplied by end users.
  responseModels: readonly string[];
  // Reviewed native maxima, including media/context tokens; never a target
  // inferred from text length. Admission must verify the protected catalogue.
  inputTokenCeiling: number; outputTokenCeiling: number; price: Price;
}
export interface ProfileConfiguration {
  profileId: string; version: number; default: Selection;
  variants: Readonly<Record<string, Selection>>;
  // Ordered and explicit: same-provider models, then complementary keys.
  capabilityFallbacks: readonly Selection[];
  configuredProviders: readonly Provider[];
}
export interface Scope {
  workspaceId: string; profileId: string; variantId: string; attemptId: string;
  conversationId?: string;
  task: string; environment: 'REAL' | 'SIMULATION';
}
export interface Input {
  capability: Capability; instructions: string; text: string;
  media?: { bytes: Uint8Array; mimeType: string };
}
export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number; audioInput: number;
}
export interface Quote {
  profileId: string; provider: Provider; model: string; modelRevision: string;
  priceVersion: string; maximumMicrousd: number; currency: 'USD';
  maximumInputTokens: number; maximumOutputTokens: number;
}
export interface RequestIdentity { sha256: string; capability: Capability; bytes: number }
export type Outcome =
  | { state: 'SUCCEEDED'; usage: Usage; costMicrousd: number; priceVersion: string }
  | { state: 'REJECTED' | 'UNCERTAIN'; code: ErrorCode; usage?: Usage; costMicrousd?: number; priceVersion: string };
export interface AdmissionPort {
  // Implementations must persist the reservation and its no-replay intent.
  reserve(scope: Scope, quote: Quote, request: RequestIdentity): Promise<{ effect: 'SEND_ONCE' | 'ALREADY_ATTEMPTED'; reservationId: string }>;
  // Revalidate effective profile authority, protected catalogue, reservation,
  // request binding and this exact credential revision after all other I/O.
  beforeSend(scope: Scope, quote: Quote, reservationId: string,
    binding: { request: RequestIdentity; credentialVersion: number }): Promise<void>;
  record(scope: Scope, reservationId: string, outcome: Outcome): Promise<void>;
}
export interface CredentialPort {
  acquire(scope: Scope, provider: Provider): Promise<{
    workspaceId: string; profileId: string; environment: Scope['environment']; provider: Provider; version: number; key: string
  }>;
}
export type ErrorCode = 'CONFIGURATION' | 'CAPABILITY' | 'PRICE_EXPIRED' | 'BUDGET' | 'INPUT_LIMIT'
  | 'CREDENTIAL_SCOPE' | 'ALREADY_ATTEMPTED' | 'AUTHORITY' | 'HTTP_REJECTED' | 'HTTP_UNKNOWN' | 'NETWORK_UNKNOWN'
  | 'RESPONSE_LIMIT' | 'OUTPUT_REJECTED' | 'USAGE_MISSING' | 'USAGE_INVALID' | 'USAGE_EXCEEDED'
  | 'RECORD_UNKNOWN';
export class AiError extends Error {
  constructor(readonly code: ErrorCode) { super(code); this.name = 'AiError'; }
}
export function requireAi(value: unknown, code: ErrorCode): asserts value {
  if (!value) throw new AiError(code);
}
export function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function profileId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');
}
