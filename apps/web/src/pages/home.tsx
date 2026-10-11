import {
  ArrowDownRight,
  ArrowUpRight,
  ChartNoAxesCombined,
  CircleCheck,
  FlaskConical,
  Layers3,
  MessageSquare,
  Package,
  Sparkles,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Badge,
  DataTable,
  Empty,
  Notice,
  PageHeader,
  Panel,
  QueryState,
  RouteLink,
  Status,
  useWorkspace,
} from "../components/shared";
import { SectionState, StateBadge, StateSummary } from "../components/operational-state";
import { object, params, rows, useData } from "../lib/api";
import { date, money } from "../lib/utils";
const cycle = [
  {
    name: "Inteligencia",
    caption: "Encuentra la oportunidad",
    icon: Sparkles,
    to: "/intelligence",
    experimental: true,
  },
  {
    name: "Productos y ofertas",
    caption: "Define lo que vendes",
    icon: Package,
    to: "/catalog",
  },
  {
    name: "Campañas",
    caption: "Conecta con tu audiencia",
    icon: TrendingUp,
    to: "/campaigns",
  },
  {
    name: "Ventas",
    caption: "Convierte con contexto",
    icon: MessageSquare,
    to: "/sales/inbox",
  },
  {
    name: "Resultados",
    caption: "Aprende de lo ocurrido",
    icon: ChartNoAxesCombined,
    to: "/results",
  },
];
export function HomePage({ sales = false }: { sales?: boolean }) {
  const { environment, session } = useWorkspace();
  const canReports = session.permissions.includes("*") || session.permissions.includes("read") || session.permissions.includes("reports:read");
  const canSales = session.permissions.includes("*") || session.permissions.includes("read") || session.permissions.includes("sales:read") || session.permissions.includes("sales:assigned");
  const canManage = ["owner", "operator"].includes(session.role);
  const canReview = ["owner", "reconciler"].includes(session.role);
  const summary = useData<Record<string, unknown>>(
    `/reports/summary${params(environment)}`,
    canReports,
    5000,
  );
  const operations = useData<Record<string, unknown>>(
    `/home/operations-summary${params(environment)}`,
    canReports,
    15_000,
  );
  const contacts = useData(`/contacts${params(environment, { limit: "200" })}`, canSales);
  const conv = useData(`/conversations${params(environment, { limit: "5" })}`, canSales);
  const incidents = useData(`/incidents${params(environment)}`, canManage);
  const pendingReceipts = useData(`/receipts${params(environment)}`, canReview);
  const data = summary.data ?? {};
  const counts = object(data.counts);
  const count = (...keys: string[]) => {
    for (const key of keys)
      if (data[key] !== undefined || counts[key] !== undefined)
        return Number(data[key] ?? counts[key]);
    return undefined;
  };
  const fallbackCards = [
    {
      name: "Conversaciones",
      value: count("conversations", "conversation_count"),
      icon: MessageSquare,
      foot: "Entradas en este entorno",
    },
    {
      name: "Pedidos",
      value: count("orders", "order_count"),
      icon: Package,
      foot: "Oferta y versión fijadas",
    },
    {
      name: "Por revisar",
      value: pendingReceipts.data?.filter((r) =>
        [
          "HUMAN_REVIEW",
          "PENDING",
          "RECEIPT_RECEIVED",
          "NEEDS_CLEARER_IMAGE",
        ].includes(r.status ?? ""),
      ).length,
      icon: Wallet,
      foot: "Revisión documental pendiente",
    },
    {
      name: "Ventas válidas",
      value: count("reconciled", "reconciled_orders", "reconciled_count"),
      icon: CircleCheck,
      foot: "Confirmación financiera humana",
    },
  ];
  const operationSections = Array.isArray(operations.data?.sections)
    ? operations.data.sections as Record<string, unknown>[]
    : [];
  const aggregatePriority = object(operations.data?.priority);
  const pendingReceiptCount = pendingReceipts.data?.filter((r) =>
    ["HUMAN_REVIEW", "PENDING", "RECEIPT_RECEIVED", "NEEDS_CLEARER_IMAGE"].includes(r.status ?? ""),
  ).length;
  const openConversation = conv.data?.find((item) => item.status === "OPEN");
  const priority = Object.keys(aggregatePriority).length ? aggregatePriority : pendingReceiptCount
    ? { severity: "HIGH", title: "Hay comprobantes por revisar", summary: `${pendingReceiptCount} ${pendingReceiptCount === 1 ? "documento requiere" : "documentos requieren"} una decisión humana antes de reconocer el ingreso.`, href: "/sales/orders", status: "REQUIRES_ATTENTION", next_action: "Abrir el comprobante más antiguo" }
    : incidents.data?.length
      ? { severity: "HIGH", title: "Revisa la salud de los canales", summary: `${incidents.data.length} ${incidents.data.length === 1 ? "incidente puede" : "incidentes pueden"} afectar la continuidad de la operación.`, href: "/sales/channels/whatsapp", status: "REQUIRES_ATTENTION", next_action: "Revisar causa y vigencia" }
      : openConversation
        ? { severity: "MEDIUM", title: "Continúa una conversación abierta", summary: "La conversación conserva oferta, origen y control humano para responder con contexto.", href: `/sales/inbox?conversation=${openConversation.id}`, status: "IN_PROGRESS", next_action: "Abrir conversación" }
        : canSales
          ? { severity: "LOW", title: "No hay una tarea crítica pendiente", summary: "Las fuentes disponibles no reportan una intervención prioritaria para tu rol.", href: "/sales", status: "READY", next_action: "Revisar la cola de Ventas" }
          : { severity: "LOW", title: "Revisa resultados verificables", summary: "Tu rol puede consultar resultados sin exponer colas operativas restringidas.", href: "/results", status: "READY", next_action: "Abrir Resultados" };
  const aggregatePartial = canReports && (Boolean(operations.data?.partial) || operationSections.some((section) => ["PARTIAL", "STALE", "UNAVAILABLE"].includes(String(section.status))));
  const priorityHref = String(priority.href ?? (canSales ? "/sales" : "/results"));
  return (
    <>
      <PageHeader
        eyebrow={sales ? "VENTAS / RESUMEN" : "TU ESPACIO DE OPERACIÓN"}
        title={
          sales
            ? "Una vista clara de tus ventas"
            : `Todo conectado, ${session.user.name.split(" ")[0] || "equipo"}.`
        }
        description="De la oferta al resultado. Cada conversación conserva su contexto."
      />
      <section aria-labelledby="home-attention-title">
        <div className="ux-anchor">
          <div className="ux-anchor-copy">
            <div className="ux-state-heading"><StateBadge value={priority.status ?? severityState(priority.severity)} /><span>{String(priority.section ?? "Prioridad para tu rol")}</span></div>
            <h2 id="home-attention-title">{String(priority.title)}</h2>
            <p>{String(priority.summary)}</p>
            <small>{String(priority.next_action ?? "Abre la tarea para revisar el siguiente paso seguro.")}</small>
          </div>
          <Link to={priorityHref as "/sales"} className="button-link">Abrir tarea <ArrowUpRight size={17} /></Link>
        </div>
      </section>

      <Panel title="Estado de la operación" description="Cada fuente conserva su vigencia. Una lectura incompleta no convierte datos faltantes en cero." action={canReports&&operations.error ? <Badge tone="warning">Resumen parcial</Badge> : undefined}>
        <SectionState pending={canReports&&operations.isPending&&!summary.data} stale={Boolean(canReports&&operations.error&&summary.data)} partial={aggregatePartial} error={canReports&&!summary.data?operations.error:null} retry={canReports?() => { void operations.refetch(); void summary.refetch(); }:undefined}>
          {operationSections.length ? <div className="ux-summary-grid">{operationSections.map((section) => {
            const freshness = object(section.freshness), summaryValue = object(section.summary);
            return <StateSummary key={String(section.key)} compact value={{state: freshness.state === "STALE" ? "STALE" : section.status, cause: String(summaryValue.primary ?? "Sin conclusión disponible"), source: String(freshness.source ?? "Commerce OS"), observed_at: typeof freshness.observed_at === "string" ? freshness.observed_at : undefined, next_action: String(summaryValue.secondary ?? "")}}/>;
          })}</div> : <div className="ux-summary-grid">
            {fallbackCards.filter((card) => card.name !== "Por revisar" || canReview).map((card) => <article className="ux-summary-card" key={card.name}><span>{card.name}</span><strong>{metricValue(card.value)}</strong><small>{card.value === undefined ? "Fuente no disponible" : card.foot}</small></article>)}
          </div>}
        </SectionState>
      </Panel>

      {canSales && <Panel title="Actividad reciente" description="Un resumen breve; la cola completa permanece en Ventas." action={<RouteLink to="/sales/inbox">Abrir cola completa</RouteLink>}>
        <SectionState pending={conv.isPending} error={conv.error} empty={!conv.isPending && !conv.data?.length} emptyTitle="Sin conversaciones recientes" retry={() => void conv.refetch()}>
          <DataTable data={(conv.data ?? []).slice(0, 5)} columns={[{key:"name",title:"Conversación",render:(r)=><Link className="table-primary" to="/sales/inbox" search={{conversation:r.id}}>{String(r.contact_name ?? contacts.data?.find((person)=>person.id===r.contact_id)?.name ?? r.name ?? "Conversación")}</Link>},{key:"stage",title:"Estado",render:(r)=><Status value={r.stage ?? r.status}/>},{key:"updated_at",title:"Última actividad",render:(r)=>date(r.updated_at)}]}/>
        </SectionState>
      </Panel>}

      <Panel title="Accesos frecuentes" description="Herramientas secundarias para continuar la operación sin duplicar la cola.">
        <nav className="sales-quicklinks" aria-label="Accesos frecuentes de Inicio">
          {canManage && <Link to="/sales/channels/whatsapp">Salud y preparación de números →</Link>}
          {canReview && <Link to="/sales/orders">Pedidos y comprobantes →</Link>}
          <Link to="/catalog">Productos y ofertas →</Link>
          {canReports&&<Link to="/results">Resultados verificables →</Link>}
        </nav>
        <div className="panel-bottom"><FlaskConical size={15}/>{environment === "SIMULATION" ? "Los resultados de pruebas no cuentan como ventas reales." : "Una conexión disponible no habilita envíos."}</div>
      </Panel>
      {!sales && <details className="cycle-section">
        <summary>Módulos experimentales</summary>
        <div className="planned-links">{cycle.filter((item) => item.experimental).map((item) => <Link to={item.to} key={item.name}>{item.name}<Badge>Experimental</Badge></Link>)}</div>
      </details>}
    </>
  );
}

