import type { ReactNode } from "react";
import { AlertCircle, ChevronRight, Clock3, Database, History, Loader2, ShieldCheck } from "lucide-react";
import { Badge } from "./shared";

export type OperationalStateCode =
  | "READY"
  | "REQUIRES_ATTENTION"
  | "BLOCKED"
  | "IN_PROGRESS"
  | "UNKNOWN"
  | "UNAVAILABLE"
  | "NO_DATA"
  | "HISTORICAL"
  | "PARTIAL"
  | "STALE";

const copy: Record<OperationalStateCode, { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" }> = {
  READY: { label: "Listo", tone: "success" },
  REQUIRES_ATTENTION: { label: "Requiere atención", tone: "warning" },
  BLOCKED: { label: "Bloqueado", tone: "danger" },
  IN_PROGRESS: { label: "En proceso", tone: "info" },
  UNKNOWN: { label: "Resultado incierto", tone: "warning" },
  UNAVAILABLE: { label: "No disponible", tone: "neutral" },
  NO_DATA: { label: "Sin datos", tone: "neutral" },
  HISTORICAL: { label: "Histórico", tone: "neutral" },
  PARTIAL: { label: "Información parcial", tone: "warning" },
  STALE: { label: "Información desactualizada", tone: "warning" },
};

const aliases: Record<string, OperationalStateCode> = {
  OK: "READY",
  ACTIVE: "READY",
  WORKING: "READY",
  CONNECTED: "READY",
  COMPLETED: "READY",
  VERIFIED: "READY",
  PUBLISHED: "READY",
  DRAFT: "IN_PROGRESS",
  ARCHIVED: "HISTORICAL",
  UNCERTAIN: "UNKNOWN",
  ATTENTION: "REQUIRES_ATTENTION",
  NEEDS_REVIEW: "REQUIRES_ATTENTION",
  HUMAN_REVIEW: "REQUIRES_ATTENTION",
  PENDING: "IN_PROGRESS",
  RUNNING: "IN_PROGRESS",
  STARTING: "IN_PROGRESS",
  FAILED: "BLOCKED",
  ERROR: "BLOCKED",
  OFFLINE: "UNAVAILABLE",
};

export function operationalState(value: unknown): OperationalStateCode {
  const raw = String(value ?? "UNKNOWN").toUpperCase();
  if (raw in copy) return raw as OperationalStateCode;
  return aliases[raw] ?? "UNKNOWN";
}

export function StateBadge({ value }: { value: unknown }) {
  const state = operationalState(value);
  return <Badge tone={copy[state].tone}>{copy[state].label}</Badge>;
}

export interface StateEvidence {
  state?: unknown;
  cause?: string | null;
  source?: string | null;
  observed_at?: string | null;
  expires_at?: string | null;
  next_action?: string | null;
  evidence?: ReactNode;
}

export function StateSummary({ value, compact = false }: { value: StateEvidence; compact?: boolean }) {
  const state = operationalState(value.state);
  const observed = readableDate(value.observed_at);
  return <div className={`ux-state-summary ux-state-${state.toLowerCase().replaceAll("_", "-")} ${compact ? "ux-state-compact" : ""}`}>
    <div className="ux-state-heading"><StateIcon state={state} /><StateBadge value={state} /></div>
    {value.cause && <p>{value.cause}</p>}
    {(value.source || observed) && <p className="ux-state-meta"><Database size={14} />{value.source || "Fuente no indicada"}{observed && <> · Actualizado {observed}</>}</p>}
    {value.next_action && <p className="ux-state-action"><ChevronRight size={15} />{value.next_action}</p>}
    {value.evidence && <details><summary>Evidencia técnica</summary>{value.evidence}</details>}
  </div>;
}

export function SectionState({
  pending,
  error,
  stale,
  partial,
  empty,
  emptyTitle = "Sin datos para mostrar",
  retry,
  children,
}: {
  pending?: boolean;
  error?: Error | null;
  stale?: boolean;
  partial?: boolean;
  empty?: boolean;
  emptyTitle?: string;
  retry?: () => void;
  children: ReactNode;
}) {
  if (pending && !stale) return <LocalSkeleton />;
  if (error && !stale) return <div className="ux-section-state" role="alert"><AlertCircle /><div><strong>No pudimos consultar esta sección</strong><p>{error.message}</p>{retry && <button type="button" onClick={retry}>Reintentar</button>}</div></div>;
  if (empty) return <div className="ux-section-state"><Database /><div><strong>{emptyTitle}</strong><p>La fuente respondió sin registros para este contexto.</p></div></div>;
  return <div className="ux-section-content">
    {(stale || partial) && <div className="ux-inline-state" role="status"><Clock3 size={15} /><span>{stale ? "Mostrando la última lectura disponible." : "La lectura está disponible con cobertura parcial."}</span>{retry && <button type="button" onClick={retry}>Actualizar</button>}</div>}
    {children}
  </div>;
}

export function LocalSkeleton({ rows = 3 }: { rows?: number }) {
  return <div className="ux-skeleton" role="status" aria-label="Cargando esta sección">
    <span className="sr-only">Cargando esta sección…</span>
    {Array.from({ length: rows }, (_, index) => <i key={index} />)}
  </div>;
}

function StateIcon({ state }: { state: OperationalStateCode }) {
  if (state === "READY") return <ShieldCheck size={17} />;
  if (state === "IN_PROGRESS") return <Loader2 className="animate-spin" size={17} />;
  if (state === "HISTORICAL") return <History size={17} />;
  if (["REQUIRES_ATTENTION", "BLOCKED", "UNKNOWN", "PARTIAL", "STALE"].includes(state)) return <AlertCircle size={17} />;
  return <Database size={17} />;
}

function readableDate(value?: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString("es-MX", { dateStyle: "medium", timeStyle: "short" });
}
