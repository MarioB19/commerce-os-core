/** Synthetic SIMULATION fixtures only. No production endpoints or private assets. */
import { writeFile, mkdir } from "node:fs/promises";
import { createApp } from "../apps/api/src/app.js";
import { pool } from "../packages/db/src/index.js";
const origin = process.env.BETTER_AUTH_URL ?? "";
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw new Error("LOCAL_REVIEW_ONLY");
const app = await createApp();
const login = await app.inject({
  method: "POST",
  url: "/api/auth/sign-in/email",
  headers: { origin },
  payload: {
    email: process.env.BOOTSTRAP_EMAIL,
    password: process.env.BOOTSTRAP_PASSWORD,
  },
});
if (login.statusCode !== 200) throw new Error("LOCAL_LOGIN_FAILED");
const cookie = [login.headers["set-cookie"]]
  .flat()
  .filter(Boolean)
  .map((x) => String(x).split(";")[0])
  .join("; ");
const post = async (path: string, body: any) => {
  const r = await app.inject({
    method: "POST",
    url: "/v1" + path,
    headers: {
      origin,
      cookie,
      "idempotency-key":
        "sales-review-v1:" +
        path +
        ":" +
        (body.name ?? body.expected_version ?? ""),
    },
    payload: { ...body, environment: "SIMULATION" },
  });
  if (r.statusCode >= 300)
    throw new Error(path + ":" + r.statusCode + ":" + r.json().error?.code);
  return r.json().data;
};
try {
  const category = await post("/categories", {
    name: "Educación · categoría propuesta",
    knowledge: [
      {
        id: "category",
        topic: "audience",
        title: "Contexto de categoría",
        content:
          "Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",
        source: "Fixture de revisión H3",
      },
    ],
  });
  const ids: any = {};
  for (const which of ["preescolar", "segundo"]) {
    const pre = which === "preescolar";
    const product = await post("/products", {
      name: pre
        ? "Preescolar Listo · copia local"
        : "Cuaderno de fotografía · ficticio",
      description: pre
        ? "Copia local de condiciones documentadas, sin accesos ni datos de producción."
        : "Segundo producto sintético para verificar separación de conocimiento.",
      category_id: category.id,
      knowledge: pre
        ? [
            {
              id: "contents",
              topic: "contents",
              title: "Qué incluye",
              content:
                "Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",
              source: "synthetic-contract-fixture",
            },
            {
              id: "audience",
              topic: "audience",
              title: "Para quién sirve",
              content:
                "Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",
              source: "synthetic-contract-fixture",
            },
            {
              id: "delivery",
              topic: "policy",
              title: "Cómo se entrega",
              content:
                "Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",
              source: "synthetic-contract-fixture",
            },
          ]
        : [
            {
              id: "contents",
              topic: "contents",
              title: "Qué incluye",
              content:
                "Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",
              source: "Fixture sintético H3",
            },
            {
              id: "audience",
              topic: "audience",
              title: "Para quién sirve",
              content:
                "Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",
              source: "Fixture sintético H3",
            },
          ],
    });
    const asset = await post("/assets", {
      name: pre ? "Beneficio sintético de Preescolar" : "Cuaderno sintético",
      kind: "link",
      url: "https://example.invalid/synthetic-review",
    });
    const offer = await post(`/products/${product.id}/offers`, {
      name: pre
        ? "Oferta Preescolar · revisión local"
        : "Oferta fotografía · ficticia",
      currency: "MXN",
      base_amount_minor: pre ? 9700 : 2500,
      fulfillment: [{ asset_id: asset.id, release_on: "receipt_approved" }],
    });
    const agent = await post("/agents", {
      name: pre ? "Lía · Preescolar (prueba)" : "Leo · Fotografía (prueba)",
      product_id: product.id,
      offer_version_id: offer.id,
      provider: "deterministic",
      model: "deterministic-v1",
      style: {
        language: "Español",
        tone: "Claro, amable y breve",
        length: "brief",
        goal: "Explicar la oferta con fuentes",
        examples: "",
        handoff: "Falta de información, conflicto o petición humana.",
      },
    });
    const nodes = [
      { id: "inicio", type: "entry", config: {}, next: "presentacion" },
      {
        id: "presentacion",
        type: "message",
        config: {
          text: pre
            ? "Hola. ¿Qué grado de preescolar trabajas?"
            : "Hola. ¿Qué fotografía practicas?",
        },
        next: "respuesta",
      },
      {
        id: "respuesta",
        type: "reply",
        config: { variable: "interes" },
        next: "decision",
      },
      {
        id: "decision",
        type: "condition",
        config: { field: "interes", operator: "contains", value: "ayuda" },
        branches: { true: "persona", false: "oferta" },
      },
      { id: "persona", type: "handoff", config: {}, next: "fin" },
      {
        id: "oferta",
        type: "message",
        config: {
          text: "{{offer_name}} · {{price}} {{currency}}. Puedes preguntar antes de confirmar el compromiso.",
        },
        next: "compromiso",
      },
      {
        id: "compromiso",
        type: "commitment",
        config: { accepted_phrases: ["acepto", "me comprometo"] },
        next: "espera",
      },
      {
        id: "espera",
        type: "wait",
        config: { seconds: 60 },
        next: "comprobante",
      },
      { id: "comprobante", type: "receipt", config: {}, next: "beneficio" },
      {
        id: "beneficio",
        type: "fulfillment",
        config: { release_on: "receipt_approved" },
        next: "fin",
      },
      { id: "fin", type: "end", config: {} },
    ];
    const labels = {
      inicio: "Inicio",
      presentacion: "Conocer el contexto",
      respuesta: "Escuchar al cliente",
      decision: "¿Necesita ayuda?",
      persona: "Hablar con el equipo",
      oferta: "Presentar la oferta",
      compromiso: "Esperar compromiso",
      espera: "Dar tiempo para revisar",
      comprobante: "Esperar comprobante válido",
      beneficio: "Entregar beneficio",
      fin: "Cerrar recorrido",
    };
    const positions = Object.fromEntries(
      nodes.map((n, i) => [
        n.id,
        {
          x: n.id === "persona" ? 370 : 50,
          y: n.id === "persona" ? 470 : (i > 4 ? i - 1 : i) * 150,
        },
      ]),
    );
    const flow = await post("/workflows", {
      name: pre
        ? "Preescolar · conversación y comprobante"
        : "Fotografía · recorrido ficticio",
      product_id: product.id,
      offer_version_id: offer.id,
      agent_version_id: agent.id,
      entry_node_id: "inicio",
      nodes,
      editor: { schema_version: 1, positions, labels },
    });
    ids[which] = {
      product: product.id,
      offer: offer.id,
      agent: agent.id,
      flow: flow.id,
    };
  }
  await mkdir("docs/evidence", { recursive: true });
  await writeFile(
    "docs/evidence/sales-review-fixtures.json",
    JSON.stringify(
      {
        environment: "SIMULATION",
        source: "Sanitized local fixtures. No private assets or customer data.",
        ids,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Two synthetic products, sellers and draft flows ready. Fixture IDs saved in sanitized evidence.",
  );
} finally {
  await app.close();
  await pool.end();
}
