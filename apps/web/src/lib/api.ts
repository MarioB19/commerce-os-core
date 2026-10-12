import { useContext, useRef } from "react";
import { WorkspaceContext, useWorkspace } from "./workspace";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
export type Environment = "SIMULATION" | "REAL";
export interface Row {
  id: string;
  version?: number;
  environment?: Environment;
  name?: string;
  alias?: string;
  title?: string;
  slug?: string;
  description?: string;
  status?: string;
  stage?: string;
  provider?: string;
  model?: string;
  instructions?: string;
  knowledge?: string;
  type?: string;
  kind?: string;
  text?: string;
  content?: string;
  direction?: string;
  purpose?: string;
  reason?: string;
  source?: string;
  source_type?: string;
  evidence?: string;
  created_at?: string;
  updated_at?: string;
  occurred_at?: string;
  recorded_at?: string;
  expires_at?: string;
  valid_from?: string;
  valid_to?: string;
  scheduled_at?: string;
  role?: string;
  email?: string;
  account_id?: string;
  conversation_id?: string;
  contact_id?: string;
  product_id?: string;
  offer_version_id?: string;
  workflow_version_id?: string;
  agent_version_id?: string;
  assigned_to?: string;
  currency?: string;
  base_amount_minor?: number;
  amount_minor?: number;
  observed_amount_minor?: number;
  reconciled_amount_minor?: number;
  event_type?: string;
  entry_node_id?: string;
  max_cost_minor?: number;
  timeout_ms?: number;
  nodes?: FlowNode[];
  [key: string]: unknown;
}
export interface FlowNode {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next?: string;
  branches?: Record<string, string>;
}
export interface Session {
  user: { id: string; name: string; email: string };
  workspace_id: string;
  role: string;
  permissions: string[];
  environment: Environment;
}
export interface ApiResponse<T> {
  data: T;
  meta?: { total: number };
}
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
export async function api<T>(
  path: string,
  init?: RequestInit,
  preserveEnvelope = false,
): Promise<T> {
  const identityPath=path.startsWith('/api/')||/^\/v2\/me\/(profiles|profile-selection)$/.test(path);
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
export function useData<T = Row[]>(
  path: string,
  enabled = true,
  interval?: number,
) {
  const scope = useContext(WorkspaceContext);
  if (!scope && path !== "/me") throw new Error("Una consulta comercial requiere un workspace válido.");
  return useQuery({
    queryKey: [scope?.session.workspace_id ?? "identity", scope?.environment ?? "REAL", path],
    queryFn: ({ signal }) => api<T>(path, { signal }),
    enabled,
    refetchInterval: (query) => query.state.error ? false : (interval ?? false),
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (count, error) =>
      !(error instanceof ApiError && [400, 401, 403, 404, 409, 422, 429].includes(error.status)) &&
      count < 1,
  });
}
export function useAction(forcedEnvironment?: Environment) {
  const client = useQueryClient();
  const { environment: contextEnvironment, session } = useWorkspace();
  const environment = forcedEnvironment ?? contextEnvironment;
  if (environment !== contextEnvironment) throw new Error("El entorno de una acción debe coincidir con su contexto local.");
  // Keep the same key after a lost response; a changed payload starts a new intent.
  const attempts = useRef(new Map<string, string>());
  return useMutation({
    mutationKey: [session.workspace_id, environment, "action"],
    mutationFn: async ({ path, body, method = "POST" }: { path: string; body?: unknown; method?: string; invalidatePaths?: string[] }) => {
      const [base, query] = path.split("?");
      const search = new URLSearchParams(query);
      search.set("environment", environment);
      const payload = body && typeof body === "object" && !Array.isArray(body) ? { ...body, environment } : body;
      const requestBody = payload === undefined ? undefined : JSON.stringify(payload);
      const intent = JSON.stringify([environment, path, method, requestBody]);
      const key = attempts.current.get(intent) ?? crypto.randomUUID();
      attempts.current.set(intent, key);
      const result = await api<unknown>(`${base}?${search}`, { method, body: requestBody, headers: { "Idempotency-Key": key } });
      attempts.current.delete(intent);
      return result;
    },
    onSuccess: async (_data, variables) => {
      await client.invalidateQueries({ predicate: ({ queryKey }) =>
        queryKey.includes(session.workspace_id) && queryKey.includes(environment) &&
        (!variables.invalidatePaths || queryKey.some(value => typeof value === "string" && variables.invalidatePaths!.some(path => value.startsWith(path))))
      });
    },
    retry: false,
  });
}
export function params(
  environment: Environment,
  extras: Record<string, string | undefined> = {},
) {
  const query = new URLSearchParams({ environment });
  for (const [key, value] of Object.entries(extras))
    if (value) query.set(key, value);
  return `?${query}`;
}
export function str(value: unknown, fallback = "Sin datos"): string {
  return value == null || value === ""
    ? fallback
    : typeof value === "string"
      ? value
      : String(value);
}
export function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function useCollection(path: string, enabled = true, interval?: number) {
  const { session, environment } = useWorkspace();
  const query = useQuery({
    queryKey: [session.workspace_id, environment, "collection", path],
    queryFn: ({ signal }) => api<ApiResponse<Row[]>>(path, { signal }, true),
    enabled,
    refetchInterval: (query) => query.state.error ? false : (interval ?? false),
    refetchIntervalInBackground: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (count, error) =>
      !(error instanceof ApiError && [400, 401, 403, 404, 409, 422, 429].includes(error.status)) &&
      count < 1,
  });
  return {
    ...query,
    data: query.data?.data,
    total: query.data?.meta?.total ?? 0,
  };
}
