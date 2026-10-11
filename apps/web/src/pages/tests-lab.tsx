import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { FlaskConical, ShieldCheck } from "lucide-react";
import { WorkspaceContext, useWorkspace } from "../lib/workspace";
import { CommandMonitor, Empty, Feedback, JsonDetail, PageHeader, Panel, QueryState } from "../components/shared";
import { Button } from "../components/ui/button";
import { EvaluationPanel } from "../components/sales/evaluation-panel";
import { Simulator } from "./flows-simulator";
import { params, useAction, useData, type Row } from "../lib/api";

export function TestsPage({ productId }: { productId?: string } = {}) {
  const { session } = useWorkspace();
  const [active, setActive] = useState(false);
  const allowed = session.permissions.includes("*") || session.permissions.includes("workflows:write");
  return <div className="tests-page">
    <PageHeader eyebrow="CONFIGURACIÓN / PRUEBAS" title="Laboratorio de pruebas" description="Ensaya una versión del recorrido con datos ficticios y un reloj virtual." action={<Button asChild variant="secondary"><Link to="/settings">Volver a Configuración</Link></Button>} />
    {!active ? <section className="lab-entry"><span className="lab-icon"><FlaskConical size={28} /></span><h2>Un espacio separado para ensayar</h2><p>Crea una copia de una versión comercial, revisa sus respuestas y simula una venta. Los borradores y las consultas de esta sesión se descartan al salir.</p><ul><li>El original REAL conserva su versión.</li><li>Las conversaciones y entregas son ficticias.</li><li>El laboratorio no conecta números ni envía WhatsApp.</li></ul><Button disabled={!allowed} onClick={() => setActive(true)}>Activar laboratorio de pruebas</Button>{!allowed && <p>Tu rol no permite ejecutar pruebas. Solicita acceso al responsable del equipo.</p>}</section> : <Laboratory key={session.workspace_id} productId={productId} onClose={() => setActive(false)} />}
  </div>;
}
function Laboratory({ onClose, productId }: { onClose: () => void; productId?: string }) {
  const { session } = useWorkspace();
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } }));
  useEffect(() => () => { void client.cancelQueries(); client.clear(); }, [client]);
  return <QueryClientProvider client={client}><WorkspaceContext.Provider value={{session:{...session,environment:"SIMULATION"},environment:"SIMULATION"}}>
    <section className="lab-banner" aria-label="Contexto local de pruebas"><FlaskConical size={22} /><div><strong>Pruebas · SIMULATION</strong><p>Datos ficticios. Al salir, las pantallas comerciales siguen en Operación real.</p></div><Button variant="secondary" onClick={onClose}>Finalizar sesión de pruebas</Button></section>
    <LabContent productId={productId} /><CommandMonitor />
  </WorkspaceContext.Provider></QueryClientProvider>;
}
function LabContent({ productId }: { productId?: string }) {
  const search = useRouterState({ select: s => s.location.search }) as { workflow?: string };
  const [source, setSource] = useState(search.workflow ?? "");
  const [offerId, setOfferId] = useState("");
  const [snapshot, setSnapshot] = useState<Row>();
  const [conversation, setConversation] = useState("");
  // The sole cross-environment read selects the source; execution only receives
  // the new references returned by the server's sanitized simulation snapshot.
  const sources = useData(`/workflows${params("REAL", { product_id: productId })}`);
  const workflows = useData(`/workflows${params("SIMULATION")}`, !!snapshot);
  const conversations = useData(`/conversations${params("SIMULATION")}`, !!snapshot, 1500);
  const detail = useData<Row>(`/conversations/${conversation}${params("SIMULATION")}`, !!conversation, 1500);
  const action = useAction();
  const selected = sources.data?.find(f => f.id === source);
  const needsOffer = Boolean(selected && !selected.offer_version_id);
  const offers = useData(`/products/${selected?.product_id}/offers${params("REAL")}`, needsOffer && Boolean(selected?.product_id));
  const eligibleOffers = offers.data?.filter(o => o.status === "PUBLISHED" && !o.archived_at && o.product_id === selected?.product_id && o.workflow_version_id === selected?.id) ?? [];
  const selectedOffer = eligibleOffers.find(o => o.id === offerId);
  const flow = workflows.data?.find(f => f.id === snapshot?.workflow_version_id);
  async function copy() {
    if (!selected || needsOffer && !selectedOffer) return;
    setSnapshot(await action.mutateAsync({ path: "/simulation-snapshots", body: { workflow_version_id: selected.id, expected_version: selected.version, ...(needsOffer ? { offer_version_id: selectedOffer!.id, expected_offer_version: selectedOffer!.version } : {}) } }) as Row);
    setConversation("");
  }
  return <div className="lab-content">
    <Panel title="1. Elige la versión que quieres ensayar" description="Se copiarán el flujo, la oferta y sus materiales permitidos a Pruebas.">
      <div className="sales-panel-body"><QueryState query={sources}><label className="field"><span>Versión comercial de origen</span><select value={source} disabled={action.isPending} onChange={event => { setSource(event.target.value); setOfferId(""); setSnapshot(undefined); setConversation(""); }}><option value="">Selecciona un flujo REAL…</option>{sources.data?.map(f => <option key={f.id} value={f.id}>{f.name} · revisión {f.version}</option>)}</select></label>{!sources.data?.length && <Empty title="Sin flujos disponibles" description="Crea y guarda primero un recorrido en Ventas → Flujos." />}</QueryState>{needsOffer && <QueryState query={offers}><label className="field"><span>Oferta que quieres ensayar</span><select value={offerId} disabled={action.isPending} onChange={event => { setOfferId(event.target.value); setSnapshot(undefined); setConversation(""); }}><option value="">Selecciona una oferta publicada…</option>{eligibleOffers.map(o => <option key={o.id} value={o.id}>{o.name} · revisión {o.version}</option>)}</select></label>{!eligibleOffers.length && <p>Este flujo necesita una oferta publicada del mismo producto que lo tenga seleccionado. Publícala en Oferta y materiales para poder ensayarla.</p>}</QueryState>}<Button disabled={!selected || needsOffer && !selectedOffer || action.isPending} onClick={() => void copy().catch(() => {})}>{action.isPending ? "Creando copia…" : "Crear copia de prueba"}</Button><Feedback error={action.error} /></div>
    </Panel>
    {snapshot && <><div className="snapshot-status" role="status"><ShieldCheck size={18} /><span>Copia de prueba creada. El flujo original conserva su revisión.</span></div><Panel title="2. Ensaya el recorrido"><div className="sales-panel-body"><Simulator key={snapshot.id} snapshot={snapshot} /><QueryState query={workflows}>{flow && <EvaluationPanel key={snapshot.id} flowId={flow.id} revision={flow.version ?? Number(snapshot.workflow_revision ?? 1)} />}</QueryState></div></Panel><Panel title="3. Conversaciones del laboratorio" description="Los detalles y el seguimiento permanecen dentro de Pruebas."><div className="sales-panel-body"><QueryState query={conversations}>{conversations.data?.length ? <div className="button-group">{conversations.data.map(c => <Button variant="secondary" key={c.id} onClick={() => setConversation(c.id)}>{String(c.contact_name ?? c.name ?? "Conversación de prueba")}</Button>)}</div> : <p>Inicia una simulación para ver sus mensajes y resultados.</p>}</QueryState>{conversation && <QueryState query={detail}><JsonDetail value={detail.data} title="Detalle de la conversación ficticia" /></QueryState>}</div></Panel></>}
  </div>;
}
