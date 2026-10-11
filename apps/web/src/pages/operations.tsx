import {SessionContinuity} from '../components/session-continuity';
import {NumberHealthCard} from '../components/number-health';
import { ReadinessPanel } from "../components/readiness";
import { WarmupOverview } from "../components/warmup-configuration";
import {Link,useRouterState} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  Download,
  ListFilter,
  Pause,
  QrCode,
  ShieldCheck,
  Smartphone,
  X,
} from "lucide-react";
import {
  Badge,
  ConfirmAction,
  DataTable,
  Empty,
  Feedback,
  JsonDetail,
  Notice,
  PageHeader,
  Panel,
  QueryState,
  ResourceForm,
  Status,
  useWorkspace,
  type Field,
} from "../components/shared";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/dialog";
import {
  api,
  object,
  params,
  str,
  useAction,
  useData,
  type Row,
} from "../lib/api";
import { date, downloadJson, shortId } from "../lib/utils";
import { ServiceTokenCreate, SettingsConfiguration } from "./settings-configuration";
import { ChannelConfiguration } from "../components/channel-configuration";
const options = (data: Row[] | undefined) =>
  data?.map((r) => ({ value: r.id, label: r.name ?? r.alias ?? r.id })) ?? [];
export function CampaignsPage() {
  const { environment } = useWorkspace();
  const campaigns = useData(
    `/message-campaigns${params(environment)}`,
    true,
    2000,
  );
  const accounts = useData(`/channel-accounts${params(environment)}`);
  const [selected, setSelected] = useState<Row | null>(null);
  const [preview, setPreview] = useState<unknown>(null);
  const mutation = useAction();
  const authorizations = useData<Row[]>(
    `/operation-authorizations${params(environment)}`,
  );
  const fields: Field[] = [
    { name: "name", label: "Nombre de la campaña", required: true },
    {
      name: "account_id",
      label: "Número de origen",
      type: "select",
      required: true,
      options: options(accounts.data),
    },
    { name: "message", label: "Mensaje", type: "textarea", required: true },
    {
      name: "segment",
      label: "Segmentación",
      type: "json",
      default: {},
      hint: "Filtros: stage, tag, product_id o contact_ids. Sólo contactos con permiso vigente.",
    },
    {
      name: "max_recipients",
      label: "Máximo de destinatarios",
      type: "number",
      default: 500,
      min: 1,
    },
  ];
  async function action(type: string) {
    if (!selected) return;
    try {
      const data = await mutation.mutateAsync({
        path: `/message-campaigns/${selected.id}/${type}`,
        body:
          type === "cancel"
            ? { reason: "Cancelación manual desde consola" }
            : {},
      });
      if (type === "preview") setPreview(data);
    } catch {
      /* shown below */
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="VENTAS / SEGUIMIENTOS Y MENSAJES"
        title="Seguimientos con permiso"
        description="Segmenta, revisa exclusiones y programa una versión concreta de tu mensaje."
        action={
          <ResourceForm
            title="Nueva campaña de mensajes"
            path="/message-campaigns"
            fields={fields}
            trigger="Crear borrador"
          />
        }
      />
      <Notice>
        Estas campañas pertenecen a Ventas. La adquisición publicitaria se
        gestiona por separado. La programación exige autorización de la versión
        y reevaluación justo antes del envío.
      </Notice>
      <Panel>
        <QueryState query={campaigns}>
          <DataTable
            data={campaigns.data ?? []}
            onSelect={(r) => {
              setSelected(r);
              setPreview(null);
            }}
            columns={[
              {
                key: "name",
                title: "Campaña",
                render: (r) => <strong>{r.name}</strong>,
              },
              {
                key: "status",
                title: "Estado",
                render: (r) => <Status value={r.status} />,
              },
              {
                key: "account_id",
                title: "Número",
                render: (r) =>
                  accounts.data?.find((a) => a.id === r.account_id)?.name ??
                  shortId(r.account_id),
              },
              { key: "max_recipients", title: "Límite" },
              {
                key: "scheduled_at",
                title: "Programación",
                render: (r) => date(r.scheduled_at),
              },
            ]}
          />
        </QueryState>
      </Panel>
      <Panel
        title="Esperas y seguimientos persistentes"
        description="Se cancelan o reevalúan por respuesta, pago, takeover y baja."
      >
        <TimerList />
      </Panel>
      <Modal
        title={selected?.name ?? "Campaña de mensajes"}
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <>
            <Status value={selected.status} />
            <blockquote className="message-preview">
              {str(selected.message)}
            </blockquote>
            <div className="button-group">
              <Button
                variant="secondary"
                onClick={() => {
                  void action("preview");
                }}
                disabled={mutation.isPending}
              >
                <ListFilter />
                Previsualizar audiencia
              </Button>
              <ResourceForm
                title="Editar borrador"
                path={`/message-campaigns/${selected.id}`}
                fields={fields}
                method="PATCH"
                initial={selected}
                trigger="Editar"
              />
              <Button
                variant="secondary"
                onClick={() => {
                  void action("cancel");
                }}
                disabled={mutation.isPending}
              >
                <X />
                Cancelar pendientes
              </Button>
            </div>
            {preview !== null && (
              <JsonDetail
                value={preview}
                title="Destinatarios, exclusiones y motivos"
              />
            )}
            <ResourceForm
              title="Programar campaña autorizada"
              description="La autorización debe cubrir cuenta, versión, audiencia, límites y vigencia."
              path={`/message-campaigns/${selected.id}/schedule`}
              trigger="Programar"
              fields={[
                {
                  name: "scheduled_at",
                  label: "Fecha de ejecución",
                  type: "datetime-local",
                  required: true,
                },
                {
                  name: "authorization_id",
                  label: "Autorización vigente",
                  type: "select",
                  required: true,
                  options: (authorizations.data ?? []).map((a) => ({
                    value: a.id,
                    label: `${shortId(a.id)} · vence ${date(a.expires_at)}`,
                  })),
                },
              ]}
              transform={(body) => ({
                ...body,
                expected_version: selected.version,
              })}
            />
            <Feedback error={mutation.error} />
            <JsonDetail value={selected} title="Instantánea del borrador" />
          </>
        )}
      </Modal>
    </>
  );
}
function TimerList() {
  const { environment } = useWorkspace();
  const timers = useData(`/timers${params(environment)}`, true, 2000);
  return (
    <QueryState query={timers}>
      <DataTable
        data={timers.data ?? []}
        columns={[
          { key: "kind", title: "Seguimiento" },
          {
            key: "conversation_id",
            title: "Conversación",
            render: (r) => shortId(r.conversation_id),
          },
          {
            key: "due_at",
            title: "Vencimiento",
            render: (r) => date(str(r.due_at, "")),
          },
          {
            key: "status",
            title: "Estado",
            render: (r) => <Status value={r.status} />,
          },
        ]}
      />
    </QueryState>
  );
}
export function ChannelsPage() {
  const { environment } = useWorkspace();
  const accounts = useData(
    `/channel-accounts${params(environment)}`,
    true,
    2000,
  );
  const signals = useData(`/health-signals${params(environment)}`, true, 5000);
  const incidents = useData(`/incidents${params(environment)}`, true, 5000);
  const offers = useData(`/offers${params(environment)}`);
  const workflows = useData(`/workflows${params(environment)}`);
  const [tab, setTab] = useState("accounts");
  const [selection, setSelected] = useState<Row | null>(null);
  const selected = accounts.data?.find((account) => account.id === selection?.id) ?? selection;
  const [detailTab,setDetailTab]=useState('connection');
  const [commandId,setCommandId]=useState<string|null>(null);
  const commandQuery=useData<Row>(`/commands/${commandId}?environment=${environment}`,!!commandId,1500);
  const [qrPending, setQrPending] = useState(false);
  const [qrExpired, setQrExpired] = useState(false);
  const [qr, setQr] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!qr) return;
    const expires = Date.parse(String(qr.expiresAt ?? qr.expires_at ?? ""));
    const timer = setTimeout(
      () => { setQr(null); setQrExpired(true); },
      Number.isFinite(expires) ? Math.max(0, expires - Date.now()) : 15000,
    );
    return () => clearTimeout(timer);
  }, [qr]);
  const [error, setError] = useState<Error | null>(null);
  const mutation = useAction();
  const fields: Field[] = [
    { name: "name", label: "Nombre del número", required: true },
    { name: "alias", label: "Alias operativo" },
    {
      name: "provider",
      label: "Transporte",
      type: "select",
      required: true,
      default: environment === "SIMULATION" ? "simulator" : "waha",
      options: environment === "SIMULATION" ? [{ value: "simulator", label: "Simulador local" }] : [
        { value: "waha", label: "WAHA · QR experimental" },
        { value: "cloud", label: "WhatsApp Cloud API · Oficial" },
      ],
    },
    {
      name: "engine",
      when: (values) => values.provider === "waha",
      default: "GOWS",
      label: "Motor de WAHA",
      type: "select",
      options: [
        { value: "GOWS", label: "GOWS" },
        { value: "NOWEB", label: "NOWEB · Comparador" },
      ],
    },
    {
      name: "gateway_ref",
      when: (values) => values.provider !== "simulator",
      label: "Referencia protegida del gateway",
      hint: "Nombre de configuración del servidor; no una clave.",
    },
    { name: "purpose", label: "Propósito del número", type: "textarea" },
    {
      name: "offer_version_id",
      label: "Oferta por defecto",
      type: "select",
      options: options(offers.data),
    },
    {
      name: "workflow_version_id",
      label: "Flujo publicado",
      type: "select",
      options: options(workflows.data?.filter((w) => w.status === "PUBLISHED")),
    },
  ];
  async function command(type: string, propagateError = false) {
    if (!selected) return;
    setError(null);
    try {
      const current=await api<Row>(`/channel-accounts/${selected.id}${params(environment)}`);
      const result=await mutation.mutateAsync({
        path: `/channel-accounts/${selected.id}/commands${params(environment)}`,
        body: { type, expected_version: current.version, reason: "Gestión manual de canal desde consola" },
      });
      setCommandId((result as Row).id);
      if (["disconnect", "logout"].includes(type)) { setQr(null); setQrExpired(false); }
    } catch (e) {
      setError(e as Error);
      if (propagateError) throw e;
    }
  }
  async function deleteNumber() {
    if (!selected) return;
    await mutation.mutateAsync({
      path: `/channel-accounts/${selected.id}`,
      method: "DELETE",
      body: { expected_version: selected.version, confirmation: "DELETE_CHANNEL_ACCOUNT", reason: "Eliminación de número confirmada desde consola" },
    });
    setSelected(null);
    setQr(null);
    setQrExpired(false);
  }
  async function getQr() {
    if (!selected || qrPending) return;
    setError(null);
    setQrPending(true);
    setQrExpired(false);
    try {
      const result = await api<Record<string, unknown>>(
        `/channel-accounts/${selected.id}/qr${params(environment)}`,
      );
      setQr(result);
    } catch (e) {
      setError(e as Error);
    } finally { setQrPending(false); }
  }
  return (
    <>
      <PageHeader
        eyebrow="VENTAS / CANALES / WHATSAPP"
        title="Tus números, bajo control"
        description="Conecta una cuenta y consulta su estado. Los envíos requieren autorización independiente."
        action={
          <ResourceForm
            title="Agregar número"
            description="La cuenta se crea sin habilitar envíos. Las credenciales se resuelven en el servidor."
            fields={fields}
            path="/channel-accounts"
            trigger="Agregar número"
          />
        }
      />
      <div className="tabs">
        <button
          className={tab === "accounts" ? "active" : ""}
          onClick={() => setTab("accounts")}
        >
          <Smartphone size={16} />
          Números y sesiones
        </button>
        <button
          className={tab === "health" ? "active" : ""}
          onClick={() => setTab("health")}
        >
          <Activity size={16} />
          Salud e incidentes
        </button>
      </div>
      <WarmupOverview />
      {tab === "accounts" ? (
        <>
          <Notice>
            WAHA es experimental y sustituible. Un QR vincula la sesión del
            transporte; la vinculación con Meta y la elegibilidad oficial se
            verifican por separado.
          </Notice>
          <QueryState query={accounts}>
            {accounts.data?.length ? (
              <div className="channel-grid">
                {accounts.data.map((a) => (
                  <button
                    className="channel-card"
                    key={a.id}
                    onClick={() => {
                      setSelected(a);
                      setDetailTab("connection");setCommandId(null);setError(null);
                      setQr(null);
                    }}
                  >
                    <div className="channel-card-top">
                      <span className="soft-icon">
                        <Smartphone size={22} />
                      </span>
                      <Status value={a.status ?? a.session_status} />
                    </div>
                    <h2>{a.name ?? a.alias}</h2>
                    <p>{a.purpose || "Sin propósito configurado"}</p>
                    <div className="channel-card-meta">
                      <Badge>
                        {a.provider === "waha"
                          ? "WAHA · experimental"
                          : a.provider === "cloud"
                            ? "Cloud API · oficial"
                            : "Simulador"}
                      </Badge>
                      <Badge
                        tone={environment === "SIMULATION" ? "info" : "warning"}
                      >
                        {environment === "SIMULATION" ? "Simulación" : "Real"}
                      </Badge>
                    </div>
                    <div className="channel-card-footer">
                      <span>Ver sesión y controles</span>
                      <ArrowUpRight size={17} />
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <Panel>
                <Empty
                  title="Conecta tu primer canal"
                  description="Empieza con una cuenta simulada para verificar el recorrido sin tráfico externo."
                />
              </Panel>
            )}
          </QueryState>
        </>
      ) : (
        <>
          <Notice>
            Las señales incluyen fuente y vigencia. Sesión conectada no
            demuestra elegibilidad ni ausencia de restricciones. Calidad no
            soportada permanece no disponible.
          </Notice>
          <Panel title="Señales por capacidad">
            <QueryState query={signals}>
              <DataTable
                data={signals.data ?? []}
                columns={[
                  {
                    key: "account_id",
                    title: "Cuenta",
                    render: (r) =>
                      accounts.data?.find((a) => a.id === r.account_id)?.name ??
                      shortId(r.account_id),
                  },
                  { key: "dimension", title: "Dimensión" },
                  {
                    key: "status",
                    title: "Estado",
                    render: (r) => <Status value={r.status} />,
                  },
                  { key: "source", title: "Fuente" },
                  {
                    key: "observed_at",
                    title: "Observación",
                    render: (r) => date(str(r.observed_at, "")),
                  },
                  {
                    key: "expires_at",
                    title: "Vigencia",
                    render: (r) => date(r.expires_at),
                  },
                ]}
              />
            </QueryState>
          </Panel>
          <Panel title="Incidentes y respuesta">
            <QueryState query={incidents}>
              <DataTable
                data={incidents.data ?? []}
                columns={[
                  {
                    key: "name",
                    title: "Incidente",
                    render: (r) => r.name ?? r.title ?? r.reason,
                  },
                  { key: "scope", title: "Ámbito" },
                  {
                    key: "status",
                    title: "Estado",
                    render: (r) => <Status value={r.status} />,
                  },
                  {
                    key: "runbook",
                    title: "Acción sugerida",
                    render: (r) =>
                      str(
                        r.runbook ?? r.recommended_action,
                        "Revisar evidencia y congelar el ámbito afectado",
                      ),
                  },
                  {
                    key: "resolve",
                    title: "Respuesta",
                    render: (r) =>
                      r.status !== "RESOLVED" ? (
                        <ResourceForm
                          title="Resolver incidente"
                          path={`/incidents/${r.id}/resolve`}
                          trigger="Resolver"
                          fields={[
                            {
                              name: "reason",
                              label: "Evidencia y motivo de resolución",
                              type: "textarea",
                              required: true,
                            },
                          ]}
                        />
                      ) : (
                        <span className="muted">Resolución registrada</span>
                      ),
                  },
                ]}
              />
            </QueryState>
          </Panel>
        </>
      )}
      <Modal
        title={selected?.name ?? "Número y sesión"}
        description="Conexión, mantenimiento del principal y recuperación por cuenta."
        wide
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setQr(null);
          }
        }}
      >
        {selected && (
          <>
            <div className="record-meta">
              <Badge>{selected.provider}</Badge>
              <Status value={selected.session_status ?? selected.status} />
              <Badge>Envíos sujetos a autorización</Badge>
            </div>
            <div className="session-navigation" role="group" aria-label="Secciones del número">{[['connection','Conexión'],['primary','Teléfono principal'],['recovery','Recuperación'],['configuration','Configuración comercial']].map(([value,label])=><Button key={value} variant={detailTab===value?'default':'secondary'} aria-pressed={detailTab===value} onClick={()=>{setDetailTab(value!);setQr(null);}}>{label}</Button>)}</div>
            <section aria-label={detailTab==='connection'?'Conexión del número':detailTab==='primary'?'Mantenimiento del principal':detailTab==='recovery'?'Recuperación del número':'Configuración comercial'}>
            {detailTab!=='configuration'&&<SessionContinuity account={selected} section={detailTab as 'primary'|'recovery'|'connection'}/>}
            {detailTab==='connection'&&<>
            <div className="channel-actions">
              {[
                ["connect", "Conectar"],
                ["check_health", "Revisar salud"],
              ].map(([type, label]) => (
                <Button
                  key={type}
                  variant="secondary"
                  onClick={() => {
                    void command(type!);
                  }}
                  disabled={mutation.isPending}
                >
                  {label}
                </Button>
              ))}
            </div>
            {commandId&&<div role="status" aria-live="polite" className="notice">{commandQuery.data?.status==='APPLIED'?(object(commandQuery.data.result).status==='FAILED'?'El proveedor no pudo conectar la sesión. Revisa su salud antes de otro intento.':object(commandQuery.data.result).status==='STARTING'?'Inicio aceptado. Espera a que la sesión confirme la conexión.':'Operación completada.'):commandQuery.data?.status==='FAILED'?`La operación necesita revisión: ${str(object(commandQuery.data.result).message??object(commandQuery.data.result).error)}`:'Operación en curso… Puedes consultar su resultado aquí.'}</div>}
            <details className="advanced-fields"><summary>Detener, reiniciar o desvincular</summary><div className="button-group">{[['disconnect','Desconectar'],['restart','Reconectar'],['freeze','Congelar'],['resume','Reanudar controles']].map(([type,label])=><ConfirmAction key={type} label={label!} title={`${label} este número`} description="La acción se aplica sólo a esta cuenta y conserva sus reglas de autorización." disabled={mutation.isPending} onConfirm={()=>command(type!,true)}/>)}</div>
            <p className="muted">Desconectar detiene la sesión. Desvincular cierra la sesión de WhatsApp y requiere otro QR para volver a conectar. El historial se conserva.</p>
            {selected.provider === "waha" && <ConfirmAction
              label="Desvincular WhatsApp"
              title="Desvincular este número"
              description="Se pausará este número y se cerrará su sesión de WhatsApp. Para volver a vincularlo necesitarás escanear otro QR. Sus conversaciones y ventas se conservan."
              disabled={mutation.isPending}
              onConfirm={() => command("logout", true)}
            />}
            </details>
            {selected.provider === "waha" && (
              <Button
                variant="secondary"
                onClick={() => {
                  void getQr();
                }}
                disabled={qrPending || mutation.isPending}
              >
                <QrCode />
                {qrPending ? "Solicitando QR…" : "Solicitar QR efímero"}
              </Button>
            )}
            {qrExpired && <Notice>El QR expiró. Solicita uno nuevo para continuar.</Notice>}
            {qr && (
              <div className="qr-view">
                {typeof qr.data === "string" && qr.mimeType === "image/png" ? (
                  <img
                    src={`data:image/png;base64,${qr.data}`}
                    alt="QR temporal de vinculación de WhatsApp"
                  />
                ) : typeof qr.data_url === "string" ? (
                  <img
                    src={qr.data_url}
                    alt="QR temporal de vinculación de WhatsApp"
                  />
                ) : typeof qr.qr === "string" &&
                  qr.qr.startsWith("data:image/") ? (
                  <img src={qr.qr} alt="QR temporal de WhatsApp" />
                ) : (
                  <Notice>
                    {str(
                      qr.message ?? qr.status,
                      "QR aún no disponible. Revisa el estado de conexión y vuelve a solicitarlo.",
                    )}
                  </Notice>
                )}
                <p>En WhatsApp, abre Dispositivos vinculados → Vincular un dispositivo y escanea este QR. La vinculación no habilita envíos ni conecta activos de Meta.</p><small>QR temporal: se elimina al cerrar o expirar.</small>
              </div>
            )}
            <details className="advanced-fields"><summary>Retirar número de Commerce OS</summary><ConfirmAction
              label="Eliminar número"
              title="Eliminar este número de Commerce OS"
              description="Se quitará de la lista y dejará de estar disponible para operar. Sus conversaciones, ventas e historial se conservan. Desvincula WhatsApp primero si llegó a iniciar una sesión."
              disabled={mutation.isPending}
              onConfirm={deleteNumber}
            />
            </details><NumberHealthCard key={`health:${environment}:${selected.id}`} account={selected} />
            </>}
            {detailTab==='configuration'&&<><ChannelConfiguration key={`${environment}:${selected.id}`} account={selected} />
            <details className="advanced-fields"><summary>Configuración técnica de la cuenta</summary>
            <ResourceForm
              title="Editar datos técnicos de la cuenta"
              path={`/channel-accounts/${selected.id}`}
              method="PATCH"
              initial={selected}
              fields={fields}
              trigger="Editar configuración"
            />
            <ResourceForm
              title="Transferir ownership con aislamiento comprobado"
              description="Congela la cuenta y comprueba que el propietario anterior ya no puede actuar. La expiración del lease no basta."
              path={`/channel-accounts/${selected.id}/commands`}
              trigger="Transferir ownership"
              fields={[
                {
                  name: "owner_id",
                  label: "Nuevo propietario técnico",
                  required: true,
                },
                {
                  name: "isolation_evidence",
                  label: "Evidencia de aislamiento del propietario anterior",
                  type: "textarea",
                  required: true,
                },
                { name: "reason", label: "Motivo", required: true },
              ]}
              transform={(body) => ({ ...body, type: "transfer_ownership" })}
            />
            </details>
            </>}
            </section>
            <Feedback error={error ?? mutation.error} />
            <JsonDetail
              value={selected}
              title="Capacidades, sesión y ownership"
            />
          </>
        )}
      </Modal>
    </>
  );
}
export function AcquisitionPage() {
  const { environment } = useWorkspace();
  const [tab, setTab] = useState("campaigns");
  const campaigns = useData(`/acquisition-campaigns${params(environment)}`);
  const adSets = useData(`/ad-sets${params(environment)}`);
  const ads = useData(`/ads${params(environment)}`);
  const bindings = useData(`/bindings${params(environment)}`);
  const accounts = useData(`/channel-accounts${params(environment)}`);
  const offers = useData(`/offers${params(environment)}`);
  const conversions = useData(`/conversions${params(environment)}`);
  const receiptSales = useData(`/orders${params(environment)}`);
  const mutation = useAction();
  const [selected, setSelected] = useState<Row | null>(null);
  const [exportError, setExportError] = useState<Error | null>(null);
  async function exportConversion(record: Row) {
    try {
      const value = await api<unknown>(
        `/conversions/${record.id}/export${params(environment)}`,
        undefined,
        true,
      );
      downloadJson(value, `conversion-${shortId(record.id)}.json`);
    } catch (e) {
      setExportError(e as Error);
    }
  }
  const evidenceFields: Field[] = [
    { name: "source", label: "Fuente del dato", required: true },
    {
      name: "evidence",
      label: "Referencia de evidencia",
      required: true,
      type: "textarea",
    },
  ];
  const configs: Record<
    string,
    { path: string; title: string; data: typeof campaigns; fields: Field[] }
  > = {
    campaigns: {
      path: "/acquisition-campaigns",
      title: "Campaña de adquisición",
      data: campaigns,
      fields: [
        { name: "name", label: "Nombre", required: true },
        {
          name: "platform",
          label: "Plataforma",
          type: "select",
          default: "manual",
          options: [
            { value: "meta", label: "Meta" },
            { value: "manual", label: "Registro manual" },
            { value: "other", label: "Otra" },
          ],
        },
        { name: "external_id", label: "ID externo observado" },
        ...evidenceFields,
      ],
    },
    sets: {
      path: "/ad-sets",
      title: "Conjunto de anuncios",
      data: adSets,
      fields: [
        { name: "name", label: "Nombre", required: true },
        {
          name: "campaign_id",
          label: "Campaña",
          type: "select",
          required: true,
          options: options(campaigns.data),
        },
        { name: "external_id", label: "ID externo observado" },
        ...evidenceFields,
      ],
    },
    ads: {
      path: "/ads",
      title: "Anuncio",
      data: ads,
      fields: [
        { name: "name", label: "Nombre", required: true },
        {
          name: "ad_set_id",
          label: "Conjunto",
          type: "select",
          required: true,
          options: options(adSets.data),
        },
        { name: "external_id", label: "ID externo observado" },
        ...evidenceFields,
      ],
    },
    bindings: {
      path: "/bindings",
      title: "Binding con vigencia",
      data: bindings,
      fields: [
        { name: "name", label: "Nombre" },
        {
          name: "account_id",
          label: "Número receptor",
          type: "select",
          required: true,
          options: options(accounts.data),
        },
        {
          name: "offer_version_id",
          label: "Oferta",
          type: "select",
          required: true,
          options: options(offers.data),
        },
        {
          name: "campaign_id",
          label: "Campaña",
          type: "select",
          options: options(campaigns.data),
        },
        {
          name: "ad_id",
          label: "Anuncio",
          type: "select",
          options: options(ads.data),
        },
        {
          name: "valid_from",
          label: "Vigente desde",
          type: "datetime-local",
          required: true,
        },
        { name: "valid_to", label: "Vigente hasta", type: "datetime-local" },
        {
          name: "confidence",
          label: "Nivel de evidencia",
          type: "select",
          default: "inferred",
          options: [
            { value: "inferred", label: "Inferido por destino" },
            { value: "observed", label: "Observado con evidencia" },
          ],
        },
        ...evidenceFields,
      ],
    },
  };
  const config = configs[tab];
  return (
    <>
      <PageHeader
        eyebrow="CAMPAÑAS / ADQUISICIÓN"
        title="Conecta el origen con la venta"
        description="Registra la estructura publicitaria y las asignaciones históricas con evidencia."
        action={
          config && (
            <ResourceForm
              title={`Registrar ${config.title.toLowerCase()}`}
              path={config.path}
              fields={config.fields}
              trigger="Registrar metadatos"
            />
          )
        }
      />
      <Notice>
        Importar metadatos y preparar conversiones son capacidades disponibles.
        Creación, publicación y optimización publicitaria permanecen
        Planificado.
      </Notice>
      <div className="tabs">
        {[
          ["campaigns", "Campañas"],
          ["sets", "Conjuntos"],
          ["ads", "Anuncios"],
          ["bindings", "Bindings"],
          ["conversions", "Conversiones"],
        ].map(([value, label]) => (
          <button
            key={value}
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value!)}
          >
            {label}
          </button>
        ))}
      </div>
      {config ? (
        <Panel>
          <QueryState query={config.data}>
            <DataTable
              data={config.data.data ?? []}
              onSelect={setSelected}
              columns={[
                {
                  key: "name",
                  title: "Nombre",
                  render: (r) => <strong>{r.name ?? shortId(r.id)}</strong>,
                },
                {
                  key: tab === "bindings" ? "account_id" : "external_id",
                  title: tab === "bindings" ? "Número" : "ID externo",
                  render: (r) =>
                    str(
                      r[tab === "bindings" ? "account_id" : "external_id"],
                      "Desconocido",
                    ),
                },
                { key: "source", title: "Fuente" },
                {
                  key: tab === "bindings" ? "valid_from" : "created_at",
                  title: tab === "bindings" ? "Vigencia" : "Registrado",
                  render: (r) =>
                    date(tab === "bindings" ? r.valid_from : r.created_at),
                },
                {
                  key: "status",
                  title: "Estado",
                  render: (r) => <Status value={r.status ?? r.confidence} />,
                },
              ]}
            />
          </QueryState>
        </Panel>
      ) : (
        <>
          <div className="toolbar">
            <p>Elegibilidad y exportación local de ingresos por comprobante validado.</p>
            <ResourceForm
              title="Preparar conversión por comprobante"
              path="/conversions/prepare"
              trigger="Preparar conversión"
              fields={[
                {
                  name: "order_id",
                  label: "Pedido con ingreso validado",
                  type: "select",
                  required: true,
                  options: options(
                    receiptSales.data?.filter(
                      (o) =>
                        o.sale_definition === "receipt_sales_v1" &&
                        Number(o.sale_amount_minor) > 0 &&
                        o.commercial_classification !== "TEST",
                    ),
                  ),
                },
                {
                  name: "destination",
                  label: "Destino de preparación",
                  type: "select",
                  required: true,
                  default: "export",
                  options: [
                    { value: "export", label: "Exportación interna" },
                    {
                      value: "meta_business_messaging",
                      label: "Meta Business Messaging · Evaluar elegibilidad",
                    },
                  ],
                },
              ]}
            />
          </div>
          <Feedback error={mutation.error} />
          <Panel>
            <QueryState query={conversions}>
              <DataTable
                data={conversions.data ?? []}
                onSelect={setSelected}
                columns={[
                  {
                    key: "order_id",
                    title: "Pedido",
                    render: (r) => shortId(str(r.order_id)),
                  },
                  {
                    key: "status",
                    title: "Estado",
                    render: (r) => <Status value={r.status} />,
                  },
                  {
                    key: "reason",
                    title: "Elegibilidad",
                    render: (r) =>
                      Array.isArray(r.blockers) && r.blockers.length
                        ? r.blockers.join(", ")
                        : "Preparación local",
                  },
                  {
                    key: "created_at",
                    title: "Preparado",
                    render: (r) => date(r.created_at),
                  },
                ]}
              />
            </QueryState>
          </Panel>
          <Notice>
            No se inventan click IDs. Preparar un evento no lo envía a Meta ni
            demuestra atribución remota.
          </Notice>
        </>
      )}
      <Modal
        title="Registro y evidencia"
        open={!!selected}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        <Feedback error={exportError} />
        <JsonDetail value={selected} />
        {selected && config && (
          <ResourceForm
            title="Nueva revisión de metadatos"
            path={`${config.path}/${selected.id}`}
            method="PATCH"
            fields={config.fields}
            initial={selected}
            trigger="Editar con versión"
          />
        )}
        {tab === "conversions" && selected && (
          <Button
            variant="secondary"
            onClick={() => {
              void exportConversion(selected);
            }}
          >
            <Download />
            Exportar preparación
          </Button>
        )}
      </Modal>
    </>
  );
}
export function SettingsPage() {
  const { environment, session } = useWorkspace();
  const routeSearch=useRouterState({select:state=>state.location.search}) as Record<string,string>;
  const requested=routeSearch.section??"status";
  const tab=({team:"users",api:"tokens",billing:"bank"}[requested]??requested);
  const status = useData<Record<string, unknown>>(
    `/system/status${params(environment)}`,
    true,
    5000,
  );
  const events = useData(
    `/events${params(environment, { limit: "100" })}`,
    tab === "audit",
    3000,
  );
  const users = useData<Row[]>(
    "/users",
    tab === "users" && session.role === "owner",
  );
  const banks = useData(`/bank-profiles${params(environment)}`, tab === "bank");
  const tokens = useData<Row[]>(
    "/service-tokens",
    tab === "tokens" && session.role === "owner",
  );
  const policies = useData(
    `/receipt-policies${params(environment)}`,
    tab === "bank",
  );
  const mutation = useAction();
  const [error, setError] = useState<Error | null>(null);
  const owner = session.role === "owner";
  const [controlReason, setControlReason] = useState("");
  const workspacePaused = Array.isArray(status.data?.controls) && status.data.controls.some((control) => object(control).scope_type === "workspace" && object(control).paused === true);
  const bankFields: Field[] = [
    { name: "name", label: "Alias", required: true },
    { name: "bank", label: "Banco", required: true },
    { name: "holder", label: "Titular", required: true },
    {
      name: "account_number",
      label: "Cuenta bancaria",
      type: "password",
      required: true,
      hint: "Se cifra en el servidor y no se devuelve completa.",
    },
    { name: "currency", label: "Moneda", default: "MXN", required: true },
    {
      name: "instructions",
      label: "Instrucciones de transferencia",
      type: "textarea",
    },
  ];
  async function freeze() {
    setError(null);
    try {
      await mutation.mutateAsync({
        path: "/system/controls",
        body: {
          environment,
          paused: !workspacePaused,
          reason: controlReason.trim(),
        },
      });
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <>
      <PageHeader
        eyebrow="CONFIGURACIÓN"
        title="Configuración de tu operación"
        description="Acceso individual, configuración protegida y trazabilidad transversal."
      />
      <div className="button-group"><Link to="/settings/integrations" className="text-link">Integraciones y verificación</Link><Link to="/settings/tests" className="text-link">Pruebas</Link><Link to="/settings/warmup" className="text-link">Warm-up de números</Link>{session.role === "owner" && <Link to="/settings/integrations/mail" className="text-link">Correo transaccional</Link>}<Link to="/settings/integrations/meta" className="text-link">Integraciones → Meta</Link><Link to="/settings/integrations/acquisition" className="text-link">Asociaciones históricas</Link></div>
      <nav className="ux-settings-nav" aria-label="Categorías de configuración">
        <Link to="/settings" search={{section:undefined}} aria-current={tab==="status"?'page':undefined}>Operación vigente</Link>
        <Link to="/settings/integrations">Integraciones</Link>
        {owner&&<Link to="/settings" search={{section:"team"}} aria-current={tab==="users"?'page':undefined}>Equipo</Link>}
        {owner&&<Link to="/settings" search={{section:"api"}} aria-current={tab==="tokens"?'page':undefined}>API y tokens</Link>}
        <Link to="/settings" search={{section:"billing"}} aria-current={tab==="bank"?'page':undefined}>Cobro protegido</Link>
        <Link to="/settings" search={{section:"recovery"}} aria-current={tab==="recovery"?'page':undefined}>Recuperación</Link>
        <Link to="/settings" search={{section:"audit"}} aria-current={tab==="audit"?'page':undefined}>Auditoría</Link>
      </nav>
      {tab === "status" ? (
        <>
          <Notice><strong>Configuración vigente.</strong> Los cambios operativos se muestran aquí; los eventos anteriores permanecen en Auditoría.</Notice>
          <ReadinessPanel />
          <SettingsConfiguration key={environment} />
          <Panel
            title="Disponibilidad del software"
            action={
              <Badge tone="success">
                <Activity size={13} />
                Estado del servidor
              </Badge>
            }
          >
            <QueryState query={status}>
              <DataTable
                data={(Array.isArray(status.data?.services)
                  ? status.data.services
                  : []
                ).map((service: Record<string, unknown>, i: number) => ({
                  ...service,
                  id: String(service.id ?? i),
                }))}
                columns={[
                  {
                    key: "name",
                    title: "Servicio",
                    render: (r) => String(r.name ?? r.service ?? "Proceso"),
                  },
                  {
                    key: "status",
                    title: "Estado",
                    render: (r) => (
                      <Status
                        value={r.stale ? "UNKNOWN" : (r.status ?? "READY")}
                      />
                    ),
                  },
                  {
                    key: "observed_at",
                    title: "Última observación",
                    render: (r) => date(str(r.observed_at, "")),
                  },
                ]}
              />
              <JsonDetail
                value={status.data}
                title="Servicios, colas, integración y controles"
              />
            </QueryState>
          </Panel>
          <div className="split-equal">
            <Panel title="Pausa adicional de todo el espacio">
              <Notice>
                Este control afecta tanto a Real como a Simulación. Liberar la pausa conserva el modo, los límites y las autorizaciones de cada entorno.
              </Notice>
              <Badge tone={workspacePaused ? "warning" : "success"}>{workspacePaused ? "Espacio pausado" : "Sin pausa adicional"}</Badge>
              {owner && (
                <>
                <label className="field"><span>Motivo de la pausa o liberación</span><input minLength={3} maxLength={2000} value={controlReason} onChange={(event) => setControlReason(event.target.value)} /></label>
                <Button
                  variant={workspacePaused ? "secondary" : "destructive"}
                  onClick={() => {
                    void freeze();
                  }}
                  disabled={mutation.isPending || status.isPending || !!status.error || controlReason.trim().length < 3}
                >
                  <Pause />
                  {workspacePaused ? "Liberar pausa del espacio" : "Congelar despachos del espacio"}
                </Button>
                </>
              )}
              <Feedback error={error} />
            </Panel>
            <Panel title="Autorizaciones con alcance">
              <p className="panel-copy">
                Abre un número para revisar su producto, oferta, flujo y agente.
                El asistente permite seleccionar contactos, vigencia y límite de mensajes.
                Un cambio relevante exige una nueva autorización.
              </p>
              {owner && (
                <a className="text-link" href="/sales/channels/whatsapp">Configurar un número y su alcance</a>
              )}
            </Panel>
          </div>
          <Panel title="Operación y recuperación">
            <div className="capability-row">
              <span className="soft-icon">
                <ShieldCheck />
              </span>
              <div>
                <strong>Backups, restauración y monitor externo</strong>
                <p>
                  Consulta el manual de operación y el paquete de despliegue. La
                  instalación del monitor externo y el piloto de transporte
                  requieren verificación específica.
                </p>
              </div>
            </div>
          </Panel>
        </>
      ) : tab === "recovery" ? (
        <><Notice><strong>Estado vigente de recuperación.</strong> Esta vista no acredita por sí sola una restauración ni un monitor externo.</Notice><ReadinessPanel/><Panel title="Recuperación por recurso" description="Conserva el contexto y revisa la evidencia actual antes de reintentar."><div className="capability-row"><span className="soft-icon"><ShieldCheck/></span><div><strong>Números y sesiones</strong><p>Abre cada número para conciliar resultados inciertos, reiniciar o recuperar una sesión.</p></div><Link to="/sales/channels/whatsapp" className="text-link">Abrir números →</Link></div><div className="capability-row"><span className="soft-icon"><Activity/></span><div><strong>Integraciones</strong><p>Comprueba credenciales, healthcheck y última observación sin asumir disponibilidad.</p></div><Link to="/settings/integrations" className="text-link">Abrir integraciones →</Link></div></Panel></>
      ) : tab === "users" ? (
        <Panel
          title="Identidades y roles"
          action={
            <ResourceForm
              title="Dar acceso al equipo"
              path="/users"
              trigger="Agregar usuario"
              fields={[
                { name: "name", label: "Nombre", required: true },
                {
                  name: "email",
                  label: "Correo",
                  type: "email",
                  required: true,
                },
                {
                  name: "password",
                  label: "Contraseña inicial",
                  type: "password",
                  required: true,
                },
                {
                  name: "role",
                  label: "Rol",
                  type: "select",
                  required: true,
                  options: [
                    "owner",
                    "operator",
                    "seller",
                    "reconciler",
                    "analyst",
                    "viewer",
                  ].map((r) => ({ value: r, label: r })),
                },
              ]}
            />
          }
        >
          <QueryState query={users}>
            <DataTable
              data={users.data ?? []}
              columns={[
                { key: "name", title: "Usuario" },
                { key: "email", title: "Correo" },
                { key: "role", title: "Rol" },
                {
                  key: "permissions",
                  title: "Administrar",
                  render: (r) =>
                    r.id === session.user.id ? (
                      <Badge>Tu cuenta</Badge>
                    ) : (
                      <ResourceForm
                        title="Actualizar acceso del equipo"
                        path={`/users/${r.id}`}
                        method="PATCH"
                        initial={r}
                        trigger="Editar acceso"
                        fields={[
                          {
                            name: "role",
                            label: "Rol",
                            type: "select",
                            required: true,
                            options: [
                              "owner",
                              "operator",
                              "seller",
                              "reconciler",
                              "analyst",
                              "viewer",
                            ].map((role) => ({ value: role, label: role })),
                          },
                          {
                            name: "active",
                            label: "Acceso activo",
                            type: "checkbox",
                            default: true,
                          },
                        ]}
                        transform={(body) => ({
                          role: body.role,
                          active: body.active,
                        })}
                      />
                    ),
                },
                {
                  key: "active",
                  title: "Acceso",
                  render: (r) => (
                    <Badge tone={r.active === false ? "warning" : "success"}>
                      {r.active === false ? "Inactivo" : "Activo"}
                    </Badge>
                  ),
                },
              ]}
            />
          </QueryState>
        </Panel>
      ) : tab === "tokens" ? (
        <>
          <Notice>
            Crea un acceso con los permisos necesarios y conserva la credencial en tu gestor de secretos. Se muestra una sola vez. La publicación interna requiere un permiso explícito.
          </Notice>
          <Panel title="Acceso de asistentes y servicios" action={<ServiceTokenCreate />}>
            <p className="panel-copy"><a className="text-link" href="/v1/openapi.json" target="_blank" rel="noreferrer">Ver contrato API</a></p>
            <QueryState query={tokens}>
              <DataTable
                data={tokens.data ?? []}
                columns={[
                  { key: "name", title: "Servicio" },
                  {
                    key: "scopes",
                    title: "Alcance",
                    render: (r) =>
                      Array.isArray(r.scopes)
                        ? r.scopes.join(", ")
                        : "Restringido",
                  },
                  {
                    key: "expires_at",
                    title: "Vigencia",
                    render: (r) => date(r.expires_at),
                  },
                  {
                    key: "revoke",
                    title: "Acción",
                    render: (r) =>
                      r.revoked_at ? (
                        <Badge>Revocado</Badge>
                      ) : (
                        <ConfirmAction label="Revocar" title={`Revocar acceso de ${r.name ?? "este servicio"}`} description="La credencial dejará de funcionar inmediatamente. Para recuperar el acceso necesitarás crear una credencial nueva." disabled={mutation.isPending} onConfirm={() => mutation.mutateAsync({ path: `/service-tokens/${r.id}`, method: "DELETE" })} />
                      ),
                  },
                ]}
              />
            </QueryState>
          </Panel>

        </>
      ) : tab === "bank" ? (
        <>
          <Notice>
            Los perfiles bancarios se versionan y cifran. El catálogo y los
            tokens limitados sólo reciben referencias y terminaciones.
          </Notice>
          <Panel
            title="Perfiles bancarios"
            action={
              owner && (
                <ResourceForm
                  title="Nuevo perfil bancario"
                  path="/bank-profiles"
                  trigger="Agregar perfil"
                  fields={bankFields}
                />
              )
            }
          >
            <QueryState query={banks}>
              <DataTable
                data={banks.data ?? []}
                columns={[
                  { key: "name", title: "Alias" },
                  { key: "bank", title: "Banco" },
                  {
                    key: "last4",
                    title: "Terminación",
                    render: (r) => `•••• ${str(r.last4 ?? r.account_last4)}`,
                  },
                  { key: "version", title: "Versión" },
                  { key: "currency", title: "Moneda" },
                ]}
              />
            </QueryState>
          </Panel>
          <Panel
            title="Políticas documentales"
            action={
              owner && (
                <ResourceForm
                  title="Nueva política de comprobantes"
                  path="/receipt-policies"
                  trigger="Agregar política"
                  fields={[
                    { name: "name", label: "Nombre", required: true },
                    {
                      name: "min_amount",
                      label: "Importe mínimo legible",
                      type: "number",
                      advanced: false,
                      default: 0.01,
                      min: 0.01,
                      step: 0.01,
                      hint: "Usa unidades de la moneda del comprobante, por ejemplo 0.01 MXN. Si se omite, el mínimo es 0.01.",
                    },
                    {
                      name: "allow_amount_mismatch",
                      label:
                        "Admitir monto distinto conservando valor observado",
                      type: "checkbox",
                      default: false,
                    },
                    {
                      name: "allow_pending",
                      label: "Admitir documento con operación pendiente",
                      type: "checkbox",
                      default: false,
                    },
                    {
                      name: "require_currency",
                      label: "Exigir moneda observada",
                      type: "checkbox",
                      default: false,
                    },
                    {
                      name: "require_destination",
                      label: "Exigir coincidencia de destino",
                      type: "checkbox",
                      default: false,
                    },
                    {
                      name: "auto_approve",
                      label:
                        "Aprobar documentalmente si cumple todas las reglas",
                      type: "checkbox",
                      default: false,
                    },
                  ]}
                  transform={({ min_amount, ...body }) => {
                    const amountMinor = min_amount === undefined ? undefined : Math.round(Number(min_amount) * 100);
                    if (min_amount !== undefined && (typeof min_amount !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor! < 1 || Math.abs(min_amount * 100 - amountMinor!) > 0.000001)) {
                      throw new Error("Usa un importe mínimo positivo de hasta dos decimales.");
                    }
                    return { ...body, ...(amountMinor === undefined ? {} : { min_amount_minor: amountMinor }) };
                  }}
                />
              )
            }
          >
            <QueryState query={policies}>
              <DataTable
                data={policies.data ?? []}
                columns={[
                  { key: "name", title: "Política" },
                  { key: "version", title: "Versión" },
                  {
                    key: "auto_approve",
                    title: "Decisión automática",
                    render: (r) =>
                      r.auto_approve ? "Según reglas" : "Revisión humana",
                  },
                  {
                    key: "allow_amount_mismatch",
                    title: "Monto diferente",
                    render: (r) =>
                      r.allow_amount_mismatch
                        ? "Admite con evidencia"
                        : "Revisión requerida",
                  },
                ]}
              />
            </QueryState>
          </Panel>
        </>
      ) : (
        <><Notice><strong>Historial.</strong> Estos eventos explican cambios anteriores; no sustituyen el estado vigente de cada recurso.</Notice><Panel
          title="Eventos de auditoría"
          description="Referencias, actor y causa. Las credenciales y el contenido sensible se mantienen protegidos."
        >
          <QueryState query={events}>
            <DataTable
              data={events.data ?? []}
              columns={[
                { key: "event_type", title: "Evento" },
                {
                  key: "aggregate_id",
                  title: "Recurso",
                  render: (r) => shortId(str(r.aggregate_id)),
                },
                {
                  key: "actor",
                  title: "Actor",
                  render: (r) =>
                    str(object(r.actor).type ?? object(r.actor).id, "Sistema"),
                },
                {
                  key: "recorded_at",
                  title: "Fecha",
                  render: (r) => date(r.recorded_at),
                },
              ]}
            />
          </QueryState>
        </Panel></>
      )}
    </>
  );
}
