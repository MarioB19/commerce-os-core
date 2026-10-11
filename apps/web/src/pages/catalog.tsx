import {AssetPreview} from '../components/asset-preview';
import {ProductWorkspace} from './product-workspace';
import {CommercialConfiguration,ArchivedConfiguration} from '../components/sales/commercial-configuration';
import {KnowledgeEditor} from '../components/sales/knowledge-editor';
import {OfferFlowEditor,OpenRemarketingCycles} from '../components/sales/offer-flow-editor';
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Archive,
  ArrowLeft,
  FileUp,
  FileText,
  Package,
  Plus,
  Search,
  ShieldCheck,
} from "lucide-react";
import {
  Badge,
  DataTable,
  Empty,
  Feedback,
  Fields,
  Notice,
  PageHeader,
  Panel,
  QueryState,
  ResourceForm,
  Status,
  initialValues,
  useWorkspace,
  type Field,
} from "../components/shared";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/dialog";
import { api, params, useAction, useData, type Row } from "../lib/api";
import { date, money } from "../lib/utils";
import {StateBadge} from '../components/operational-state';
const productFields: Field[] = [
  {
    name: "name",
    label: "Nombre del producto",
    required: true,
    placeholder: "Ej. Guía de fotografía",
  },
  {
    name: "slug",
    label: "Identificador",
    placeholder: "guia-de-fotografia",
    hint: "Letras minúsculas, números y guiones.",
  },
  { name: "description", label: "Descripción", type: "textarea" },
];
export function CatalogPage() {
  const { environment, session } = useWorkspace();
  const location = useRouterState({ select: (s) => s.location });
  const search = location.search as {
    product?: string; all?: string; view?: string; proposal?: string;
  };
  const navigate=useNavigate();
  const selected=search.product??null;
  const setSelected=(product:string|null)=>void navigate({to:'/catalog',search:old=>({...old,product:product??undefined,all:product?undefined:"true"}),replace:false});
  const filter=(search as Record<string,string>).q??"";
  const setFilter=(q:string)=>void navigate({to:'/catalog',search:old=>({...old,q}),replace:true});
  const tab = search.view === "assets" ? "assets" : "products";
  const setTab = (view:string) => void navigate({to:'/catalog',search:old=>({...old,view:view==='assets'?'assets':undefined}),replace:true});
  const [archiveOpen,setArchiveOpen]=useState(false);
  const products = useData(`/products${params(environment, { q: filter })}`);
  const assets = useData(`/assets${params(environment)}`);
  const offers = useData(`/offers${params(environment)}`);
  const proposals = useData<Row[]>(`/intelligence/opportunities${params(environment,{limit:'100'})}`,Boolean(search.proposal));
  const proposal = proposals.data?.find(item=>item.id===search.proposal);
  const selectedQuery = useData<Row>(`/products/${selected}${params(environment)}`, !!selected);
  const selectedProduct = selectedQuery.data ?? products.data?.find((p) => p.id === selected);
  // The router can publish a destination location before this page unmounts.
  // Restore the optional product preference only while entering the catalog.
  useEffect(()=>{if(location.pathname!=='/catalog'||selected||search.all==='true'||filter||!products.data)return;try{const saved=localStorage.getItem(`commerce-selected-product:${session.workspace_id}:${environment}`);if(saved&&products.data.some(p=>p.id===saved))void navigate({to:'/catalog',search:old=>({...old,product:saved}),replace:true});}catch{/* Optional navigation preference. */}},[location.pathname,selected,search.all,filter,products.data,navigate,session.workspace_id,environment]);
  if (selected && !selectedProduct) return <QueryState query={selectedQuery}><Empty title="No disponible" /></QueryState>;
  if (selectedProduct)
    return (
      <ProductWorkspace product={selectedProduct} offerContent={<ProductDetail product={selectedProduct} onBack={() => setSelected(null)}/>}/>
    );
  return (
    <>
      <details onToggle={event=>setArchiveOpen(event.currentTarget.open)}><summary>Ver archivo recuperable</summary>{archiveOpen&&<ArchivedConfiguration/>}</details>
      <PageHeader
        eyebrow="CATÁLOGO COMPARTIDO"
        title="Productos y ofertas"
        description="Una fuente de verdad para lo que vendes, prometes y entregas."
        action={
          <ResourceForm
            title="Nuevo producto"
            description="El producto existe sin depender de un canal. Las ofertas y entregables se configuran después."
            fields={productFields}
            path="/products"
            trigger="Nuevo producto"
          />
        }
      />
      {search.proposal&&<section className="ux-anchor" aria-labelledby="proposal-handoff-title"><div className="ux-anchor-copy"><div className="ux-state-heading"><StateBadge value={proposal?'IN_PROGRESS':proposals.isLoading?'IN_PROGRESS':'PARTIAL'}/><span>Propuesta guardada en Inteligencia</span></div><h2 id="proposal-handoff-title">{String(proposal?.title??proposal?.name??(proposals.isLoading?'Recuperando propuesta…':'Propuesta no disponible'))}</h2><p>{String(proposal?.summary??proposal?.description??'Elige un producto para convertir esta propuesta en oferta. Nada se publica, asigna ni activa automáticamente.')}</p><small>El traspaso conserva el contexto; la oferta y sus versiones siguen bajo control del equipo.</small></div></section>}
      <div className="tabs">
        <button
          className={tab === "products" ? "active" : ""}
          onClick={() => setTab("products")}
        >
          <Package size={16} />
          Productos <span>{products.data?.length ?? "No disponible"}</span>
        </button>
        <button
          className={tab === "assets" ? "active" : ""}
          onClick={() => setTab("assets")}
        >
          <Archive size={16} />
          Archivos y accesos <span>{assets.data?.length ?? "No disponible"}</span>
        </button>
      </div>
      {tab === "products" ? (
        <>
          <div className="toolbar">
            <label className="search-field"><span>Buscar productos</span><div className="search-input">
              <Search size={17} />
              <input
                aria-label="Buscar productos"
                placeholder="Buscar en el catálogo…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div></label>

          </div>
          <QueryState query={products}>
            {!products.data?.length ? (
              <Panel>
                <Empty
                  title="Tu siguiente producto empieza aquí"
                  description="Crea un producto y agrega una oferta con precio, condiciones y materiales."
                />
              </Panel>
            ) : (
              <div className="product-grid">
                {products.data.map((product) => {
                  const list = (offers.data ?? []).filter(
                    (o) => o.product_id === product.id,
                  );
                  return (
                    <button
                      className="product-card"
                      key={product.id}
                      onClick={() => setSelected(product.id)}
                    >
                      <div className="product-card-content">
                        <div className="product-card-title">
                          <h2>{product.name}</h2>
                          <span>↗</span>
                        </div>
                        <p>
                          {product.description ||
                            "Agrega una descripción para tu equipo."}
                        </p>
                        <div className="product-card-footer">
                          <span>
                            {list.length}{" "}
                            {list.length === 1 ? "oferta" : "ofertas"}
                          </span>
                          <strong>
                            {list[0]
                              ? money(
                                  list[0].base_amount_minor,
                                  list[0].currency,
                                )
                              : "Sin oferta"}
                          </strong>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </QueryState>
        </>
      ) : (
        <>
          <div className="toolbar">
            <p>Contenido privado y referencias de entrega versionadas.</p>
            <AssetUploader />
          </div>
          <Panel>
            <QueryState query={assets}>
              <DataTable
                data={assets.data ?? []}
                columns={[
                  {
                    key: "name",
                    title: "Material",
                    render: (r) => (
                      <span className="table-primary">
                        <FileText size={15} />
                        {r.name}
                      </span>
                    ),
                  },
                  { key: "kind", title: "Tipo" },
                  {
                    key: "status",
                    title: "Estado",
                    render: (r) => <Status value={r.status} />,
                  },
                  { key: "usage_count", title: "Uso", render: (r) => r.usage_count == null ? "No verificado" : `${r.usage_count} referencias` },
                ]}
              />
            </QueryState>
          </Panel>
        </>
      )}
    </>
  );
}
function ProductDetail({
  product,
  onBack,
}: {
  product: Row;
  onBack: () => void;
}) {
  const { environment } = useWorkspace();
  const offers = useData(
    `/offers${params(environment, { product_id: product.id })}`,
  );
  const assets = useData(`/assets${params(environment)}`);
  const bank = useData(`/bank-profiles${params(environment)}`);
  const policies = useData(`/receipt-policies${params(environment)}`);
  const [selectedOffer, setSelectedOffer] = useState<Row | null>(null);
  const publication = useAction();
  const versioning = useAction();
  const [publishedMessage, setPublishedMessage] = useState("");
  const fields: Field[] = [
    { name: "name", label: "Nombre de la oferta", required: true },
    {
      name: "base_amount",
      label: "Precio total",
      type: "number",
      step: 0.01,
      required: true,
      min: 0,
      hint: "Importe total en la moneda elegida, por ejemplo 107.00.",
    },
    {
      name: "currency",
      label: "Moneda",
      type: "select",
      required: true,
      default: "MXN",
      options: [
        { value: "MXN", label: "MXN · Peso mexicano" },
        { value: "USD", label: "USD · Dólar estadounidense" },
      ],
    },
    {
      name: "billing_delay_minutes",
      label: "Espera antes del cobro (minutos)",
      type: "number",
      default: 30,
      min: 0,
    },
    {
      name: "payment_profile_version_id",
      label: "Perfil bancario",
      type: "select",
      options: (bank.data ?? []).map((r) => ({
        value: r.id,
        label: r.name ?? r.id,
      })),
    },
    {
      name: "receipt_policy_version_id",
      label: "Política documental",
      type: "select",
      options: (policies.data ?? []).map((r) => ({
        value: r.id,
        label: r.name ?? r.id,
      })),
    },
    {
      name: "fulfillment",
      label: "Entregables y condiciones",
      type: "fulfillment",
      advanced: false,
      default: [],
      options: (assets.data ?? []).filter((asset) => asset.status === "READY").map((asset) => ({ value: asset.id, label: asset.name ?? "Material sin nombre" })),
      hint: "Cada fila fija un material, su condición de liberación y un importe mínimo opcional.",
    },
  ];
  return (
    <>
      <Button variant="ghost" onClick={onBack} className="back-button">
        <ArrowLeft />
        Volver al catálogo
      </Button>
      <PageHeader
        eyebrow="PRODUCTOS Y OFERTAS"
        title={product.name ?? "Producto"}
        description={product.description}
        action={
          <ResourceForm
            title="Editar producto"
            fields={productFields}
            path={`/products/${product.id}`}
            method="PATCH"
            initial={product}
            trigger="Editar producto"
          />
        }
      />
      <nav className="sales-quicklinks" aria-label="Ventas de este producto"><Link to="/sales/agents" search={{product:product.id}}>Configurar vendedor →</Link><Link to="/sales/flows" search={{product:product.id}}>Ajustar flujo →</Link><Link to="/sales/inbox" search={{product:product.id}}>Conversaciones →</Link></nav>
      <CommercialConfiguration productId={product.id}/><details><summary>Conocimiento y categoría compartidos</summary><KnowledgeEditor key={product.id} record={product}/></details>
      <div className="record-meta"><Badge>Producto · versión {product.version??1}</Badge><Status value={environment} /><details><summary>Referencia técnica</summary><code>{product.id}</code></details></div>
      <Notice>
        Las ventas conservan la oferta y la versión que usaron. Crear una oferta
        nueva conserva el historial comercial.
      </Notice>
      <ResourceForm
        title="Duplicar producto como borrador"
        path={`/products/${product.id}/duplicate`}
        trigger="Duplicar producto"
        fields={[
          {
            name: "name",
            label: "Nombre del nuevo producto",
            required: true,
            default: `${product.name} · copia`,
          },
        ]}
      />
      <div style={{ height: 20 }} />
      <Panel
        title="Ofertas y condiciones"
        description="Precio, perfil de cobro y reglas de entrega fijados por versión."
        action={
          <ResourceForm
            title="Nueva oferta"
            fields={fields}
            transform={data=>{const {base_amount,billing_delay_minutes,...rest}=data;return {...rest,base_amount_minor:Math.round(Number(base_amount)*100),billing_delay_seconds:Math.round(Number(billing_delay_minutes??30)*60)};}}
            path={`/products/${product.id}/offers`}
            trigger="Nueva oferta"
          />
        }
      >
        <QueryState query={offers}>
          <DataTable
            data={offers.data ?? []}
            onSelect={setSelectedOffer}
            columns={[
              {
                key: "name",
                title: "Oferta",
                render: (r) => <strong>{r.name ?? "Oferta"}</strong>,
              },
              {
                key: "base_amount_minor",
                title: "Precio",
                render: (r) => money(r.base_amount_minor, r.currency),
              },
              {
                key: "status",
                title: "Estado",
                render: (r) => <Status value={r.status} />,
              },
              {
                key: "created_at",
                title: "Creada",
                render: (r) => date(r.created_at),
              },
              {
                key: "id",
                title: "Revisión",
                render: (r) => <span>v{r.version??1}</span>,
              },
              {
                key: "usage_count",
                title: "Uso",
                render: (r) => r.usage_count == null && r.active_assignments == null ? "No verificado" : `${Number(r.usage_count??r.active_assignments??0)} usos`,
              },
            ]}
          />
        </QueryState>
      </Panel>
      <Panel
        title="Materiales disponibles"
        description="Usa estas referencias al configurar las condiciones de entrega."
        action={<AssetUploader />}
      >
        <QueryState query={assets}>
          <DataTable
            data={assets.data ?? []}
            columns={[
              { key: "name", title: "Nombre" },
              { key: "kind", title: "Formato" },
              { key: "preview", title: "Material", render: (r) => r.status === "READY" ? <AssetPreview assetId={r.id} /> : null },
              {
                key: "status",
                title: "Disponibilidad",
                render: (r) => <Status value={r.status} />,
              },
            ]}
          />
        </QueryState>
      </Panel>
      <Modal
        open={!!selectedOffer}
        onOpenChange={(open) => {
          if (!open) setSelectedOffer(null);
        }}
        title="Versión de oferta"
        description="Configura el recorrido completo con nombres y vistas previas. Guardar conserva un borrador; publicar sigue siendo una acción separada."
        wide
      >
        <div className="record-meta">
          <Badge>
            {money(selectedOffer?.base_amount_minor, selectedOffer?.currency)}
          </Badge>
          <Status value={selectedOffer?.status} />
        </div>
        {selectedOffer?.status === "DRAFT" && (
          <Button
            disabled={publication.isPending}
            onClick={() => {
              void publication
                .mutateAsync({
                  path: `/offers/${selectedOffer.id}/publish`,
                  body: { expected_version: selectedOffer.version },
                })
                .then((published) => {
                  setSelectedOffer(published as Row);
                  setPublishedMessage(
                    "Oferta publicada como nueva versión inmutable.",
                  );
                  return offers.refetch();
                })
                .catch(() => {});
            }}
          >
            Publicar oferta
          </Button>
        )}
        {selectedOffer?.status === "PUBLISHED" && <Button variant="secondary" disabled={versioning.isPending} onClick={()=>{void versioning.mutateAsync({path:`/offers/${selectedOffer.id}/versions`,body:{expected_version:selectedOffer.version,changes:{}}}).then(row=>{setSelectedOffer(row as Row);setPublishedMessage('Nueva versión editable creada; la publicada conserva su historial.');return offers.refetch();}).catch(()=>{});}}>{versioning.isPending?'Creando borrador…':'Crear nueva versión editable'}</Button>}
        <Feedback error={publication.error??versioning.error} success={publishedMessage} />
        {selectedOffer&&<OfferFlowEditor offer={selectedOffer} product={product} assets={assets.data??[]} uploadAction={<AssetUploader/>} onSaved={saved=>{setSelectedOffer(current=>current?{...current,...saved}:saved);void offers.refetch();}}/>}
        {selectedOffer?.status==='PUBLISHED'&&<OpenRemarketingCycles offer={selectedOffer} productOfferIds={(offers.data??[]).map(row=>row.id)}/>}
      </Modal>
    </>
  );
}
function AssetUploader() {
  const { environment, session } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (!["owner", "operator"].includes(session.role)) return null;
  return <>
    <Button variant="secondary" onClick={() => setOpen(true)}><FileUp />Agregar material</Button>
    <Modal title="Agregar material privado" description="Archivos y códigos protegidos. Selecciona cómo se entregará el material cuando el flujo cumpla sus condiciones." open={open} onOpenChange={setOpen}>
      {open && <AssetUploadForm key={environment} onSaved={() => setOpen(false)} />}
    </Modal>
  </>;
}
function AssetUploadForm({ onSaved }: { onSaved: () => void }) {
  const { environment } = useWorkspace();
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const fields: Field[] = [
    { name: "name", label: "Nombre del material", required: true },
    { name: "kind", label: "Tipo de entrega", type: "select", required: true, default: "file", options: [
      { value: "file", label: "Archivo privado" }, { value: "link", label: "Enlace HTTPS" },
      { value: "portal", label: "Acceso a portal con código" }, { value: "webhook", label: "Acceso mediante servicio de entrega" },
    ] },
    { name: "url", when: (values) => values.kind === "link" || values.kind === "portal", required: true, label: "Dirección HTTPS", placeholder: "https://" },
    { name: "portal_code", when: (values) => values.kind === "portal", required: true, type: "password", label: "Código de acceso al portal", hint: "El código se cifra. No se devuelve en el catálogo ni se conserva al cerrar este formulario." },
    { name: "portal_instructions", when: (values) => values.kind === "portal", type: "textarea", advanced: false, label: "Instrucciones para acceder", hint: "Se entregan junto al enlace y el código cuando corresponda." },
    { name: "delivery_reference", when: (values) => values.kind === "webhook", required: true, type: "password", label: "Referencia protegida de entrega", hint: "Referencia que interpreta el servicio de entrega configurado en Sistema." },
  ];
  const [values, setValues] = useState(initialValues(fields));
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ create: string; upload: string; complete: string; assetId?: string } | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setError(null); setPending(true);
    try {
      const kind = values.kind;
      if (kind === "file" && !file) throw new Error("Selecciona el archivo a proteger.");
      if (kind === "file" && file && (!file.size || file.size > 20 * 1024 * 1024)) throw new Error("El archivo debe tener contenido y medir hasta 20 MiB.");
      if (["link", "portal"].includes(kind ?? "")) {
        let valid = false;
        try { const url = new URL(values.url ?? ""); valid = url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { /* The message never includes the submitted URL. */ }
        if (!valid) throw new Error("Usa una dirección HTTPS sin credenciales ni fragmentos.");
      }
      if (kind === "portal" && (!values.portal_code || values.portal_code.length > 512 || (values.portal_instructions?.length ?? 0) > 4096)) throw new Error("El portal necesita un código de hasta 512 caracteres e instrucciones de hasta 4096.");
      attempt.current ??= { create: crypto.randomUUID(), upload: crypto.randomUUID(), complete: crypto.randomUUID() };
      const intent = attempt.current;
      if (!intent.assetId) {
        const body = {
          name: values.name, environment,
          kind: kind === "portal" || kind === "webhook" ? "access" : kind,
          adapter: kind === "portal" || kind === "link" ? "link" : kind === "webhook" ? "webhook" : "private_file",
          ...(kind === "link" ? { url: values.url } : {}),
          ...(kind === "portal" ? { delivery_reference: JSON.stringify({ url: values.url, code: values.portal_code, instructions: values.portal_instructions ?? "" }) } : {}),
          ...(kind === "webhook" ? { delivery_reference: values.delivery_reference } : {}),
          ...(kind === "file" && file ? { mime_type: file.type || "application/octet-stream", size_bytes: file.size } : {}),
        };
        // Private access codes and file bytes must not enter React Query's mutation cache.
        const asset = await api<Row>(`/assets${params(environment)}`, { method: "POST", headers: { "Idempotency-Key": intent.create }, body: JSON.stringify(body) });
        intent.assetId = asset.id;
      }
      if (kind === "file" && file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        await api(`/assets/${intent.assetId}/content${params(environment)}`, { method: "PUT", headers: { "Idempotency-Key": intent.upload }, body: JSON.stringify({ base64: btoa(binary) }) });
        bytes.fill(0); binary = "";
      }
      await api(`/assets/${intent.assetId}/complete${params(environment)}`, { method: "POST", headers: { "Idempotency-Key": intent.complete }, body: "{}" });
      setValues(initialValues(fields)); setFile(null); attempt.current = null;
      await client.invalidateQueries(); onSaved();
    } catch (caught) { setError(caught as Error); } finally { setPending(false); }
  }
  return <form onSubmit={(event) => void submit(event)} onChange={() => { attempt.current = null; setError(null); }} autoComplete="off">
    <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <Fields fields={fields} values={values} setValues={(next) => { if (next.kind !== values.kind) { next.portal_code = ""; next.portal_instructions = ""; next.delivery_reference = ""; next.url = ""; setFile(null); } setValues(next); }} />
      {values.kind === "file" && <label className="upload-area"><FileUp size={26} /><strong>{file?.name ?? "Seleccionar archivo"}</strong><small>PDF, imagen, audio, video o texto · Hasta 20 MiB</small><input type="file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} aria-label="Archivo privado" /></label>}
      <Notice><ShieldCheck size={14} /> Guardar prepara el material. La entrega a un contacto depende del flujo y de una autorización vigente.</Notice>
      <Feedback error={error} />
      <div className="form-footer"><Button type="submit" disabled={pending}><Plus />{pending ? "Protegiendo…" : "Guardar material"}</Button></div>
    </fieldset>
  </form>;
}
