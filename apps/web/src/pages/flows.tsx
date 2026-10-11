import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  PageHeader,
  QueryState,
  Feedback,
  Empty,
  useWorkspace,
} from "../components/shared";
import { Button } from "../components/ui/button";
import { Modal } from "../components/ui/dialog";
import { useData, useAction, params, type Row } from "../lib/api";
import { FlowEditor } from "../components/sales/flow-editor";
export function FlowsPage() {
  const { environment, session } = useWorkspace();
  const location = useRouterState({ select: (s) => s.location }),
    navigate = useNavigate();
  const search = location.search as Record<string, string>;
  const selected = location.pathname.split("/")[3];
  const flows = useData(
      `/workflows${params(environment, { q: search.q, product_id: search.product, status: search.status })}`,
    ),
    detail = useData<Row>(
      `/workflows/${selected}${params(environment)}`,
      !!selected,
    ),
    products = useData(`/products${params(environment)}`),
    accounts = useData(
      `/channel-accounts${params(environment)}`,
      ["owner", "operator"].includes(session.role),
    );
  const [create, setCreate] = useState(false),
    [name, setName] = useState("");
  const action = useAction();
  const canWrite =
    session.permissions.includes("*") ||
    session.permissions.includes("workflows:write");
  if (selected)
    return (
      <QueryState query={detail}>
        {detail.data && (
          <>{detail.data.product_id&&<p><Link to="/catalog" search={{product:detail.data.product_id}}>Ver producto y asignar su configuración a números →</Link></p>}<FlowEditor key={`${environment}:${selected}`} flow={detail.data} /></>
        )}
      </QueryState>
    );
  return (
    <>
      <PageHeader
        eyebrow="VENTAS / FLUJOS Y VENDEDORES"
        title="Diseña el recorrido de cada venta"
        description="Elige una oferta, configura su vendedor y prueba cada paso."
        action={
          canWrite ? (
            <div className="button-group">
              <Button variant="secondary" asChild><Link to="/settings/tests">Abrir Pruebas</Link></Button>
              <Button onClick={() => setCreate(true)}>Nuevo flujo</Button>
            </div>
          ) : undefined
        }
      />
      <div className="tabs">
        <Link to="/sales/flows" search={search} aria-current="page">
          Flujos comerciales
        </Link>
        <Link to="/sales/agents" search={search}>
          Agentes de venta
        </Link>
      </div>
      <div className="sales-search">
        <label className="field">
          <span>Buscar flujo</span>
          <input
            type="search"
            value={search.q ?? ""}
            onChange={(e) =>
              void navigate({
                to: "/sales/flows",
                search: { ...search, q: e.target.value },
                replace: true,
              })
            }
          />
        </label>
        <label className="field">
          <span>Producto</span>
          <select
            value={search.product ?? ""}
            onChange={(e) =>
              void navigate({
                to: "/sales/flows",
                search: { ...search, product: e.target.value },
                replace: true,
              })
            }
          >
            <option value="">Todos</option>
            {products.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Estado</span>
          <select
            value={search.status ?? ""}
            onChange={(e) =>
              void navigate({
                to: "/sales/flows",
                search: { ...search, status: e.target.value },
                replace: true,
              })
            }
          >
            <option value="">Todos</option>
            <option value="DRAFT">Borradores</option>
            <option value="PUBLISHED">Publicados</option>
          </select>
        </label>
      </div>
      <QueryState query={flows}>
        <div className="sales-cards">
          {flows.data?.map((f) => (
            <Link
              key={f.id}
              to={`/sales/flows/${f.id}`}
              search={search}
              className="sales-card"
            >
              <strong>{f.name}</strong>
              <span>
                {products.data?.find((p) => p.id === f.product_id)?.name ??
                  "Producto pendiente"}
              </span>
              <span>
                {f.status === "PUBLISHED" ? "Publicado" : "Borrador"} · revisión{" "}
                {f.version} · {f.nodes?.length} pasos
              </span>
              <small>
                {accounts.data
                  ?.filter((a) => a.workflow_version_id === f.id)
                  .map((a) => a.name)
                  .join(", ") || "Sin asignación directa a números"}
              </small>
            </Link>
          ))}
          {!flows.data?.length && (
            <Empty
              title="Construye un recorrido comercial"
              description="Crea un flujo y elige la oferta que venderá."
            />
          )}
        </div>
      </QueryState>
      <Modal
        title="Nuevo flujo comercial"
        open={create}
        onOpenChange={setCreate}
      >
        <label className="field">
          <span>Nombre del flujo</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <p>
          Empieza con inicio, mensaje, compromiso, comprobante y fin. Puedes
          agregar ramas y materiales.
        </p>
        <Feedback error={action.error} />
        <Button
          disabled={!name.trim() || action.isPending}
          onClick={() =>
            void action
              .mutateAsync({
                path: "/workflows",
                body: {
                  name,
                  entry_node_id: "inicio",
                  ...(search.product ? { product_id: search.product } : {}),
                  nodes: [
                    {
                      id: "inicio",
                      type: "entry",
                      config: {},
                      next: "mensaje",
                    },
                    {
                      id: "mensaje",
                      type: "message",
                      config: {
                        text: "Conoce {{product_name}} por {{price}} {{currency}}.",
                      },
                      next: "compromiso",
                    },
                    {
                      id: "compromiso",
                      type: "commitment",
                      config: {},
                      next: "comprobante",
                    },
                    {
                      id: "comprobante",
                      type: "receipt",
                      config: {},
                      next: "fin",
                    },
                    { id: "fin", type: "end", config: {} },
                  ],
                },
              })
              .then((r) => {
                setCreate(false);
                void navigate({
                  to: `/sales/flows/${(r as Row).id}`,
                  search: {},
                });
              })
              .catch(() => {})
          }
        >
          Crear borrador
        </Button>
      </Modal>
    </>
  );
}
