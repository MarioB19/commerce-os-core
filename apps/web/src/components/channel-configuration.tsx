import { useId, useState, type FormEvent } from "react";
import { Badge, Feedback, Notice, Panel, QueryState, useWorkspace } from "./shared";
import { Button } from "./ui/button";
import { params, str, useAction, useData, type Row } from "../lib/api";
import { date } from "../lib/utils";

interface Assignment { assignment_id?: string; assignment_revision?: number; product_id?: string; offer_version_id?: string; workflow_version_id?: string; agent_version_id?: string; gateway_ref?: string }
interface Setup {
  account_version: number;
  configuration_version: number;
  options: { products: Row[]; offers: Row[]; workflows: Row[]; agents: Row[]; gateways: { id: string; name: string; provider: string }[] };
  effective_assignment: Assignment;
  checks: { key: string; label: string; ok: boolean; message?: string; href?: string }[];
  ready: boolean;
  blockers: string[];
  sending_enabled: boolean;
  authorization?: { id: string; expires_at: string; scope: { max_messages?: number; contact_ids?: string[]; allow_automation?: boolean; recipient_mode?: "selected_contacts" | "new_inbound" }; revoked_at?: string | null } | null;
}

export function ChannelConfiguration({ account }: { account: Row }) {
  const { environment, session } = useWorkspace();
  const setup = useData<Setup>(`/channel-accounts/${account.id}/setup${params(environment)}`, session.role === "owner");
  if (session.role !== "owner") return <Notice>El administrador asigna el producto y autoriza la operación de este número.</Notice>;
  return <Panel title="Preparar este número" description="Elige qué vende, revisa los requisitos y define quién puede recibir mensajes." action={<Button variant="secondary" size="sm" onClick={() => void setup.refetch()}>Actualizar comprobaciones</Button>}>
    <QueryState query={setup}>
      {setup.data && <ChannelSetupForm key={`${account.id}:${setup.data.account_version}:${setup.data.configuration_version}`} account={account} setup={setup.data} refresh={() => void setup.refetch()} />}
    </QueryState>
  </Panel>;
}

