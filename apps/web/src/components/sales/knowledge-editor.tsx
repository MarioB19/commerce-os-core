import { PendingEdits } from "./pending-edits";
import { useState, useEffect } from "react";
import { Button } from "../ui/button";
import { Feedback, useWorkspace } from "../shared";
import {
  object,
  rows,
  useAction,
  useData,
  params,
  type Row,
} from "../../lib/api";
export function KnowledgeEditor({
  record,
  kind = "product",
  onDirtyChange,
}: {
  record: Row;
  kind?: "product" | "category";
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { environment, session } = useWorkspace();
  const canWrite =
    session.permissions.includes("*") ||
    session.permissions.includes("catalog:write");
  const action = useAction();
  const [items, setItems] = useState(() => rows(record.knowledge)),
    [category, setCategory] = useState(String(record.category_id ?? "")),
    [agent, setAgent] = useState(record.agent_version_id ?? ""),
    [version, setVersion] = useState(record.version ?? 1),
    [message, setMessage] = useState(""),
    [error, setError] = useState<Error | null>(null);
  const [saved, setSaved] = useState(
    JSON.stringify({ items, category, agent }),
  );
  const categories = useData(`/categories${params(environment)}`),
    agents = useData(`/agents${params(environment)}`);
  const [newCategory, setNewCategory] = useState("");
  const [nestedDirty, setNestedDirty] = useState(false);
  const dirty =
    JSON.stringify({ items, category, agent }) !== saved ||
    nestedDirty ||
    !!newCategory.trim();
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  async function save() {
    try {
      const changes =
        kind === "product"
          ? {
              knowledge: items,
              category_id: category || null,
              agent_version_id: agent || null,
            }
          : { knowledge: items };
      const row = (await action.mutateAsync({
        path:
          kind === "product"
            ? `/products/${record.id}/versions`
            : `/categories/${record.id}`,
        method: kind === "product" ? "POST" : "PATCH",
        body:
          kind === "product"
            ? { expected_version: version, changes }
            : { expected_version: version, ...changes },
      })) as Row;
      setVersion(row.version ?? version + 1);
      setSaved(JSON.stringify({ items, category, agent }));
      setError(null);
      setMessage(
        "Conocimiento guardado en una nueva revisión. Conversaciones anteriores conservan sus fuentes.",
      );
    } catch (e) {
      setError(e as Error);
    }
  }
  return (
    <section className="knowledge-editor">
      <PendingEdits
        dirty={dirty}
        onBlocked={(message) => setError(new Error(message))}
      />
      <h3>
        {kind === "product" ? "Qué sabe del producto" : "Contexto de categoría"}
      </h3>
      <p>
        Agrega sólo hechos aprobados con una fuente identificable. Precios,
        descuentos y entrega se leen de la oferta. Nunca escribas credenciales
        ni códigos privados.
      </p>
      <fieldset disabled={!canWrite}>
        {kind === "product" && (
          <>
            <label className="field">
              <span>Categoría opcional</span>
              <select
                value={category}
                onChange={(e) => {
                  if (nestedDirty) {
                    setError(
                      new Error(
                        "Guarda el conocimiento de categoría antes de elegir otra.",
                      ),
                    );
                    return;
                  }
                  setCategory(e.target.value);
                }}
              >
                <option value="">Sin categoría</option>
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>Crear categoría</summary>
              <label className="field">
                <span>Nombre de categoría</span>
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                />
              </label>
              <Button
                variant="secondary"
                disabled={!newCategory.trim()}
                onClick={() =>
                  void action
                    .mutateAsync({
                      path: "/categories",
                      body: { name: newCategory },
                    })
                    .then((r) => {
                      setCategory((r as Row).id);
                      setNewCategory("");
                      setNewCategory("");
                    })
                    .catch((e) => setError(e))
                }
              >
                Crear categoría compartida
              </Button>
            </details>
            <label className="field">
              <span>Vendedor para nuevas conversaciones del producto</span>
              <select value={agent} onChange={(e) => setAgent(e.target.value)}>
                <option value="">Sin asignar</option>
                {agents.data
                  ?.filter((a) => !a.product_id || a.product_id === record.id)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · r{Number(a.revision ?? 1)}
                    </option>
                  ))}
              </select>
              <small>Vínculo, oferta y número pueden tener prioridad.</small>
            </label>
          </>
        )}
        {items.map((item, index) => (
          <div className="knowledge-source" key={item.id}>
            <div className="form-grid">
              <label className="field">
                <span>Tipo de conocimiento {index + 1}</span>
                <select
                  value={String(item.topic ?? "faq")}
                  onChange={(e) =>
                    setItems(
                      items.map((x, i) =>
                        i === index ? { ...x, topic: e.target.value } : x,
                      ),
                    )
                  }
                >
                  {[
                    ["description", "Descripción"],
                    ["audience", "Público"],
                    ["contents", "Contenido"],
                    ["requirements", "Requisitos"],
                    ["faq", "Pregunta frecuente"],
                    ["objection", "Objeción"],
                    ["policy", "Política aprobada"],
                  ].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Título {index + 1}</span>
                <input
                  value={String(item.title ?? "")}
                  onChange={(e) =>
                    setItems(
                      items.map((x, i) =>
                        i === index ? { ...x, title: e.target.value } : x,
                      ),
                    )
                  }
                />
              </label>
            </div>
            <label className="field">
              <span>Hecho aprobado {index + 1}</span>
              <textarea
                rows={3}
                value={String(item.content ?? "")}
                onChange={(e) =>
                  setItems(
                    items.map((x, i) =>
                      i === index ? { ...x, content: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
            <label className="field">
              <span>Fuente del hecho {index + 1}</span>
              <input
                value={String(item.source ?? "")}
                placeholder="Documento y sección o decisión aprobada"
                onChange={(e) =>
                  setItems(
                    items.map((x, i) =>
                      i === index ? { ...x, source: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
            <Button
              variant="ghost"
              onClick={() => setItems(items.filter((_, i) => i !== index))}
            >
              Quitar fuente {index + 1}
            </Button>
          </div>
        ))}
        <div className="button-group">
          <Button
            variant="secondary"
            onClick={() =>
              setItems([
                ...items,
                {
                  id: `fuente_${crypto.randomUUID().slice(0, 8)}`,
                  topic: "faq",
                  title: "",
                  content: "",
                  source: "",
                },
              ])
            }
            disabled={items.length >= 40}
          >
            Agregar fuente
          </Button>
          <Button onClick={() => void save()} disabled={action.isPending}>
            Guardar conocimiento
          </Button>
        </div>
      </fieldset>
      <Feedback error={error} success={message} />
      {kind === "product" &&
        category &&
        categories.data?.find((c) => c.id === category) && (
          <details>
            <summary>Conocimiento de la categoría compartida</summary>
            <KnowledgeEditor
              onDirtyChange={setNestedDirty}
              key={category}
              record={categories.data.find((c) => c.id === category)!}
              kind="category"
            />
          </details>
        )}
      <details>
        <summary>Revisiones de conocimiento</summary>
        <KnowledgeVersions id={record.id} kind={kind} />
      </details>
    </section>
  );
}
function KnowledgeVersions({ id, kind }: { id: string; kind: string }) {
  const { environment } = useWorkspace();
  const q = useData(
      `/categories/${id}/versions${params(environment)}`,
      kind === "category",
    ),
    p = useData(
      `/products/${id}/versions${params(environment)}`,
      kind === "product",
    );
  return (
    <ul>
      {(kind === "category" ? q.data : p.data)?.map((v, i) => (
        <li key={i}>
          Revisión {v.version} ·{" "}
          {Array.isArray(v.knowledge)
            ? v.knowledge.length
            : rows(object(v.body).knowledge).length}{" "}
          fuentes
        </li>
      ))}
    </ul>
  );
}
