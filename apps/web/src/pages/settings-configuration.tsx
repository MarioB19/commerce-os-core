import { useId, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge, Feedback, Notice, Panel, QueryState, useWorkspace } from "../components/shared";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/dialog";
import { api, params, useAction, useData } from "../lib/api";
import { date } from "../lib/utils";

interface OperationalBody {
  dispatch_frozen: boolean;
  real_sends_enabled: boolean;
  allow_real_operations: boolean;
  allow_channel_onboarding: boolean;
  contact_messages_per_minute: number;
  channel_account_concurrency: number;
}
interface OperationalSettings {
  version: number;
  body: OperationalBody;
  release_hold?: boolean;
  release_hold_at?: string | null;
  updated_at?: string;
  updated_by?: string;
}
interface LaunchStatus {
  configuration_version:number;
  release_hold:boolean;
  policy_open:boolean;
  workspace_paused:boolean;
  observed_at:string;
  summary:{operating:number;attention:number;blocked:number};
  numbers:{id:string;alias:string;status:"OPERANDO"|"NECESITA_ATENCION"|"BLOQUEADO";reason_code:string;authorization_expires_at:string|null;authorization_scopes:{assignment_id:string;recipient_mode:string;max_messages:number;allow_automation:boolean;expires_at:string}[];authorization_expiring_soon:boolean;unknown_effects:number;blocked_effects:number;next_action:{label:string}}[];
}

export function SettingsConfiguration() {
  const { environment, session } = useWorkspace();
  const settings = useData<OperationalSettings>(`/settings/operations${params(environment)}`, session.role === "owner");
  if (session.role !== "owner") return <Notice>El administrador gestiona el modo de operación, las conexiones y los límites de este entorno.</Notice>;
  return <>
    {environment === "REAL" && <LaunchSwitch />}
    <Panel title="Modo de operación y límites" description={`Configuración de ${environment === "REAL" ? "Real" : "Simulación"}. Los cambios de política comercial invalidan las autorizaciones anteriores; una pausa desde el interruptor de ventas conserva su vigencia.`} action={<Button variant="secondary" size="sm" onClick={() => void settings.refetch()}>Actualizar configuración</Button>}>
      <QueryState query={settings}>
        {settings.data && <OperationsForm key={`${environment}:${settings.data.version}`} value={settings.data} onSaved={async()=> (await settings.refetch()).data} />}
      </QueryState>
    </Panel>
    <IntegrationsConfiguration key={environment} />
  </>;
}

