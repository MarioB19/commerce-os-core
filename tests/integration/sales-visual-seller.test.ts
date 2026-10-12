import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import { beforeAll, afterAll, it, expect } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createApp } from "../../apps/api/src/app.js";
import { provisionUser } from "../../apps/api/src/auth.js";
import {
  pool,
  putRecord,
  getRecord,
  withTransaction,
} from "../../packages/db/src/index.js";
import { materializeMessage } from "../../apps/automation-worker/src/inbound.js";
import { advanceWorkflow } from "../../apps/automation-worker/src/workflows.js";
import { processAgents } from "../../apps/automation-worker/src/agents.js";
import {
  DeterministicSalesAi,
  type SalesAiProvider,
  type AgentResult,
} from "../../packages/domain/src/sales/ai.js";
const workspace = "visual-" + randomUUID(),
  origin = (process.env.TRUSTED_ORIGINS ?? "http://localhost:5173").split(
    ",",
  )[0]!;
let app: FastifyInstance, cookie: string, viewer: string;
const call = (
  method: any,
  url: string,
  payload?: any,
  key = randomUUID(),
  auth = cookie,
) =>
  app.inject(explicitFixtureEnvironment({
    method,
    url,
    payload: method === "GET" || payload === undefined ? payload : { environment: "SIMULATION", ...payload },
    headers: { origin, cookie: auth, "idempotency-key": key },
  }));
