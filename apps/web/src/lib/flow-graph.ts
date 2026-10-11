import type { FlowNode } from "../../../../packages/domain/src/sales/workflow.js";
interface Row {
  id: string;
  name?: string;
  description?: string;
  product_id?: string;
  offer_version_id?: string;
  agent_version_id?: string;
  entry_node_id?: string;
  nodes?: FlowNode[];
  max_steps?: unknown;
  editor?: unknown;
}
export interface FlowDocument {
  name: string;
  description: string;
  product_id?: string;
  offer_version_id?: string;
  agent_version_id?: string;
  entry_node_id: string;
  nodes: FlowNode[];
  max_steps: number;
  editor: {
    schema_version: 1;
    positions: Record<string, { x: number; y: number }>;
    labels: Record<string, string>;
  };
}
export const stepTypes = [
  ["entry", "Inicio"],
  ["message", "Mensaje"],
  ["reply", "Esperar respuesta"],
  ["ai", "Vendedor IA"],
  ["condition", "Condición"],
  ["stage", "Actualizar etapa"],
  ["wait", "Esperar un tiempo"],
  ["commitment", "Compromiso"],
  ["fulfillment", "Entrega"],
  ["bank_instructions", "Instrucciones de pago"],
  ["receipt", "Comprobante aprobado"],
  ["post_receipt", "Beneficio posterior"],
  ["approval", "Pedir aprobación"],
  ["handoff", "Pasar a una persona"],
  ["subflow", "Subflujo"],
  ["end", "Fin"],
] as const;
export const stepName = (type: string) =>
  stepTypes.find((t) => t[0] === type)?.[1] ?? "Comprobante · legado";
