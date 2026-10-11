import type { Body, DomainRecord } from "../../../contracts/src/index.js";
import type { AgentProposal } from "./ai.js";
import { canonicalSalesVariables } from "./variables.js";
export interface SellerSource {
  id: string;
  topic: string;
  title: string;
  content: string;
  source: string;
  record_id: string;
  revision: number;
}
export interface SellerSnapshot {
  schema_version: 1;
  product_id?: string;
  agent_version_id?: string;
  offer_version_id?: string;
  offer: Body;
  sources: SellerSource[];
  conflicts: string[];
  agent: Body;
}
export interface SellerContext {
  customer_text: string;
  offer: Body;
  history: Array<{ role: "customer" | "seller"; text: string }>;
  stage: string;
  order: Body;
  variables: Body;
  sources: SellerSource[];
  conflicts: string[];
}
/** Same precedence in API previews and new inbound conversations. Existing IDs remain pinned. */
export function resolveSellerAssignment(input: {
  binding?: Body;
  offer?: Body;
  account?: Body;
  product?: Body;
  workflow?: Body;
}) {
  for (const origin of [
    "binding",
    "offer",
    "account",
    "product",
    "workflow",
  ] as const) {
    const id = input[origin]?.agent_version_id;
    if (id) return { agent_version_id: String(id), origin };
  }
  return { agent_version_id: undefined, origin: "unassigned" };
}
export function sanitizeSellerText(value: unknown, max = 2000): string {
  return String(value ?? "")
    .replace(/https?:\/\/\S+/gi, "[enlace omitido]")
    .replace(/\b(?:sk-|Bearer\s+)[a-zA-Z0-9_-]+/gi, "[secreto omitido]")
    .replace(
      /\b(?:c[oó]digo|password|contrase[nñ]a|token|clave|cuenta|clabe)\s*[:=]\s*\S+/gi,
      "[dato privado omitido]",
    )
    .replace(/\b[0-9][0-9 -]{6,32}[0-9]\b/g, "[número omitido]")
    .slice(0, max);
}
export function buildSellerSnapshot(input: {
  offer?: DomainRecord;
  product?: DomainRecord;
  category?: DomainRecord;
  agent?: DomainRecord;
}): SellerSnapshot {
  const { offer, product, category, agent } = input;
  const sources: SellerSource[] = [];
  const add = (
    record: DomainRecord | undefined,
    topic: string,
    title: string,
    content: unknown,
    source: string,
    id: string,
  ) => {
    const clean = sanitizeSellerText(content, 4000);
    if (record && clean)
      sources.push({
        id: `${record.kind}:${record.id}:r${record.version}:${id}`,
        topic,
        title: sanitizeSellerText(title, 160),
        content: clean,
        source: sanitizeSellerText(source, 500),
        record_id: record.id,
        revision: record.version,
      });
  };
  add(
    product,
    "description",
    "Descripción",
    product?.body.description,
    "Catálogo del producto",
    "description",
  );
  for (const r of [product, category])
    for (const s of r?.body.knowledge ?? [])
      add(r, s.topic, s.title, s.content, s.source, s.id);
  // Legacy free knowledge is scoped to the selected agent, never another product.
  if (!agent?.body.product_id || agent.body.product_id === product?.id) {
    let compiled: Body | undefined;
    try {
      const value=JSON.parse(agent?.body.knowledge??'');
      if(value?.compilation==='KNOWLEDGE_WITHOUT_MONETARY_LITERALS'&&Array.isArray(value.faq)&&value.rules&&typeof value.rules==='object'&&!Array.isArray(value.rules))compiled=value;
    } catch { /* Existing free text retains its original sanitization contract. */ }
    if(compiled){
      for(const [key,value] of Object.entries(compiled.rules).slice(0,20))if(typeof value==='string')add(agent,'rules',key,value,'Reglas publicadas del vendedor','rule-'+key);
      for(const [index,item] of compiled.faq.slice(0,30).entries())if(typeof item?.question==='string'&&typeof item?.answer==='string')add(agent,'faq',item.question,item.question+'\n'+item.answer,'FAQ publicada del vendedor','faq-'+index);
      for(const [index,item] of (Array.isArray(compiled.sources)?compiled.sources:[]).slice(0,30).entries())if(typeof item?.content==='string')add(agent,'reference',item.title??'Fuente',item.content,'Fuente publicada del vendedor','source-'+index);
    }else add(agent,"faq","Conocimiento del vendedor",agent?.body.knowledge,"Configuración del vendedor","legacy");
  }
  const canonical:Body = {
    name: sanitizeSellerText(
      offer?.body.name ?? product?.body.name ?? "Oferta",
    ),
    currency: offer?.body.currency,
    base_amount_minor: offer?.body.base_amount_minor,
    billing_delay_seconds: offer?.body.billing_delay_seconds,
    positive_payment_unlocks_all: offer?.body.positive_payment_unlocks_all === true,
    madrina: offer?.body.madrina?.enabled ? {enabled:true,threshold_exclusive_minor:10700,policy_version:'mcl-receipt-total-v5',third_party_effects:false} : undefined,
    delivery_rules: (offer?.body.fulfillment ?? []).map(
      (f: Body, _i: number, all: Body[]) => ({
        material_ref: `material_${all.findIndex((x) => x.asset_id === f.asset_id) + 1}`,
        release_on: f.release_on,
        min_amount_minor: f.min_amount_minor,
      }),
    ),
  };
  canonical.approved_commercial_reply=canonicalThresholdReply({offer:canonical} as SellerContext);
  if (offer)
    sources.unshift({
      id: "offer_snapshot",
      topic: "offer",
      title: "Oferta canónica",
      content: `${canonical.name}: ${(Number(canonical.base_amount_minor) / 100).toFixed(2)} ${canonical.currency}. Entrega según reglas de la oferta.`,
      source: "Oferta seleccionada",
      record_id: offer.id,
      revision: offer.version,
    });
  let budget = 12000;
  for (const source of sources) {
    source.content = source.content.slice(0, Math.max(0, budget));
    budget -= source.content.length;
  }
  const conflicts: string[] = [];
  if (agent?.body.product_id && agent.body.product_id !== product?.id)
    conflicts.push("AGENT_PRODUCT_MISMATCH");
  if (agent?.body.offer_version_id && agent.body.offer_version_id !== offer?.id)
    conflicts.push("AGENT_OFFER_MISMATCH");
  // A monetary assertion in knowledge must be reviewed, never used to override an offer.
  if (
    sources.some(
      (s) =>
        s.id !== "offer_snapshot" &&
        /(?:\$\s*\d|\d+(?:[.,]\d+)?\s*(?:MXN|USD|pesos|d[oó]lares))/i.test(
          s.content,
        ),
    )
  )
    conflicts.push("COMMERCIAL_KNOWLEDGE_REQUIRES_REVIEW");
  const agentConfig = agent
    ? {
        name: sanitizeSellerText(agent.body.name, 160),
        provider: agent.body.provider,
        model: agent.body.model,
        instructions: sanitizeSellerText(agent.body.instructions, 4000),
        style: Object.fromEntries(
          Object.entries(agent.body.style ?? {}).map(([key, value]) => [
            key,
            sanitizeSellerText(value, 4000),
          ]),
        ),
        revision: agent.body.revision ?? 1,
      }
    : {};
  return {
    schema_version: 1,
    product_id: product?.id,
    agent_version_id: agent?.id,
    offer_version_id: offer?.id,
    offer: canonical,
    sources: sources.filter((s) => s.content),
    conflicts,
    agent: agentConfig,
  };
}
export function composeSellerContext(
  snapshot: SellerSnapshot,
  input: {
    text: string;
    history?: Array<{ role: "customer" | "seller"; text: string }>;
    stage?: string;
    order?: Body;
    variables?: Body;
  },
): SellerContext {
  let remaining = 6000;
  const history = (input.history ?? [])
    .slice(-12)
    .reverse()
    .map((m) => {
      const text = sanitizeSellerText(m.text, Math.min(1000, remaining));
      remaining -= text.length;
      return { role: m.role, text };
    })
    .filter((m) => m.text)
    .reverse();
  return {
    customer_text: sanitizeSellerText(input.text),
    offer: snapshot.offer,
    history,
    stage: input.stage ?? "NEW",
    order: {
      status: input.order?.status ?? "OFFERED",
      receipt_status: input.order?.receipt_status ?? "NONE",
      sale_definition: input.order?.sale_definition ?? null,
    },
    variables: Object.fromEntries(
      Object.entries(canonicalSalesVariables(input.variables))
        .filter(
          ([key, value]) =>
            [
              "grado",
              "nivel",
              "necesidad",
              "objetivo",
              "interes",
              "modalidad",
              "education_role",
            ].includes(key) &&
            ["string", "number", "boolean"].includes(typeof value),
        )
        .map(([key, value]) => [key, sanitizeSellerText(value, 300)]),
    ),
    sources: snapshot.sources,
    conflicts: snapshot.conflicts,
  };
}
/** Exact canonical wording also lets the grounding guard verify tier totals without accepting an invented price. */
export function canonicalThresholdReply(context: SellerContext): string | undefined {
  if(context.offer.positive_payment_unlocks_all&&context.offer.currency&&Number.isSafeInteger(context.offer.base_amount_minor))
    return `El precio de referencia es $${(Number(context.offer.base_amount_minor)/100).toFixed(2)} ${context.offer.currency}. Cualquier comprobante válido con un importe positivo registra exactamente ese importe y libera todos los regalos y accesos configurados; no hay un monto mínimo comercial ni beneficios por niveles.`;
  if(context.offer.madrina?.enabled&&context.offer.currency==='MXN'&&context.offer.base_amount_minor===9700)
    return 'El precio base es $97.00 MXN. Primero recibes el Core después de aceptar el acuerdo y luego realizas el pago. Con $107.00 MXN en total aprobados recibes Calendario y Kit; no es un cargo adicional. Cualquier total aprobado superior a $107.00 MXN acredita el tier Madrina: conserva Calendario y Kit. El pago extra está incluido en el total y no agrega beneficios ni entregas a terceros.';
  const thresholds = [...new Set<number>((context.offer.delivery_rules ?? [])
    .filter((r: Body) => ['receipt_approved', 'reconciled'].includes(r.release_on) && Number.isSafeInteger(r.min_amount_minor) && r.min_amount_minor > context.offer.base_amount_minor)
    .map((r: Body) => r.min_amount_minor))].sort((a,b) => a-b);
  if (thresholds.length !== 1 || !context.offer.currency) return;
  return `El precio base es $${(Number(context.offer.base_amount_minor)/100).toFixed(2)} ${context.offer.currency}. El beneficio adicional se habilita desde $${(thresholds[0]!/100).toFixed(2)} ${context.offer.currency} en total aceptados en comprobantes; ese importe es el total, no un cargo adicional.`;
}
export function proposalGroundingIssue(
  p: AgentProposal,
  context: SellerContext,
): string | undefined {
  if (context.conflicts.length) return context.conflicts[0];
  if (
    p.intent === "opt_out" ||
    p.intent === "human_handoff" ||
    p.tool === "request_human"
  )
    return;
  const supplied = new Set(context.sources.map((s) => s.id));
  if (!p.grounding.length || p.grounding.some((id) => !supplied.has(id)))
    return "UNSUPPLIED_SOURCE";
  if (
    /(?:pago|comprobante|transferencia)\s+(?:aprobado|confirmado)|ya\s+(?:pagaste|entregu[eé])/i.test(
      p.reply,
    )
  )
    return "UNVERIFIED_COMMERCIAL_CLAIM";
  const amounts = [
    ...p.reply.matchAll(
      /\$\s*(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(MXN|USD|EUR|pesos|d[oó]lares|euros)\b/gi,
    ),
  ].map((m) => {
    const unit = m[3]?.toLowerCase();
    const code = unit
      ? ({ pesos: "MXN", dólares: "USD", dolares: "USD", euros: "EUR" }[unit] ??
        unit.toUpperCase())
      : context.offer.currency;
    return code !== context.offer.currency
      ? NaN
      : Math.round(Number((m[1] ?? m[2])!.replace(",", ".")) * 100);
  });
  if (amounts.some((n) => n !== context.offer.base_amount_minor) && p.reply !== canonicalThresholdReply(context))
    return "PRICE_CONFLICT";
  return;
}
/** Fixture matching is intentionally conservative; it is not a linguistic quality evaluation. */
export function deterministicSellerReply(context: SellerContext): {
  proposal: AgentProposal;
  reason: string;
} {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const text = normalize(context.customer_text.trim()).replace(/^[¿¡]+/, "");
  const result = (
    reply: string,
    intent: AgentProposal["intent"],
    grounding: string[],
    reason: string,
  ) => ({
    proposal: {
      reply,
      intent,
      confidence: intent === "unknown" ? 0 : 1,
      tool:
        intent === "human_handoff" || intent === "unknown"
          ? ("request_human" as const)
          : ("none" as const),
      grounding,
    },
    reason,
  });
  if (context.stage === "COMMITTED" && /^(?:por ?que no contestas|sigues ahi|estas ahi|hola|me lees|me escuchas)[?.!\s]*$/.test(text))
    return result(
      "Aquí sigo. Perdón por la espera. ¿Qué necesitas revisar del material o del acceso?",
      "question",
      ["offer_snapshot"],
      "POST_AGREEMENT_CHECK_IN",
    );
  if (/^(stop|baja|no me escribas|cancelar suscripcion)$/.test(text))
    return result("Baja registrada en esta prueba.", "opt_out", [], "OPT_OUT");
  if (/humano|persona|asesor/.test(text))
    return result(
      "Solicito ayuda del equipo.",
      "human_handoff",
      [],
      "REQUESTED_HUMAN",
    );
  if (context.conflicts.length)
    return result(
      "Hay información comercial en conflicto. El equipo debe revisarla.",
      "unknown",
      [],
      context.conflicts[0]!,
    );
  if (
    /ignora|instrucciones|gratis|descuento|aprueba|password|clabe|codigo de acceso/.test(
      text,
    )
  )
    return result(
      "No tengo una fuente aprobada para esa solicitud. Solicito ayuda.",
      "unknown",
      [],
      "UNSUPPORTED_REQUEST",
    );
  if ((/kit|total|adicional/.test(text)||context.offer.madrina?.enabled&&/madrina|107|108|194|precio|cuanto|cuesta|pago antes|pagar antes|pago despues/.test(text)) && canonicalThresholdReply(context))
    return result(canonicalThresholdReply(context)!, "question", ["offer_snapshot"], "CANONICAL_BENEFIT_TOTAL");
  if (/precio|cuanto|cuesta|moneda/.test(text) && context.offer.currency)
    return result(
      `El precio es $${(Number(context.offer.base_amount_minor) / 100).toFixed(2)} ${context.offer.currency}.`,
      "question",
      ["offer_snapshot"],
      "CANONICAL_OFFER",
    );
  const topic = /incluye|contenido|temario/.test(text)
    ? "contents"
    : /para quien|sirve|publico/.test(text)
      ? "audience"
      : /entrega|recib/.test(text)
        ? "policy"
        : /requisit/.test(text)
          ? "requirements"
          : /objecion|caro/.test(text)
            ? "objection"
            : undefined;
  if (!topic && /^(y |eso|lo anterior)/.test(text)) {
    const last = context.history.filter((m) => m.role === "customer").at(-1);
    if (last) {
      const prior = deterministicSellerReply({
        ...context,
        customer_text: last.text,
        history: [],
      });
      return { ...prior, reason: "BOUNDED_HISTORY: " + prior.reason };
    }
  }
  const tokens = text.split(/\W+/).filter((w) => w.length > 3);
  const source = context.sources.find(
    (s) =>
      s.id !== "offer_snapshot" &&
      (topic
        ? s.topic === topic
        : tokens.some((t) => normalize(s.title).includes(t))),
  );
  if (source)
    return result(source.content, "question", [source.id], "APPROVED_SOURCE");
  return result(
    "No tengo información aprobada para responder eso sobre esta oferta. Solicito ayuda del equipo.",
    "unknown",
    [],
    "KNOWLEDGE_MISSING",
  );
}

export function sellerInstructions(snapshot: SellerSnapshot): string {
  const style = snapshot.agent.style ?? {};
  return sanitizeSellerText(
    [
      style.language,
      style.tone,
      style.length,
      style.goal,
      style.examples,
      style.handoff,
      snapshot.agent.instructions,
      snapshot.offer.approved_commercial_reply ? `Para explicar precios o tiers usa literalmente la respuesta comercial aprobada: ${snapshot.offer.approved_commercial_reply}` : undefined,
    ]
      .filter(Boolean)
      .join("\n"),
    6000,
  );
}