const data = (r: any, status = 200) => {
  expect(r.statusCode, r.body).toBe(status);
  return r.json().data;
};
const input = (name = "Visual") => ({
  name,
  entry_node_id: "a",
  nodes: [
    { id: "a", type: "entry", config: {}, next: "reply" },
    { id: "reply", type: "reply", config: { variable: "grado" }, next: "end" },
    { id: "end", type: "end", config: {} },
  ],
});
beforeAll(async () => {
  app = await createApp();
  for (const role of ["owner", "viewer"] as const) {
    const email = randomUUID() + "@example.invalid",
      password = randomBytes(24).toString("base64url");
    await provisionUser({
      name: "Synthetic " + role,
      email,
      password,
      workspace_id: workspace,
      role,
    });
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      remoteAddress: "192.0.2.45",
      payload: { email, password },
      headers: { origin },
    });
    expect(login.statusCode).toBe(200);
    const c = [login.headers["set-cookie"]]
      .flat()
      .filter(Boolean)
      .map((x) => String(x).split(";")[0])
      .join("; ");
    if (role === "owner") cookie = c;
    else viewer = c;
  }
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
async function fixture() {
  const category = data(
    await call("POST", "/v1/categories", {
      name: "Categoría propuesta",
      knowledge: [
        {
          id: "scope",
          topic: "audience",
          title: "Público general",
          content: "Contenido sintético para pruebas de contrato; no representa el material comercial ni autoriza acciones.",
          source: "Fixture aprobado",
        },
      ],
    }),
    201,
  );
  const product = data(
    await call("POST", "/v1/products", {
      name: "Preescolar Listo · copia local",
      category_id: category.id,
      knowledge: [
        {
          id: "contents",
          topic: "contents",
          title: "Qué incluye",
          content:
            "Fixture sintético inicial: referencia 360. No representa material comercial ni autoriza acciones.",
          source: "synthetic-contract-fixture",
        },
      ],
    }),
    201,
  );
  const offer = data(
    await call("POST", `/v1/products/${product.id}/offers`, {
      name: "Preescolar copia",
      currency: "MXN",
      base_amount_minor: 9700,
    }),
    201,
  );
  const agent = data(
    await call("POST", "/v1/agents", {
      name: "Vendedora de prueba",
      product_id: product.id,
      offer_version_id: offer.id,
    }),
    201,
  );
  const flow = data(
    await call("POST", "/v1/workflows", {
      ...input(),
      product_id: product.id,
      offer_version_id: offer.id,
      agent_version_id: agent.id,
    }),
    201,
  );
  return { category, product, offer, agent, flow };
}
it("saves incomplete drafts, protects expected revision, preserves metadata and rejects publication", async () => {
  const f = data(
    await call("POST", "/v1/workflows", {
      name: "Incomplete",
      entry_node_id: "missing",
      nodes: [{ id: "condition", type: "condition", config: {} }],
      editor: {
        schema_version: 1,
        positions: { condition: { x: 20, y: 90 } },
        labels: { condition: "Decisión" },
      },
    }),
    201,
  );
  expect(f.editor.labels.condition).toBe("Decisión");
  expect(
    data(await call("POST", `/v1/workflows/${f.id}/validate`, {})).valid,
  ).toBe(false);
  expect(
    (
      await call("POST", `/v1/workflows/${f.id}/publish`, {
        expected_version: 1,
      })
    ).statusCode,
  ).toBe(400);
  const patches = await Promise.all([
    call("PATCH", `/v1/workflows/${f.id}`, { expected_version: 1, name: "A" }),
    call("PATCH", `/v1/workflows/${f.id}`, { expected_version: 1, name: "B" }),
  ]);
  expect(patches.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  const saved = data(await call("GET", `/v1/workflows/${f.id}`));
  expect(saved.editor.positions.condition).toEqual({ x: 20, y: 90 });
  expect(
    (
      await call("PATCH", `/v1/workflows/${f.id}`, {
        expected_version: 2,
        nodes: [
          {
            id: "a",
            type: "message",
            config: { nested: { script: "unsafe" } },
          },
        ],
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await call("POST", "/v1/workflows", {
        ...input(),
        nodes: Array.from({ length: 101 }, (_, i) => ({
          id: "n" + i,
          type: "end",
          config: {},
        })),
      })
    ).statusCode,
  ).toBe(400);
  expect(
    data(
      await call("POST", `/v1/workflows/${f.id}/duplicate`, {
        name: "Incomplete copy",
      }),
    ).status,
  ).toBe("DRAFT");
});
it("creates immutable agent families and versioned category/product knowledge without reassignment", async () => {
  const f = await fixture();
  const first = data(
    await call("PATCH", `/v1/agents/${f.agent.id}`, {
      expected_version: 1,
      name: "Next seller",
    }),
  );
  expect(first.id).not.toBe(f.agent.id);
  expect(first.revision).toBe(2);
  expect(
    (
      await call("PATCH", `/v1/agents/${f.agent.id}`, {
        expected_version: 1,
        name: "Concurrent stale",
      })
    ).statusCode,
  ).toBe(409);
  expect(
    data(await call("GET", `/v1/agents/${first.id}/versions`)),
  ).toHaveLength(2);
  expect(
    data(await call("GET", `/v1/workflows/${f.flow.id}`)).agent_version_id,
  ).toBe(f.agent.id);
  data(
    await call("PATCH", `/v1/categories/${f.category.id}`, {
      expected_version: 1,
      knowledge: [],
    }),
  );
  expect(
    data(await call("GET", `/v1/categories/${f.category.id}/versions`)),
  ).toHaveLength(2);
  expect(
    (
      await call("POST", "/v1/products", {
        name: "Invalid category",
        category_id: randomUUID(),
      })
    ).statusCode,
  ).toBe(400);
});
it("evaluates immutable draft snapshots, isolates scope, revisions and deterministic provider with no business effects", async () => {
  const f = await fixture();
  const startBody = { expected_version: 1 },
    key = randomUUID(),
    evaluation = data(
      await call(
        "POST",
        `/v1/workflows/${f.flow.id}/evaluations`,
        startBody,
        key,
      ),
      201,
    );
  expect(
    data(
      await call(
        "POST",
        `/v1/workflows/${f.flow.id}/evaluations`,
        startBody,
        key,
      ),
      201,
    ).id,
  ).toBe(evaluation.id);
  expect(
    evaluation.snapshot.seller.sources.some((s: any) =>
      s.content.includes("360"),
    ),
  ).toBe(true);
  data(
    await call("PATCH", `/v1/workflows/${f.flow.id}`, {
      expected_version: 1,
      name: "Changed later",
    }),
  );
  data(
    await call("POST", `/v1/products/${f.product.id}/versions`, {
      expected_version: 1,
      changes: { knowledge: [] },
    }),
    201,
  );
  expect(
    data(await call("GET", `/v1/evaluations/${evaluation.id}`)).snapshot.flow
      .name,
  ).toBe("Visual");
  expect(
    (await call("GET", `/v1/evaluations/${evaluation.id}?environment=REAL`))
      .statusCode,
  ).toBe(404);
  expect(
    (await call("POST", `/v1/evaluations/${evaluation.id}/provider`, {})).json()
      .error.code,
  ).toBe("PROVIDER_EVALUATION_NOT_ENABLED");
  const turnKey = randomUUID(),
    turn = { expected_version: 1, input: { type: "reply", text: "segundo" } };
  const next = data(
    await call("POST", `/v1/evaluations/${evaluation.id}/turns`, turn, turnKey),
  );
  expect(next.state.status).toBe("FINISHED");
  expect(
    data(
      await call(
        "POST",
        `/v1/evaluations/${evaluation.id}/turns`,
        turn,
        turnKey,
      ),
    ).version,
  ).toBe(next.version);
  expect(
    (await call("POST", `/v1/evaluations/${evaluation.id}/turns`, turn))
      .statusCode,
  ).toBe(409);
  await expect(
    pool.query(
      "UPDATE records SET body=jsonb_set(body,'{snapshot,workflow_revision}','99'),version=version+1 WHERE id=$1",
      [evaluation.id],
    ),
  ).rejects.toThrow("IMMUTABLE_EVALUATION_SNAPSHOT");
  for (const table of [
    "outbox",
    "commands",
    "operation_authorizations",
    "timers",
  ])
    expect(
      (
        await pool.query(
          `SELECT count(*)::int n FROM ${table} WHERE workspace_id=$1`,
          [workspace],
        )
      ).rows[0].n,
    ).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM records WHERE workspace_id=$1 AND kind IN ('conversation','order','message')",
        [workspace],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("enforces viewer and environment permissions at API, not just UI", async () => {
  const f = await fixture();
  expect(
    (
      await call(
        "GET",
        `/v1/workflows/${f.flow.id}`,
        undefined,
        randomUUID(),
        viewer,
      )
    ).statusCode,
  ).toBe(200);
  for (const [method, path, body] of [
    [
      "PATCH",
      `/v1/workflows/${f.flow.id}`,
      { expected_version: 1, name: "forbidden" },
    ],
    ["POST", `/v1/workflows/${f.flow.id}/evaluations`, { expected_version: 1 }],
    ["POST", "/v1/categories", { name: "forbidden" }],
    ["POST", "/v1/agents", { name: "forbidden" }],
  ] as any[])
    expect(
      (await call(method, path, body, randomUUID(), viewer)).statusCode,
    ).toBe(403);
  const foreign = await putRecord(pool, {
    workspaceId: "another-" + workspace,
    environment: "SIMULATION",
    kind: "category",
    body: { name: "Other" },
  });
  expect(
    (
      await call("POST", "/v1/products", {
        name: "Cross scope",
        category_id: foreign.id,
      })
    ).statusCode,
  ).toBe(400);
});
async function runtime(nodes?: any[]) {
  const f = await fixture();
  if (nodes)
    f.flow = data(
      await call("PATCH", `/v1/workflows/${f.flow.id}`, {
        expected_version: f.flow.version,
        entry_node_id: nodes[0].id,
        nodes,
      }),
    );
  const published = data(
    await call("POST", `/v1/workflows/${f.flow.id}/publish`, {
      expected_version: f.flow.version,
    }),
  );
  const account = await putRecord(pool, {
    workspaceId: workspace,
    environment: "SIMULATION",
    kind: "channel_account",
    body: {
      name: "Runtime fixture",
      provider: "simulator",
      status: "WORKING",
      offer_version_id: f.offer.id,
      workflow_version_id: published.id,
    },
  });
  const identity = "opaque:" + randomUUID();
  const receive = async (text: string, key = randomUUID()) =>
    withTransaction((c) =>
      materializeMessage(
        c,
        account,
        {
          key,
          type: "message",
          providerAt: new Date().toISOString(),
          identity,
          text,
          kind: "text",
          payload: {},
        },
        randomUUID(),
      ),
    );
  return { ...f, account, receive, published };
}
it("pins category/product/agent sources at conversation start and supplies bounded sanitized history", async () => {
  const f = await runtime(),
    conv = (await f.receive("Qué incluye"))!;
  expect(conv.body.agent_assignment_origin).toBe("workflow");
  expect(conv.body.seller_snapshot.agent_version_id).toBe(f.agent.id);
  data(
    await call("POST", `/v1/products/${f.product.id}/versions`, {
      expected_version: 1,
      changes: { knowledge: [] },
    }),
    201,
  );
  await putRecord(pool, {workspaceId:workspace,environment:'SIMULATION',kind:'message',body:{conversation_id:conv.id,direction:'OUTBOUND',status:'CANCELLED',text:'Never sent; do not present as seller history'}});
  await f.receive("¿Y eso?");
  let observed: any;
  const provider: SalesAiProvider = {
    propose: async (config, context) => {
      observed = context;
      return new DeterministicSalesAi().propose(config, context);
    },
    receipt: async () => {
      throw new Error("UNUSED");
    },
  };
  await processAgents(100, provider);
  expect(observed.history.some((m: any) => m.text === "Qué incluye")).toBe(
    true,
  );
  expect(observed.history.some((m: any) => m.text.includes("Never sent"))).toBe(false);
  expect(observed.sources.some((s: any) => s.content.includes("360"))).toBe(
    true,
  );
  const run = (
    await pool.query(
      "SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1",
      [conv.id],
    )
  ).rows.at(-1).body;
  expect(run.context_snapshot.history).toEqual(observed.history);
  expect(run.status).toBe("COMPLETED");
});
it("gives a consumed reply to the flow once and does not create a duplicate agent effect", async () => {
  const f = await runtime(),
    conv = (await f.receive("Hola"))!;
  await withTransaction((c) => advanceWorkflow(c, conv));
  const key = randomUUID();
  await f.receive("segundo", key);
  expect(await f.receive("segundo", key)).toBeUndefined();
  let calls = 0;
  await processAgents(100, {
    propose: async () => {
      calls++;
      throw new Error("SHOULD_NOT_RUN");
    },
    receipt: async () => {
      throw new Error("UNUSED");
    },
  });
  expect(calls).toBe(0);
  expect(
    (await getRecord(pool, workspace, "conversation", conv.id))?.body.flow_state
      .status,
  ).toBe("FINISHED");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM outbox WHERE conversation_id=$1",
        [conv.id],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("discards response after new input and rejects unknown grounding without side effects", async () => {
  const f = await runtime(),
    conv = (await f.receive("precio"))!;
  let entered!: () => void, release!: (v: AgentResult) => void;
  const ready = new Promise<void>((r) => (entered = r)),
    pending = new Promise<AgentResult>((r) => (release = r));
  const running = processAgents(100, {
    propose: async () => {
      entered();
      return pending;
    },
    receipt: async () => {
      throw new Error("UNUSED");
    },
  });
  await ready;
  await f.receive("Otro mensaje");
  release({
    proposal: {
      reply: "$97.00 MXN",
      intent: "question",
      confidence: 1,
      tool: "none",
      grounding: ["offer_snapshot"],
    },
    usage: { input_tokens: 0, output_tokens: 0, cost_minor: 0 },
    provider: "deterministic",
    model: "fixture",
  });
  await running;
  expect(
    (
      await pool.query(
        "SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1 ORDER BY created_at DESC",
        [conv.id],
      )
    ).rows[0].body.status,
  ).toBe("DISCARDED");
  await processAgents(100, {
    propose: async () => ({
      proposal: {
        reply: "Invented",
        intent: "question",
        confidence: 1,
        tool: "none",
        grounding: ["another-product"],
      },
      usage: { input_tokens: 0, output_tokens: 0, cost_minor: 0 },
      provider: "deterministic",
      model: "fixture",
    }),
    receipt: async () => {
      throw new Error("UNUSED");
    },
  });
  expect(
    (await getRecord(pool, workspace, "conversation", conv.id))?.body.ai_status,
  ).toBe("HUMAN_REVIEW");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM outbox WHERE conversation_id=$1",
        [conv.id],
      )
    ).rows[0].n,
  ).toBe(0);
});
it("keeps external AI denied in simulation and records missing provider without dispatch", async () => {
  const f = await runtime();
  const external = data(
    await call("POST", "/v1/agents", {
      name: "External unavailable",
      provider: "openai",
      model: "unconfigured-fixture",
      product_id: f.product.id,
      offer_version_id: f.offer.id,
    }),
    201,
  );
  await pool.query(
    "UPDATE records SET body=body||jsonb_build_object('agent_version_id',$2::text),version=version+1 WHERE id=$1",
    [f.account.id, external.id],
  );
  const account = (await getRecord(
    pool,
    workspace,
    "channel_account",
    f.account.id,
  ))!;
  const conv = await withTransaction((c) =>
    materializeMessage(
      c,
      account,
      {
        key: randomUUID(),
        type: "message",
        providerAt: new Date().toISOString(),
        identity: "opaque:" + randomUUID(),
        text: "precio",
        kind: "text",
        payload: {},
      },
      randomUUID(),
    ),
  );
  await processAgents(100);
  const run = (
    await pool.query(
      "SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1",
      [conv!.id],
    )
  ).rows[0].body;
  expect(run.reason).toBe("SIMULATION_EXTERNAL_AI_DENIED");
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM outbox WHERE conversation_id=$1",
        [conv!.id],
      )
    ).rows[0].n,
  ).toBe(0);
});
for (const failure of ["AI_COST_LIMIT", "AI_REQUEST_TIMEOUT"])
  it(`records ${failure} from a provider double and keeps effects empty`, async () => {
    const f = await runtime(),
      conv = (await f.receive("precio"))!;
    await processAgents(100, {
      propose: async () => {
        throw new Error(failure);
      },
      receipt: async () => {
        throw new Error("UNUSED");
      },
    });
    const run = (
      await pool.query(
        "SELECT body FROM records WHERE kind='ai_run' AND body->>'conversation_id'=$1",
        [conv.id],
      )
    ).rows[0].body;
    expect(run.reason).toBe(failure);
    expect(run.status).toBe("FAILED");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int n FROM outbox WHERE conversation_id=$1",
          [conv.id],
        )
      ).rows[0].n,
    ).toBe(0);
  });
