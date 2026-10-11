import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError, type Fetch } from './types.js';
export function verifyHmac(body: Uint8Array, secret: string, signature: string | undefined, algorithm: 'sha256' | 'sha512'): boolean {
  if (!secret || !signature) return false;
  const supplied = signature.replace(/^sha256=/, '');
  if (!new RegExp(`^[a-fA-F0-9]{${algorithm === 'sha256' ? 64 : 128}}$`).test(supplied)) return false;
  return timingSafeEqual(createHmac(algorithm, secret).update(body).digest(), Buffer.from(supplied, 'hex'));
}
export function eventDigest(body: Uint8Array | string): string { return createHash('sha256').update(body).digest('hex'); }
export function canonicalIdentity(value: string): string {
  if (/^(wa:|lid:|opaque:)/.test(value)) return value;
  if (value.endsWith('@lid')) return `lid:${value.slice(0, -4)}`;
  const match = value.match(/^\+?(\d{6,18})(?:@(?:c\.us|s\.whatsapp\.net))?$/);
  if (match) return `wa:${match[1]}`;
  return `opaque:${value}`; // No merging LID and phone without provider evidence.
}
export async function limitedBytes(response: Response, max = 16 * 1024 * 1024): Promise<Uint8Array> {
  if (!response.ok) throw new ProviderError('MEDIA_FETCH_FAILED', response.status);
  if (Number(response.headers.get('content-length') ?? '0') > max) throw new ProviderError('MEDIA_TOO_LARGE');
  const reader = response.body?.getReader(); if (!reader) throw new ProviderError('MEDIA_EMPTY');
  const chunks: Uint8Array[] = []; let length = 0;
  try { for (;;) { const item = await reader.read(); if (item.done) break; length += item.value.length; if (length > max) throw new ProviderError('MEDIA_TOO_LARGE'); chunks.push(item.value); } }
  finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
export function guardedUrl(value: string, origin: string): URL {
  const url = new URL(value, origin); if (url.origin !== new URL(origin).origin || url.username || url.password) throw new ProviderError('MEDIA_ORIGIN_DENIED'); return url;
}
export async function jsonRequest(fetcher: Fetch, url: string | URL, init: RequestInit, timeoutMs: number): Promise<Record<string, any>> {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new ProviderError(`PROVIDER_HTTP_${response.status}`, response.status);
  return response.status === 204 ? {} : await response.json() as Record<string, any>;
}