function label(row: Row) { return `${str(row.name ?? row.title, "Sin nombre")}${row.version ? ` · v${row.version}` : ""}`; }
function localDateTime(value: Date) { return new Date(value.getTime() - value.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }

function ChannelSetupForm({ account, setup, refresh }: { account: Row; setup: Setup; refresh: () => void }) {
  const id = useId();
  const [assignment, setAssignment] = useState<Assignment>(setup.effective_assignment);
  const [assignmentReason, setAssignmentReason] = useState("");
  const [operationReason, setOperationReason] = useState("");
  const [confirmActivation, setConfirmActivation] = useState(false);
  const [showAuthorization, setShowAuthorization] = useState(false);
  const [success, setSuccess] = useState("");
  const mutation = useAction();
  const dirty = (Object.keys(assignment) as (keyof Assignment)[]).some((key) => (assignment[key] ?? "") !== (setup.effective_assignment[key] ?? ""));
  const product = setup.options.products.find((item) => item.id === assignment.product_id);
  const productLineage = product?.lineage_id ?? product?.id;
  const offers = setup.options.offers.filter((offer) => offer.status === "PUBLISHED" && (offer.product_lineage_id ?? offer.product_id) === productLineage);
  const offer = setup.options.offers.find((item) => item.id === assignment.offer_version_id);
  const offerLineage = offer?.lineage_id ?? offer?.id;
  const workflows = setup.options.workflows.filter((workflow) => workflow.status === "PUBLISHED" && (!workflow.product_id || (workflow.product_lineage_id ?? workflow.product_id) === productLineage) && (!workflow.offer_version_id || (workflow.offer_lineage_id ?? workflow.offer_version_id) === offerLineage));
  const agents = setup.options.agents.filter((agent) => !agent.product_id || agent.product_id === assignment.product_id);
  const gateways = setup.options.gateways.filter((gateway) => gateway.provider === account.provider);
  const canChangeGateway = ["DISCONNECTED", "STOPPED", "FAILED"].includes(str(account.status));
  const canAct = setup.ready && !dirty;
  const active = setup.sending_enabled;
  const authorization = setup.authorization;
  const validAuthorization = authorization && !authorization.revoked_at && Date.parse(authorization.expires_at) > Date.now();
  async function saveAssignment(event: FormEvent) {
    event.preventDefault(); setSuccess("");
    try {
      await mutation.mutateAsync({ path: `/channel-accounts/${account.id}/setup`, method: "PATCH", body: { expected_version: setup.account_version, product_id: assignment.product_id, offer_version_id: assignment.offer_version_id, workflow_version_id: assignment.workflow_version_id, agent_version_id: assignment.agent_version_id || null, gateway_ref: assignment.gateway_ref || undefined, reason: assignmentReason.trim() } });
      setSuccess("Asignación guardada. Las conversaciones nuevas usarán estas versiones.");
    } catch { /* Server checks the saved revision; conflicts require review. */ }
  }
  async function activate() {
    if (!canAct || !confirmActivation) return;
    setSuccess("");
    try {
      await mutation.mutateAsync({ path: `/channel-accounts/${account.id}/activate`, body: { expected_version: setup.account_version, configuration_version: setup.configuration_version, reason: operationReason.trim(), confirmation: "ENABLE_REAL_ACCOUNT" } });
      setSuccess("Número habilitado. Define un alcance autorizado para que pueda operar.");
    } catch { /* Feedback below. */ }
  }
  async function deactivate() {
    setSuccess("");
    try {
      await mutation.mutateAsync({ path: `/channel-accounts/${account.id}/deactivate`, body: { expected_version: setup.account_version, reason: operationReason.trim() } });
      setSuccess("Número deshabilitado para nuevos envíos.");
    } catch { /* Feedback below. */ }
  }
  async function revoke() {
    if (!authorization) return;
    setSuccess("");
    try {
      await mutation.mutateAsync({ path: `/operation-authorizations/${authorization.id}`, method: "DELETE" });
      setSuccess("Autorización revocada.");
    } catch { /* Feedback below. */ }
  }
  return <>
    <form onSubmit={(event) => void saveAssignment(event)}>
      <h3>1. Producto y versiones</h3>
      <div className="form-grid">
        <label className="field" htmlFor={`${id}-product`}><span>Producto de este número</span><select aria-label="Producto de este número" id={`${id}-product`} required value={assignment.product_id ?? ""} onChange={(event) => setAssignment({ ...assignment, product_id: event.target.value, offer_version_id: "", workflow_version_id: "", agent_version_id: "" })}><option value="">Selecciona un producto</option>{setup.options.products.map((product) => <option key={product.id} value={product.id}>{label(product)}</option>)}</select></label>
        <label className="field" htmlFor={`${id}-offer`}><span>Oferta publicada</span><select aria-label="Oferta publicada" id={`${id}-offer`} required disabled={!assignment.product_id} value={assignment.offer_version_id ?? ""} onChange={(event) => { const offer = offers.find((item) => item.id === event.target.value); setAssignment({ ...assignment, offer_version_id: event.target.value, workflow_version_id: offer?.workflow_version_id ?? "", agent_version_id: offer?.agent_version_id ?? "" }); }}><option value="">Selecciona una oferta</option>{offers.map((offer) => <option key={offer.id} value={offer.id}>{label(offer)}</option>)}</select><small>Las condiciones y materiales quedan vinculados a esta versión.</small></label>
        <label className="field" htmlFor={`${id}-workflow`}><span>Flujo publicado</span><select aria-label="Flujo publicado" id={`${id}-workflow`} required disabled={!assignment.offer_version_id} value={assignment.workflow_version_id ?? ""} onChange={(event) => setAssignment({ ...assignment, workflow_version_id: event.target.value })}><option value="">Selecciona un flujo</option>{workflows.map((workflow) => <option key={workflow.id} value={workflow.id}>{label(workflow)}</option>)}</select></label>
        <label className="field" htmlFor={`${id}-agent`}><span>Agente de venta</span><select aria-label="Agente de venta" id={`${id}-agent`} value={assignment.agent_version_id ?? ""} onChange={(event) => setAssignment({ ...assignment, agent_version_id: event.target.value })}><option value="">Usar agente de la oferta o producto</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{label(agent)}</option>)}</select><small>Un flujo con pasos de IA necesita un agente compatible. Sin uno heredado, el flujo funciona sólo con sus reglas deterministas.</small></label>
        {account.provider !== "simulator" && <label className="field field-wide" htmlFor={`${id}-gateway`}><span>Conexión de WhatsApp</span><select aria-label="Conexión de WhatsApp" id={`${id}-gateway`} required disabled={!canChangeGateway} value={assignment.gateway_ref ?? ""} onChange={(event) => setAssignment({ ...assignment, gateway_ref: event.target.value })}><option value="">Selecciona la conexión configurada</option>{gateways.map((gateway) => <option key={gateway.id} value={gateway.id}>{gateway.name}</option>)}</select><small>{!canChangeGateway && "Desconecta el número para cambiar su conexión. "}Gestiona sus credenciales desde <a href="/settings">Sistema → Conexiones</a>.</small></label>}
      </div>
      <p className="panel-copy"><a href="/catalog">Abrir productos y ofertas</a> · <a href="/sales/flows">Abrir flujos y agentes</a></p>
      <label className="field" htmlFor={`${id}-assignment-reason`}><span>Motivo de la asignación</span><input id={`${id}-assignment-reason`} required minLength={3} maxLength={2000} value={assignmentReason} onChange={(event) => setAssignmentReason(event.target.value)} /></label>
      <Button type="submit" disabled={mutation.isPending || assignmentReason.trim().length < 3 || !assignment.product_id || !assignment.offer_version_id || !assignment.workflow_version_id}>Guardar asignación</Button>
    </form>

    <h3>2. Comprobar y habilitar</h3>
    {dirty && <Notice>Guarda la asignación para comprobar las versiones que acabas de elegir. Los resultados siguientes corresponden a la configuración guardada.</Notice>}
    <ul aria-label="Requisitos para habilitar el número">
      {setup.checks.map((check) => <li key={check.key}><Badge tone={check.ok ? "success" : "warning"}>{check.ok ? "Listo" : "Pendiente"}</Badge> <strong>{check.label}</strong>{check.message && <p>{check.message}</p>}{!check.ok && check.href?.startsWith("/") && !check.href.startsWith("//") && <a href={check.href}>Resolver {check.label.toLowerCase()}</a>}</li>)}
    </ul>
    {!setup.ready && !setup.checks.some((check) => !check.ok) && <Notice>La comprobación del servidor encontró requisitos pendientes. Actualiza las comprobaciones antes de continuar.</Notice>}
    <div className="record-meta"><Badge tone={active ? "success" : "warning"}>{active ? "Número habilitado" : "Número deshabilitado para enviar"}</Badge><span>Configuración revisada: {setup.configuration_version}</span></div>
    <label className="field" htmlFor={`${id}-operation-reason`}><span>Motivo de habilitación o desactivación</span><input id={`${id}-operation-reason`} minLength={3} maxLength={2000} value={operationReason} onChange={(event) => setOperationReason(event.target.value)} /></label>
    {active ? <Button variant="destructive" disabled={mutation.isPending || operationReason.trim().length < 3} onClick={() => void deactivate()}>Deshabilitar este número</Button> : <>
      <label className="field"><span><input type="checkbox" checked={confirmActivation} onChange={(event) => setConfirmActivation(event.target.checked)} disabled={!canAct} /> Revisé la configuración y quiero habilitar este número para operar con alcance autorizado.</span></label>
      <Button disabled={!canAct || !confirmActivation || mutation.isPending || operationReason.trim().length < 3} onClick={() => void activate()}>Habilitar este número</Button>
    </>}

    <h3>3. Autorizar un alcance limitado</h3>
    <p className="panel-copy">Selecciona contactos que ya hayan conversado con este número y tengan permiso, un máximo de mensajes y una vigencia. Autorizar permite actuar dentro de ese alcance; no envía un mensaje por sí mismo.</p>
    {validAuthorization && <Notice><p>Autorización vigente hasta {date(authorization.expires_at)} · Máximo {authorization.scope.max_messages ?? "definido"} mensajes · {authorization.scope.recipient_mode === "new_inbound" ? "Nuevas conversaciones entrantes" : `${authorization.scope.contact_ids?.length ?? 0} contactos seleccionados`} · {authorization.scope.allow_automation ? "Flujo automático permitido" : "Operación manual"}.</p><Button variant="secondary" disabled={mutation.isPending} onClick={() => void revoke()}>Revocar autorización</Button></Notice>}
    {!active && <Notice>Primero completa las comprobaciones y habilita este número.</Notice>}
    <Button variant="secondary" disabled={!active || !canAct || mutation.isPending} onClick={() => setShowAuthorization(!showAuthorization)}>{showAuthorization ? "Cerrar formulario de alcance" : validAuthorization ? "Definir nueva autorización" : "Definir alcance autorizado"}</Button>
    {showAuthorization && active && <AuthorizationForm account={account} setup={setup} ready={canAct} onSaved={() => { refresh(); setShowAuthorization(false); setSuccess("Alcance autorizado y guardado. No se envió ningún mensaje desde este formulario."); }} />}
    <Feedback error={mutation.error} success={success || false} />
  </>;
}