it("restores historical knowledge for a legacy conversation and pins it on first run", async () => {
  const f = await runtime(),
    conv = (await f.receive("Qué incluye"))!;
  await pool.query(
    "UPDATE records SET body=body-'seller_snapshot',version=version+1 WHERE id=$1",
    [conv.id],
  );
  data(
    await call("POST", `/v1/products/${f.product.id}/versions`, {
      expected_version: 1,
      changes: {
        knowledge: [
          {
            id: "new",
            topic: "contents",
            title: "New",
            content: "New facts: fixture sintético de una revisión posterior, distinto del conocimiento histórico.",
            source: "Later revision",
          },
        ],
      },
    }),
    201,
  );
  await processAgents(100);
  const saved = (await getRecord(pool, workspace, "conversation", conv.id))!;
  expect(JSON.stringify(saved.body.seller_snapshot)).toContain("360");
  expect(JSON.stringify(saved.body.seller_snapshot)).not.toContain("New facts");
});

it("human review preserves commitment and receipt gates including provider failure", async () => {
  for (const failProvider of [false, true]) {
    const f = await runtime([
      { id: "commit", type: "commitment", config: {}, next: "receipt" },
      { id: "receipt", type: "receipt", config: {}, next: "end" },
      { id: "end", type: "end", config: {} },
    ]);
    const conv = (await f.receive("hola"))!;
    await withTransaction((c) => advanceWorkflow(c, conv));
    await f.receive("Quiero una persona");
    await processAgents(
      100,
      failProvider
        ? {
            propose: async () => {
              throw new Error("AI_REQUEST_TIMEOUT");
            },
            receipt: async () => {
              throw new Error("UNUSED");
            },
          }
        : undefined,
    );
    const reviewed = (await getRecord(
      pool,
      workspace,
      "conversation",
      conv.id,
    ))!;
    expect(reviewed.body.flow_state.status).toBe("HUMAN_REVIEW");
    await f.receive("acepto");
    await withTransaction((c) =>
      advanceWorkflow(c, reviewed, "human_approved"),
    );
    const resumed = (await getRecord(
      pool,
      workspace,
      "conversation",
      conv.id,
    ))!;
    expect(resumed.body.flow_state.waiting_for).toBe("commitment");
    expect(resumed.body.ai_status).toBeNull();
    const order = (
      await pool.query(
        "SELECT body FROM records WHERE kind='order' AND body->>'conversation_id'=$1",
        [conv.id],
      )
    ).rows[0].body;
    expect(order.status).toBe("OFFERED");
    expect(order.receipt_status).toBe("NONE");
  }
});
it("a flow message and AI node produce one response per customer input", async () => {
  const f = await runtime([
    {
      id: "hello",
      type: "message",
      config: { text: "Mensaje único del flujo" },
      next: "ai",
    },
    { id: "ai", type: "ai", config: {}, next: "end" },
    { id: "end", type: "end", config: {} },
  ]);
  const conv = (await f.receive("precio"))!;
  await withTransaction((c) => advanceWorkflow(c, conv));
  await processAgents(100);
  const count = async () =>
    Number(
      (
        await pool.query(
          "SELECT count(*) n FROM outbox WHERE conversation_id=$1",
          [conv.id],
        )
      ).rows[0].n,
    );
  expect(await count()).toBe(1);
  const first = (await getRecord(pool, workspace, "conversation", conv.id))!;
  expect(first.body.flow_state.waiting_for).toBe("ai_customer_message");
  const key = randomUUID();
  await f.receive("precio", key);
  await f.receive("precio", key);
  await processAgents(100);
  await processAgents(100);
  expect(await count()).toBe(2);
  expect(
    (await getRecord(pool, workspace, "conversation", conv.id))?.body.flow_state
      .status,
  ).toBe("FINISHED");
});

it('clears an explicit product seller with a versioned null while retaining its earlier assignment',async()=>{
 const f=await fixture();
 const assigned=data(await call('POST',`/v1/products/${f.product.id}/versions`,{expected_version:1,changes:{agent_version_id:f.agent.id}}),201);
 const cleared=data(await call('POST',`/v1/products/${f.product.id}/versions`,{expected_version:assigned.version,changes:{agent_version_id:null}}),201);
 expect(cleared.agent_version_id).toBeNull();
 const history=data(await call('GET',`/v1/products/${f.product.id}/versions`));
 expect(history.find((v:any)=>v.version===assigned.version).agent_version_id).toBe(f.agent.id);
});