export function edgesOf(nodes: FlowNode[]) {
  return nodes.flatMap((n) => [
    ...(n.next
      ? [
          {
            id: `${n.id}:next`,
            source: n.id,
            target: n.next,
            port: "next",
            label: "Siguiente",
          },
        ]
      : []),
    ...Object.entries(n.branches ?? {}).map(([port, target]) => ({
      id: `${n.id}:${port}`,
      source: n.id,
      target,
      port,
      label: port === "true" ? "Sí" : port === "false" ? "No" : port,
    })),
  ]);
}
export function organize(nodes: FlowNode[], entry: string) {
  const levels = new Map<string, number>(),
    active = new Set<string>();
  const visit = (id: string, level: number) => {
    if (active.has(id) || level > 100) return;
    if ((levels.get(id) ?? -1) >= level) return;
    levels.set(id, level);
    active.add(id);
    for (const edge of edgesOf(nodes).filter((e) => e.source === id))
      visit(edge.target, level + 1);
    active.delete(id);
  };
  visit(entry, 0);
  const counts: Record<number, number> = {};
  return Object.fromEntries(
    nodes.map((n) => {
      const level = levels.get(n.id) ?? 0;
      const column = counts[level] ?? 0;
      counts[level] = column + 1;
      return [n.id, { x: column * 290 + 40, y: level * 160 + 30 }];
    }),
  );
}
export function documentOf(row: Row): FlowDocument {
  const nodes = structuredClone(row.nodes ?? []);
  return {
    name: row.name ?? "",
    description: row.description ?? "",
    product_id: row.product_id,
    offer_version_id: row.offer_version_id,
    agent_version_id: row.agent_version_id,
    entry_node_id: row.entry_node_id ?? nodes[0]?.id ?? "",
    nodes,
    max_steps: Number(row.max_steps ?? 100),
    editor: row.editor
      ? (structuredClone(row.editor) as FlowDocument["editor"])
      : {
          schema_version: 1,
          positions: organize(nodes, row.entry_node_id ?? ""),
          labels: {},
        },
  };
}
export function connect(
  doc: FlowDocument,
  source: string,
  port: string,
  target?: string,
): FlowDocument {
  const from = doc.nodes.find((n) => n.id === source);
  if (
    !from ||
    from.type === "end" ||
    (from.type === "condition" && !["true", "false"].includes(port)) ||
    (from.type !== "condition" && port !== "next")
  )
    throw new Error("Esta salida no corresponde al tipo de paso.");
  if (target && !doc.nodes.some((n) => n.id === target))
    throw new Error("Selecciona un destino existente.");
  const result = structuredClone(doc);
  result.nodes = result.nodes.map((n) => {
    if (n.id !== source) return n;
    if (port === "next") {
      if (target) n.next = target;
      else delete n.next;
    } else {
      n.branches = { ...n.branches };
      if (target) n.branches[port] = target;
      else delete n.branches[port];
    }
    return n;
  });
  const seen = new Set<string>();
  const reaches = (id: string): boolean => {
    if (id === source) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return edgesOf(result.nodes)
      .filter((e) => e.source === id)
      .some((e) => reaches(e.target));
  };
  if (target && reaches(target))
    throw new Error(
      "La conexión crearía un ciclo. El recorrido debe ser acíclico.",
    );
  return result;
}
export function makeNode(type: string, id: string): FlowNode {
  return {
    id,
    type,
    config:
      type === "message"
        ? { text: "" }
        : type === "wait"
          ? { seconds: 1800 }
          : type === "condition"
            ? { field: "customer_text", operator: "contains", value: "" }
            : type === "commitment"
              ? {
                  accepted_phrases: [
                    "acepto",
                    "me comprometo",
                    "confirmo mi compromiso",
                  ],
                }
              : type === "reply"
                ? { variable: "respuesta" }
                : type === "stage"
                  ? { stage: "QUALIFIED" }
                  : {},
  };
}
export function insertStep(
  doc: FlowDocument,
  node: FlowNode,
  edge?: ReturnType<typeof edgesOf>[number],
  position?: { x: number; y: number },
) {
  if (doc.nodes.length >= 100)
    throw new Error("El flujo admite hasta 100 pasos.");
  let result = structuredClone(doc);
  result.nodes.push(node);
  result.editor.positions[node.id] = position ?? { x: 60, y: 60 };
  if (!result.entry_node_id) result.entry_node_id = node.id;
  if (edge) {
    if (["condition", "end"].includes(node.type))
      throw new Error(
        "Agrega este tipo libremente y conecta sus salidas en el inspector.",
      );
    result = connect(result, edge.source, edge.port, node.id);
    result = connect(result, node.id, "next", edge.target);
  }
  return result;
}
export function deleteStep(doc: FlowDocument, id: string) {
  const result = structuredClone(doc);
  result.nodes = result.nodes
    .filter((n) => n.id !== id)
    .map((n) => {
      if (n.next === id) delete n.next;
      if (n.branches)
        n.branches = Object.fromEntries(
          Object.entries(n.branches).filter(([, target]) => target !== id),
        );
      return n;
    });
  delete result.editor.positions[id];
  delete result.editor.labels[id];
  if (result.entry_node_id === id) result.entry_node_id = "";
  return result;
}
export function moveLinear(
  doc: FlowDocument,
  id: string,
  direction: "before" | "after",
) {
  const edges = edgesOf(doc.nodes);
  const adjacent =
    direction === "before"
      ? edges.find((e) => e.target === id)?.source
      : doc.nodes.find((n) => n.id === id)?.next;
  if (!adjacent) throw new Error("No hay un paso lineal adyacente.");
  const a = direction === "before" ? adjacent : id,
    b = direction === "before" ? id : adjacent;
  const left = doc.nodes.find((n) => n.id === a)!,
    right = doc.nodes.find((n) => n.id === b)!;
  const incomingA = edges.filter((e) => e.target === a),
    incomingB = edges.filter((e) => e.target === b);
  if (
    left.type === "condition" ||
    right.type === "condition" ||
    left.type === "end" ||
    right.type === "end" ||
    incomingA.length > 1 ||
    incomingB.length !== 1
  )
    throw new Error(
      "Mover antes/después requiere un tramo lineal sin bifurcaciones.",
    );
  const result = structuredClone(doc);
  for (const n of result.nodes) {
    if (n.id === a) {
      if (right.next) n.next = right.next;
      else delete n.next;
    } else if (n.id === b) n.next = a;
    else {
      if (n.next === a) n.next = b;
      if (n.branches)
        for (const port of Object.keys(n.branches))
          if (n.branches[port] === a) n.branches[port] = b;
    }
  }
  if (result.entry_node_id === a) result.entry_node_id = b;
  return result;
}