function AuthorizationForm({ account, setup, ready, onSaved }: { account: Row; setup: Setup; ready: boolean; onSaved: () => void }) {
  const { environment } = useWorkspace();
  const id = useId();
  const [search, setSearch] = useState("");
  const [recipientMode, setRecipientMode] = useState<"selected_contacts" | "new_inbound">("selected_contacts");
  const contacts = useData<Row[]>(`/contacts${params(environment, { limit: "200", q: search || undefined })}`, recipientMode === "selected_contacts");
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [maxMessages, setMaxMessages] = useState(1);
  const [expires, setExpires] = useState(() => localDateTime(new Date(Date.now() + 3600000)));
  const [automation, setAutomation] = useState(false);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const mutation = useAction();
  async function authorize(event: FormEvent) {
    event.preventDefault();
    if (!ready || !confirmed || (recipientMode === "selected_contacts" && (!Object.keys(selected).length || Object.keys(selected).length > 200))) return;
    try { await mutation.mutateAsync({ path: setup.effective_assignment.assignment_id ? `/assignments/${setup.effective_assignment.assignment_id}/authorize` : `/channel-accounts/${account.id}/authorize`, body: { expected_version: setup.effective_assignment.assignment_revision ?? setup.account_version, configuration_version: setup.configuration_version, recipient_mode: recipientMode, contact_ids: recipientMode === "selected_contacts" ? Object.keys(selected) : [], max_messages: maxMessages, expires_at: new Date(expires).toISOString(), allow_automation: automation, reason: reason.trim(), confirmation: "AUTHORIZE_REAL_SCOPE" } }); onSaved(); } catch { /* No automatic retries after a version conflict. */ }
  }
  return <form onSubmit={(event) => void authorize(event)} onChange={() => setConfirmed(false)}>
    <label className="field" htmlFor={`${id}-recipient-mode`}><span>Destinatarios del alcance</span><select aria-label="Destinatarios del alcance" id={`${id}-recipient-mode`} value={recipientMode} onChange={(event) => setRecipientMode(event.target.value as "selected_contacts" | "new_inbound")}><option value="selected_contacts">Contactos seleccionados</option><option value="new_inbound">Nuevas conversaciones entrantes</option></select></label>
    {recipientMode === "selected_contacts" ? <>
    <label className="field" htmlFor={`${id}-search`}><span>Buscar destinatarios por nombre</span><input id={`${id}-search`} type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <QueryState query={contacts}>
      {!contacts.data?.length && <Notice>No hay contactos para seleccionar. Registra el contacto y su consentimiento desde Ventas antes de autorizar mensajes.</Notice>}
      <fieldset><legend>Destinatarios permitidos</legend>{contacts.data?.map((contact) => <label className="field" key={contact.id}><span><input type="checkbox" checked={contact.id in selected} onChange={(event) => setSelected((current) => { const next = { ...current }; if (event.target.checked) next[contact.id] = str(contact.name, "Contacto sin nombre"); else delete next[contact.id]; return next; })} /> {str(contact.name, "Contacto sin nombre")}</span></label>)}</fieldset>
    </QueryState>
    <p className="panel-copy">Hasta 200 contactos por autorización y 200 resultados por búsqueda. {Object.keys(selected).length} seleccionados{Object.keys(selected).length ? `: ${Object.values(selected).join(", ")}` : "."}</p>
    {!!Object.keys(selected).length && <Button type="button" variant="secondary" size="sm" onClick={() => { setSelected({}); setConfirmed(false); }}>Limpiar selección</Button>}
    </> : <Notice tone="warning">Este alcance atiende conversaciones iniciadas por el contacto después de autorizarlo, dentro de su ventana de atención de 24 horas. No incluye la base histórica ni permite iniciar conversaciones salientes. El máximo total de mensajes y el vencimiento se aplican a todo el alcance.</Notice>}
    <div className="form-grid">
      <label className="field" htmlFor={`${id}-limit`}><span>Máximo total de mensajes</span><input id={`${id}-limit`} type="number" min={1} max={10000} required value={maxMessages} onChange={(event) => setMaxMessages(Number(event.target.value))} /></label>
      <label className="field" htmlFor={`${id}-expires`}><span>Vigente hasta</span><input aria-label="Vigente hasta" id={`${id}-expires`} type="datetime-local" required min={localDateTime(new Date())} max={localDateTime(new Date(Date.now() + (setup.effective_assignment.assignment_id ? 366 : 7) * 86400000))} value={expires} onChange={(event) => setExpires(event.target.value)} /><small>Hora local de tu navegador. Máximo {setup.effective_assignment.assignment_id ? "366 días para esta asignación" : "siete días"}.</small></label>
    </div>
    <label className="field"><span><input type="checkbox" checked={automation} onChange={(event) => setAutomation(event.target.checked)} /> Permitir respuestas y seguimientos automáticos del flujo asignado dentro de este alcance.</span></label>
    <label className="field" htmlFor={`${id}-reason`}><span>Propósito y motivo de la autorización</span><textarea id={`${id}-reason`} required minLength={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
    <Notice>{recipientMode === "selected_contacts" ? "El contacto debe tener una conversación observada en este número. Seleccionarlo no registra su consentimiento." : "Sólo se permiten respuestas a nuevos contactos entrantes dentro de su ventana vigente."} El servidor comprueba consentimiento, bajas, identidad y límites antes de cada envío.</Notice>
    <label className="field"><span><input type="checkbox" checked={confirmed} onChange={(event) => { event.stopPropagation(); setConfirmed(event.target.checked); }} /> Confirmo estos destinatarios, vigencia, límite y permiso de automatización.</span></label>
    <Feedback error={mutation.error} />
    <Button type="submit" disabled={!ready || !confirmed || (recipientMode === "selected_contacts" && (!Object.keys(selected).length || Object.keys(selected).length > 200)) || reason.trim().length < 3 || mutation.isPending}>{mutation.isPending ? "Autorizando…" : "Autorizar este alcance"}</Button>
  </form>;
}
