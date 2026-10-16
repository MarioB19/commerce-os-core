/** V7 browser API client: one bounded request helper with the profile fence.
 * Legacy React data hooks were retired with the previous application (F8). */
export class ApiError extends Error {
  status: number;
  code: string;
  details: { path?: string | (string | number)[]; message?: string }[];
  diagnostic?: Record<string, unknown>;
  constructor(message: string, status: number, code: string, details: ApiError["details"] = [], diagnostic?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.diagnostic = diagnostic;
  }
}
/** Server-confirmed profile selection (V7). Every business request carries
 * it as a CAS fence; the server re-checks it and never treats it as authority.
 * Identity routes never send it. Cleared on sign-out or a new identity. */
let profileFence: { workspaceId: string; version: number } | null = null;
export function setProfileFence(fence: { workspaceId: string; version: number } | null) {
  profileFence = fence && typeof fence.workspaceId === "string" && fence.workspaceId.length > 0 && Number.isSafeInteger(fence.version) && fence.version > 0
    ? { workspaceId: fence.workspaceId, version: fence.version } : null;
}
export const currentProfileFence = () => profileFence;
export async function api<T>(
  path: string,
  init?: RequestInit,
  preserveEnvelope = false,
): Promise<T> {
  // Identity and platform-administration routes are outside every profile:
  // they never carry the profile fence, the /v1 prefix or an environment.
  const identityPath=path.startsWith('/api/')||/^\/v2\/(me\/(profiles|profile-selection)|platform\/[a-z0-9/_.%-]+)$/i.test(path);
  // The standalone official client defaults explicitly to REAL; lab callers always
  // provide their SIMULATION query. Identity routes are outside business context.
  if (!identityPath) {
    const [base, query] = path.split("?");
    const search = new URLSearchParams(query);
    if (!search.has("environment")) search.set("environment", "REAL");
    path = `${base}?${search}`;
  }
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(init?.signal?.reason);
  if (init?.signal?.aborted) onAbort();
  else init?.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 15_000);
  const timeoutError = () => {
    const write = Boolean(init?.method && init.method !== "GET");
    return new ApiError(
      write
        ? "La operación tardó demasiado y su resultado no es concluyente. Revisa el estado antes de intentar de nuevo."
        : "La consulta tardó demasiado. Conservamos la última lectura disponible; pulsa Reintentar.",
      0,
      "REQUEST_TIMEOUT",
    );
  };
  try {
    const response = await fetch(identityPath ? path : `/v1${path}`, {
      ...init,
      signal: controller.signal,
      credentials: "include",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.method && init.method !== "GET"
          ? { "Idempotency-Key": crypto.randomUUID() }
          : {}),
        ...(!identityPath && profileFence
          ? { "X-Commerce-Profile-Id": profileFence.workspaceId, "X-Commerce-Profile-Version": String(profileFence.version) }
          : {}),
        ...init?.headers,
      },
    });
    if (response.status === 429) {
      const seconds = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 ? ` ${Math.ceil(seconds)} segundos` : " un momento";
      throw new ApiError(`Hay demasiadas solicitudes. Espera${delay} y pulsa Reintentar. Conservamos tus datos.`, 429, "RATE_LIMITED");
    }
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (timedOut) throw timeoutError();
      if (init?.signal?.aborted) throw error;
      throw new ApiError("El servidor devolvió una respuesta incompleta. Reintenta la misma operación.", response.status, "INVALID_RESPONSE");
    }
    if (!body || typeof body !== "object") throw new ApiError("La respuesta del servidor no tiene el formato esperado.", response.status, "INVALID_RESPONSE");
    if (!response.ok) {
      throw new ApiError(
        body.error?.message ?? body.message ?? `No se pudo completar la solicitud (${response.status}).`,
        response.status,
        body.error?.code ?? "REQUEST_FAILED",
        Array.isArray(body.error?.details) ? body.error.details : [],
        body.error?.diagnostic,
      );
    }
    return (preserveEnvelope ? body : "data" in body ? body.data : body) as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw timeoutError();
    if (init?.signal?.aborted) throw error;
    throw new ApiError("No pudimos conectar con el servidor. Conservamos tus datos; comprueba la conexión y reintenta.", 0, "NETWORK_ERROR");
  } finally {
    globalThis.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", onAbort);
  }
}
