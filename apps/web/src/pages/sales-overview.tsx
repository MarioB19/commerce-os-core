import { Link } from "@tanstack/react-router";
import { PageHeader, Panel, useWorkspace } from "../components/shared";
import { SectionState, StateBadge } from "../components/operational-state";
import { useData, params, type Row } from "../lib/api";

type WorkItem = {
  id: string;
  priority: number;
  state: string;
  title: string;
  reason: string;
  owner: string;
  at?: string;
  to: "/sales/inbox" | "/sales/orders" | "/sales/channels/whatsapp";
  search?: Record<string, string>;
};

const safeName = (value: unknown, fallback: string) => {
  const text = String(value ?? "").trim();
  return !text || /\d{7,}/.test(text) ? fallback : text;
};
const age = (value?: string) => {
  if (!value) return "Antigüedad no verificable";
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 0) return "Antigüedad no verificable";
  const hours = Math.floor(elapsed / 3_600_000);
  return hours < 1 ? "Hace menos de una hora" : hours < 24 ? `Hace ${hours} h` : `Hace ${Math.floor(hours / 24)} d`;
};

export function SalesOverview() {
  const { environment, session } = useWorkspace();
  const canOrders = ["owner", "operator", "reconciler", "seller"].includes(session.role);
  const canChannels = ["owner", "operator"].includes(session.role);
  const conv = useData<Row[]>(`/conversations${params(environment)}`);
  const receipts = useData<Row[]>(`/receipts${params(environment)}`, canOrders);
  const channels = useData<Row[]>(`/channel-accounts${params(environment)}`, canChannels);
  const work: WorkItem[] = [
    ...(conv.data ?? []).filter(item => item.status === "OPEN").map(item => ({
      id: `conversation:${item.id}`,
      priority: item.ai_status === "HUMAN_REVIEW" ? 0 : item.stage === "PAYMENT_REVIEW" ? 1 : 3,
      state: item.ai_status === "HUMAN_REVIEW" ? "REQUIRES_ATTENTION" : "IN_PROGRESS",
      title: safeName(item.contact_name ?? item.title, "Conversación protegida"),
      reason: item.ai_status === "HUMAN_REVIEW" ? "El vendedor solicitó revisión humana." : `Continuar etapa: ${safeName(item.stage, "conversación abierta")}.`,
      owner: safeName(item.assigned_to ?? item.owner_name, "Sin responsable"),
      at: String(item.updated_at ?? item.created_at ?? "") || undefined,
      to: "/sales/inbox" as const,
      search: { conversation: item.id },
    })),
    ...(canOrders ? (receipts.data ?? []).filter(item => !["APPROVED", "REJECTED"].includes(item.status ?? "")).map(item => ({
      id: `receipt:${item.id}`,
      priority: item.status === "HUMAN_REVIEW" ? 0 : 1,
      state: item.status === "HUMAN_REVIEW" ? "REQUIRES_ATTENTION" : "IN_PROGRESS",
      title: "Comprobante por revisar",
      reason: "Confirmar evidencia antes de reconocer ingreso o liberar materiales.",
      owner: safeName(item.assigned_to ?? item.reviewer_name, "Reconciliación"),
      at: String(item.updated_at ?? item.created_at ?? "") || undefined,
      to: "/sales/orders" as const,
      search: { order: String(item.order_id ?? "") },
    })) : []),
    ...(canChannels ? (channels.data ?? []).filter(item => item.status !== "WORKING").map(item => ({
      id: `channel:${item.id}`,
      priority: ["UNKNOWN", "FAILED", "DISCONNECTED"].includes(String(item.status)) ? 0 : 2,
      state: String(item.status) === "UNKNOWN" ? "UNKNOWN" : "REQUIRES_ATTENTION",
      title: safeName(item.alias ?? item.name, "Número protegido"),
      reason: "La conexión o su evidencia vigente requiere revisión.",
      owner: safeName(item.responsible, "Operaciones"),
      at: String(item.observed_at ?? item.updated_at ?? "") || undefined,
      to: "/sales/channels/whatsapp" as const,
    })) : []),
  ].sort((a, b) => a.priority - b.priority || Date.parse(a.at ?? "") - Date.parse(b.at ?? ""));
  const queries = [conv, ...(canOrders ? [receipts] : []), ...(canChannels ? [channels] : [])];
  const failures = queries.filter(query => query.error);
  return <>
    <PageHeader eyebrow="COMMERCE OS / VENTAS" title="Tu operación de ventas" description="Una cola priorizada para continuar conversaciones, revisar comprobantes y recuperar canales." />
    <section className="ux-anchor" aria-labelledby="sales-priority-title">
      <div className="ux-anchor-copy"><div className="ux-state-heading"><StateBadge value={failures.length ? "PARTIAL" : work.length ? "REQUIRES_ATTENTION" : "READY"}/><span>Prioridad operativa</span></div><h2 id="sales-priority-title">{work[0]?.title ?? "No hay tareas abiertas verificadas"}</h2><p>{work[0]?.reason ?? "Las fuentes consultadas no reportan conversaciones, comprobantes o canales pendientes."}</p><small>{work.length} {work.length === 1 ? "tarea pendiente" : "tareas pendientes"} · los teléfonos completos nunca se muestran.</small></div>
      {work[0]&&<Link className="button-link" to={work[0].to} search={work[0].search}>Atender ahora →</Link>}
    </section>
    <Panel title="Cola de trabajo" description="Ordenada por riesgo, revisión humana y antigüedad; cada fila explica por qué está aquí.">
      <SectionState pending={queries.some(query=>query.isLoading)} partial={failures.length>0} stale={failures.length>0} error={failures[0]?.error as Error|undefined} retry={()=>void Promise.all(queries.map(query=>query.refetch()))} empty={!work.length&&!queries.some(query=>query.isLoading)} emptyTitle="Sin tareas abiertas">
        <ol className="ux-work-queue" aria-label="Tareas de ventas priorizadas">{work.slice(0,20).map(item=><li key={item.id}><StateBadge value={item.state}/><div><strong>{item.title}</strong><p>{item.reason}</p><small>{item.owner} · {age(item.at)}</small></div><Link to={item.to} search={item.search}>Abrir →</Link></li>)}</ol>
      </SectionState>
    </Panel>
    <nav className="sales-quicklinks" aria-label="Herramientas secundarias de Ventas">
      <Link to="/sales/inbox">Conversaciones →</Link>
      {canOrders&&<Link to="/sales/orders">Pedidos y comprobantes →</Link>}
      <Link to="/sales/flows">Flujos →</Link><Link to="/sales/agents">Vendedores →</Link>
      {canChannels&&<Link to="/sales/channels/whatsapp">Números de WhatsApp →</Link>}
      <Link to="/sales/campaigns">Seguimientos y mensajes →</Link>
    </nav>
  </>;
}
