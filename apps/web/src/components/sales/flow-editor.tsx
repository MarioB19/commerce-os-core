import { useCallback, useEffect, useRef, useState } from "react";
import {
  Link,
  useBlocker,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Handle,
  Position,
  useReactFlow,
  type NodeProps,
  type Node,
  type Connection,
  type EdgeProps,
  BaseEdge,
  getSmoothStepPath,
  EdgeLabelRenderer,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "../ui/button";
import { Modal } from "../ui/dialog";
import { Feedback, useWorkspace } from "../shared";
import {
  params,
  useAction,
  useData,
  type Row,
  type FlowNode,
  object,
} from "../../lib/api";
import {
  documentOf,
  stepTypes,
  stepName,
  edgesOf,
  organize,
  connect,
  insertStep,
  deleteStep,
  makeNode,
  moveLinear,
  type FlowDocument,
} from "../../lib/flow-graph";
import { EvaluationPanel } from "./evaluation-panel";
type BlockData = { label: string; kind: string; selected: boolean };
function SalesBlock({ data }: NodeProps<Node<BlockData>>) {
  return (
    <div className={`sales-block kind-${data.kind}`}>
      <Handle type="target" position={Position.Top} role="img" aria-label="Entrada" />
      <small>{stepName(data.kind)}</small>
      <strong>{data.label}</strong>
      {data.kind !== "end" &&
        (data.kind === "condition" ? (
          <>
            <Handle
              role="img"
              type="source"
              id="true"
              position={Position.Bottom}
              style={{ left: "25%" }}
              aria-label="Salida Sí"
            />
            <span className="port-yes">Sí</span>
            <Handle
              role="img"
              type="source"
              id="false"
              position={Position.Bottom}
              style={{ left: "75%" }}
              aria-label="Salida No"
            />
            <span className="port-no">No</span>
          </>
        ) : (
          <Handle
            role="img"
            type="source"
            id="next"
            position={Position.Bottom}
            aria-label="Siguiente"
          />
        ))}
    </div>
  );
}
function SalesEdge(props: EdgeProps) {
  const [path, x, y] = getSmoothStepPath(props);
  return (
    <>
      <BaseEdge path={path} markerEnd={props.markerEnd} style={props.style} />
      <EdgeLabelRenderer>
        <button
          className="edge-insert nodrag nopan"
          data-edge-id={props.id}
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${x}px,${y}px)`,
            pointerEvents: "all",
          }}
          aria-label={`Conexión ${String(props.label)}. Seleccionar destino o insertar paso.`}
          onClick={() => (props.data?.pick as (() => void) | undefined)?.()}
        >
          {String(props.label)} +
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
const nodeTypes = { sales: SalesBlock },
  edgeTypes = { sales: SalesEdge };
export function FlowEditor({ flow }: { flow: Row }) {
  return (
    <ReactFlowProvider>
      <Editor key={`${flow.environment}:${flow.id}`} flow={flow} />
    </ReactFlowProvider>
  );
}
function Editor({ flow }: { flow: Row }) {
  const { environment, session } = useWorkspace();
  const canWrite =
    session.permissions.includes("*") ||
    session.permissions.includes("workflows:write");
  const editable = flow.status !== "PUBLISHED" && canWrite;
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search }) as Record<
    string,
    string
  >;
  const graph = useReactFlow();
  const [doc, setDoc] = useState(() => documentOf(flow)),
    [past, setPast] = useState<FlowDocument[]>([]),
    [future, setFuture] = useState<FlowDocument[]>([]);
  const [saved, setSaved] = useState(() => JSON.stringify(documentOf(flow))),
    [revision, setRevision] = useState(flow.version ?? 1),
    [saving, setSaving] = useState(false),
    [error, setError] = useState<Error | null>(null),
    [message, setMessage] = useState("Borrador guardado");
  const [selected, setSelected] = useState(
      search.node ?? flow.entry_node_id ?? "",
    ),
    [view, setView] = useState(() =>
      window.innerWidth < 768 ? "steps" : "map",
    ),
    [find, setFind] = useState(""),
    [library, setLibrary] = useState(false),
    [test, setTest] = useState(false),
    [minimap, setMinimap] = useState(false);
  const [newType, setNewType] = useState("message"),
    [selectedEdge, setSelectedEdge] =
      useState<ReturnType<typeof edgesOf>[number]>(),
    [confirmEdit, setConfirmEdit] = useState<{
      title: string;
      description: string;
      next: FlowDocument;
      select?: string;
    }>();
  const [issues, setIssues] = useState<
      Array<{ message: string; node_id?: string }>
    >([]),
    [advanced, setAdvanced] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState<Connection>();
  const mutation = useAction();
  const offers = useData(`/offers${params(environment)}`),
    workflows = useData(`/workflows${params(environment)}`),
    materials = useData(`/assets${params(environment)}`),
    agents = useData(`/agents${params(environment)}`),
    seller = useData<Row>(`/workflows/${flow.id}/seller${params(environment)}`);
  const current = doc.nodes.find((n) => n.id === selected),
    dirty = JSON.stringify(doc) !== saved || Object.keys(advanced).length > 0;
  const live = useRef({ doc, revision, saved });
  live.current = { doc, revision, saved };
  const inflight = useRef<Promise<Row | undefined> | null>(null);
  const save = useCallback(async (): Promise<Row | undefined> => {
    if (inflight.current) await inflight.current;
    if (JSON.stringify(live.current.doc) === live.current.saved)
      return { ...flow, version: live.current.revision };
    if (Object.keys(advanced).length)
      throw new Error(
        "Corrige o aplica los parámetros avanzados antes de guardar.",
      );
    setSaving(true);
    const snapshot = structuredClone(live.current.doc),
      expected = live.current.revision;
    const promise = (async () => {
      try {
        const row = (await mutation.mutateAsync({
          path: `/workflows/${flow.id}`,
          method: "PATCH",
          body: { ...snapshot, expected_version: expected },
        })) as Row;
        setRevision(row.version ?? expected + 1);
        setSaved(JSON.stringify(snapshot));
        live.current = {
          ...live.current,
          revision: row.version ?? expected + 1,
          saved: JSON.stringify(snapshot),
        };
        setError(null);
        setMessage("Borrador guardado");
        return row;
      } catch (e) {
        setError(e as Error);
        setMessage("Sin guardar · tus cambios siguen aquí");
        throw e;
      } finally {
        setSaving(false);
        inflight.current = null;
      }
    })();
    inflight.current = promise;
    return promise;
  }, [advanced, flow, mutation]);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!editable || !dirty || error || Object.keys(advanced).length) return;
    const timer = setTimeout(() => {
      void saveRef.current().catch(() => {});
    }, 800);
    return () => clearTimeout(timer);
  }, [doc, dirty, editable, error, advanced]);
  useEffect(() => {
    const guard = (e: Event) => {
      if (dirty) {
        e.preventDefault();
        setError(new Error("Guarda el borrador antes de cambiar de entorno."));
      }
    };
    window.addEventListener("commerce:context-change", guard);
    return () => window.removeEventListener("commerce:context-change", guard);
  }, [dirty]);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      dirty && current.pathname !== next.pathname,
    enableBeforeUnload: dirty,
    withResolver: true,
  });
  const commit = (next: FlowDocument) => {
    if (!editable) return;
    setPast((p) => [...p.slice(-59), structuredClone(doc)]);
    setFuture([]);
    setDoc(next);
    setIssues([]);
    setMessage("Cambios pendientes · guardado automático");
  };
  const patch = (values: Partial<FlowDocument>) =>
    commit({ ...doc, ...values });
  const update = (values: Partial<FlowNode>) =>
    patch({
      nodes: doc.nodes.map((n) =>
        n.id === selected ? { ...n, ...values } : n,
      ),
    });
  const configure = (values: Record<string, unknown>) => {
    if (!current) return;
    const config = { ...current.config, ...values };
    for (const key of Object.keys(config))
      if (config[key] === undefined) delete config[key];
    update({ config });
  };
  const label = (id: string) =>
    doc.editor.labels[id] || doc.nodes.find((n) => n.id === id)?.id || id;
  const pick = useCallback(
    (id: string) => {
      setSelected(id);
      if (view === "map") {
        const p = live.current.doc.editor.positions[id];
        if (p)
          void graph.setCenter(p.x + 110, p.y + 45, {
            zoom: 1,
            duration: window.matchMedia("(prefers-reduced-motion: reduce)")
              .matches
              ? 0
              : 200,
          });
      }
      void navigate({
        to: `/sales/flows/${flow.id}`,
        search: (old) => ({ ...old, node: id }),
        replace: true,
      });
      requestAnimationFrame(() => {
        const target = document.getElementById("step-inspector-heading");
        target?.focus({ preventScroll: true });
        if (view === "steps")
          document
            .getElementById(`step-${id}`)
            ?.scrollIntoView({ block: "nearest" });
      });
    },
    [graph, navigate, view],
  );
  const [visualNodes, setVisualNodes] = useState<Node<BlockData>[]>([]);
  useEffect(() => {
    setVisualNodes(
      doc.nodes.map((n) => ({
        id: n.id,
        type: "sales",
        position: doc.editor.positions[n.id] ?? { x: 40, y: 40 },
        selected: n.id === selected,
        data: {
          label: doc.editor.labels[n.id] || n.id,
          kind: n.type,
          selected: n.id === selected,
        },
        ariaLabel: `${doc.editor.labels[n.id] || n.id}, ${stepName(n.type)}`,
      })),
    );
  }, [doc.nodes, doc.editor, selected]);
  const edges = edgesOf(doc.nodes).map((e) => ({
    ...e,
    type: "sales",
    sourceHandle: e.port,
    style: {
      stroke: e.port === "false" ? "#a1462a" : "#245e57",
      strokeWidth: 2,
    },
    data: {
      pick: () => {
        setSelectedEdge(e);
        pick(e.target);
      },
    },
  }));
  const requestConnection = (c: Connection) => {
    try {
      connect(doc, c.source, c.sourceHandle ?? "next", c.target);
      setConnection(c);
    } catch (e) {
      setError(e as Error);
    }
  };
  function add(
    type = newType,
    position?: { x: number; y: number },
    edge?: ReturnType<typeof edgesOf>[number],
  ) {
    try {
      const node = makeNode(type, `paso_${crypto.randomUUID().slice(0, 8)}`);
      const next = insertStep(doc, node, edge, position);
      next.editor.labels[node.id] = `${stepName(type)} ${doc.nodes.length + 1}`;
      if (edge)
        setConfirmEdit({
          title: "Insertar en la conexión",
          description: `${label(edge.source)} → ${stepName(type)} → ${label(edge.target)}`,
          next,
          select: node.id,
        });
      else {
        commit(next);
        setSelected(node.id);
      }
      setLibrary(false);
    } catch (e) {
      setError(e as Error);
    }
  }
  async function validate() {
    try {
      const data = (await mutation.mutateAsync({
        path: "/workflows/validate",
        body: doc,
      })) as {
        valid: boolean;
        issues: Array<{ message: string; node_id?: string }>;
      };
      setIssues(data.issues);
      setMessage(
        data.valid
          ? "Recorrido válido. Puedes probarlo."
          : "Completa los pasos indicados.",
      );
    } catch (e) {
      setError(e as Error);
    }
  }
  async function duplicate(asRevision = false) {
    try {
      const row = (await mutation.mutateAsync({
        path: `/workflows/${flow.id}/${asRevision ? "versions" : "duplicate"}`,
        body: asRevision
          ? { expected_version: revision, changes: {} }
          : { name: `${doc.name} · copia` },
      })) as Row;
      await navigate({ to: `/sales/flows/${row.id}`, search: {} });
    } catch (e) {
      setError(e as Error);
    }
  }
  const listSearch = Object.fromEntries(
    Object.entries(search).filter(([key]) =>
      ["q", "product", "status"].includes(key),
    ),
  );
  return (
    <section className="sales-editor">
      <div className="editor-top">
        <div>
          <Link to="/sales/flows" search={listSearch}>
            ← Flujos comerciales
          </Link>
          <h1>{doc.name}</h1>
          <p>
            {flow.status === "PUBLISHED"
              ? "Versión publicada · sólo lectura"
              : "Borrador"}{" "}
            · revisión {revision} · {doc.nodes.length}/100 pasos
          </p>
        </div>
        <div className="button-group">
          {editable && (
            <>
              <Button
                variant="secondary"
                disabled={saving}
                onClick={() => void save().catch(() => {})}
              >
                {saving ? "Guardando…" : "Guardar"}
              </Button>
              <Button variant="secondary" onClick={() => void validate()}>
                Validar
              </Button>
            </>
          )}
          <Button
            disabled={!canWrite}
            onClick={() => setTest(!test)}
            aria-expanded={test}
          >
            Probar conversación
          </Button>
          <details>
            <summary>Versiones</summary>
            <Button
              variant="ghost"
              disabled={!canWrite}
              onClick={() => void duplicate()}
            >
              Duplicar flujo
            </Button>
            {flow.status === "PUBLISHED" && (
              <Button
                variant="secondary"
                disabled={!canWrite}
                onClick={() => void duplicate(true)}
              >
                Crear nueva revisión
              </Button>
            )}
            {editable && (
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    const saved = await save();
                    const row = (await mutation.mutateAsync({
                      path: `/workflows/${flow.id}/publish`,
                      body: { expected_version: saved?.version ?? revision },
                    })) as Row;
                    await navigate({
                      to: `/sales/flows/${row.id}`,
                      search: {},
                    });
                  } catch (e) {
                    setError(e as Error);
                  }
                }}
              >
                Publicar versión interna
              </Button>
            )}
            <p>Una versión interna no habilita envíos.</p>
          </details>
        </div>
      </div>
      <div role="status" className="save-status">
        {saving
          ? "Guardando…"
          : dirty
            ? "Cambios pendientes de guardar"
            : message}
      </div>
      <Feedback error={error} />
      {error && (
        <div className="button-group">
          <Button
            variant="secondary"
            onClick={() => {
              setError(null);
              void save().catch(() => {});
            }}
          >
            Reintentar guardado
          </Button>
          <Button
            variant="secondary"
            onClick={() =>
              void mutation
                .mutateAsync({
                  path: "/workflows",
                  body: { ...doc, name: `${doc.name} · cambios conservados` },
                })
                .then((row) =>
                  navigate({
                    to: `/sales/flows/${(row as Row).id}`,
                    search: {},
                    ignoreBlocker: true,
                  }),
                )
                .catch((e) => setError(e))
            }
          >
            Guardar mis cambios como copia
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              const blob = new Blob([JSON.stringify(doc, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "borrador-local.json";
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            Descargar mis cambios para comparar
          </Button>
        </div>
      )}
      {search.parent && (
        <Link
          to={`/sales/flows/${search.parent}`}
          search={{ ...listSearch, node: search.parentNode }}
        >
          ← Volver al flujo padre, mismo paso
        </Link>
      )}
      <details className="flow-context">
        <summary>
          Producto, oferta y vendedor ·{" "}
          {offers.data?.find((o) => o.id === doc.offer_version_id)?.name ??
            "Seleccionar oferta"}
        </summary>
        <div className="form-grid">
          <label className="field">
            <span>Nombre del flujo</span>
            <input
              value={doc.name}
              disabled={!editable}
              onChange={(e) => patch({ name: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Oferta para nuevas ejecuciones</span>
            <select
              value={doc.offer_version_id ?? ""}
              disabled={!editable}
              onChange={(e) => {
                const o = offers.data?.find((o) => o.id === e.target.value);
                patch({
                  offer_version_id: e.target.value || undefined,
                  product_id: o?.product_id,
                });
              }}
            >
              <option value="">Seleccionar oferta…</option>
              {offers.data?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} · {o.currency} · {o.status}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Vendedor del flujo (respaldo)</span>
            <select
              disabled={!editable}
              value={doc.agent_version_id ?? ""}
              onChange={(e) =>
                patch({ agent_version_id: e.target.value || undefined })
              }
            >
              <option value="">Sin respaldo</option>
              {agents.data
                ?.filter(
                  (a) => !a.product_id || a.product_id === doc.product_id,
                )
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · r{Number(a.revision ?? 1)}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            <span>Paso inicial</span>
            <select
              disabled={!editable}
              value={doc.entry_node_id}
              onChange={(e) => patch({ entry_node_id: e.target.value })}
            >
              <option value="">Seleccionar…</option>
              {doc.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {label(n.id)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p>
          Vendedor efectivo guardado:{" "}
          {String(
            object(object(seller.data?.snapshot).agent).name ?? "Sin asignar",
          )}{" "}
          · origen {String(seller.data?.origin ?? "sin asignar")}.{" "}
          {String(seller.data?.scope ?? "")}
        </p>
        {seller.data?.agent_version_id && (
          <Link to={`/sales/agents/${seller.data.agent_version_id}`}>
            Configurar este vendedor
          </Link>
        )}
        {doc.product_id && (
          <Link to="/catalog" search={{ product: doc.product_id }}>
            {" "}
            Abrir producto compartido
          </Link>
        )}
        <Link to="/sales/channels/whatsapp">
          {" "}
          Revisar asignación del número
        </Link>
      </details>
      <div className="editor-tools">
        <div className="tabs" aria-label="Vista del recorrido">
          <button
            aria-pressed={view === "map"}
            className={view === "map" ? "active" : ""}
            onClick={() => setView("map")}
          >
            Mapa
          </button>
          <button
            aria-pressed={view === "steps"}
            className={view === "steps" ? "active" : ""}
            onClick={() => setView("steps")}
          >
            Pasos
          </button>
        </div>
        <label className="compact-search">
          <span>Buscar paso</span>
          <input
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder="Nombre o tipo"
          />
        </label>
        {editable && (
          <>
            <Button
              variant="secondary"
              onClick={() => setLibrary(!library)}
              aria-expanded={library}
            >
              Agregar paso
            </Button>
            <Button
              variant="ghost"
              disabled={!past.length}
              onClick={() => {
                const prev = past.at(-1)!;
                setFuture((f) => [doc, ...f]);
                setPast((p) => p.slice(0, -1));
                setDoc(prev);
              }}
            >
              Deshacer
            </Button>
            <Button
              variant="ghost"
              disabled={!future.length}
              onClick={() => {
                setPast((p) => [...p, doc]);
                setDoc(future[0]!);
                setFuture((f) => f.slice(1));
              }}
            >
              Rehacer
            </Button>
          </>
        )}
        {view === "map" && (
          <>
            <Button variant="ghost" onClick={() => void graph.zoomIn()}>
              Acercar
            </Button>
            <Button variant="ghost" onClick={() => void graph.zoomOut()}>
              Alejar
            </Button>
            <Button
              variant="ghost"
              onClick={() => void graph.fitView({ padding: 0.2 })}
            >
              Ajustar mapa
            </Button>
            <Button variant="ghost" onClick={() => pick(selected)}>
              Centrar selección
            </Button>
            {editable && (
              <Button
                variant="ghost"
                onClick={() => {
                  patch({
                    editor: {
                      ...doc.editor,
                      positions: organize(doc.nodes, doc.entry_node_id),
                    },
                  });
                  requestAnimationFrame(
                    () => void graph.fitView({ padding: 0.2 }),
                  );
                }}
              >
                Autoorganizar
              </Button>
            )}
            <Button variant="ghost" onClick={() => setMinimap(!minimap)}>
              Mini mapa
            </Button>
          </>
        )}
      </div>
      {find && (
        <div className="search-results" aria-label="Resultados de pasos">
          {doc.nodes
            .filter((n) =>
              `${label(n.id)} ${n.id} ${stepName(n.type)}`
                .toLowerCase()
                .includes(find.toLowerCase()),
            )
            .map((n) => (
              <Button key={n.id} variant="secondary" onClick={() => pick(n.id)}>
                {label(n.id)} · {stepName(n.type)}
              </Button>
            ))}
        </div>
      )}
      {library && editable && (
        <div className="step-library">
          <p>
            Arrastra un tipo al mapa o elige y pulsa Agregar. Para insertar
            entre pasos, selecciona una conexión.
          </p>
          {stepTypes.map(([type, title]) => (
            <button
              key={type}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/commerce-step", type);
                setNewType(type);
              }}
              onClick={() => {
                setNewType(type);
                add(type, undefined, undefined);
              }}
            >
              {title}
            </button>
          ))}
        </div>
      )}
      {selectedEdge && editable && (
        <div className="connection-bar">
          <strong>
            {label(selectedEdge.source)} → {label(selectedEdge.target)}
          </strong>
          <label>
            Tipo a insertar
            <select
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
            >
              {stepTypes
                .filter(([t]) => !["condition", "end"].includes(t))
                .map(([type, title]) => (
                  <option key={type} value={type}>
                    {title}
                  </option>
                ))}
            </select>
          </label>
          <Button
            variant="secondary"
            onClick={() => add(newType, undefined, selectedEdge)}
          >
            Insertar aquí
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              commit(connect(doc, selectedEdge.source, selectedEdge.port));
              setSelectedEdge(undefined);
            }}
          >
            Quitar conexión
          </Button>
          <Button variant="ghost" onClick={() => setSelectedEdge(undefined)}>
            Cerrar conexión
          </Button>
        </div>
      )}
      {!!issues.length && (
        <div role="alert" className="graph-issues">
          <strong>Pendientes del recorrido</strong>
          {issues.map((issue, i) => (
            <button
              key={i}
              onClick={() => issue.node_id && pick(issue.node_id)}
            >
              {issue.message}
            </button>
          ))}
        </div>
      )}
      <div className={`visual-workbench ${test ? "testing" : ""}`}>
        <div className="graph-main">
          {view === "map" ? (
            <div
              className="real-flow-map"
              aria-label="Mapa del flujo"
              onDragOver={(e) => {
                if (editable) e.preventDefault();
              }}
              onDrop={(e) => {
                if (!editable) return;
                e.preventDefault();
                const type = e.dataTransfer.getData(
                  "application/commerce-step",
                );
                if (!stepTypes.some((t) => t[0] === type)) return;
                const edgeId = (e.target as HTMLElement)
                  .closest("[data-edge-id]")
                  ?.getAttribute("data-edge-id");
                add(
                  type,
                  graph.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
                  edgesOf(doc.nodes).find((x) => x.id === edgeId),
                );
              }}
            >
              <ReactFlow
                nodes={visualNodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                nodesDraggable={editable}
                nodesConnectable={editable}
                edgesReconnectable={editable}
                onNodesChange={(changes) => {
                  setVisualNodes((old) => applyNodeChanges(changes, old));
                  const selection = changes.find(
                    (c) => c.type === "select" && c.selected,
                  );
                  if (selection?.type === "select") setSelected(selection.id);
                  const positions = changes.filter(
                    (c) => c.type === "position" && c.position && !c.dragging,
                  );
                  if (editable && positions.length) {
                    const next = { ...doc.editor.positions };
                    for (const c of positions)
                      if (c.type === "position" && c.position)
                        next[c.id] = c.position;
                    patch({ editor: { ...doc.editor, positions: next } });
                  }
                }}
                onNodeClick={(_e, n) => {
                  setSelectedEdge(undefined);
                  pick(n.id);
                }}
                onConnect={requestConnection}
                onReconnect={(edge, c) => {
                  try {
                    const next = connect(
                      connect(doc, edge.source, edge.sourceHandle ?? "next"),
                      c.source,
                      c.sourceHandle ?? "next",
                      c.target,
                    );
                    setConfirmEdit({
                      title: "Reconectar pasos",
                      description: `${label(edge.source)} → ${label(edge.target)} pasa a ${label(c.source)} → ${label(c.target)}`,
                      next,
                    });
                  } catch (e) {
                    setError(e as Error);
                  }
                }}
                deleteKeyCode={null}
                onInit={(instance) => {
                  const pos = doc.editor.positions[selected] ?? { x: 0, y: 0 };
                  void instance.setViewport({
                    x: 40 - pos.x * 0.9,
                    y: 40 - pos.y * 0.9,
                    zoom: 0.9,
                  });
                }}
                minZoom={0.15}
                maxZoom={2}
                ariaLabelConfig={{
                  "controls.zoomIn.ariaLabel": "Acercar",
                  "controls.zoomOut.ariaLabel": "Alejar",
                  "controls.fitView.ariaLabel": "Ajustar mapa",
                  "node.a11yDescription.default":
                    "Enter selecciona. Flechas mueven la posición visual. También puedes usar la vista Pasos.",
                  "edge.a11yDescription.default":
                    "Conexión del recorrido. Usa el inspector para editar origen y destino.",
                }}
              >
                <Background />
                {minimap && <MiniMap pannable zoomable />}
              </ReactFlow>
            </div>
          ) : (
            <div className="steps-view" aria-label="Pasos del mismo grafo">
              {doc.nodes.map((n) => (
                <article
                  id={`step-${n.id}`}
                  key={n.id}
                  className={selected === n.id ? "selected" : ""}
                >
                  <button onClick={() => pick(n.id)}>
                    <small>{stepName(n.type)}</small>
                    <strong>{label(n.id)}</strong>
                  </button>
                  <div className="step-exits">
                    {edgesOf([n]).map((e) => (
                      <button
                        key={e.id}
                        onClick={() => {
                          setSelectedEdge(e);
                          pick(e.target);
                        }}
                      >
                        {e.label} → {label(e.target)}
                      </button>
                    ))}
                    {!edgesOf([n]).length && (
                      <span>
                        {n.type === "end"
                          ? "Fin del recorrido"
                          : "Salida pendiente"}
                      </span>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
        <aside className="step-inspector" aria-label="Configuración del paso">
          <h2 id="step-inspector-heading" tabIndex={-1}>
            {current ? label(current.id) : "Selecciona un paso"}
          </h2>
          {current && (
            <>
              <p>
                {stepName(current.type)} · {current.id}
              </p>
              <fieldset disabled={!editable}>
                <label className="field">
                  <span>Nombre visible del paso</span>
                  <input
                    value={doc.editor.labels[current.id] ?? ""}
                    placeholder={current.id}
                    onChange={(e) =>
                      patch({
                        editor: {
                          ...doc.editor,
                          labels: {
                            ...doc.editor.labels,
                            [current.id]: e.target.value,
                          },
                        },
                      })
                    }
                  />
                </label>
                {current.type === "message" && (
                  <>
                    <label className="field">
                      <span>Texto o descripción</span>
                      <textarea
                        value={String(current.config.text ?? "")}
                        rows={5}
                        onChange={(e) => configure({ text: e.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>Formato</span>
                      <select
                        value={String(current.config.kind ?? "text")}
                        onChange={(e) => configure({ kind: e.target.value })}
                      >
                        {["text", "image", "audio", "document", "video"].map(
                          (t) => (
                            <option key={t}>{t}</option>
                          ),
                        )}
                      </select>
                    </label>
                    <label className="field">
                      <span>Material del catálogo</span>
                      <select
                        value={String(current.config.asset_id ?? "")}
                        onChange={(e) =>
                          configure({ asset_id: e.target.value || undefined })
                        }
                      >
                        <option value="">Sin material</option>
                        {materials.data
                          ?.filter((m) => m.status === "READY")
                          .map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                            </option>
                          ))}
                      </select>
                    </label>
                  </>
                )}
                {current.type === "reply" && (
                  <label className="field">
                    <span>Guardar respuesta como</span>
                    <input
                      value={String(current.config.variable ?? "")}
                      onChange={(e) =>
                        configure({ variable: e.target.value || undefined })
                      }
                    />
                  </label>
                )}
                {current.type === "wait" && (
                  <>
                    <label className="field">
                      <span>Espera en minutos</span>
                      <input
                        type="number"
                        min={0}
                        max={43200}
                        step={1 / 60}
                        value={Number(current.config.seconds ?? 0) / 60}
                        onChange={(e) =>
                          configure({
                            seconds: Math.round(Number(e.target.value) * 60),
                          })
                        }
                      />
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={Boolean(current.config.cancel_on_response)}
                        onChange={(e) =>
                          configure({ cancel_on_response: e.target.checked })
                        }
                      />{" "}
                      Detener seguimiento si responde
                    </label>
                  </>
                )}
                {current.type === "condition" && (
                  <>
                    <label className="field">
                      <span>Campo de la condición</span>
                      <input
                        list="condition-fields"
                        value={String(current.config.field ?? "")}
                        onChange={(e) => configure({ field: e.target.value })}
                      />
                      <datalist id="condition-fields">
                        <option value="customer_text" />
                        <option value="conversation.stage" />
                        <option value="order.receipt_status" />
                        {doc.nodes
                          .filter(
                            (n) => n.type === "reply" && n.config.variable,
                          )
                          .map((n) => (
                            <option
                              key={n.id}
                              value={String(n.config.variable)}
                            />
                          ))}
                      </datalist>
                    </label>
                    <label className="field">
                      <span>Comparación</span>
                      <select
                        value={String(current.config.operator ?? "contains")}
                        onChange={(e) =>
                          configure({ operator: e.target.value })
                        }
                      >
                        {[
                          ["equals", "Es igual a"],
                          ["not_equals", "Es distinto de"],
                          ["contains", "Contiene"],
                          ["exists", "Tiene valor"],
                          ["gte", "Es mayor o igual"],
                        ].map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                    {current.config.operator !== "exists" && (
                      <label className="field">
                        <span>Valor de la condición</span>
                        <input
                          value={String(current.config.value ?? "")}
                          type={
                            current.config.operator === "gte"
                              ? "number"
                              : "text"
                          }
                          onChange={(e) =>
                            configure({
                              value:
                                current.config.operator === "gte"
                                  ? Number(e.target.value)
                                  : e.target.value,
                            })
                          }
                        />
                      </label>
                    )}
                  </>
                )}
                {current.type === "stage" && (
                  <label className="field">
                    <span>Etapa verificable</span>
                    <input
                      value={String(current.config.stage ?? "")}
                      onChange={(e) => configure({ stage: e.target.value })}
                    />
                  </label>
                )}
                {current.type === "commitment" && (
                  <label className="field">
                    <span>Frases exactas de compromiso</span>
                    <textarea
                      value={(
                        (current.config.accepted_phrases ?? []) as string[]
                      ).join("\n")}
                      onChange={(e) =>
                        configure({
                          accepted_phrases: e.target.value.split("\n"),
                        })
                      }
                    />
                    <small>
                      Una por línea. La IA no confirma compromiso por
                      inferencia.
                    </small>
                  </label>
                )}
                {["fulfillment", "post_receipt"].includes(current.type) && (
                  <label className="field">
                    <span>Regla de entrega</span>
                    <select
                      value={String(
                        current.config.release_on ?? "receipt_approved",
                      )}
                      onChange={(e) =>
                        configure({ release_on: e.target.value })
                      }
                    >
                      <option value="commitment_accepted">
                        Compromiso aceptado
                      </option>
                      <option value="receipt_approved">
                        Comprobante aprobado
                      </option>
                      {current.config.release_on === "reconciled" && (
                        <option value="reconciled">Comprobante · legado</option>
                      )}
                    </select>
                  </label>
                )}
                {current.type === "receipt" && (
                  <p>
                    Espera la política de comprobante vigente. Prueba/Falso
                    siguen excluidos del ingreso.
                  </p>
                )}
                {current.type === "ai" && (
                  <p>
                    Usa el vendedor efectivo de la conversación. Una pregunta no
                    aprueba pagos ni libera materiales.
                  </p>
                )}
                {current.type === "subflow" && (
                  <label className="field">
                    <span>Subflujo publicado</span>
                    <select
                      value={String(current.config.workflow_version_id ?? "")}
                      onChange={(e) =>
                        configure({
                          workflow_version_id: e.target.value || undefined,
                        })
                      }
                    >
                      <option value="">Selecciona…</option>
                      {workflows.data
                        ?.filter(
                          (w) => w.status === "PUBLISHED" && w.id !== flow.id,
                        )
                        .map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                {current.type !== "end" &&
                  (current.type === "condition"
                    ? ["true", "false"]
                    : ["next"]
                  ).map((port) => (
                    <label className="field" key={port}>
                      <span>
                        {port === "true"
                          ? "Si se cumple · Sí"
                          : port === "false"
                            ? "Si no se cumple · No"
                            : "Siguiente paso"}
                      </span>
                      <select
                        value={
                          port === "next"
                            ? (current.next ?? "")
                            : (current.branches?.[port] ?? "")
                        }
                        onChange={(e) => {
                          try {
                            const next = connect(
                              doc,
                              current.id,
                              port,
                              e.target.value || undefined,
                            );
                            setConfirmEdit({
                              title: "Cambiar conexión",
                              description: `${label(current.id)} · ${port === "next" ? "Siguiente" : port === "true" ? "Sí" : "No"} → ${e.target.value ? label(e.target.value) : "Sin conexión"}`,
                              next,
                            });
                          } catch (e) {
                            setError(e as Error);
                          }
                        }}
                      >
                        <option value="">Salida pendiente</option>
                        {doc.nodes
                          .filter((n) => n.id !== selected)
                          .map((n) => (
                            <option key={n.id} value={n.id}>
                              {label(n.id)}
                            </option>
                          ))}
                      </select>
                    </label>
                  ))}
                <details>
                  <summary>Posición sin arrastrar</summary>
                  <div className="button-group">
                    {[
                      ["Izquierda", -40, 0],
                      ["Derecha", 40, 0],
                      ["Arriba", 0, -40],
                      ["Abajo", 0, 40],
                    ].map(([title, x, y]) => (
                      <Button
                        key={title}
                        variant="secondary"
                        onClick={() => {
                          const p = doc.editor.positions[selected] ?? {
                            x: 0,
                            y: 0,
                          };
                          patch({
                            editor: {
                              ...doc.editor,
                              positions: {
                                ...doc.editor.positions,
                                [selected]: {
                                  x: p.x + Number(x),
                                  y: p.y + Number(y),
                                },
                              },
                            },
                          });
                        }}
                      >
                        {title}
                      </Button>
                    ))}
                  </div>
                  <p>Mover visualmente no cambia la ejecución.</p>
                  {(["before", "after"] as const).map((direction) => (
                    <Button
                      key={direction}
                      variant="ghost"
                      onClick={() => {
                        try {
                          setConfirmEdit({
                            title: "Reordenar tramo lineal",
                            description: `Mover ${label(selected)} ${direction === "before" ? "antes" : "después"} del paso adyacente cambia las conexiones.`,
                            next: moveLinear(doc, selected, direction),
                          });
                        } catch (e) {
                          setError(e as Error);
                        }
                      }}
                    >
                      Mover {direction === "before" ? "antes" : "después"}
                    </Button>
                  ))}
                </details>
                <details>
                  <summary>Avanzado · parámetros declarativos</summary>
                  <label className="field">
                    <span>Parámetros del paso (JSON)</span>
                    <textarea
                      rows={6}
                      value={
                        advanced[current.id] ??
                        JSON.stringify(current.config, null, 2)
                      }
                      onChange={(e) => {
                        const value = e.target.value;
                        try {
                          const config = JSON.parse(value);
                          if (
                            !config ||
                            Array.isArray(config) ||
                            typeof config !== "object"
                          )
                            throw new Error();
                          update({ config });
                          setAdvanced((old) => {
                            const next = { ...old };
                            delete next[current.id];
                            return next;
                          });
                        } catch {
                          setAdvanced((old) => ({
                            ...old,
                            [current.id]: value,
                          }));
                        }
                      }}
                    />
                  </label>
                  {advanced[current.id] !== undefined && (
                    <p role="alert">
                      JSON incompleto conservado. Corrígelo para guardar.
                    </p>
                  )}
                </details>
              </fieldset>
              {current.type === "subflow" &&
                current.config.workflow_version_id && (
                  <Link
                    to={`/sales/flows/${String(current.config.workflow_version_id)}`}
                    search={{
                      ...listSearch,
                      parent: flow.id,
                      parentNode: selected,
                    }}
                  >
                    Abrir subflujo →
                  </Link>
                )}
              {editable && (
                <div className="button-group">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const node = {
                        ...structuredClone(current),
                        id: `paso_${crypto.randomUUID().slice(0, 8)}`,
                      };
                      delete node.next;
                      delete node.branches;
                      try {
                        commit(insertStep(doc, node));
                        setSelected(node.id);
                      } catch (e) {
                        setError(e as Error);
                      }
                    }}
                  >
                    Duplicar paso
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      setConfirmEdit({
                        title: "Eliminar paso",
                        description: `Se quitará ${label(selected)} y ${edgesOf(doc.nodes).filter((e) => e.source === selected || e.target === selected).length} conexiones. No se reconectarán ramas automáticamente. Puedes deshacer.`,
                        next: deleteStep(doc, selected),
                        select:
                          doc.entry_node_id === selected
                            ? ""
                            : doc.entry_node_id,
                      })
                    }
                  >
                    Eliminar paso
                  </Button>
                </div>
              )}
            </>
          )}
        </aside>
        {test && (
          <EvaluationPanel
            flowId={flow.id}
            revision={revision}
            beforeStart={editable ? save : undefined}
            onSelect={pick}
          />
        )}
      </div>
      <Modal
        title={confirmEdit?.title ?? "Cambiar recorrido"}
        open={!!confirmEdit}
        onOpenChange={(open) => {
          if (!open) setConfirmEdit(undefined);
        }}
      >
        <p>{confirmEdit?.description}</p>
        <Button
          onClick={() => {
            if (confirmEdit) {
              commit(confirmEdit.next);
              if (confirmEdit.select !== undefined)
                setSelected(confirmEdit.select);
            }
            setConfirmEdit(undefined);
            setSelectedEdge(undefined);
          }}
        >
          Confirmar cambio
        </Button>
      </Modal>
      <Modal
        title="Conectar pasos"
        open={!!connection}
        onOpenChange={(open) => {
          if (!open) setConnection(undefined);
        }}
      >
        <p>
          {connection &&
            `${label(connection.source)} → ${label(connection.target)}`}
        </p>
        <Button
          onClick={() => {
            if (connection)
              commit(
                connect(
                  doc,
                  connection.source,
                  connection.sourceHandle ?? "next",
                  connection.target,
                ),
              );
            setConnection(undefined);
          }}
        >
          Confirmar conexión
        </Button>
      </Modal>
      <Modal
        title="Conserva tus cambios"
        open={blocker.status === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
      >
        <p>El borrador tiene cambios pendientes. Guárdalos antes de salir.</p>
        <Feedback error={error} />
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