function LaunchSwitch(){
  const status=useData<LaunchStatus>('/settings/launch?environment=REAL',true,30_000);
  const mutation=useAction();
  const [reason,setReason]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [message,setMessage]=useState('');
  async function switchSales(action:'OPEN'|'PAUSE'){
    if(!status.data||!confirmed||reason.trim().length<3)return;
    setMessage('');
    try{
      const result=await mutation.mutateAsync({path:'/settings/launch/switch',body:{expected_version:status.data.configuration_version,action,reason:reason.trim(),confirmation:'CONFIRM_REAL_SWITCH'}}) as {readback:LaunchStatus};
      const fresh=(await status.refetch()).data;
      if(!fresh||fresh.configuration_version!==result.readback.configuration_version||fresh.workspace_paused!==(action==='PAUSE')){setMessage('La respuesta llegó, pero la lectura posterior no coincide. Actualiza el estado antes de intentar otra acción.');return;}
      setMessage(action==='PAUSE'?'Ventas pausadas y estado verificado.':`REAL abierto. ${fresh.summary.operating} números operando; revisa los demás antes de anunciar el lanzamiento.`);
      setConfirmed(false);setReason('');
    }catch{/* Mutation feedback keeps the error and the same idempotency key for retry. */}
  }
  return <Panel title="Interruptor de ventas REAL" description="Pausa inmediata sin perder permisos vigentes. Abrir muestra el resultado real por número; cada autorización conserva su límite y vencimiento." action={<Button variant="secondary" size="sm" onClick={()=>void status.refetch()}>Actualizar estado</Button>}>
    <QueryState query={status}>
      {status.data&&<>
        <div className="record-meta"><Badge tone={status.data.release_hold||status.data.workspace_paused||!status.data.policy_open?'warning':'success'}>{status.data.release_hold?'Publicación en curso':status.data.workspace_paused?'Ventas pausadas':status.data.policy_open?'REAL abierto':'REAL cerrado'}</Badge><span>Revisión comercial {status.data.configuration_version} · {status.data.summary.operating} operando · {status.data.summary.attention} requieren atención · {status.data.summary.blocked} bloqueados</span></div>
        {status.data.numbers.length>0&&<div className="table-scroll"><table><thead><tr><th>Número</th><th>Estado</th><th>Causa</th><th>Permiso y alcance</th><th>Siguiente acción</th></tr></thead><tbody>{status.data.numbers.map(number=><tr key={number.id}><td>{number.alias}</td><td>{number.status==='OPERANDO'?'Operando':number.status==='BLOQUEADO'?'Bloqueado':'Necesita atención'}</td><td>{number.reason_code}{number.unknown_effects>0?` · ${number.unknown_effects} envío incierto`:''}{number.blocked_effects>0?` · ${number.blocked_effects} retenidos`:''}</td><td>{number.authorization_scopes.length?number.authorization_scopes.map(scope=><div key={scope.assignment_id}>{scope.recipient_mode==='new_inbound'?'Sólo entradas nuevas':'Contactos seleccionados'} · máx. {scope.max_messages} · {scope.allow_automation?'automatización autorizada':'sin automatización'} · hasta {date(scope.expires_at)}</div>):'Sin permiso vigente'}{number.authorization_expiring_soon?' · vence pronto':''}</td><td>{number.next_action?.label??'Revisar número'}</td></tr>)}</tbody></table></div>}
        <label className="field"><span>Motivo</span><input value={reason} onChange={event=>setReason(event.target.value)} minLength={3} maxLength={2000} placeholder="Motivo de la apertura o pausa" /></label>
        <Notice tone="warning"><label><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} /> Confirmo el cambio de operación REAL para este workspace.</label></Notice>
        <div className="record-meta"><Button onClick={()=>void switchSales('OPEN')} disabled={!confirmed||reason.trim().length<3||mutation.isPending||status.data.release_hold}>Abrir ventas</Button><Button variant="secondary" onClick={()=>void switchSales('PAUSE')} disabled={!confirmed||reason.trim().length<3||mutation.isPending}>Pausar ventas</Button></div>
        <Feedback error={mutation.error} success={message} />
      </>}
    </QueryState>
  </Panel>;
}

