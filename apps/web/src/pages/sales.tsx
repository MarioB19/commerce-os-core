import {AssetPreview} from '../components/asset-preview';
import { useState, type FormEvent } from "react";
import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  CheckCheck,
  FileCheck2,
  Hand,
  MessageCircle,
  Pause,
  Play,
  Search,
  Send,
  Shield,
  Upload,
  UserRound,
  Wallet,
} from "lucide-react";
import {
  Badge,
  DataTable,
  Empty,
  Feedback,
  JsonDetail,
  Notice,
  PageHeader,
  Pagination,
  Panel,
  QueryState,
  ResourceForm,
  Status,
  useWorkspace,
} from "../components/shared";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/dialog";
import {
  api,
  object,
  params,
  rows,
  str,
  useCollection,
  useAction,
  useData,
  type Row,
} from "../lib/api";
import { date, downloadJson, money, shortId } from "../lib/utils";
function receiptMoney(record: Row) {
  const extraction = object(record.extraction);
  const amount =
    record.amount_minor ??
    record.observed_amount_minor ??
    extraction.amount_minor;
  const currency = record.currency ?? extraction.currency;
  return money(
    typeof amount === "number" || typeof amount === "string"
      ? amount
      : undefined,
    typeof currency === "string" ? currency : undefined,
  );
}
export function InboxPage() {
  const { environment } = useWorkspace();
  const search = useRouterState({ select: (s) => s.location.search }) as {
    conversation?: string;
  };
  const navigate=useNavigate();
  const selected=search.conversation??null;
  const setSelected=(conversation:string|null)=>void navigate({to:'/sales/inbox',search:old=>({...old,conversation:conversation??undefined}),replace:false});
  const filter=(search as Record<string,string>).q??"";
  const setFilter=(filter:string)=>void navigate({to:'/sales/inbox',search:old=>({...old,q:filter}),replace:true});
  const account=(search as Record<string,string>).account??"";
  const setAccount=(account:string)=>void navigate({to:'/sales/inbox',search:old=>({...old,account:account}),replace:true});
  const stage=(search as Record<string,string>).stage??"";
  const setStage=(stage:string)=>void navigate({to:'/sales/inbox',search:old=>({...old,stage:stage}),replace:true});
  const product=(search as Record<string,string>).product??"";
  const setProduct=(product:string)=>void navigate({to:'/sales/inbox',search:old=>({...old,product:product}),replace:true});
  const assigned=(search as Record<string,string>).assigned??"";
  const setAssigned=(assigned:string)=>void navigate({to:'/sales/inbox',search:old=>({...old,assigned:assigned}),replace:true});
  const [offset, setOffset] = useState(0);
  const contacts = useData(`/contacts${params(environment, { limit: "200" })}`);
  const accounts = useData(`/channel-accounts${params(environment)}`);
  const products = useData(`/products${params(environment)}`);
  const conversations = useCollection(
    `/conversations${params(environment, { q: filter, account_id: account, stage, product_id: product, assigned_to: assigned, limit: "50", offset: String(offset) })}`,
    true,
    1000,
  );
  const detail = useData<Row>(
    `/conversations/${selected}${params(environment)}`,
    !!selected,
    1000,
  );
  return (
    <>
      <PageHeader
        eyebrow="VENTAS / INBOX"
        title="Conversaciones con contexto"
        description="Acompaña cada venta con la oferta, el origen y el control humano a la vista."
      />
      <div className="inbox-filters">
        <label className="search-field"><span>Buscar conversaciones</span><div className="search-input">
          <Search size={16} />
          <input
            aria-label="Buscar conversaciones"
            placeholder="Buscar conversación…"
            value={filter}
            onChange={(e) => {
              setFilter(e.target.value);
              setOffset(0);
            }}
          />
        </div></label>
        <label className="search-field"><span>Número</span><select
          aria-label="Filtrar por número"
          value={account}
          onChange={(e) => {
            setAccount(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">Todos los números</option>
          {accounts.data?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name ?? a.alias}
            </option>
          ))}
        </select></label>
        <details><summary>Más filtros</summary><div className="advanced-filter-row">
        <label className="search-field"><span>Filtrar por etapa</span><select
          aria-label="Filtrar por etapa"
          value={stage}
          onChange={(e) => {
            setStage(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">Todas las etapas</option>
          {[
            "NEW",
            "OFFERED",
            "COMMITTED",
            "RECEIPT_RECEIVED",
            "RECEIPT_APPROVED",
            "RECONCILED",
          ].map((x) => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select></label>
        <label className="search-field"><span>Filtrar por producto</span><select
          aria-label="Filtrar por producto"
          value={product}
          onChange={(e) => {
            setProduct(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">Todos los productos</option>
          {products.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select></label>
        <label className="search-field"><span>Responsable</span><input
          aria-label="Responsable"
          placeholder="ID de responsable"
          value={assigned}
          onChange={(e) => {
            setAssigned(e.target.value);
            setOffset(0);
          }}
        /></label>
        </div></details>
      </div>
      <div className={`inbox-layout ${selected ? "has-selection" : ""}`}>
        <aside className="conversation-list">
          <div className="conversation-list-title">
            Bandeja de entrada <Badge>{conversations.total}</Badge>
          </div>
          <QueryState query={conversations}>
            {conversations.data?.length ? (
              conversations.data.map((c) => (
                <button
                  className={`conversation-item ${selected === c.id ? "selected" : ""}`}
                  onClick={() => setSelected(c.id)}
                  key={c.id}
                >
                  <span className="contact-avatar">
                    {String(
                      c.contact_name ??
                        contacts.data?.find(
                          (person) => person.id === c.contact_id,
                        )?.name ??
                        c.name ??
                        "C",
                    )
                      .slice(0, 2)
                      .toUpperCase()}
                  </span>
                  <div>
                    <div className="conversation-item-top">
                      <strong>
                        {String(
                          c.contact_name ??
                            contacts.data?.find(
                              (person) => person.id === c.contact_id,
                            )?.name ??
                            c.name ??
                            shortId(c.contact_id),
                        )}
                      </strong>
                      <small>
                        {c.updated_at
                          ? new Date(c.updated_at).toLocaleTimeString("es-MX", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </small>
                    </div>
                    <p>
                      {String(
                        c.last_message ??
                          c.last_message_text ??
                          "Abrir conversación",
                      )}
                    </p>
                    <div>
                      <Status value={c.stage ?? c.status} />
                      <small>
                        {accounts.data?.find((a) => a.id === c.account_id)
                          ?.name ?? shortId(c.account_id)}
                      </small>
                    </div>
                  </div>
                </button>
              ))
            ) : (
              <Empty
                title="Bandeja en calma"
                description="Las conversaciones recibidas aparecen aquí. Revisa la conexión de tus números para comenzar."
              />
            )}
          </QueryState>
          <div className="list-pagination">
            <Button
              size="sm"
              variant="ghost"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 50))}
            >
              ← Anterior
            </Button>
            <span>
              {Math.min(offset + 1, conversations.total)}–
              {offset + (conversations.data?.length ?? 0)} /{" "}
              {conversations.total}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={offset + 50 >= conversations.total}
              onClick={() => setOffset(offset + 50)}
            >
              Siguiente →
            </Button>
          </div>
        </aside>
        <section className="conversation-detail">
          {selected ? (
            <QueryState query={detail}>
              {detail.data && (
                <ConversationDetail
                  key={`${environment}:${selected}`}
                  conversation={detail.data}
                  onBack={() => setSelected(null)}
                />
              )}
            </QueryState>
          ) : (
            <div className="chat-empty">
              <div>
                <MessageCircle size={36} />
              </div>
              <h2>Cada conversación cuenta.</h2>
              <p>
                Selecciona un chat para revisar su contexto,
                <br />
                seguir la venta o tomar el control.
              </p>
              <Badge tone="info">
                {environment === "SIMULATION"
                  ? "Entorno de simulación"
                  : "Entorno real"}
              </Badge>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
function ConversationDetail({
  conversation: c,
  onBack,
}: {
  conversation: Row;
  onBack: () => void;
}) {
  const { environment, session } = useWorkspace();
  const mutation = useAction();
  const [text, setText] = useState("");
  const [tab, setTab] = useState("messages");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const controls = object(c.controls);
  const contact = object(c.contact);
  const offer = object(c.offer);
  const order = object(c.order);
  const flowState = object(c.flow_state);
  const workflowVersion = c.runtime_workflow_id ?? c.workflow_version_id ?? c.workflow_runtime_version;
  const waitingNode = flowState.waiting_node_id ?? flowState.node_id;
  const messages = rows(c.messages);
  const events = rows(c.events);
  const outbox = rows(c.outbox);
  const authorizations = useData(
    `/operation-authorizations${params(environment)}`,
    ["owner", "operator", "reconciler"].includes(session.role),
  );
  const assets = useData(`/assets${params(environment)}`);
  async function command(type: string, payload: Record<string, unknown> = {}) {
    setError(null);
    setNotice("");
    try {
      const fresh=type==='send_message'?await api<Row>(`/conversations/${c.id}${params(environment)}`):undefined;
      const result = await mutation.mutateAsync({
        path: `/conversations/${c.id}/commands`,
        body: { type, ...payload, ...(fresh?{expected_version:fresh.version}:{}) },
      });
      setNotice(
        `Acción registrada (${shortId((result as Row).id)}). Se actualizará al procesarse.`,
      );
      if (type === "send_message") setText("");
    } catch (e) {
      setError(e as Error);
    }
  }
  async function control(payload: Record<string, unknown>) {
    try {
      await mutation.mutateAsync({
        path: `/conversations/${c.id}/controls`,
        body: { ...payload, reason: "Control manual desde inbox" },
      });
      setNotice("Control actualizado. Los efectos en curso siguen visibles.");
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <>
      <div className="chat-header">
        <div>
          <Button
            className="mobile-back"
            aria-label="Volver a conversaciones"
            size="icon"
            variant="ghost"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
          <span className="contact-avatar">
            {str(contact.name ?? c.contact_name, "C")
              .slice(0, 2)
              .toUpperCase()}
          </span>
          <div>
            <h2>
              {str(
                contact.name ?? c.contact_name ?? c.name,
                shortId(c.contact_id),
              )}
            </h2>
            <small>
              {str(c.account_name, shortId(c.account_id))} ·{" "}
              <span>
                {environment === "SIMULATION" ? "Simulación" : "Real"}
              </span>
            </small>
          </div>
        </div>
        <Status value={c.stage ?? c.status} />
      </div>
      <div className="chat-controls">
        <Button
          size="sm"
          variant={controls.takeover ? "default" : "secondary"}
          disabled={mutation.isPending}
          onClick={() => {
            void control({ takeover: !controls.takeover });
          }}
        >
          <Hand />
          {controls.takeover ? "Retomar automatización" : "Tomar control"}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void control({ paused: !controls.paused });
          }}
        >
          {controls.paused ? <Play /> : <Pause />}
          {controls.paused ? "Reanudar" : "Pausar"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            void command("assign", { assigned_to: session.user.id });
          }}
        >
          <UserRound />
          Asignarme
        </Button>
      </div>
      <div className="conversation-sales-context"><strong>Vendedor: {String(object(object(c.seller_snapshot).agent).name??'Sin asignar')}</strong><span> · Origen: {String(c.agent_assignment_origin??'Asignación histórica')} · Etapa: {c.stage}</span>{c.agent_version_id&&<Link to={`/sales/agents/${c.agent_version_id}`}> Ver revisión del vendedor →</Link>}{c.workflow_version_id&&<Link to={`/sales/flows/${c.workflow_version_id}`} search={{node:String(flowState.waiting_node_id??flowState.node_id??'')}}> Abrir versión del flujo →</Link>}</div>
      <div className="chat-context">
        <div>
          <small>OFERTA FIJADA</small>
          <Link
            to="/catalog"
            search={{ product: str(offer.product_id ?? c.product_id, "") }}
          >
            {str(offer.name, "Ver catálogo")} ↗
          </Link>
          <span>
            {offer.base_amount_minor !== undefined
              ? money(
                  Number(offer.base_amount_minor),
                  str(offer.currency, "MXN"),
                )
              : shortId(c.offer_version_id)}
          </span>
        </div>
        <div>
          <small>ORIGEN</small>
          <strong>
            {str(
              c.source_type ??
                object(c.origin).classification ??
                object(c.origin).type,
              "Desconocido",
            )}
          </strong>
          <span>Evidencia conservada</span>
        </div>
        <div>
          <small>CONTROL</small>
          <strong>
            {controls.takeover
              ? "Humano"
              : controls.paused
                ? "Pausado"
                : "Automatización gobernada"}
          </strong>
          <span>
            {
              outbox.filter((o) =>
                ["SENDING", "UNKNOWN"].includes(o.status ?? ""),
              ).length
            }{" "}
            efectos en curso / inciertos
          </span>
        </div>
      </div>
      <div className="tabs compact">
        <button
          className={tab === "messages" ? "active" : ""}
          onClick={() => setTab("messages")}
        >
          Mensajes
        </button>
        <button
          className={tab === "events" ? "active" : ""}
          onClick={() => setTab("events")}
        >
          Timeline
        </button>
        <button
          className={tab === "outbox" ? "active" : ""}
          onClick={() => setTab("outbox")}
        >
          Salidas <span>{outbox.length}</span>
        </button>
        <button
          className={tab === "sale" ? "active" : ""}
          onClick={() => setTab("sale")}
        >
          Venta y permiso
        </button>
      </div>
      <div className="chat-body">
        {tab === "messages" ? (
          messages.length ? (
            messages.map((m) => (
              <div
                key={m.id}
                className={`message ${["outbound", "OUT", "OUTBOUND"].includes(m.direction ?? "") ? "outbound" : "inbound"}`}
              >
                <div>
                  {m.kind && m.kind !== "text" && <Badge>{m.kind}</Badge>}
                  <p>{str(m.text ?? m.content, m.asset_id ? "" : "Mensaje sin texto")}</p>
                  {Boolean(m.asset_id) && <AssetPreview assetId={str(m.asset_id)} inline />}
                  <small>
                    {date(m.occurred_at ?? m.created_at)}{" "}
                    {m.direction === "outbound" && <CheckCheck size={13} />}
                  </small>
                </div>
              </div>
            ))
          ) : (
            <Empty title="Aún no hay mensajes" />
          )
        ) : tab === "events" ? (
          <div className="timeline">
            {events.map((e) => (
              <div key={e.id}>
                <i />
                <div>
                  <strong>{e.event_type ?? e.type}</strong>
                  <small>{date(e.recorded_at ?? e.created_at)}</small>
                  <JsonDetail value={e.payload} title="Ver evidencia" />
                </div>
              </div>
            ))}
          </div>
        ) : tab === "outbox" ? (
          <>
            <Notice>
              Los efectos SENDING pueden llegar después de tomar control.
              UNKNOWN exige revisión y no se reenvía automáticamente.
            </Notice>
            <DataTable
              data={outbox}
              columns={[
                { key: "kind", title: "Tipo" },
                {
                  key: "status",
                  title: "Estado",
                  render: (r) => <Status value={r.status} />,
                },
                {
                  key: "created_at",
                  title: "Creado",
                  render: (r) => date(r.created_at),
                },
              ]}
            />
            {outbox.map((o) => (
              <Panel key={o.id} title={`${shortId(o.id)} · ${o.status}`}>
                <JsonDetail
                  value={o}
                  title="Contenido, causa, aprobación e intentos"
                />
                <div className="button-group">
                  {["READY", "BLOCKED"].includes(o.status ?? "") && (
                    <>
                      <ResourceForm
                        title="Editar salida pendiente"
                        path={`/outbox/${o.id}/edit`}
                        trigger="Editar propuesta"
                        fields={[
                          {
                            name: "text",
                            label: "Mensaje revisado",
                            type: "textarea",
                            required: true,
                            default: object(o.payload).text,
                          },
                          { name: "reason", label: "Motivo", required: true },
                        ]}
                        transform={(body) => ({
                          ...body,
                          expected_config_hash: o.config_hash,
                        })}
                      />
                      <ResourceForm
                        title="Aprobar versión exacta de la salida"
                        path={`/outbox/${o.id}/approve`}
                        trigger="Aprobar"
                        fields={[
                          {
                            name: "authorization_id",
                            label: "Autorización vigente",
                            type: "select",
                            required: true,
                            options: (authorizations.data ?? []).map((a) => ({
                              value: a.id,
                              label: shortId(a.id),
                            })),
                          },
                        ]}
                        transform={(body) => ({
                          ...body,
                          config_hash: o.config_hash,
                        })}
                      />
                      <ResourceForm
                        title="Cancelar salida pendiente"
                        path={`/outbox/${o.id}/cancel`}
                        trigger="Cancelar salida"
                        fields={[
                          { name: "reason", label: "Motivo", required: true },
                        ]}
                      />
                    </>
                  )}
                  {o.status === "UNKNOWN" && (
                    <ResourceForm
                      title="Resolver resultado incierto"
                      description="Se necesita evidencia del proveedor y aislamiento del intento anterior. No se reenvía automáticamente."
                      path={`/outbox/${o.id}/resolve`}
                      trigger="Revisar resultado incierto"
                      fields={[
                        {
                          name: "outcome",
                          label: "Resultado comprobado",
                          type: "select",
                          required: true,
                          options: [
                            {
                              value: "keep_unknown",
                              label: "Conservar incierto",
                            },
                            {
                              value: "confirm_sent",
                              label: "Envío confirmado por evidencia",
                            },
                            {
                              value: "confirm_not_sent",
                              label: "No enviado, comprobado",
                            },
                          ],
                        },
                        {
                          name: "evidence",
                          label: "Evidencia verificable",
                          type: "textarea",
                          required: true,
                        },
                        {
                          name: "provider_message_id",
                          label: "ID remoto observado (si existe)",
                        },
                      ]}
                    />
                  )}
                </div>
              </Panel>
            ))}
          </>
        ) : (
          <div className="sale-controls">
            {flowState.status === "HUMAN_REVIEW" && Boolean(workflowVersion) && Boolean(waitingNode) && (
              <Panel title="Aprobación pendiente del flujo">
                <Notice>
                  Revisa el contexto antes de continuar el paso {String(waitingNode)}.
                  La decisión queda vinculada a la versión activa del flujo.
                </Notice>
                <JsonDetail value={flowState} title="Estado y contexto del paso" />
                <ResourceForm
                  key={`${String(workflowVersion)}:${String(waitingNode)}`}
                  title="Aprobar el paso pendiente"
                  path={`/conversations/${c.id}/commands`}
                  trigger="Aprobar paso del flujo"
                  fields={[{ name: "reason", label: "Motivo de la aprobación", type: "textarea", required: true }]}
                  transform={(body) => ({
                    type: "approve_step",
                    expected_workflow_version_id: workflowVersion,
                    expected_node_id: waitingNode,
                    reason: body.reason,
                  })}
                />
              </Panel>
            )}
            <Panel title="Acciones de venta">
              <Button
                onClick={() => {
                  void command("commitment");
                }}
                disabled={mutation.isPending}
              >
                <FileCheck2 />
                Registrar compromiso
              </Button>
              {Boolean(order.id) && (
                <Link
                  to="/sales/orders"
                  search={{ order: String(order.id) }}
                  className="text-link"
                >
                  Abrir pedido {shortId(String(order.id))} ↗
                </Link>
              )}
              <ResourceForm
                title="Registrar comprobante"
                path={`/conversations/${c.id}/commands`}
                trigger="Registrar comprobante"
                fields={[
                  {
                    name: "asset_id",
                    label: "Evidencia privada",
                    type: "select",
                    required: true,
                    options: (assets.data ?? []).map((a) => ({
                      value: a.id,
                      label: a.name ?? a.id,
                    })),
                  },
                ]}
                transform={(body) => ({ ...body, type: "receipt_received" })}
              />
            </Panel>
            <Panel title="Consentimiento y baja">
              <Notice>
                Registrar evidencia no implica inferir consentimiento a partir
                del historial.
              </Notice>
              <ResourceForm
                title="Registrar consentimiento con evidencia"
                path={`/conversations/${c.id}/commands`}
                trigger="Registrar evidencia"
                fields={[
                  { name: "purpose", label: "Propósito", required: true },
                  { name: "source", label: "Fuente", required: true },
                  {
                    name: "observed_at",
                    label: "Fecha observada",
                    type: "datetime-local",
                    required: true,
                  },
                  {
                    name: "evidence",
                    label: "Evidencia del permiso",
                    type: "textarea",
                    required: true,
                  },
                ]}
                transform={(body) => ({
                  environment,
                  type: "consent",
                  consent: Object.fromEntries(
                    Object.entries(body).filter(
                      ([key]) => key !== "environment",
                    ),
                  ),
                })}
              />
              <Button
                variant="destructive"
                onClick={() => {
                  void command("opt_out", {
                    reason: "Baja registrada por operador desde inbox",
                  });
                }}
                disabled={mutation.isPending}
              >
                <Shield />
                Registrar baja global
              </Button>
              <JsonDetail
                value={contact}
                title="Identidad y permiso persistidos"
              />
            </Panel>
          </div>
        )}
      </div>
      <div className="chat-composer">
        <Feedback error={error} success={notice} />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void command("send_message", {
              text,
            });
          }}
        >
          <label><span>Mensaje</span><textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
            placeholder={
              environment === "SIMULATION"
                ? "Escribe un mensaje para el simulador…"
                : "Prepara una respuesta con autorización vigente…"
            }
            aria-label="Mensaje"
            rows={2}
          /></label>
          <Button
            type="submit"
            disabled={mutation.isPending || !text.trim()}
            aria-label="Proponer mensaje"
          >
            <Send size={18} />
          </Button>
        </form>
        <small>
          La salida pasa por los controles, el consentimiento y la autorización
          vigentes.
        </small>
      </div>
    </>
  );
}
export function LeadsPage() {
  const { environment } = useWorkspace();
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);
  const leads = useCollection(
    `/leads${params(environment, { q, limit: "50", offset: String(offset) })}`,
  );
  const [selected, setSelected] = useState<Row | null>(null);
  return (
    <>
      <PageHeader
        eyebrow="VENTAS / LEADS"
        title="Relaciones con memoria"
        description="Identidad, procedencia y permiso conservados a través de tus números."
        action={
          <div className="button-group">
            <ExportContacts />
            <ImportContacts />
          </div>
        }
      />
      <div className="toolbar">
        <div className="search-input">
          <Search size={16} />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOffset(0);
            }}
            placeholder="Buscar contacto…"
            aria-label="Buscar leads"
          />
        </div>
      </div>
      <Panel>
        <QueryState query={leads}>
          <DataTable
            data={leads.data ?? []}
            onSelect={setSelected}
            columns={[
              {
                key: "name",
                title: "Contacto",
                render: (r) => <strong>{r.name ?? shortId(r.id)}</strong>,
              },
              {
                key: "stage",
                title: "Etapa",
                render: (r) => <Status value={r.stage ?? r.status} />,
              },
              {
                key: "source",
                title: "Procedencia",
                render: (r) =>
                  str(
                    r.source ??
                      object(r.origin).classification ??
                      object(r.origin).type,
                    "Desconocida",
                  ),
              },
              {
                key: "consent",
                title: "Permiso",
                render: (r) => (
                  <Badge tone={r.consent ? "success" : "warning"}>
                    {r.consent ? "Evidencia registrada" : "No documentado"}
                  </Badge>
                ),
              },
              {
                key: "created_at",
                title: "Alta",
                render: (r) => date(r.created_at),
              },
            ]}
          />
        </QueryState>
        <Pagination
          offset={offset}
          total={leads.total}
          count={leads.data?.length ?? 0}
          onChange={setOffset}
        />
      </Panel>
      <Modal
        title="Identidad y procedencia"
        open={!!selected}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        <JsonDetail value={selected} />
      </Modal>
    </>
  );
}
function ImportContacts() {
  const { environment } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("");
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<Row | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useAction();
  async function check(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const parsed = JSON.parse(input);
      const data = (await mutation.mutateAsync({
        path: "/imports/preview",
        body: {
          source,
          environment,
          rows: Array.isArray(parsed) ? parsed : parsed.rows,
        },
      })) as Row;
      setPreview(data);
    } catch (e) {
      setError(e as Error);
    }
  }
  async function commit() {
    try {
      await mutation.mutateAsync({
        path: `/imports/${preview?.id}/commit`,
        body: {},
      });
      setOpen(false);
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
          setPreview(null);
        }}
      >
        <Upload />
        Importar contactos
      </Button>
      <Modal
        title="Importación con procedencia"
        description="Primero valida el contenido y los duplicados. El consentimiento ausente se conserva como desconocido."
        open={open}
        onOpenChange={setOpen}
      >
        {!preview ? (
          <form
            onSubmit={(e) => {
              void check(e);
            }}
          >
            <label className="field">
              <span>Fuente del archivo</span>
              <input
                value={source}
                onChange={(e) => setSource(e.target.value)}
                required
                placeholder="Exportación autorizada del CRM, fecha y alcance"
              />
            </label>
            <label className="field">
              <span>Archivo JSON de contactos</span>
              <input
                type="file"
                accept="application/json,.json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void file.text().then(setInput);
                }}
              />
            </label>
            <label className="field">
              <span>Filas a importar</span>
              <textarea
                className="code-input"
                rows={8}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                required
                placeholder={
                  '[{"name":"Contacto de prueba","external_id":"demo-001","messages":[]} ]'
                }
              />
            </label>
            <div className="form-footer">
              <Button type="submit" disabled={mutation.isPending}>
                Validar y previsualizar
              </Button>
            </div>
          </form>
        ) : (
          <>
            <Notice>
              Revisa errores, duplicados y la procedencia antes de confirmar.
              Los mensajes históricos no se convierten en permiso.
            </Notice>
            <JsonDetail
              value={preview}
              title="Preview, validación y deduplicación"
            />
            <div className="form-footer">
              <Button variant="secondary" onClick={() => setPreview(null)}>
                Corregir datos
              </Button>
              <Button
                onClick={() => {
                  void commit();
                }}
                disabled={mutation.isPending || !preview.id}
              >
                Confirmar importación
              </Button>
            </div>
          </>
        )}
        <Feedback error={error} />
      </Modal>
    </>
  );
}
export function OrdersPage() {
  const { environment } = useWorkspace();
  const search = useRouterState({ select: (s) => s.location.search }) as {
    order?: string;
  };
  const [selected, setSelected] = useState<string | null>(search.order ?? null);
  const [filter, setFilter] = useState("");
  const [offset, setOffset] = useState(0);
  const orders = useCollection(
    `/orders${params(environment, { status: filter, limit: "50", offset: String(offset) })}`,
    true,
    2000,
  );
  const receipts = useCollection(
    `/receipts${params(environment, { status: filter, limit: "50", offset: String(offset) })}`,
    true,
    2000,
  );
  const [tab, setTab] = useState("orders");
  return (
    <>
      <PageHeader
        eyebrow="VENTAS / PEDIDOS Y COBROS"
        title="Cada cobro, con evidencia"
        description="Compromiso, entrega y ventas respaldadas por comprobantes."
      />
      <Notice tone="warning">
        El comprobante aprobado registra la venta y puede liberar los beneficios de la oferta. Prueba/Falso excluyen el ingreso y conservan el historial.
      </Notice>
      <div className="tabs">
        <button
          className={tab === "orders" ? "active" : ""}
          onClick={() => {
            setTab("orders");
            setOffset(0);
            setFilter("");
          }}
        >
          <Wallet size={16} />
          Pedidos
        </button>
        <button
          className={tab === "receipts" ? "active" : ""}
          onClick={() => {
            setTab("receipts");
            setOffset(0);
            setFilter("");
          }}
        >
          <FileCheck2 size={16} />
          Comprobantes
        </button>
      </div>
      <div className="toolbar">
        <select
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setOffset(0);
          }}
          aria-label="Filtrar pedidos"
        >
          <option value="">Todos los estados</option>
          {(tab === "orders"
            ? [
                "OFFERED",
                "COMMITTED",
                "RECEIPT_RECEIVED",
                "RECEIPT_APPROVED",
                "RECONCILED",
              ]
            : ["PENDING", "HUMAN_REVIEW", "APPROVED", "REJECTED"]
          ).map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <Panel>
        <QueryState query={tab === "orders" ? orders : receipts}>
          <DataTable
            data={(tab === "orders" ? orders.data : receipts.data) ?? []}
            onSelect={(row) =>
              setSelected(tab === "orders" ? row.id : str(row.order_id))
            }
            columns={[
              {
                key: "id",
                title: tab === "orders" ? "Pedido" : "Comprobante",
                render: (r) => (
                  <code className="table-primary">{shortId(r.id)}</code>
                ),
              },
              {
                key: "amount_minor",
                title: "Importe",
                render: (r) => receiptMoney(r),
              },
              {
                key: "status",
                title: "Estado",
                render: (r) => <Status value={r.status} />,
              },
              {
                key: "offer_version_id",
                title: "Oferta",
                render: (r) => shortId(r.offer_version_id),
              },
              {
                key: "created_at",
                title: "Fecha",
                render: (r) => date(r.created_at),
              },
            ]}
          />
        </QueryState>
        <Pagination
          offset={offset}
          total={tab === "orders" ? orders.total : receipts.total}
          count={(tab === "orders" ? orders.data : receipts.data)?.length ?? 0}
          onChange={setOffset}
        />
      </Panel>
      {selected && (
        <OrderDetail id={selected} onClose={() => setSelected(null)} />
      )}
    </>
  );
}
export function OrderDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { environment, session } = useWorkspace();
  const order = useData<Row>(`/orders/${id}${params(environment)}`, true, 1000);
  const receipts = useData(
    `/receipts${params(environment, { order_id: id })}`,
    true,
    1000,
  );
  const fulfillments = useData(
    `/fulfillments${params(environment, { order_id: id })}`,
    true,
    1000,
  );
  const contributions = useData(`/orders/${id}/contributions${params(environment)}`);
  const saleHistory = useData(`/orders/${id}/sale-history${params(environment)}`);
  const [reviewId, setReviewId] = useState<string | null>(null);
  // Keep the selection stable while queued worker results refresh the receipt.
  const review = receipts.data?.find((receipt) => receipt.id === reviewId) ?? null;
  const [success, setSuccess] = useState("");
  const row = order.data;
  const canReview = ["owner", "operator", "reconciler"].includes(session.role);
  return (
    <Modal
      title="Pedido y evidencia comercial"
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <QueryState query={order}>
        {row && (
          <>
            <div className="order-summary">
              <div>
                <small>IMPORTE DE LA OFERTA</small>
                <h2>{money(row.amount_minor, row.currency)}</h2>
              </div>
              <Status value={row.status} />
            </div>
            <div className="record-meta">
              <code>{shortId(row.id)}</code>
              <Badge>
                {environment === "SIMULATION" ? "Simulación" : "Real"}
              </Badge>
              <Badge>Oferta {shortId(row.offer_version_id)}</Badge>
            </div>
            <Panel title="Comprobantes">
              <DataTable
                data={(receipts.data ?? []).filter((r) => r.order_id === id)}
                onSelect={(receipt) => setReviewId(receipt.id)}
                columns={[
                  {
                    key: "id",
                    title: "Referencia",
                    render: (r) => shortId(r.id),
                  },
                  {
                    key: "status",
                    title: "Revisión",
                    render: (r) => <Status value={r.status} />,
                  },
                  {
                    key: "amount_minor",
                    title: "Observado",
                    render: (r) => receiptMoney(r),
                  },
                ]}
              />
            </Panel>
            {review && (
              <div className="review-box">
                <h3>Revisar documento {shortId(review.id)}</h3>
                <JsonDetail
                  value={review}
                  title="Extracción, anomalías y evidencia"
                />
                {Boolean(review.asset_id) && (
                  <Button variant="secondary" onClick={()=>void api<{url:string}>(`/receipts/${review.id}/access${params(environment)}`).then(access=>window.open(access.url,"_blank","noopener,noreferrer"))}>Ver evidencia privada ↗</Button>
                )}
                {canReview && <ResourceForm
                  title="Decisión documental"
                  path={`/receipts/${review.id}/review`}
                  trigger="Registrar revisión"
                  fields={[
                    {
                      name: "decision",
                      label: "Decisión",
                      type: "select",
                      required: true,
                      options: [
                        { value: "APPROVED", label: "Aprobar documento" },
                        { value: "REJECTED", label: "Rechazar documento" },
                        {
                          value: "HUMAN_REVIEW",
                          label: "Requiere revisión adicional",
                        },
                      ],
                    },
                    {
                      name: "amount",
                      label: "Importe aceptado",
                      advanced: false,
                      type: "number",
                      min: 0.01,
                      step: 0.01,
                      hint: "Usa el importe en la moneda observada, por ejemplo 97.00 MXN. Si se omite, se conserva el importe extraído del comprobante.",
                    },
                    {
                      name: "currency",
                      label: "Moneda observada por revisión humana",
                      advanced: false,
                      placeholder: "MXN",
                    },
                    {name:"payment_key",label:"Clave de pago adicional (opcional)",hint:"Déjala vacía para el pago principal. Sólo usa otra clave para un aporte real distinto."},
                    {name:"replaces_receipt_id",label:"Comprobante sustituido (opcional)",hint:"ID de evidencia anterior del mismo pago; no agrega ingreso."},
                    {
                      name: "reason",
                      label: "Motivo y evidencia",
                      type: "textarea",
                      required: true,
                    },
                  ]}
                  transform={({ amount, ...body }) => {
                    const amountMinor = amount === undefined ? undefined : Math.round(Number(amount) * 100);
                    if (amount !== undefined && (typeof amount !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor! < 1 || Math.abs(amount * 100 - amountMinor!) > 0.000001)) {
                      throw new Error("Usa un importe positivo de hasta dos decimales.");
                    }
                    return { ...body, ...(amountMinor === undefined ? {} : { amount_minor: amountMinor }), expected_version: review.version };
                  }}
                  onSaved={() => {
                    setReviewId(null);
                    setSuccess("Revisión registrada para procesarse.");
                  }}
                />}
                {canReview && <ResourceForm title="Clasificar comprobante" trigger={review.commercial_classification === "FALSE" ? "Restaurar comprobante" : "Marcar como falso"} path={`/receipts/${review.id}/classification`} fields={[{name:"reason",label:"Motivo",type:"textarea",required:true}]} transform={body=>({...body,classification:review.commercial_classification === "FALSE"?"GENUINE":"FALSE",expected_version:review.version})} onSaved={()=>setReviewId(null)} />}
              </div>
            )}
            <Panel title="Entrega por material">
              <DataTable
                data={(fulfillments.data ?? []).filter(
                  (f) => f.order_id === id,
                )}
                columns={[
                  {
                    key: "asset_id",
                    title: "Material",
                    render: (r) => shortId(str(r.asset_id)),
                  },
                  { key: "release_on", title: "Condición" },
                  {
                    key: "status",
                    title: "Estado",
                    render: (r) => <Status value={r.status} />,
                  },
                ]}
              />
            </Panel>
            {canReview && <ResourceForm title="Clasificación comercial" trigger={row.commercial_classification === "TEST" ? "Restaurar venta comercial" : "Marcar como prueba"} path={`/orders/${row.id}/classification`} fields={[{name:"reason",label:"Motivo",type:"textarea",required:true}]} transform={body=>({...body,classification:row.commercial_classification === "TEST"?"COMMERCIAL":"TEST",expected_version:row.version})} />}
            <Panel title="Ingreso reconocido por comprobante"><strong>{money(Number(row.sale_amount_minor??0),row.currency)}</strong><p>La aprobación del comprobante registra el ingreso. Prueba/Falso corrige el periodo original.</p><Badge>{String(row.sale_status??"Pendiente")}</Badge><JsonDetail value={contributions.data??[]} title="Contribuciones, fecha efectiva y revisión" /></Panel>
            <JsonDetail value={saleHistory.data??[]} title="Historial de reconocimiento y correcciones" />
            {canReview && <ResourceForm title="Corregir atribución con evidencia" trigger="Corregir origen" path={`/orders/${row.id}/attribution`} fields={[{name:"meta_ad_account_id",label:"Cuenta publicitaria",placeholder:"act_…",required:true},{name:"ad_id",label:"ID del anuncio",required:true},{name:"observed_at",label:"Fecha de la evidencia",type:"datetime-local",required:true},{name:"evidence_ref",label:"Referencia de evidencia",required:true},{name:"reason",label:"Motivo",type:"textarea",required:true}]} transform={body=>({...body,expected_version:row.version})} />}
            <Feedback success={success} />
            <JsonDetail
              value={row}
              title="Oferta histórica, atribución y trazabilidad"
            />
          </>
        )}
      </QueryState>
    </Modal>
  );
}

function ExportContacts() {
  const { environment } = useWorkspace();
  const [error, setError] = useState<Error | null>(null);
  async function download() {
    try {
      const result = await api<unknown>(
        `/contacts/export${params(environment)}`,
      );
      downloadJson(result, `contactos-${environment.toLowerCase()}.json`);
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <div>
      <Button
        variant="secondary"
        onClick={() => {
          void download();
        }}
      >
        Exportar con procedencia
      </Button>
      <Feedback error={error} />
    </div>
  );
}
