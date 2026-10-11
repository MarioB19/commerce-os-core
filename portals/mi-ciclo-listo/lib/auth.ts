import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

export const AUTH_COOKIE = "mcl_session";
const SESSION_SECONDS = 60 * 60 * 12;

export type AccessScope = "core" | "kit";
export type AccessSession = {
  scope: AccessScope;
  exp: number;
};

function configuredHashes(scope: AccessScope): string[] {
  const raw = scope === "kit" ? process.env.MCL_KIT_CODES_SHA256 : process.env.MCL_CORE_CODES_SHA256;
  return (raw ?? "")
    .split(",")
    .map((hash) => hash.trim().toLowerCase())
    .filter((hash) => /^[a-f0-9]{64}$/.test(hash));
}

function sessionSecret(): string | null {
  const value = process.env.MCL_SESSION_SECRET?.trim();
  if (!value || value.length < 32 || value === "secreto_aleatorio_largo_de_32_bytes_o_mas") return null;
  return value;
}

function equalText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authIsConfigured(): boolean {
  return Boolean(sessionSecret() && (configuredHashes("core").length || configuredHashes("kit").length));
}

export function validateAccessCode(value: unknown): AccessScope | null {
  if (typeof value !== "string" || value.length > 128 || !authIsConfigured()) return null;
  const normalized = value.normalize("NFKC").trim().toLocaleUpperCase("es-MX");
  if (!normalized) return null;
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");

  // El alcance kit incluye las tres herramientas; se comprueba primero.
  if (configuredHashes("kit").some((hash) => equalText(digest, hash))) return "kit";
  if (configuredHashes("core").some((hash) => equalText(digest, hash))) return "core";
  return null;
}

export function createSessionToken(scope: AccessScope): string {
  const secret = sessionSecret();
  if (!secret) throw new Error("Acceso no configurado.");
  const payload: AccessSession = { scope, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifySessionToken(token: string | undefined): AccessSession | null {
  const secret = sessionSecret();
  if (!secret || !token) return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest("base64url");
  if (!equalText(signature, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as AccessSession;
    if (!(["core", "kit"] as string[]).includes(payload.scope)) return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function getAccessSession(): Promise<AccessSession | null> {
  const store = await cookies();
  return verifySessionToken(store.get(AUTH_COOKIE)?.value);
}

export function canUse(scope: AccessScope, required: AccessScope): boolean {
  // Both code families are retained for backwards compatibility, but every
  // recognized buyer now receives the complete package. Amount and legacy
  // code family no longer create an access tier.
  return Boolean(scope && required);
}

export const authCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_SECONDS,
};
