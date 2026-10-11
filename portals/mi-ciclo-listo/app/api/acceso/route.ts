import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authCookieOptions, authIsConfigured, createSessionToken, validateAccessCode } from "@/lib/auth";

import {accessAttempts} from '@/lib/access-attempts';

function clientKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconocido";
}

function requestIsSameOrigin(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    const protocol = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
    return Boolean(host && url.host === host && url.protocol === `${protocol}:`);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!requestIsSameOrigin(request)) {
    return NextResponse.json({ error: "Origen no permitido." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (!authIsConfigured()) {
    return NextResponse.json(
      { error: "El acceso todavía no está configurado. Contacta a soporte." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
  }
  const code = typeof body === "object" && body !== null && "code" in body ? (body as { code: unknown }).code : null;
  const scope = validateAccessCode(code);
  let permitted:boolean;
  try { permitted=accessAttempts().record(clientKey(request),Boolean(scope)); }
  catch { return NextResponse.json({error:"El acceso no está disponible temporalmente."},{status:503,headers:{"Cache-Control":"no-store"}}); }
  if(!permitted)return NextResponse.json({error:"Demasiados intentos. Espera 15 minutos o solicita apoyo."},{status:429,headers:{"Cache-Control":"no-store","Retry-After":"900"}});
  if (!scope) {
    return NextResponse.json(
      { error: "No reconocimos ese código. Revisa mayúsculas y espacios." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = NextResponse.json({ ok: true, scope }, { headers: { "Cache-Control": "no-store" } });
  response.cookies.set(AUTH_COOKIE, createSessionToken(scope), authCookieOptions);
  return response;
}