function metricValue(value: unknown) {
  return value === undefined || value === null || Number.isNaN(Number(value)) ? "No verificable" : String(value);
}
function severityState(value: unknown) {
  const severity = String(value ?? "LOW").toUpperCase();
  return severity === "CRITICAL" || severity === "HIGH" ? "REQUIRES_ATTENTION" : severity === "MEDIUM" ? "IN_PROGRESS" : "READY";
}
export function PlannedPage({ type }: { type: "intelligence" | "studio" }) {
  const intelligence = type === "intelligence";
  return (
    <>
      <PageHeader
        eyebrow="PRÓXIMAS CAPACIDADES"
        title={intelligence ? "Inteligencia" : "Estudio creativo"}
        description={
          intelligence
            ? "Decisiones comerciales que comienzan con evidencia."
            : "De una oferta clara a materiales listos para revisión."
        }
      />
      <section className="planned-page">
        <div className="planned-orbit">
          {intelligence ? <Sparkles size={44} /> : <Layers3 size={44} />}
        </div>
        <Badge>Experimental</Badge>
        <h2>
          {intelligence
            ? "Encuentra tu siguiente oportunidad."
            : "Un lugar para dar forma a tus ideas."}
        </h2>
        <p>
          {intelligence
            ? "Investigación de mercados, competidores y oportunidades con fuentes verificables. Cada hipótesis podrá conectarse con una oferta y contrastarse con los resultados de Ventas."
            : "Briefs, copy, creativos, audio, video y landings versionados. Los materiales conectarán producto, campaña y resultado con una revisión explícita antes de publicar."}
        </p>
        <div className="planned-flow">
          <span>
            {intelligence ? "Fuentes y señales" : "Producto y oferta"}
          </span>
          <ArrowDownRight size={20} />
          <span>
            {intelligence ? "Hipótesis con evidencia" : "Materiales revisados"}
          </span>
          <ArrowDownRight size={20} />
          <span>
            {intelligence ? "Ofertas y experimentos" : "Campañas y aprendizaje"}
          </span>
        </div>
        <RouteLink to={intelligence ? "/results" : "/catalog"}>
          {intelligence
            ? "Consultar resultados disponibles"
            : "Abrir catálogo compartido"}
        </RouteLink>
      </section>
    </>
  );
}
export function ResultsPage() {
  const { environment, session } = useWorkspace();
  const search = useRouterState({ select: (state) => state.location.search }) as Record<string, string>;
  const navigate = useNavigate();
  const canExport = session.permissions.includes("*") || session.permissions.includes("reports:export");
  const allowedGroups = ["offer_version_id", "account_id", "agent_version_id", "source_type"];
  const group = allowedGroups.includes(search.group) ? search.group : "offer_version_id";
  const setGroup = (value: string) => void navigate({ to: "/results", search: (old) => ({ ...old, group: value }), replace: true });
  const searchValue = (key: string) => typeof search[key] === "string" && search[key] ? search[key] : undefined;
  const reportFilters = {
    group_by: group,
    from: searchValue("from"),
    to: searchValue("to"),
    product_id: searchValue("product_id"),
    account_id: searchValue("account_id"),
    offer_version_id: searchValue("offer_version_id"),
    agent_version_id: searchValue("agent_version_id"),
    source: searchValue("source"),
  };
  const summary = useData<Record<string, unknown>>(
    `/reports/summary${params(environment, reportFilters)}`,
    true,
    5000,
  );
  const [error, setError] = useState<Error | null>(null);
  async function exportData() {
    try {
      const data = await api<unknown>(
        `/reports/export${params(environment, { ...reportFilters, format: "json" })}`,
        undefined,
        true,
      );
      downloadJson(
        data,
        `commerce-os-resultados-${environment.toLowerCase()}.json`,
      );
    } catch (e) {
      setError(e as Error);
    }
  }
  const data = summary.data ?? {};
  const counts = object(data.counts);
  const attribution = object(data.attribution);
  const cohort = object(data.cohort);
  const cohortSize = cohort.size ?? counts.conversations;
  const observedAt = data.measured_at;
  const revenueState = String(data.revenue_state ?? (data.revenue_minor == null ? "UNVERIFIABLE" : Number(data.revenue_minor) === 0 ? "ZERO" : "VERIFIED"));
  const revenueByCurrency = rows(data.revenue_by_currency);
  const revenueValue = revenueState === "VERIFIED"
    ? money(Number(data.revenue_minor), typeof data.currency === "string" ? data.currency : undefined)
    : revenueState === "ZERO"
      ? "0 · sin ingreso reconocido"
      : revenueState === "NOT_COMPARABLE"
        ? revenueByCurrency.map((item) => money(Number(item.revenue_minor), item.currency)).join(" · ")
        : "No verificable";
  const evidenceCoverage = attribution.evidence_coverage == null ? null : Number(attribution.evidence_coverage);
  const coverageLabel = Number(cohortSize) === 0
    ? "Cohorte vacía"
    : cohortSize == null || evidenceCoverage == null || !Number.isFinite(evidenceCoverage)
      ? "Cobertura no verificable"
      : `${Math.round(evidenceCoverage * 100)} % con origen observado o inferido`;
  const suggestedDecision = revenueState === "UNVERIFIABLE"
    ? "Revisa la fuente de reconocimiento antes de concluir si hubo ingreso."
    : revenueState === "NOT_COMPARABLE"
      ? "Compara cada moneda por separado; no sumes importes que no son equivalentes."
      : revenueState === "ZERO"
      ? "No se reconoció ingreso en este corte; confirma cobertura antes de cambiar la operación."
      : Number(attribution.unknown ?? 0) > 0
        ? "Prioriza los orígenes desconocidos antes de comparar rendimiento."
        : "Compara los segmentos con muestra suficiente y conserva este corte como referencia.";
  const legacyResultRows = rows(
    data[
      group === "account_id"
        ? "by_account"
        : group === "agent_version_id"
          ? "by_agent"
          : group === "source_type"
            ? "by_source"
            : "by_offer"
    ],
  );
  const resultRows = rows(data.segments).length ? rows(data.segments) : legacyResultRows;
  const rangeLabel = cohort.from || cohort.to_exclusive
    ? `${cohort.from ? date(String(cohort.from)) : "Inicio no acotado"} — ${cohort.to_exclusive ? `${date(String(cohort.to_exclusive))} (exclusivo)` : "Fin no acotado"}`
    : "Todo el historial disponible";
  const revenueHeading = revenueState === "VERIFIED"
    ? `${revenueValue} de ingreso reconocido`
    : revenueState === "ZERO"
      ? "Sin ingreso reconocido en este corte"
      : revenueState === "NOT_COMPARABLE"
        ? "Ingreso disponible por moneda, sin total comparable"
        : "El ingreso no puede verificarse con este corte";
  return (
    <>
      <PageHeader
        eyebrow="RESULTADOS Y APRENDIZAJE"
        title="Hechos para decidir mejor"
        description="Compara intención, aprobación documental, ventas e ingresos por cohorte de conversación."
      />
      <Notice>
        {environment === "SIMULATION"
          ? "Resultados de simulación. Se excluyen de la operación real."
          : "Datos del entorno real."}{" "}
        El ingreso se reconoce por comprobante validado. ROAS no disponible
        sin gasto comparable.
      </Notice>
      <Feedback error={error} />
      <section className="ux-anchor" aria-labelledby="results-anchor-title">
        <div className="ux-anchor-copy">
          <div className="ux-state-heading"><StateBadge value={revenueState === "UNVERIFIABLE" ? "UNAVAILABLE" : revenueState === "NOT_COMPARABLE" ? "PARTIAL" : "READY"}/><span>Resultado verificable</span></div>
          <h2 id="results-anchor-title">{revenueHeading}</h2>
          <p>{suggestedDecision}</p>
          <small>Cohorte: {cohortSize == null ? "No verificable" : String(cohortSize)} · {coverageLabel} · {observedAt ? `actualizado ${date(String(observedAt))}` : "fecha no disponible"}</small>
        </div>
        {canExport?<Button variant="secondary" disabled={!summary.data || summary.isPending} onClick={() => void exportData()}><Download/>Exportar este corte</Button>:<small>Tu rol puede consultar este corte, pero la exportación está reservada a owner y analyst.</small>}
      </section>
      <div className="toolbar">
        <label className="inline-field">
          Agrupar por
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="offer_version_id">Oferta</option>
            <option value="account_id">Número</option>
            <option value="agent_version_id">Agente</option>
            <option value="source_type">Origen</option>
          </select>
        </label>
      </div>
      <QueryState query={summary}>
        <div className="ux-summary-grid" aria-label="Cobertura y calidad del corte">
          <article className="ux-summary-card"><span>Tamaño de cohorte</span><strong>{cohortSize == null ? "No verificable" : String(cohortSize)}</strong><small>{rangeLabel}</small></article>
          <article className="ux-summary-card"><span>Cobertura</span><strong>{coverageLabel}</strong><small>Observado, inferido y desconocido permanecen separados.</small></article>
          <article className="ux-summary-card"><span>Entorno</span><strong>{environment === "REAL" ? "Operación real" : "Simulación"}</strong><small>Nunca se suman ambos entornos.</small></article>
          <article className="ux-summary-card"><span>Última actualización</span><strong>{observedAt ? date(String(observedAt)) : "No verificable"}</strong><small>La exportación conserva este mismo agrupamiento.</small></article>
        </div>
        <div className="metric-grid">
          <Metric
            label="Pedidos"
            value={data.orders ?? object(data.counts).orders}
          />
          <Metric
            label="Documentos aprobados"
            value={object(data.counts).receipt_approved}
          />
          <Metric
            label="Ventas por comprobante"
            value={object(data.counts).reconciled}
          />
          <Metric
            label="Ingreso por comprobante"
            value={revenueState === "UNVERIFIABLE" ? undefined : revenueValue}
          />
        </div>
        <div className="split-equal">
          <Panel title="Hitos del embudo">
            {rows(data.funnel).length ? <div className="funnel-chart">
              {rows(data.funnel).map((item) => (
                <div key={String(item.stage)}>
                  <div>
                    <Status value={item.stage} />
                    <strong>{String(item.count)}</strong>
                  </div>
                  <span>
                    <i
                      style={{
                        width: `${Number(object(data.counts).conversations) > 0 ? Math.min(100, (Number(item.count) / Number(object(data.counts).conversations)) * 100) : 0}%`,
                      }}
                    />
                  </span>
                </div>
              ))}
            </div> : <Empty title="Sin hitos en esta cohorte" description="La fuente respondió sin etapas del embudo para el corte seleccionado."/>}
          </Panel>
          <Panel title="Cobertura de atribución">
            <div className="attribution-metrics">
              {[
                ["observed", "Origen observado"],
                ["inferred", "Origen inferido"],
                ["unknown", "Origen desconocido"],
              ].map(([key, label]) => (
                <div key={key}>
                  <span>{label}</span>
                  <strong>
                    {String(object(data.attribution)[key!] ?? "—")}
                  </strong>
                </div>
              ))}
            </div>
            <div className="panel-bottom">
              Cada conversación de la cohorte se cuenta una vez.
            </div>
          </Panel>
        </div>
        <Panel title="Embudo y cobertura por segmento">
          <DataTable
            data={resultRows.map((r, i) => ({ ...r, id: r.id ?? String(i) }))}
            columns={[
              {
                key: "label",
                title: "Segmento",
                render: (r) => <div><strong>{String(r.label ?? r.offer_name ?? r.account_alias ?? r.agent_name ?? r.source_label ?? "Segmento sin nombre")}</strong><details><summary>Referencia técnica</summary><code>{String((r.key ?? r.offer_version_id ?? r.account_id ?? r.agent_version_id ?? r.id) === "unknown" ? "Sin referencia técnica" : r.key ?? r.offer_version_id ?? r.account_id ?? r.agent_version_id ?? r.id)}</code></details></div>,
              },
              {
                key: "sample_size",
                title: "Muestra y cobertura",
                render: (r) => {
                  const segmentAttribution = object(r.attribution);
                  return <div><strong>{String(r.sample_size ?? r.conversations ?? "No verificable")} conversaciones</strong><small>{String(segmentAttribution.observed ?? "—")} observadas · {String(segmentAttribution.inferred ?? "—")} inferidas · {String(segmentAttribution.unknown ?? "—")} desconocidas</small></div>;
                },
              },
              { key: "orders", title: "Pedidos" },
              { key: "reconciled", title: "Ventas válidas" },
              {
                key: "amount_minor",
                title: "Ingreso",
                render: (r) =>
                  rows(r.revenue_by_currency)
                    .map((v) => money(Number(v.amount_minor), v.currency))
                    .join(" · ") || "Sin ingreso por comprobante",
              },
            ]}
          />
        </Panel>
        <Panel title="Explicación y decisión" description={suggestedDecision}>
          <p className="panel-copy">Cero significa que la fuente respondió con cero. “No verificable” significa que falta una lectura suficiente. ROAS permanece no comparable cuando ingreso y gasto no comparten periodo, moneda y cobertura.</p>
        </Panel>
        <details className="ux-evidence"><summary>Definición, IDs técnicos y evidencia del reporte</summary>
          <JsonDetail
            value={data}
            title="Ver datos persistidos, conteos y cobertura"
          />
        </details>
      </QueryState>
    </>
  );
}
import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "../components/ui/button";
import { Feedback, JsonDetail } from "../components/shared";
import { api } from "../lib/api";
import { downloadJson } from "../lib/utils";
function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong>{value === undefined ? "—" : String(value)}</strong>
      <small>
        {value === undefined
          ? "Sin información verificable"
          : "Datos del entorno seleccionado"}
      </small>
    </div>
  );
}
