import { useState, useEffect, type ReactElement } from "react";
import {
  Link,
  useNavigate,
  useRouterState,
  useBlocker,
} from "@tanstack/react-router";
import {
  PageHeader,
  Panel,
  Feedback,
  QueryState,
  Empty,
  useWorkspace,
} from "../components/shared";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/dialog";
import { params, useAction, useData, object, type Row } from "../lib/api";
import { KnowledgeEditor } from "../components/sales/knowledge-editor";
import { EvaluationPanel } from "../components/sales/evaluation-panel";
export function SellersPage(): ReactElement {
  const { environment, session } = useWorkspace();
  const location = useRouterState({ select: (s) => s.location });
  const id = location.pathname.split("/")[3];
  const query = useData<Row>(
    `/agents/${id}${params(environment)}`,
    !!id && id !== "new",
  );
  const search = location.search as Record<string, string>;
  const navigate = useNavigate();
  const agents = useData(
    `/agents${params(environment, { q: search.q, product_id: search.product })}`,
  );
  const canWrite =
    session.permissions.includes("*") ||
    session.permissions.includes("workflows:write");
  if (id)
    return id === "new" ? (
      <SellerWizard
        key={environment + id}
        initial={{ id: "new", product_id: search.product }}
      />
    ) : (
      <QueryState query={query}>
        {query.data && (
          <SellerWizard key={environment + id} initial={query.data} />
        )}
      </QueryState>
    );
  return (
    <>
      <PageHeader
        eyebrow="VENTAS / VENDEDORES"
        title="Un vendedor para cada oferta"
        description="Define lo que sabe, revisa cómo responde y conserva cada versión."
        action={
          canWrite ? (
            <Link
              to="/sales/agents/new"
              search={search}
              className="button-link"
            >
              Nuevo vendedor
            </Link>
          ) : undefined
        }
      />
      <div className="tabs">
        <Link to="/sales/flows" search={search}>
          Flujos comerciales
        </Link>
        <Link to="/sales/agents" search={search} aria-current="page">
          Agentes de venta
        </Link>
      </div>
      <label className="field">
        <span>Buscar vendedor</span>
        <input
          value={search.q ?? ""}
          onChange={(e) =>
            void navigate({
              to: "/sales/agents",
              search: { ...search, q: e.target.value },
              replace: true,
            })
          }
        />
      </label>
      <QueryState query={agents}>
        <div className="sales-cards">
          {agents.data?.map((a) => (
            <Link
              key={a.id}
              to={`/sales/agents/${a.id}`}
              search={search}
              className="sales-card"
            >
              <strong>{a.name}</strong>
              <span>Revisión {Number(a.revision ?? 1)}</span>
              <span>
                {a.product_id ? "Producto asignado" : "Sin producto asignado"}
              </span>
              <span>
                {a.source_version_id
                  ? "Revisión conservada"
                  : "Configuración inicial"}
              </span>
            </Link>
          ))}
          {!agents.data?.length && (
            <Empty
              title="Configura tu primer vendedor"
              description="Elige un producto del catálogo y agrega fuentes aprobadas."
            />
          )}
        </div>
      </QueryState>
    </>
  );
}
function SellerWizard({ initial }: { initial: Row }) {
  const { environment, session } = useWorkspace();
  const canWrite =
    session.permissions.includes("*") ||
    session.permissions.includes("workflows:write");
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search }) as Record<
    string,
    string
  >;
  const action = useAction();
  const products = useData(`/products${params(environment)}`),
    offers = useData(`/offers${params(environment)}`),
    flows = useData(`/workflows${params(environment)}`),
    accounts = useData(
      `/channel-accounts${params(environment)}`,
      session.role === "owner" || session.role === "operator",
    );
  const defaults = {
    name: initial.name ?? "Vendedor de prueba",
    product_id: initial.product_id ?? "",
    offer_version_id: initial.offer_version_id ?? "",
    provider: initial.provider ?? "workspace",
    model: initial.model ?? "",
    knowledge: initial.knowledge ?? "",
    instructions: initial.instructions ?? "",
    max_cost_minor: initial.max_cost_minor ?? 0,
    timeout_ms: initial.timeout_ms ?? 10000,
    max_tokens: Number(initial.max_tokens ?? 500),
    ...object(
      initial.input_cost_per_million_minor === undefined
        ? {}
        : {
            input_cost_per_million_minor: initial.input_cost_per_million_minor,
            output_cost_per_million_minor:
              initial.output_cost_per_million_minor,
          },
    ),
    style: {
      language: "Español",
      tone: "Claro, amable y breve",
      length: "brief",
      goal: "Ayudar a elegir con información comprobable",
      examples: "",
      handoff: "Preguntas sin fuente, conflicto o solicitud de persona.",
      ...object(initial.style),
    },
  };
  const [form, setForm] = useState(defaults),
    [saved, setSaved] = useState(JSON.stringify(defaults)),
    [step, setStep] = useState(
      Math.max(0, Math.min(4, Number(search.step) || 0)),
    ),
    [error, setError] = useState<Error | null>(null),
    [evaluationFlow, setEvaluationFlow] = useState("");
  const [knowledgeDirty, setKnowledgeDirty] = useState(false);
  const dirty = JSON.stringify(form) !== saved;
  useEffect(() => {
    const handler = (event: Event) => {
      if (dirty) {
        event.preventDefault();
        setError(
          new Error(
            "Guarda la revisión del vendedor antes de cambiar de entorno.",
          ),
        );
      }
    };
    window.addEventListener("commerce:context-change", handler);
    return () => window.removeEventListener("commerce:context-change", handler);
  }, [dirty]);
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  async function save() {
    try {
      if (knowledgeDirty)
        throw new Error(
          "Guarda primero los cambios de Qué sabe. Conservamos su contenido al cambiar de sección.",
        );
      const { product_id, offer_version_id, ...rest } = form;
      const row = (await action.mutateAsync({
        path: initial.id === "new" ? "/agents" : `/agents/${initial.id}`,
        method: initial.id === "new" ? "POST" : "PATCH",
        body: {
          ...rest,
          ...(form.provider === "workspace" ? {model:null,max_cost_minor:0,input_cost_per_million_minor:undefined,output_cost_per_million_minor:undefined} : {}),
          ...(product_id ? { product_id } : {}),
          ...(offer_version_id ? { offer_version_id } : {}),
          ...(initial.id !== "new"
            ? { expected_version: initial.version }
            : {}),
        },
      })) as Row;
      setSaved(JSON.stringify(form));
      await navigate({
        to: `/sales/agents/${row.id}`,
        search: { step: String(step) },
        ignoreBlocker: true,
      });
      return row;
    } catch (e) {
      setError(e as Error);
      throw e;
    }
  }
  const product = products.data?.find((p) => p.id === form.product_id),
    offer = offers.data?.find((o) => o.id === form.offer_version_id);
  const sections = [
    "Qué vende",
    "Qué sabe",
    "Cómo responde",
    "Cuándo pide ayuda",
    "Probar y revisar",
  ];
  return (
    <section className="seller-wizard">
      <Link to="/sales/agents">← Vendedores</Link>
      <PageHeader
        eyebrow="CONFIGURACIÓN GUIADA"
        title={initial.name ?? "Configura tu vendedor"}
        description="Las revisiones nuevas conservan el conocimiento de conversaciones anteriores."
      />
      <div className="seller-summary">
        <strong>{product?.name ?? "Selecciona un producto"}</strong>
        <span>
          {offer?.name ?? "Selecciona una oferta"}
          {offer &&
            ` · $${(Number(offer.base_amount_minor) / 100).toFixed(2)} ${offer.currency}`}
        </span>
        <span>
          Revisión {Number(initial.revision ?? 1)} ·{" "}
          {form.provider === "deterministic"
            ? "Doble de prueba"
            : "Proveedor externo pendiente de validar"}
        </span>
      </div>
      <nav className="wizard-tabs" aria-label="Secciones del vendedor">
        {sections.map((title, index) => (
          <button
            key={title}
            aria-current={step === index ? "step" : undefined}
            onClick={() => {
              setStep(index);
              void navigate({
                to: `/sales/agents/${initial.id}`,
                search: { step: String(index) },
                replace: true,
                ignoreBlocker: true,
              });
            }}
          >
            <span>{index + 1}</span>
            {title}
          </button>
        ))}
      </nav>
      <Panel title={sections[step]}>
        <div className="sales-panel-body">
          <fieldset disabled={!canWrite}>
            {step === 0 && (
              <>
                <label className="field">
                  <span>Producto que vende</span>
                  <select
                    value={form.product_id}
                    onChange={(e) => {
                      if (knowledgeDirty) {
                        setError(
                          new Error(
                            "Guarda Qué sabe antes de cambiar de producto.",
                          ),
                        );
                        return;
                      }
                      setForm({
                        ...form,
                        product_id: e.target.value,
                        offer_version_id: "",
                      });
                    }}
                  >
                    <option value="">Selecciona un producto…</option>
                    {products.data?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Oferta y condiciones</span>
                  <select
                    value={form.offer_version_id}
                    onChange={(e) =>
                      setForm({ ...form, offer_version_id: e.target.value })
                    }
                  >
                    <option value="">Selecciona una oferta…</option>
                    {offers.data
                      ?.filter((o) => o.product_id === form.product_id)
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name} · {o.status} · $
                          {Number(o.base_amount_minor) / 100} {o.currency}
                        </option>
                      ))}
                  </select>
                </label>
                <p>
                  Precios y entrega provienen de esta oferta. Guardar una
                  revisión no reasigna conversaciones.
                </p>
              </>
            )}
            {step === 2 && (
              <>
                <p>Valores iniciales propuestos; puedes adaptarlos.</p>
                <label className="field">
                  <span>Nombre visible del vendedor</span>
                  <input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </label>
                {[
                  ["language", "Idioma"],
                  ["tone", "Tono"],
                  ["goal", "Objetivo"],
                  ["examples", "Ejemplos de respuesta"],
                ].map(([key, title]) => (
                  <label className="field" key={key}>
                    <span>{title}</span>
                    <textarea
                      rows={key === "examples" ? 4 : 2}
                      value={String(
                        (form.style as Record<string, unknown>)[key] ?? "",
                      )}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          style: { ...form.style, [key]: e.target.value },
                        })
                      }
                    />
                  </label>
                ))}
                <label className="field">
                  <span>Longitud</span>
                  <select
                    value={String(form.style.length)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        style: { ...form.style, length: e.target.value },
                      })
                    }
                  >
                    <option value="brief">Breve</option>
                    <option value="balanced">Con explicación</option>
                  </select>
                </label>
              </>
            )}
            {step === 3 && (
              <>
                <label className="field">
                  <span>Cuándo solicitar ayuda</span>
                  <textarea
                    value={String(form.style.handoff)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        style: { ...form.style, handoff: e.target.value },
                      })
                    }
                  />
                </label>
                <p>
                  Falta de fuente, conflictos, baja y control humano siempre
                  conservan las reglas del sistema.
                </p>
                <label className="field">
                  <span>Tiempo máximo en segundos</span>
                  <input
                    type="number"
                    min={0.1}
                    max={60}
                    value={form.timeout_ms / 1000}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        timeout_ms: Math.round(Number(e.target.value) * 1000),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span>
                    Presupuesto por respuesta (unidad monetaria de
                    configuración)
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={form.max_cost_minor / 100}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        max_cost_minor: Math.round(
                          Number(e.target.value) * 100,
                        ),
                      })
                    }
                  />
                </label>
              </>
            )}
          </fieldset>
          <div hidden={step !== 1}>
            {product ? (
              <KnowledgeEditor
                key={product.id}
                record={product}
                onDirtyChange={setKnowledgeDirty}
              />
            ) : (
              <p>Selecciona primero qué producto vende.</p>
            )}
          </div>
          {step === 4 && (
            <>
              <p>
                Guarda primero la revisión. El chat usa fuentes del catálogo y
                un doble determinista.
              </p>
              <label className="field">
                <span>Flujo para la prueba</span>
                <select
                  value={evaluationFlow}
                  onChange={(e) => setEvaluationFlow(e.target.value)}
                >
                  <option value="">Selecciona un flujo de esta oferta…</option>
                  {flows.data
                    ?.filter(
                      (f) => f.offer_version_id === form.offer_version_id,
                    )
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </select>
              </label>
              {canWrite && evaluationFlow && initial.id !== "new" && !dirty && (
                <EvaluationPanel
                  flowId={evaluationFlow}
                  revision={
                    flows.data?.find((f) => f.id === evaluationFlow)?.version ??
                    1
                  }
                  agentId={initial.id}
                />
              )}
              <p>
                La prueba utiliza explícitamente esta revisión del vendedor. No
                cambia su asignación.
              </p>
              <Link to="/sales/flows" search={{ product: form.product_id }}>
                Abrir flujos del producto →
              </Link>
            </>
          )}
          <details>
            <summary>Instrucciones y proveedor · avanzado</summary>
            <fieldset disabled={!canWrite}>
              <label className="field">
                <span>Instrucciones adicionales</span>
                <textarea
                  value={form.instructions}
                  rows={5}
                  onChange={(e) =>
                    setForm({ ...form, instructions: e.target.value })
                  }
                />
                <small>
                  Se conservan al cambiar de sección. No modifican precios ni
                  permisos.
                </small>
              </label>
              <label className="field">
                <span>Conocimiento legado de esta revisión</span>
                <textarea
                  value={form.knowledge}
                  onChange={(e) =>
                    setForm({ ...form, knowledge: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>Proveedor</span>
                <select
                  value={form.provider}
                  onChange={(e) =>
                    setForm({ ...form, provider: e.target.value, model:e.target.value === "workspace" ? "" : e.target.value === "deterministic" ? "deterministic-v1" : "" })
                  }
                >
                  <option value="workspace">Configurar IA de Ventas después</option>
                  <option value="deterministic">
                    Doble determinista (pruebas)
                  </option>
                  <option value="openai">OpenAI (conexión protegida)</option>
                </select>
              </label>
              <label className="field">
                <span>Modelo</span>
                <input
                  value={form.model}
                  disabled={form.provider === "workspace"}
                  placeholder="Pendiente en la conexión de IA de Ventas"
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </label>
            </fieldset>
            <p>
              Proveedor real no evaluado en esta entrega. Configuración y
              presupuesto externos pendientes.
            </p>
          </details>
          <Feedback error={error} />
          <div className="button-group">
            {step > 0 && (
              <Button variant="secondary" onClick={() => setStep(step - 1)}>
                Anterior
              </Button>
            )}
            {step < 4 && (
              <Button variant="secondary" onClick={() => setStep(step + 1)}>
                Siguiente
              </Button>
            )}
            {canWrite && (
              <Button
                disabled={!form.name.trim() || action.isPending}
                onClick={() => void save().catch(() => {})}
              >
                {initial.id === "new"
                  ? "Guardar vendedor"
                  : "Guardar nueva revisión"}
              </Button>
            )}
          </div>
        </div>
      </Panel>
      {initial.id !== "new" && canWrite && initial.status !== "PUBLISHED" && <Button disabled={action.isPending} onClick={()=>{void action.mutateAsync({path:`/agents/${initial.id}/publish`,body:{expected_version:initial.version}}).catch(e=>setError(e.message));}}>Publicar configuración del vendedor</Button>}
      {initial.status === "PUBLISHED" && <p>Configuración publicada. {initial.provider === "workspace" ? "Modelo, costos y límites se resolverán al configurar IA de Ventas." : "La operación conserva sus controles propios."}</p>}
      {initial.id !== "new" && (
        <Panel title="Dónde se usa esta revisión">
          <div className="sales-panel-body">
            <p>
              Las asignaciones se resuelven: vínculo → oferta → número →
              producto → flujo.
            </p>
            {flows.data
              ?.filter((f) => f.agent_version_id === initial.id)
              .map((f) => (
                <p key={f.id}>
                  <Link to={`/sales/flows/${f.id}`}>{f.name}</Link> · respaldo
                  del flujo
                </p>
              ))}
            {offers.data
              ?.filter((o) => o.agent_version_id === initial.id)
              .map((o) => (
                <p key={o.id}>{o.name} · oferta</p>
              ))}
            {products.data
              ?.filter((p) => p.agent_version_id === initial.id)
              .map((p) => (
                <p key={p.id}>
                  <Link to="/catalog" search={{ product: p.id }}>
                    {p.name}
                  </Link>{" "}
                  · producto
                </p>
              ))}
            {accounts.data
              ?.filter((a) => a.agent_version_id === initial.id)
              .map((a) => (
                <p key={a.id}>{a.name} · número</p>
              ))}
            <Link to="/sales/channels/whatsapp">
              Revisar prioridad y preparación de números
            </Link>
          </div>
        </Panel>
      )}
      <Modal
        title="Conserva la configuración del vendedor"
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <p>
          Hay cambios pendientes. Puedes seguir editando o guardar una revisión.
        </p>
        <Button
          onClick={() =>
            void save()
              .then(() => blocker.proceed?.())
              .catch(() => {})
          }
        >
          Guardar y continuar
        </Button>
        <Button variant="secondary" onClick={() => blocker.reset?.()}>
          Seguir editando
        </Button>
      </Modal>
    </section>
  );
}
