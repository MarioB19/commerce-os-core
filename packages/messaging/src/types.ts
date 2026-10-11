export type ProviderKind = 'simulator' | 'waha' | 'cloud';
export type MessageKind = 'text' | 'image' | 'audio' | 'document' | 'template';
export interface ProviderCapabilities {
  provider: ProviderKind; experimental: boolean; qr: boolean; sessionLifecycle: boolean;
  formats: readonly MessageKind[]; acknowledgements: boolean; nativeFencing: false;
  remoteIdempotency: false; groups?: 'unsupported'|'probe_required'|'supported'; accountQuality: boolean; businessWindow: boolean;
}
export interface OutboundMessage {
  effectId: string; recipient: string; kind: MessageKind; text?: string;
  media?: { bytes?: Uint8Array; url?: string; providerId?: string; mimeType: string; filename?: string };
  template?: { name: string; language: string; components?: unknown[]; approved: boolean };
}
export interface SendResult { status: 'ACCEPTED' | 'REJECTED' | 'UNKNOWN'; providerMessageId?: string; reason?: string }
export interface HealthSignal {
  dimension: 'infrastructure' | 'session' | 'transport' | 'restriction' | 'quality';
  status: 'OK' | 'BLOCKED' | 'UNKNOWN' | 'WARNING'; value: unknown;
  scope: 'account' | 'host' | 'waba'; source: 'provider_read' | 'provider_event' | 'local_probe';
  observedAt: string; expiresAt: string; availability: 'supported' | 'not_available' | 'not_authorized';
}
export interface CanonicalEvent {
  groupId?: string; senderIdentity?: string; participantIdentity?: string; receivingSession?: string;
  key: string; type: 'message' | 'ack' | 'session' | 'restriction' | 'group_membership' | 'unhandled';
  providerAt: string; identity?: string; identityAliases?: string[];
  providerMessageId?: string; fromMe?: boolean; text?: string;
  kind?: MessageKind | 'unsupported'; media?: { providerId?: string; url?: string; mimeType?: string; filename?: string; sha256?: string };
  status?: string; referral?: Record<string, unknown>; payload: Record<string, unknown>;
}
export interface MessagingProvider {
  readonly capabilities: ProviderCapabilities;
  send(message: OutboundMessage): Promise<SendResult>;
  profile?(): Promise<{identity:string;name:string}>;
  updateProfile?(input:{name:string;about:string;picture?:{bytes:Uint8Array;mimeType:string}},beforeMutation?:()=>Promise<void>): Promise<void>;
  listGroups?(input:{offset:number;limit:number}):Promise<{groups:{id:string;name:string}[];hasMore:boolean}>;
  group?(id:string):Promise<ProviderGroup>;
  runtime?():Promise<{version:string;engine:string}>;
  health(): Promise<HealthSignal[]>;
  recentInbound?(input:{since:string;until:string;limit:number}):Promise<{messages:Record<string,unknown>[];truncated:boolean}>;
  lifecycle(action: 'start' | 'stop' | 'restart' | 'logout'): Promise<{ status: string }>;
  qr(): Promise<{ mimeType: string; data: string; expiresAt: string }>;
  media(reference: { providerId?: string; url?: string }): Promise<{ bytes: Uint8Array; mimeType: string }>;
}
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export class ProviderError extends Error {
  constructor(public readonly code: string, public readonly httpStatus?: number) { super(code); this.name = 'ProviderError'; }
}

export interface ProviderGroup {id:string;name:string;members:{identity:string;verifiedIdentity:string|null;admin:boolean;mappingSource:string}[];adminOnly:boolean;observedAt:string;runtime:{version:string;engine:string};complete:boolean}