function OperationsForm({ value,onSaved }: { value: OperationalSettings;onSaved:()=>Promise<OperationalSettings|undefined> }) {
  const { environment } = useWorkspace();
  const id = useId();
  const operationEnabled = !value.body.dispatch_frozen && value.body.real_sends_enabled && value.body.allow_real_operations;
  const [enabled, setEnabled] = useState(operationEnabled);
  const [onboarding, setOnboarding] = useState(value.body.allow_channel_onboarding);
  const [frequency, setFrequency] = useState(value.body.contact_messages_per_minute);
  const [concurrency, setConcurrency] = useState(value.body.channel_account_concurrency);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [verification,setVerification]=useState("");
  const [readbackError,setReadbackError]=useState<Error|null>(null);
  const mutation = useAction();
  const changes: OperationalBody = { dispatch_frozen: !enabled, real_sends_enabled: enabled, allow_real_operations: enabled, allow_channel_onboarding: onboarding, contact_messages_per_minute: frequency, channel_account_concurrency: concurrency };
  const changed = (Object.keys(changes) as (keyof OperationalBody)[]).some((key) => changes[key] !== value.body[key]);
  const changedFields=(Object.keys(changes) as (keyof OperationalBody)[]).filter(key=>changes[key]!==value.body[key]);
  const fieldLabels:Record<keyof OperationalBody,string>={dispatch_frozen:'Bloqueo de despachos',real_sends_enabled:'Envíos reales',allow_real_operations:'Operación real',allow_channel_onboarding:'Vinculación de números',contact_messages_per_minute:'Mensajes por contacto/minuto',channel_account_concurrency:'Envíos simultáneos por número'};
  const display=(value:boolean|number)=>typeof value==='boolean'?(value?'Permitido':'No permitido'):String(value);
  const enablingReal = environment === "REAL" && enabled && !operationEnabled;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (enablingReal && !confirmed) return;
    setVerification("");setReadbackError(null);
    try { await mutation.mutateAsync({ path: "/settings/operations", method: "PATCH", body: { expected_version: value.version, reason: reason.trim(), changes } });const current=await onSaved();const matches=current&&current.version>value.version&&(Object.keys(changes) as (keyof OperationalBody)[]).every(key=>current.body[key]===changes[key]);if(!matches)throw new Error("El servidor aceptó el cambio, pero la lectura posterior no coincide. No repitas la operación hasta conciliar el estado vigente.");setVerification(`Cambio comprobado en la revisión ${current.version}.`); } catch(error) { if(!mutation.error)setReadbackError(error as Error); }
  }
  return <form onSubmit={(event) => void save(event)}>
    <div className="record-meta"><Badge tone={operationEnabled ? "success" : "warning"}>{operationEnabled ? "Operación permitida" : "Despachos congelados"}</Badge><span>Revisión {value.version} · {date(value.updated_at)}</span></div>
    <div className="form-grid">
      <label className="field" htmlFor={`${id}-mode`}><span>Modo de operación</span><select aria-label="Modo de operación" id={`${id}-mode`} value={enabled ? "enabled" : "frozen"} onChange={(event) => { setEnabled(event.target.value === "enabled"); setConfirmed(false); }}><option value="frozen">Congelado: conservar configuración sin despachar</option><option value="enabled">Permitir operación con cuentas y alcances autorizados</option></select><small>El servidor sigue comprobando la cuenta, el contacto, la vigencia y el alcance antes de cada envío.</small></label>
      <label className="field" htmlFor={`${id}-onboarding`}><span>Vinculación de números</span><select aria-label="Vinculación de números" id={`${id}-onboarding`} value={onboarding ? "enabled" : "disabled"} onChange={(event) => setOnboarding(event.target.value === "enabled")}><option value="disabled">En pausa</option><option value="enabled">Permitir conexión y QR</option></select><small>Vincular un dispositivo sólo prepara su identidad; cada número conserva su propia activación.</small></label>
      <label className="field" htmlFor={`${id}-frequency`}><span>Mensajes por contacto y minuto</span><input id={`${id}-frequency`} type="number" min={1} max={60} step={1} required value={frequency} onChange={(event) => setFrequency(Number(event.target.value))} /></label>
      <label className="field" htmlFor={`${id}-concurrency`}><span>Envíos simultáneos por número</span><input id={`${id}-concurrency`} type="number" min={1} max={10} step={1} required value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label>
    </div>
    <label className="field" htmlFor={`${id}-reason`}><span>Motivo del cambio</span><input id={`${id}-reason`} minLength={3} maxLength={2000} required value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Qué se habilita o ajusta y para qué" /></label>
    {enablingReal && <Notice tone="warning"><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirmo que las cuentas activas podrán operar dentro de las autorizaciones vigentes.</label></Notice>}
    {changedFields.length>0&&<details className="ux-evidence" open={enablingReal}><summary>Revisar diferencia e impacto</summary><div className="table-scroll"><table><thead><tr><th>Ajuste</th><th>Vigente</th><th>Propuesto</th><th>Impacto</th></tr></thead><tbody>{changedFields.map(key=><tr key={key}><td>{fieldLabels[key]}</td><td>{display(value.body[key])}</td><td>{display(changes[key])}</td><td>{key==='dispatch_frozen'||key==='real_sends_enabled'||key==='allow_real_operations'?'Puede cambiar la elegibilidad de acciones externas.':key==='allow_channel_onboarding'?'Cambia si se pueden iniciar conexiones y QR.':'Cambia el límite aplicado por el servidor.'}</td></tr>)}</tbody></table></div></details>}
    <Feedback error={readbackError??mutation.error} success={verification} />
    <Button type="submit" disabled={!changed || mutation.isPending || reason.trim().length < 3 || (enablingReal && !confirmed)}>{mutation.isPending ? "Guardando…" : "Guardar modo y límites"}</Button>
  </form>;
}

interface ConfigField { name: string; label: string; type: string; required: boolean; default?: unknown; options?: (string | { value: string; label: string })[] }
interface IntegrationDefinition { type: string; label: string; multiple: boolean; config_fields: ConfigField[]; secret_fields: { name: string; label: string; required: boolean }[]; reference_help: string }
interface IntegrationProfile { key: string; type: string; reference: string; label: string; version: number; enabled: boolean; config: Record<string, unknown>; secrets: Record<string, { configured: boolean }>; updated_at?: string }
interface IntegrationInventory { definitions: IntegrationDefinition[]; profiles: IntegrationProfile[] }

