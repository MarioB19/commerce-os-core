import {
  useState,
  useId,
  useRef,
  type ReactNode,
  type FormEvent,
} from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Inbox,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useMutationState, useQuery } from "@tanstack/react-query";
import { Button } from "./ui/button";
import { Modal } from "./ui/dialog";
import {
  ApiError,
  type Row,
  str,
  useAction,
  api,
  object,
  params,
} from "../lib/api";
import { useWorkspace } from "../lib/workspace";
export { WorkspaceContext, useWorkspace } from "../lib/workspace";
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
const labels: Record<string, string> = {
  DRAFT: "Borrador",
  ACTIVE: "Activo",
  PUBLISHED: "Publicado",
  CONNECTED: "Conectado",
  WORKING: "Conectado",
  STOPPED: "Desconectado",
  QUALIFYING: "Identificando interés",
  READY: "Listo",
  PAUSED: "En pausa",
  FROZEN: "Congelado",
  DISCONNECTED: "Desconectado",
  UNKNOWN: "Resultado incierto",
  SIMULATION: "Simulación",
  REAL: "Real",
  PENDING: "Pendiente",
  APPLIED: "Aplicado",
  FAILED: "Falló",
  CANCELLED: "Cancelado",
  RECONCILED: "Registro histórico",
  RECEIPT_APPROVED: "Documento aprobado",
  RECEIPT_SALE: "Venta por comprobante",
  OFFER_PRESENTED: "Oferta presentada",
  RECEIPT_RECEIVED: "Comprobante recibido",
  HUMAN_REVIEW: "Revisión humana",
  NEW: "Nuevo",
  COMMITTED: "Compromiso",
  SENT: "Enviado al proveedor",
  SENDING: "En curso",
  DELIVERED: "Entrega confirmada",
  READ: "Lectura confirmada",
  BLOCKED: "Bloqueado",
  APPROVED: "Aprobado",
  INELIGIBLE: "No elegible",
  PREVIEW: "Vista previa",
  SCHEDULED: "Programado",
  COMPLETED: "Completado",
  NEEDS_REVIEW: "Requiere revisión",
  OPTED_OUT: "Baja",
  FAILED_DEFINITE: "Fallo confirmado",
  REQUIRES_ATTENTION: "Requiere atención",
  IN_PROGRESS: "En proceso",
  UNAVAILABLE: "No disponible",
  NO_DATA: "Sin datos",
  HISTORICAL: "Histórico",
  STALE: "Información desactualizada",
  PARTIAL: "Información parcial",
  PRODUCT_SELECTION_REQUIRED: "Falta elegir producto",
  QR_NOT_READY: "QR aún no disponible",
  SCAN_QR_CODE: "Listo para escanear QR",
};
export function Status({ value }: { value?: unknown }) {
  const v = str(value, "UNKNOWN");
  return (
    <Badge
      tone={
        [
          "RECONCILED",
          "CONNECTED",
          "DELIVERED",
          "ACTIVE",
          "APPLIED",
          "APPROVED",
          "COMPLETED",
          "READ",
        ].includes(v)
          ? "success"
          : ["FAILED", "BLOCKED", "REJECTED", "FAILED_DEFINITE"].includes(v)
            ? "danger"
            : [
                  "UNKNOWN",
                  "PAUSED",
                  "FROZEN",
                  "HUMAN_REVIEW",
                  "RECEIPT_RECEIVED",
                  "PENDING",
                  "SENDING",
                  "REQUIRES_ATTENTION",
                  "STALE",
                  "PARTIAL",
                  "PRODUCT_SELECTION_REQUIRED",
                ].includes(v)
              ? "warning"
              : ["SIMULATION", "PUBLISHED", "READY", "IN_PROGRESS", "SCAN_QR_CODE"].includes(v)
                ? "info"
                : "neutral"
      }
    >
      {labels[v] ?? v.toLowerCase().replaceAll("_", " ")}
    </Badge>
  );
}
export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="page-actions">{action}</div>}
    </div>
  );
}
export function Panel({
  title,
  description,
  action,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title && (
        <div className="panel-heading">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}
export function Empty({
  title = "Todo comienza aquí",
  description = "Los registros aparecerán cuando se creen en este entorno.",
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Inbox size={26} />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <Loader2 className="animate-spin" size={20} /> Cargando datos de tu
      operación…
    </div>
  );
}
export function ErrorState({
  error,
  retry,
}: {
  error: Error;
  retry?: () => void;
}) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle size={22} />
      <div>
        <strong>
          {error instanceof ApiError && error.status === 403
            ? "No tienes permiso para ver este recurso"
            : "No pudimos cargar esta información"}
        </strong>
        <p>{error.message}</p>
        {retry && (
          <Button variant="secondary" size="sm" onClick={retry}>
            <RefreshCw />
            Reintentar
          </Button>
        )}
      </div>
    </div>
  );
}
export function Notice({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <div className={`notice notice-${tone}`}>
      <AlertCircle size={17} />
      <div>{children}</div>
    </div>
  );
}
export function Feedback({
  error,
  success,
}: {
  error?: Error | null;
  success?: string | false;
}) {
  return (
    <>
      {error && (
        <div className="inline-error" role="alert">
          <AlertCircle size={16} />
          <div><strong>{error.message}</strong>{error instanceof ApiError && error.diagnostic && <div className="diagnostic-detail">
            <p>{String(error.diagnostic.action ?? "Revisa la configuración y vuelve a intentarlo.")}</p>
            <p>Estado: {String(error.diagnostic.account_status ?? "No disponible")} · {error.diagnostic.retryable ? "Puedes reintentar" : "Requiere revisión"}</p>
            <small>Diagnóstico {String(error.diagnostic.diagnostic_id ?? "No disponible")} · {String(error.diagnostic.attempted_at ?? "No disponible")}</small>
          </div>}</div>
        </div>
      )}
      {success && (
        <div className="inline-success" role="status">
          <Check size={16} />
          {success}
        </div>
      )}
    </>
  );
}
export function QueryState({
  query,
  children,
}: {
  query: { isPending: boolean; error: Error | null; refetch: () => unknown; data?: unknown };
  children: ReactNode;
}) {
  const hasData = query.data !== undefined;
  if (query.isPending && !hasData) return <Loading />;
  if (query.error && !hasData)
    return (
      <ErrorState
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  return <>{query.error && <div className="query-stale" role="status"><AlertCircle size={17}/><div><strong>Mostrando la última lectura disponible</strong><p>{query.error.message}</p></div><Button variant="secondary" size="sm" onClick={() => { void query.refetch(); }}><RefreshCw/>Reintentar</Button></div>}{children}</>;
}
export interface Column {
  key: string;
  title: string;
  render?: (row: Row) => ReactNode;
}
export function DataTable({
  data,
  columns,
  onSelect,
  empty,
}: {
  data: Row[];
  columns: Column[];
  onSelect?: (row: Row) => void;
  empty?: string;
}) {
  if (!data.length) return <Empty title={empty ?? "Aún no hay registros"} />;
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={columns.map((c) => c.title).join(", ")}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col">{c.title}</th>
            ))}
            {onSelect && (
              <th>
                <span className="sr-only">Abrir</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr key={row.id}>
              {columns.map((c) => (
                <td key={c.key}>
                  {c.render ? c.render(row) : str(row[c.key])}
                </td>
              ))}
              {onSelect && (
                <td>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => onSelect(row)}
                    aria-label={`Abrir ${row.name ?? row.alias ?? row.id}`}
                  >
                    <ArrowRight size={16} />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
export interface Field {
  name: string;
  label: string;
  type?:
    | "text"
    | "number"
    | "textarea"
    | "select"
    | "json"
    | "datetime-local" | "date"
    | "email"
    | "password"
    | "fulfillment"
    | "checkbox";
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  default?: unknown;
  step?: number | "any";
  min?: number;
  max?: number;
  advanced?: boolean;
  when?: (values: Record<string, string>) => boolean;
}
export function validateFields(fields: Field[], values: Record<string, string>) {
  const errors: Record<string, string> = {};
  for (const f of fields.filter((field) => !field.when || field.when(values))) {
    const value = values[f.name]?.trim() ?? "";
    if (f.required && !value) errors[f.name] = `Completa ${f.label.toLowerCase()}.`;
    else if (value && f.type === "number" && (!Number.isFinite(Number(value)) || (f.min !== undefined && Number(value) < f.min) || (f.max !== undefined && Number(value) > f.max))) errors[f.name] = `Usa un número${f.min !== undefined ? ` igual o mayor que ${f.min}` : " válido"}${f.max !== undefined ? ` y menor o igual que ${f.max}` : ""}.`;
    else if (value && f.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) errors[f.name] = "Escribe un correo válido, como nombre@equipo.com.";
    else if (value && f.type === "json") { try { JSON.parse(value); } catch { errors[f.name] = "Revisa el formato JSON: comillas, llaves y comas."; } }
    else if (value && f.type === "fulfillment") {
      try {
        const items = JSON.parse(value) as FulfillmentItem[];
        if (!Array.isArray(items) || items.length > 30 || items.some((item) => !item.asset_id || !f.options?.some((option) => option.value === item.asset_id) || !releaseConditions.some(([key]) => key === item.release_on) || (item.min_amount_minor !== undefined && (!Number.isSafeInteger(item.min_amount_minor) || item.min_amount_minor < 0)))) errors[f.name] = "Revisa cada entrega: selecciona un material disponible, una condición y un importe mínimo válido.";
        else if (new Set(items.map((item) => `${item.asset_id}:${item.release_on}`)).size !== items.length) errors[f.name] = "El mismo material y condición no pueden repetirse.";
      } catch { errors[f.name] = "No se pudieron leer las entregas. Agrega de nuevo las filas."; }
    }
  }
  return errors;
}
export function Fields({ fields, values, setValues, errors = {}, prefix: suppliedPrefix }: {
  fields: Field[]; values: Record<string, string>; setValues: (value: Record<string, string>) => void;
  errors?: Record<string, string>; prefix?: string;
}) {
  const ownPrefix = useId();
  const prefix = suppliedPrefix ?? ownPrefix;
  const visible = fields.filter((f) => !f.when || f.when(values));
  const isAdvanced = (f: Field) => f.advanced ?? (!f.required && !["name", "description", "alias", "purpose"].includes(f.name));
  function group(list: Field[]) {
    return <div className="form-grid">{list.map((f) => {
      const id = `${prefix}-${f.name}`;
      const common = {
        id, name: f.name, "aria-label": f.label, required: f.required,
        "aria-invalid": errors[f.name] ? true as const : undefined,
        "aria-describedby": [f.hint ? `${id}-hint` : "", errors[f.name] ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined,
      };
      const change = (value: string) => setValues({ ...values, [f.name]: value });
      if (f.type === "fulfillment") return <div className="field field-wide" key={f.name}><FulfillmentEditor id={id} label={f.label} value={values[f.name] ?? "[]"} onChange={change} options={f.options ?? []} error={errors[f.name]} />{f.hint && <small>{f.hint}</small>}</div>;
      return <div className={`field ${f.type === "textarea" || f.type === "json" ? "field-wide" : ""}`} key={f.name}>
        <label htmlFor={id}>{f.label}{f.required ? <i aria-hidden="true"> *</i> : <span className="optional-label"> · opcional</span>}</label>
        {f.type === "select" ? <select {...common} value={values[f.name] ?? ""} onChange={(e) => change(e.target.value)}>
          <option value="">Selecciona…</option>{f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select> : f.type === "textarea" || f.type === "json" ? <textarea {...common} rows={f.type === "json" ? 5 : 3} placeholder={f.placeholder} value={values[f.name] ?? ""} onChange={(e) => change(e.target.value)} className={f.type === "json" ? "code-input" : ""} /> :
          f.type === "checkbox" ? <input {...common} type="checkbox" checked={values[f.name] === "true"} onChange={(e) => change(String(e.target.checked))} /> :
          <input {...common} type={f.type ?? "text"} min={f.min} max={f.max} step={f.step} placeholder={f.placeholder} value={values[f.name] ?? ""} onChange={(e) => change(e.target.value)} autoComplete={f.type === "password" ? "new-password" : f.type === "email" ? "email" : "off"} />}
        {f.hint && <small id={`${id}-hint`}>{f.hint}</small>}
        {errors[f.name] && <span id={`${id}-error`} className="field-error">{errors[f.name]}</span>}
      </div>;
    })}</div>;
  }
  const advanced = visible.filter(isAdvanced);
  return <>
    {group(visible.filter((f) => !isAdvanced(f)))}
    {!!advanced.length && <details className="advanced-fields" open={advanced.some((f) => errors[f.name]) ? true : undefined}>
      <summary>Opciones adicionales ({advanced.length})</summary>{group(advanced)}
    </details>}
  </>;
}
export function parsedValues(fields: Field[], values: Record<string, string>) {
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.when && !f.when(values)) continue;
    const value = values[f.name];
    if (value === "" || value === undefined) continue;
    result[f.name] =
      f.type === "checkbox"
        ? value === "true"
        : f.type === "number"
          ? Number(value)
          : f.type === "json" || f.type === "fulfillment"
            ? JSON.parse(value)
            : f.type === "datetime-local"
              ? new Date(value).toISOString()
              : value;
  }
  return result;
}
interface FulfillmentItem { asset_id: string; release_on: string; min_amount_minor?: number }
const releaseConditions = [["commitment_accepted", "Al aceptar el compromiso de pago"], ["receipt_approved", "Al aprobar el comprobante"], ["reconciled", "Al conciliar el pago"]] as const;
function FulfillmentEditor({ id, label, value, onChange, options, error }: { id: string; label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; error?: string }) {
  let items: FulfillmentItem[] = [];
  try { const decoded: unknown = JSON.parse(value); if (Array.isArray(decoded)) items = decoded; } catch { /* Validation reports malformed historical values. */ }
  const update = (index: number, changes: Partial<FulfillmentItem>) => onChange(JSON.stringify(items.map((item, position) => position === index ? { ...item, ...changes } : item)));
  return <fieldset id={id} aria-describedby={error ? `${id}-error` : undefined} aria-invalid={error ? true : undefined}>
    <legend>{label}</legend>
    {!items.length && <p className="panel-copy">Agrega los materiales y el momento de entrega. Puedes guardar una oferta en borrador antes de completarlos.</p>}
    {items.map((item, index) => <fieldset key={index}>
      <legend>Entrega {index + 1}</legend>
      <div className="form-grid">
        <label className="field" htmlFor={`${id}-${index}-asset`}><span>Material de la entrega {index + 1}</span><select id={`${id}-${index}-asset`} required value={item.asset_id} onChange={(event) => update(index, { asset_id: event.target.value })}><option value="">Selecciona un material disponible</option>{options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className="field" htmlFor={`${id}-${index}-condition`}><span>Cuándo liberar la entrega {index + 1}</span><select id={`${id}-${index}-condition`} value={item.release_on} onChange={(event) => update(index, { release_on: event.target.value })}>{releaseConditions.map(([key, title]) => <option key={key} value={key}>{title}</option>)}</select></label>
        <label className="field" htmlFor={`${id}-${index}-amount`}><span>Importe mínimo para entrega {index + 1}</span><input aria-label={`Importe mínimo para entrega ${index + 1}`} id={`${id}-${index}-amount`} type="number" min={0} step={0.01} value={item.min_amount_minor === undefined ? "" : item.min_amount_minor / 100} onChange={(event) => update(index, { min_amount_minor: event.target.value === "" ? undefined : Math.round(Number(event.target.value) * 100) })} /><small>Opcional. Usa el importe en la moneda de la oferta, por ejemplo 97.00.</small></label>
      </div>
      <Button type="button" variant="secondary" size="sm" onClick={() => onChange(JSON.stringify(items.filter((_, position) => position !== index)))}>Quitar entrega {index + 1}</Button>
    </fieldset>)}
    {error && <span id={`${id}-error`} className="field-error">{error}</span>}
    <Button type="button" variant="secondary" disabled={items.length >= 30} onClick={() => onChange(JSON.stringify([...items, { asset_id: "", release_on: "commitment_accepted" }]))}>Agregar entrega</Button>
  </fieldset>;
}
export function initialValues(
  fields: Field[],
  initial?: Record<string, unknown>,
) {
  return Object.fromEntries(
    fields.map((f) => {
      const value = initial?.[f.name] ?? f.default ?? "";
      return [
        f.name,
        typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value),
      ];
    }),
  );
}
export function ResourceForm({
  title,
  description,
  fields,
  path,
  trigger = "Crear",
  method = "POST",
  initial,
  transform,
  onSaved,
}: {
  title: string;
  description?: string;
  fields: Field[];
  path: string;
  trigger?: string;
  method?: string;
  initial?: Record<string, unknown>;
  transform?: (data: Record<string, unknown>) => unknown;
  onSaved?: (data: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const prefix = useId();
  const busy = useRef(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [values, setValues] = useState(() => initialValues(fields, initial));
  const [localError, setLocalError] = useState<Error | null>(null);
  const mutation = useAction();
  const { environment, session } = useWorkspace();
  const roles =
    path.startsWith("/receipts/") || /^\/orders\/[^/]+\/(classification|attribution)$/.test(path)
      ? ["owner", "operator", "reconciler"]
      : /reconcile$/.test(path) ? ["owner", "reconciler"]
      : path.startsWith("/outbox/") && /(?:approve|resolve)$/.test(path)
        ? ["owner"]
        : path.startsWith("/conversations/") || path.startsWith("/outbox/")
          ? ["owner", "operator", "seller"]
          : /^(\/users|\/service-tokens|\/operation-authorizations|\/bank-profiles|\/receipt-policies)/.test(
                path,
              )
            ? ["owner"]
            : ["owner", "operator"];
  const allowed = roles.includes(session.role);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy.current) return;
    setLocalError(null);
    const invalid = validateFields(fields, values);
    setErrors(invalid);
    if (Object.keys(invalid).length) { requestAnimationFrame(() => document.getElementById(`${prefix}-errors`)?.focus()); return; }
    busy.current = true;
    try {
      let body: unknown = {
        ...parsedValues(fields, values),
        environment,
        ...(method === "PATCH" ? { expected_version: initial?.version } : {}),
      };
      if (transform) body = transform(body as Record<string, unknown>);
      const data = await mutation.mutateAsync({ path, body, method });
      onSaved?.(data);
      setOpen(false);
      setValues(initialValues(fields));
    } catch (error) {
      if (error instanceof ApiError) {
        const fieldErrors = Object.fromEntries(error.details.map((issue) => [Array.isArray(issue.path) ? issue.path[0] : issue.path?.split(".")[0], issue.message ?? "Revisa este valor."]).filter(([name]) => fields.some((f) => f.name === name)));
        setErrors(fieldErrors);
      }
      setLocalError(
        error instanceof Error ? error : new Error("No se pudo guardar."),
      );
    } finally { busy.current = false; }
  }
  if (!allowed) return null;
  return (
    <>
      <Button
        variant={method === "PATCH" ? "secondary" : "default"}
        onClick={() => {
          setOpen(true);
          mutation.reset();
          setLocalError(null);
        }}
      >
        {method === "POST" && <Plus />}
        {trigger}
      </Button>
      <Modal
        title={title}
        description={description}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Keep the draft while this page remains open.
        }}
      >
        <form noValidate aria-busy={mutation.isPending}
          onSubmit={(e) => {
            void submit(e);
          }}
        >
          <p className="form-guidance">* Obligatorio. Puedes cerrar y retomar este borrador mientras permanezcas en esta página.</p>
          {!!Object.keys(errors).length && <div id={`${prefix}-errors`} className="form-errors" role="alert" tabIndex={-1}>
            <strong>Revisa los siguientes campos</strong><ul>{Object.entries(errors).map(([name, message]) => <li key={name}><a href={`#${prefix}-${name}`} onClick={() => { document.getElementById(`${prefix}-${name}`)?.closest("details")?.setAttribute("open", ""); document.getElementById(`${prefix}-${name}`)?.focus(); }}>{message}</a></li>)}</ul>
          </div>}
          <Fields fields={fields} values={values} setValues={(next) => { setValues(next); if (Object.keys(errors).length) setErrors(validateFields(fields, next)); }} errors={errors} prefix={prefix} />
          <Feedback error={localError} />
          <div className="form-footer">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setOpen(false);
                // Draft retained until a successful save.
              }}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Check />
              )}
              Guardar
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
export function JsonDetail({
  value,
  title = "Detalle y evidencia",
}: {
  value: unknown;
  title?: string;
}) {
  return (
    <details className="json-detail">
      <summary>{title}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
export function RouteLink({
  to,
  children,
}: {
  to: string;
  children: ReactNode;
}) {
  return (
    <Link to={to} className="text-link">
      {children}
      <ArrowRight size={14} />
    </Link>
  );
}
export function DetailDrawer({
  row,
  title,
  onClose,
  children,
}: {
  row: Row | null;
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      title={title}
      open={!!row}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {children}
      <JsonDetail value={row} />
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          <X />
          Cerrar
        </Button>
      </div>
    </Modal>
  );
}

export function CommandMonitor() {
  const { session, environment } = useWorkspace();
  const results = useMutationState({
    filters: { status: "success", mutationKey: [session.workspace_id, environment, "action"] },
    select: (m) => m.state.data,
  });
  const candidate = [...results]
    .reverse()
    .map(object)
    .find(
      (r) => r.command_id || (r.status === "PENDING" && r.kind && r.payload),
    );
  const commandId = String(candidate?.command_id ?? candidate?.id ?? "");
  const [dismissed, setDismissed] = useState("");
  const command = useQuery({
    queryKey: [session.workspace_id, environment, `/commands/${commandId}${params(environment)}`],
    queryFn: ({ signal }) => api<Row>(`/commands/${commandId}${params(environment)}`, { signal }),
    enabled:
      !!commandId && ["owner", "operator", "reconciler"].includes(session.role),
    refetchInterval: (query) =>
      !query.state.error && query.state.data?.status === "PENDING" ? 1000 : false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  if (dismissed === commandId) return null;
  if (command.error) return <ErrorState error={command.error} retry={() => { void command.refetch(); }} />;
  if (!command.data) return null;
  const state = command.data.status;
  const result = object(command.data.result);
  const diagnostic = object(result.diagnostic);
  return (
    <div
      className={`command-notice ${state === "FAILED" ? "failed" : ""}`}
      role={state === "FAILED" ? "alert" : "status"}
    >
      <span>
        {state === "PENDING" ? (
          <Loader2 className="animate-spin" size={16} />
        ) : state === "FAILED" ? (
          <AlertCircle size={16} />
        ) : (
          <Check size={16} />
        )}
      </span>
      <div>
        <strong>
          {state === "PENDING"
            ? "Acción guardada; procesando…"
            : state === "FAILED"
              ? "La acción no se pudo aplicar"
              : "Acción aplicada"}
        </strong>
        <small>
          {state === "FAILED"
            ? str(
                result.message,
                "Revisa el recurso y vuelve a intentarlo.",
              )
            : "El estado y la evidencia se actualizaron desde el servidor."}
        </small>
        {state === "FAILED" && typeof diagnostic.action === "string" && <small>{diagnostic.action}</small>}
        {environment === "REAL" && state === "FAILED" && result.error === "QR_OPERATION_NOT_AUTHORIZED" && <Link to="/settings">Abrir configuración de operación</Link>}
        {state === "FAILED" && typeof result.error === "string" && <small>Referencia: {result.error}</small>}
      </div>
      <button
        className="icon-button"
        aria-label="Cerrar estado de acción"
        onClick={() => setDismissed(commandId)}
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function Pagination({
  offset,
  limit = 50,
  total,
  count,
  onChange,
}: {
  offset: number;
  limit?: number;
  total: number;
  count: number;
  onChange: (offset: number) => void;
}) {
  return (
    <nav className="pagination" aria-label="Paginación">
      <Button
        variant="ghost"
        size="sm"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - limit))}
      >
        ← Anterior
      </Button>
      <span>
        {Math.min(offset + 1, total)}–{offset + count} / {total}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={offset + limit >= total}
        onClick={() => onChange(offset + limit)}
      >
        Siguiente →
      </Button>
    </nav>
  );
}

export function ConfirmAction({ label, title, description, onConfirm, disabled = false }: {
  label: string; title: string; description: string; onConfirm: () => Promise<unknown>; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  return <>
    <Button variant="secondary" disabled={disabled} onClick={() => { setOpen(true); setError(null); }}>{label}</Button>
    <Modal title={title} description={description} open={open} onOpenChange={(value) => { if (!pending) setOpen(value); }}>
      <Feedback error={error} />
      <div className="form-footer"><Button variant="secondary" disabled={pending} onClick={() => setOpen(false)}>Cancelar</Button>
        <Button variant="destructive" disabled={pending} onClick={() => {
          if (pending) return;
          setPending(true);
          void onConfirm().then(() => setOpen(false)).catch((reason: unknown) => setError(reason instanceof Error ? reason : new Error("No se pudo completar la operación."))).finally(() => setPending(false));
        }}>{pending ? "Procesando…" : `Confirmar ${label.toLowerCase()}`}</Button>
      </div>
    </Modal>
  </>;
}
