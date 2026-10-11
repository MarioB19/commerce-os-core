import { useRef, useEffect, useState } from 'react';
import { Panel, Feedback, QueryState, useWorkspace } from './shared';
import { Button } from './ui/button';
import { api, useData, params, type Row } from '../lib/api';
type Item = Record<string, any>;
type PendingRead = { id: string; version: number; status: string; action: 'prepare' | 'apply' | 'resolve' };
export function ProductAssistant({ product }: { product: Row }) {
  const { environment, session } = useWorkspace();
  return <ProductAssistantForm key={session.workspace_id + ':' + environment + ':' + product.id} product={product} />;
}
function ProductAssistantForm({ product }: { product: Row }) {
  const { environment, session } = useWorkspace(), draftKey = `commerce-assistant:${session.workspace_id}:${environment}:${product.id}`;
  const intent = useRef({ hash: '', key: crypto.randomUUID() });
  const context = useData<Item>(`/products/${product.id}/assistant${params(environment)}`);
  function savedDraft() { try { return JSON.parse(localStorage.getItem(draftKey) ?? '{}'); } catch { return {}; } }
  const [request, setRequest] = useState(() => savedDraft().request ?? ''), [description, setDescription] = useState(() => savedDraft().description ?? '');
  const [pendingRead, setPendingRead] = useState<PendingRead | null>(() => savedDraft().pendingRead ?? null);
  const [readConflict, setReadConflict] = useState<Item | null>(null);
  const [proposal, setProposal] = useState<Item | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<Error | null>(null), [result, setResult] = useState('');
  useEffect(() => { try { localStorage.setItem(draftKey, JSON.stringify({ request, description, pendingRead })); } catch { /* storage optional */ } }, [draftKey, request, description, pendingRead]);
  function reviewable(p: Item) { return { ...p, diff: Object.entries(p.changes).map(([field, to]) => ({ field, to, from: p.previous_product?.[field] ?? '' })) }; }
  async function readBack(expected: PendingRead) {
    setReadConflict(null);
    const refreshed = await context.refetch();
    if (refreshed.isError || !refreshed.data) throw Error('El guardado fue recibido, pero la lectura posterior falló. Comprueba el resultado guardado sin repetir el cambio.');
    const observed = refreshed.data.proposals?.find((p: Item) => p.id === expected.id);
    if (!observed || observed.version !== expected.version || observed.status !== expected.status) {
      if (observed && Number.isSafeInteger(observed.version) && observed.version > expected.version) setReadConflict(observed);
      throw Error('La lectura no contiene la propuesta y revisión esperadas. Conservamos la referencia para comprobarla sin repetir el cambio.');
    }
    if (expected.action === 'prepare') {
      setProposal(observed.status === 'DRAFT' ? reviewable(observed) : null);
      setResult('Propuesta guardada y releída.');
    } else {
      setProposal(null);
      setResult(expected.action === 'apply' ? 'Cambio guardado y comprobado por lectura posterior.' : 'Excepción resuelta y comprobada por lectura posterior.');
    }
    setPendingRead(null);
  }
  async function verifySaved() {
    if (!pendingRead || busy) return;
    setBusy(true); setError(null); setResult('');
    try { await readBack(pendingRead); } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  async function prepare() {
    if (pendingRead || busy) return;
    setBusy(true); setError(null); setResult('');
    try {
      const body = JSON.stringify({ expected_version: context.data?.product.version ?? product.version, kind: description ? 'product_update' : 'exception_note', request_text: request, changes: description ? { description } : {} });
      if (intent.current.hash !== body) intent.current = { hash: body, key: crypto.randomUUID() };
      const value = await api<Item>(`/products/${product.id}/assistant/proposals${params(environment)}`, { method: 'POST', headers: { 'Idempotency-Key': intent.current.key }, body });
      const expected: PendingRead = { id: value.id, version: value.version, status: value.status, action: 'prepare' };
      setPendingRead(expected); setProposal(null);
      await readBack(expected);
    } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  async function apply() {
    if (!proposal || pendingRead || busy) return;
    setBusy(true); setError(null); setResult('');
    try {
      await api(`/products/${product.id}${params(environment)}`, { method: 'PATCH', headers: { 'Idempotency-Key': 'assistant-apply-' + proposal.id }, body: JSON.stringify({ ...proposal.changes, expected_version: proposal.expected_version }) });
      const current = await api<Row>(`/products/${product.id}${params(environment)}`);
      if (Object.entries(proposal.changes).some(([k, v]) => current[k] !== v)) throw Error('La lectura posterior no coincide; revisa el recurso.');
      const value = await api<Item>(`/products/${product.id}/assistant/proposals/${proposal.id}/state${params(environment)}`, { method: 'POST', headers: { 'Idempotency-Key': 'assistant-reconcile-' + proposal.id }, body: JSON.stringify({ expected_version: proposal.version, action: 'reconcile', reason: 'Cambio aplicado mediante API y verificado por lectura posterior' }) });
      const expected: PendingRead = { id: value.id, version: value.version, status: value.status, action: 'apply' };
      setPendingRead(expected);
      await readBack(expected);
    } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  async function resolve(p: Item) {
    if (pendingRead || busy) return;
    setBusy(true); setError(null); setResult('');
    try {
      const value = await api<Item>(`/products/${product.id}/assistant/proposals/${p.id}/state${params(environment)}`, { method: 'POST', headers: { 'Idempotency-Key': 'assistant-resolve-' + p.id + '-' + p.version }, body: JSON.stringify({ expected_version: p.version, action: 'resolve', reason: 'Excepción resuelta por el equipo desde el producto' }) });
      const expected: PendingRead = { id: value.id, version: value.version, status: value.status, action: 'resolve' };
      setPendingRead(expected);
      await readBack(expected);
    } catch (e) { setError(e as Error); } finally { setBusy(false); }
  }
  return <Panel title="Asistente del producto" description="Consulta preparación, registra excepciones y prepara cambios revisables con el mismo contrato de la API."><div className="sales-panel-body grid gap-4">
    <QueryState query={context}>{context.data && <>
      <p>{context.data.next_actions.length ? context.data.next_actions.join(' · ') : 'Configuración principal registrada. Revisa pruebas, conexiones y autorizaciones antes de operar.'}</p>
      <details><summary>Preparar cambio o registrar excepción</summary>
        <label className="field"><span>Qué necesitas resolver</span><textarea value={request} onChange={e => setRequest(e.target.value)} placeholder="Describe la excepción o el motivo del cambio" /></label>
        <label className="field"><span>Nueva descripción del producto (opcional)</span><textarea value={description} onChange={e => setDescription(e.target.value)} /></label>
        <Button disabled={busy || !!pendingRead || request.trim().length < 3} onClick={() => void prepare()}>Preparar propuesta</Button>
      </details>
      <p className="muted">La consulta y preparación por reglas funcionan sin proveedor IA. El perfil del asistente se verifica por separado en Integraciones.</p>
      {proposal && <section aria-label="Propuesta y diferencias"><h3>Propuesta guardada</h3>{proposal.diff?.map((d: Item) => <div key={d.field}><strong>{d.field === 'description' ? 'Descripción' : d.field}</strong><p>Actual: {d.from}</p><p>Propuesta: {d.to}</p></div>)}{Object.keys(proposal.changes).length > 0 && <Button disabled={busy || !!pendingRead} onClick={() => void apply()}>Aplicar este cambio al producto</Button>}</section>}
      <details><summary>Propuestas y excepciones guardadas</summary>{context.data.proposals?.map((p: Item) => <article key={p.id}><strong>{p.kind === 'exception_note' ? 'Excepción registrada' : 'Propuesta de cambio'}</strong><p>{p.request_text}</p><small>{p.status} · {new Date(p.created_at).toLocaleString()}</small>{p.status === 'DRAFT' && <Button variant="secondary" disabled={busy || !!pendingRead} onClick={() => setProposal(reviewable(p))}>Revisar propuesta</Button>}{p.status === 'OPEN' && <Button variant="secondary" disabled={busy || !!pendingRead} onClick={() => void resolve(p)}>Marcar excepción resuelta</Button>}</article>)}</details>
    </>}</QueryState>
    {pendingRead && <div role="status"><p>Hay un resultado guardado pendiente de comprobar. Esta consulta conserva la referencia y no repite el cambio.</p><Button variant="secondary" disabled={busy} onClick={() => void verifySaved()}>Comprobar resultado guardado</Button>{readConflict && <><p>Existe una revisión posterior de esta propuesta. Puedes revisarla y liberar la referencia anterior sin repetir cambios.</p><Button variant="secondary" disabled={busy} onClick={() => { setProposal(readConflict.status === 'DRAFT' ? reviewable(readConflict) : null); setPendingRead(null); setReadConflict(null); setError(null); setResult('Referencia anterior liberada. Revisa el estado vigente; no se confirmó la revisión esperada de la operación anterior.'); }}>Revisar versión actual</Button></>}</div>}
    <Feedback error={error} />{result && <p role="status">{result}</p>}
  </div></Panel>;
}