export function IntegrationsConfiguration() {
  const { environment } = useWorkspace();
  const inventory = useData<IntegrationInventory>(`/settings/integrations${params(environment)}`);
  const [editing, setEditing] = useState<{ definition: IntegrationDefinition; profile?: IntegrationProfile } | null>(null);
  const [success, setSuccess] = useState(false);
  return <Panel title="Conexiones" description="Credenciales cifradas para WhatsApp, Meta, IA y entrega. Sólo se muestra si están configuradas." action={<Button variant="secondary" size="sm" onClick={() => void inventory.refetch()}>Actualizar conexiones</Button>}>
    <Feedback success={success && "Conexión guardada. Revisa la preparación de los números y renueva su autorización antes de operar."} />
    <QueryState query={inventory}>
      {inventory.data?.definitions.map((definition) => {
        const profiles = inventory.data?.profiles.filter((profile) => profile.type === definition.type) ?? [];
        return <section key={definition.type} aria-label={definition.label}>
          <div className="panel-heading"><h3>{definition.label}</h3>{(definition.multiple || !profiles.length) && <Button variant="secondary" size="sm" onClick={() => { setSuccess(false); setEditing({ definition }); }}>Agregar {definition.label}</Button>}</div>
          {!profiles.length && <p className="panel-copy">Aún no hay una conexión configurada.</p>}
          {profiles.map((profile) => <div className="capability-row" key={profile.key}>
            <div><strong>{profile.label}</strong><p>{profile.enabled ? "Habilitada" : "Deshabilitada"} · {Object.values(profile.secrets).filter((secret) => secret.configured).length} credenciales configuradas · Revisión {profile.version}</p></div>
            <Button variant="secondary" size="sm" onClick={() => { setSuccess(false); setEditing({ definition, profile }); }} aria-label={`Editar conexión ${profile.label}`}>Configurar</Button>
          </div>)}
        </section>;
      })}
    </QueryState>
    <Modal title={editing?.profile ? `Configurar ${editing.profile.label}` : `Agregar ${editing?.definition.label ?? "conexión"}`} description="Los valores secretos se reemplazan sólo cuando escribes uno nuevo. Deja el campo vacío para conservar la credencial actual." open={!!editing} onOpenChange={(open) => { if (!open) setEditing(null); }}>
      {editing && <IntegrationForm definition={editing.definition} profile={editing.profile} onSaved={() => { setEditing(null); setSuccess(true); }} />}
    </Modal>
  </Panel>;
}

function IntegrationForm({ definition, profile, onSaved }: { definition: IntegrationDefinition; profile?: IntegrationProfile; onSaved: () => void }) {
  const { environment } = useWorkspace();
  const id = useId();
  const client = useQueryClient();
  const [label, setLabel] = useState(profile?.label ?? definition.label);
  const [reference, setReference] = useState(profile?.reference ?? (definition.multiple ? "" : "default"));
  const [enabled, setEnabled] = useState(profile?.enabled ?? false);
  const [config, setConfig] = useState<Record<string, unknown>>(profile?.config ?? Object.fromEntries(definition.config_fields.filter((field) => field.default !== undefined).map((field) => [field.name, field.default])));
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [clearSecrets, setClearSecrets] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const key = useRef(crypto.randomUUID());
  const inputChanged = () => { key.current = crypto.randomUUID(); setError(null); };
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError(null);
    try {
      // Credentials stay in this mounted form. Do not put requests in React Query's mutation cache.
      await api(`/settings/integrations/${encodeURIComponent(profile?.key ?? `${definition.type}:${reference}`)}${params(environment)}`, { method: "PUT", headers: { "Idempotency-Key": key.current }, body: JSON.stringify({ expected_version: profile?.version ?? 0, label: label.trim(), enabled, config, secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== "")), clear_secrets: clearSecrets, reason: reason.trim() }) });
      setSecrets({}); setClearSecrets([]);
      await client.invalidateQueries();
      onSaved();
    } catch (caught) { setError(caught as Error); } finally { setPending(false); }
  }
  return <form onSubmit={(event) => void save(event)} onChange={inputChanged} autoComplete="off">
    <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <div className="form-grid">
        <label className="field" htmlFor={`${id}-label`}><span>Nombre de la conexión</span><input id={`${id}-label`} required maxLength={160} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Nombre reconocible para tu equipo" /></label>
        {definition.type==="openai" ? <label className="field"><span>Perfil de uso</span><select value={reference} disabled={!!profile} onChange={e=>setReference(e.target.value)}><option value="">Selecciona el perfil</option><option value="default">Vendedor WhatsApp</option><option value="assistant">Asistente operativo</option></select></label> : definition.multiple && <label className="field" htmlFor={`${id}-reference`}><span>Referencia de la conexión</span><input aria-label="Referencia de la conexión" id={`${id}-reference`} required maxLength={64} pattern="[A-Za-z][A-Za-z0-9_-]*" value={reference} readOnly={!!profile} onChange={(event) => setReference(event.target.value)} /><small>{definition.reference_help}</small></label>}
        <label className="field" htmlFor={`${id}-enabled`}><span>Estado de la conexión</span><select id={`${id}-enabled`} value={enabled ? "enabled" : "disabled"} onChange={(event) => setEnabled(event.target.value === "enabled")}><option value="disabled">Deshabilitada</option><option value="enabled">Habilitada</option></select></label>
        {definition.config_fields.map((field) => <label className="field" key={field.name} htmlFor={`${id}-${field.name}`}><span>{field.label}</span>{field.type === "select" ? <select id={`${id}-${field.name}`} required={enabled && field.required} value={String(config[field.name] ?? "")} onChange={(event) => setConfig({ ...config, [field.name]: event.target.value })}><option value="">Selecciona una opción</option>{field.options?.map((option) => <option key={typeof option === "string" ? option : option.value} value={typeof option === "string" ? option : option.value}>{typeof option === "string" ? option : option.label}</option>)}</select> : <input id={`${id}-${field.name}`} type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"} required={enabled && field.required} min={field.type === "number" ? 0 : undefined} value={String(config[field.name] ?? "")} onChange={(event) => { const next = { ...config }; if (!field.required && event.target.value === "") delete next[field.name]; else next[field.name] = field.type === "number" && event.target.value !== "" ? Number(event.target.value) : event.target.value; setConfig(next); }} />}</label>)}
      </div>
      {definition.secret_fields.map((field) => {
        const configured = profile?.secrets[field.name]?.configured ?? false;
        const clearing = clearSecrets.includes(field.name);
        return <div key={field.name}>
          <label className="field" htmlFor={`${id}-secret-${field.name}`}><span>{field.label} · {configured ? "Configurada" : "Sin configurar"}</span><input id={`${id}-secret-${field.name}`} type="password" autoComplete="new-password" spellCheck={false} required={enabled && field.required && (!configured || clearing)} disabled={clearing} value={secrets[field.name] ?? ""} onChange={(event) => setSecrets({ ...secrets, [field.name]: event.target.value })} placeholder={configured ? "Vacío conserva la credencial actual" : "Introduce la credencial"} /></label>
          {configured && <label className="field"><span><input type="checkbox" checked={clearing} onChange={(event) => { setClearSecrets(event.target.checked ? [...clearSecrets, field.name] : clearSecrets.filter((name) => name !== field.name)); setSecrets({ ...secrets, [field.name]: "" }); }} /> Retirar {field.label} de esta conexión</span></label>}
        </div>;
      })}
      <label className="field" htmlFor={`${id}-reason`}><span>Motivo del cambio</span><input id={`${id}-reason`} required minLength={3} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} /></label>
      <Notice>Guardar invalida autorizaciones anteriores. Si el gateway tiene una sesión vinculada o un QR activo, desconéctala antes de cambiar su conexión. Las claves de webhooks también deben coincidir con las configuradas en el proveedor.</Notice>
      <Feedback error={error} />
      <Button type="submit" disabled={pending || reason.trim().length < 3}>{pending ? "Guardando conexión…" : "Guardar conexión"}</Button>
    </fieldset>
  </form>;
}

const tokenPermissions = [
  ["products:read", "Consultar productos"], ["products:write", "Crear y editar productos"], ["products:publish", "Publicar versiones de productos"],
  ["offers:read", "Consultar ofertas"], ["offers:write", "Crear y editar ofertas"], ["offers:publish", "Publicar versiones de ofertas"],
  ["workflows:read", "Consultar flujos"], ["workflows:draft", "Crear borradores de flujos"], ["workflows:publish", "Publicar versiones de flujos"],
  ["simulations:run", "Ejecutar simulaciones"],
  ["assets:read", "Consultar materiales"], ["assets:write", "Preparar materiales"],
  ["sales:read", "Consultar conversaciones y pedidos"], ["sales:propose", "Proponer acciones comerciales autorizadas"],
  ["channels:read", "Consultar números y preparación"], ["commands:read", "Consultar comandos"],
  ["warmup:read", "Consultar warm-up"], ["warmup:manage", "Configurar warm-up"],
] as const;

export function ServiceTokenCreate() {
  const { session } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (session.role !== "owner") return null;
  return <>
    <Button variant="secondary" onClick={() => setOpen(true)}>Crear acceso API</Button>
    <Modal title="Crear acceso de asistente o servicio" description="Elige permisos y una vigencia. La credencial nueva aparece una sola vez y se elimina de esta pantalla al cerrar." open={open} onOpenChange={setOpen}>
      {open && <ServiceTokenForm onClose={() => setOpen(false)} />}
    </Modal>
  </>;
}

function ServiceTokenForm({ onClose }: { onClose: () => void }) {
  const id = useId();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [allowedEnvironments, setAllowedEnvironments] = useState<string[]>(["REAL"]);
  const [days, setDays] = useState(7);
  const [resourceIds, setResourceIds] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [token, setToken] = useState("");
  const [copied, setCopied] = useState(false);
  const intent = useRef<{ key: string; expires: string } | null>(null);
  async function create(event: FormEvent) {
    event.preventDefault();
    if (pending || !scopes.length) return;
    setPending(true); setError(null);
    intent.current ??= { key: crypto.randomUUID(), expires: new Date(Date.now() + days * 86400000).toISOString() };
    try {
      // One-time tokens must never enter the query or mutation cache.
      const result = await api<{ token: string }>("/service-tokens", { method: "POST", headers: { "Idempotency-Key": intent.current.key }, body: JSON.stringify({ name: name.trim(), scopes, allowed_environments: allowedEnvironments, resource_ids: resourceIds.trim() ? resourceIds.split(/[\s,]+/).filter(Boolean) : null, expires_at: intent.current.expires }) });
      setToken(result.token); result.token = "";
      await client.invalidateQueries();
    } catch (caught) { setError(caught as Error); } finally { setPending(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(token); setCopied(true); } catch { setError(new Error("No se pudo copiar. Selecciona la credencial y guárdala en tu gestor de secretos antes de cerrar.")); }
  }
  if (token) return <>
    <Notice>Guarda esta credencial ahora en tu gestor de secretos. Al cerrar dejará de estar disponible. Puedes revocarla desde la lista de accesos.</Notice>
    <label className="field" htmlFor={`${id}-token`}><span>Credencial nueva</span><input id={`${id}-token`} type="password" value={token} readOnly autoComplete="off" onFocus={(event) => event.target.select()} /></label>
    <div className="button-group"><Button onClick={() => void copy()}>Copiar credencial</Button><Button variant="secondary" onClick={() => { setToken(""); onClose(); }}>Guardé la credencial, cerrar</Button></div>
    <Feedback error={error} success={copied && "Credencial copiada al portapapeles."} />
  </>;
  return <form onSubmit={(event) => void create(event)} onChange={() => { intent.current = null; setError(null); }}>
    <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label className="field" htmlFor={`${id}-name`}><span>Nombre del servicio</span><input id={`${id}-name`} required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ej. Asistente de catálogo" /></label>
      <fieldset><legend>Entornos permitidos</legend>{[["REAL", "Operación real"], ["SIMULATION", "Laboratorio de pruebas"]].map(([value,label]) => <label className="checkbox-row" key={value}><input type="checkbox" checked={allowedEnvironments.includes(value!)} onChange={event => setAllowedEnvironments(event.target.checked ? [...allowedEnvironments, value!] : allowedEnvironments.filter(env => env !== value))} />{label}</label>)}</fieldset>
      <fieldset><legend>Permisos del acceso</legend>{tokenPermissions.map(([scope, title]) => <label className="field" key={scope}><span><input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes(event.target.checked ? [...scopes, scope] : scopes.filter((value) => value !== scope))} /> {title}</span></label>)}</fieldset>
      <label className="field" htmlFor={`${id}-days`}><span>Vigencia en días</span><input id={`${id}-days`} type="number" min={1} max={90} required value={days} onChange={(event) => setDays(Number(event.target.value))} /></label>
      <details><summary>Limitar a recursos concretos</summary><label className="field"><span>IDs de recursos permitidos, separados por coma</span><textarea value={resourceIds} onChange={event => setResourceIds(event.target.value)} placeholder="Vacío permite los recursos del workspace cubiertos por los permisos seleccionados." /></label></details>
      <Notice>Los permisos y entornos limitan el acceso del servicio. Cada salida conserva las autorizaciones y controles del servidor.</Notice>
      <Feedback error={error} />
      <Button type="submit" disabled={pending || !name.trim() || !scopes.length || !allowedEnvironments.length}>{pending ? "Creando acceso…" : "Crear credencial limitada"}</Button>
    </fieldset>
  </form>;
}
