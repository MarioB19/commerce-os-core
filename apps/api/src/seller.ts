import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  pool,
  putRecord,
  listRecords,
} from "../../../packages/db/src/index.js";
import { loadSellerSnapshot } from "../../../packages/db/src/seller-context.js";
import {
  resolveSellerAssignment,
  sanitizeSellerText,
} from "../../../packages/domain/src/sales/seller-context.js";
import {
  evaluationFlow,
  newEvaluation,
  runEvaluation,
  type EvaluationSnapshot,
} from "../../../packages/domain/src/sales/flow-evaluation.js";
import { validateWorkflow } from "../../../packages/domain/src/sales/workflow.js";
import { assertPermission } from "../../../packages/domain/src/core/permissions.js";
import { workflowValidation, lockCatalogRecord } from "./catalog-versions.js";
import {
  principal,
  envOf,
  resourcePermitted,
  scopedRecord,
  parseBody,
  readPermission,
  writePermission,
  mutate,
  present,
  audit,
  fail,
} from "./context.js";
import type { Body } from "../../../packages/contracts/src/index.js";
export async function sellerRoutes(app: FastifyInstance) {
  app.get("/v1/agents/:id/versions", async (req) => {
    readPermission(principal(req), "agent");
    const r = await scopedRecord(req, "agent", (req.params as Body).id);
    const family = r.body.series_id ?? r.id;
    return {
      data: (await listRecords(pool, r.workspace_id, "agent", r.environment))
        .filter((a) => resourcePermitted(principal(req),a.id))
        .filter((a) => (a.body.series_id ?? a.id) === family)
        .map(present),
    };
  });
  app.get("/v1/categories/:id/versions", async (req) => {
    readPermission(principal(req), "category");
    const r = await scopedRecord(req, "category", (req.params as Body).id);
    return {
      data: (
        await pool.query(
          "SELECT * FROM record_versions WHERE record_id=$1 AND workspace_id=$2 ORDER BY version DESC",
          [r.id, r.workspace_id],
        )
      ).rows.map((v) => ({ version: v.version, knowledge: v.body.knowledge })),
    };
  });
  app.get("/v1/workflows/:id/seller", async (req) => {
    readPermission(principal(req), "workflow");
    const f = await scopedRecord(req, "workflow", (req.params as Body).id);
    const selection = z.object({ offer_version_id: z.string().uuid().optional() }).parse(req.query);
    // A reusable published workflow is normally referenced by the offer, not
    // the other way around. Never select the newest of several commercial offers.
    const candidates = !selection.offer_version_id && !f.body.offer_version_id
      ? (await listRecords(pool, f.workspace_id, "offer", f.environment)).filter((o) =>
          resourcePermitted(principal(req), o.id) && o.body.status === "PUBLISHED" &&
          !o.body.archived_at && o.body.workflow_version_id === f.id &&
          (!f.body.product_id || o.body.product_id === f.body.product_id))
      : [];
    const offerId = selection.offer_version_id ?? f.body.offer_version_id ??
      (candidates.length === 1 ? candidates[0]!.id : undefined);
    if (!offerId) return { data: {
      offer_selection: { state: "REQUIRED", reason: candidates.length ? "AMBIGUOUS_OFFERS" : "NO_PUBLISHED_OFFER", candidates: candidates.map((o) => ({ id: o.id, name: o.body.name })) },
      snapshot: null,
      scope: "Selecciona una oferta de este flujo para consultar su vendedor y contexto comercial.",
    } };
    const offer = await scopedRecord(req, "offer", offerId);
    if ((f.body.product_id && offer.body.product_id !== f.body.product_id) ||
        (selection.offer_version_id && offer.id !== f.body.offer_version_id && offer.body.workflow_version_id !== f.id))
      throw fail(409, "OFFER_WORKFLOW_MISMATCH", "La oferta seleccionada no corresponde a este flujo y producto.");
    const product =
      (offer?.body.product_id ?? f.body.product_id)
        ? await scopedRecord(
            req,
            "product",
            offer?.body.product_id ?? f.body.product_id,
          )
        : undefined;
    const assignment = resolveSellerAssignment({
      offer: offer?.body,
      product: product?.body,
      workflow: f.body,
    });
    if (assignment.agent_version_id)
      await scopedRecord(req, "agent", assignment.agent_version_id);
    if (product?.body.category_id)
      await scopedRecord(req, "category", product.body.category_id);
    const seller = await loadSellerSnapshot(
      pool,
      f.workspace_id,
      f.environment,
      offer?.id,
      assignment.agent_version_id,
    );
    return {
      data: {
        ...assignment,
        offer_selection: { state: "SELECTED", offer_version_id: offer.id, source: selection.offer_version_id ? "EXPLICIT" : f.body.offer_version_id ? "WORKFLOW" : "UNIQUE_PUBLISHED_OFFER" },
        scope:
          "Oferta/producto/flujo. Un vínculo o número puede tener prioridad al recibir.",
        snapshot: seller,
      },
    };
  });
  app.post("/v1/workflows/:id/evaluations", async (req, reply) => {
    if(envOf(req)!=='SIMULATION')throw fail(400,'SIMULATION_ONLY');
    const p = principal(req);
    assertPermission(p, p.service ? "simulations:run" : "workflows:write");
    const input = z
      .object({
        expected_version: z.number().int().positive(),
        agent_version_id: z.string().uuid().optional(),
      })
      .strict()
      .parse(parseBody(req));
    const result = await mutate(
      req,
      "workflow.evaluate:" + (req.params as Body).id,
      async (c) => {
        const f = await lockCatalogRecord(
          req,
          "workflow",
          (req.params as Body).id,
          c,
        );
        if (f.version !== input.expected_version)
          throw fail(409, "VERSION_CONFLICT");
        const validation = await workflowValidation(req, f.body, c, true);
        if (!validation.valid)
          throw fail(
            400,
            "INVALID_WORKFLOW",
            "Completa el recorrido antes de probar.",
            validation.issues,
          );
        const offer = f.body.offer_version_id
          ? await scopedRecord(req, "offer", f.body.offer_version_id, c)
          : undefined;
        if (!offer)
          throw fail(
            409,
            "OFFER_REQUIRED",
            "Selecciona una oferta para probar el vendedor.",
          );
        const product = await scopedRecord(
          req,
          "product",
          offer.body.product_id,
          c,
        );
        const assignment = resolveSellerAssignment({
          offer: offer.body,
          product: product.body,
          workflow: f.body,
        });
        const effectiveAgentId=input.agent_version_id??assignment.agent_version_id;
        if (effectiveAgentId)
          await scopedRecord(req, "agent", effectiveAgentId, c);
        if (product.body.category_id)
          await scopedRecord(req, "category", product.body.category_id, c);
        const seller = await loadSellerSnapshot(
          c,
          f.workspace_id,
          f.environment,
          offer.id,
          input.agent_version_id ?? assignment.agent_version_id,
        );
        const subflows: EvaluationSnapshot["subflows"] = {};
        const collect = async (body: Body, depth: number, path: string[]) => {
          for (const n of body.nodes)
            if (n.type === "subflow") {
              if (depth >= 5 || path.includes(n.config.workflow_version_id))
                throw fail(400, "SUBFLOW_DEPTH_LIMIT");
              const sub = await scopedRecord(
                req,
                "workflow",
                n.config.workflow_version_id,
                c,
              );
              if (
                sub.body.status !== "PUBLISHED" ||
                !validateWorkflow(sub.body as any).valid
              )
                throw fail(400, "INVALID_SUBFLOW");
              subflows[sub.id] = evaluationFlow(sub.body);
              await collect(sub.body, depth + 1, [...path, sub.id]);
            }
        };
        await collect(f.body, 0, [f.id]);
        const snapshot: EvaluationSnapshot = {
          flow: evaluationFlow(f.body),
          workflow_id: f.id,
          workflow_revision: f.version,
          seller,
          subflows,
          mode: "DETERMINISTIC",
        };
        const row = await putRecord(c, {
          workspaceId: f.workspace_id,
          environment: f.environment,
          kind: "flow_evaluation",
          body: {
            snapshot,
            state: newEvaluation(snapshot),
            created_by: p.user.id,
            assignment_origin: input.agent_version_id
              ? "evaluation_override"
              : assignment.origin,
            external_effects: false,
            provider_evaluation: {
              enabled: false,
              reason: "PROVIDER_EVALUATION_NOT_ENABLED",
              paid_calls: 0,
            },
          },
        });
        await audit(c, req, "workflow.evaluation_created", row.id, {
          workflow_id: f.id,
          revision: f.version,
          mode: "DETERMINISTIC",
        });
        return { data: present(row), status: 201 };
      },
    );
    reply.code(201);
    return { data: result.data };
  });
  app.get("/v1/evaluations/:id", async (req) => {
    const p = principal(req);
    assertPermission(p, p.service ? "simulations:run" : "workflows:write");
    return {
      data: present(
        await scopedRecord(req, "flow_evaluation", (req.params as Body).id),
      ),
    };
  });
  app.post("/v1/evaluations/:id/turns", async (req) => {
    const p = principal(req);
    assertPermission(p, p.service ? "simulations:run" : "workflows:write");
    const input = z
      .object({
        expected_version: z.number().int().positive(),
        input: z.discriminatedUnion("type", [
          z
            .object({
              type: z.literal("reply"),
              text: z.string().trim().min(1).max(2000),
            })
            .strict(),
          z
            .object({
              type: z.literal("clock"),
              seconds: z.number().int().min(0).max(31536000),
            })
            .strict(),
          z
            .object({
              type: z.literal("receipt"),
              decision: z.enum(["PENDING", "APPROVED"]),
              amount_minor: z
                .number()
                .int()
                .positive()
                .max(10000000)
                .optional(),
            })
            .strict(),
          z.object({ type: z.literal("approve") }).strict(),
        ]),
      })
      .strict()
      .parse(parseBody(req));
    const result = await mutate(
      req,
      "evaluation.turn:" + (req.params as Body).id,
      async (c) => {
        const old = await lockCatalogRecord(
          req,
          "flow_evaluation",
          (req.params as Body).id,
          c,
        );
        if (old.version !== input.expected_version)
          throw fail(409, "VERSION_CONFLICT");
        if (old.body.state.steps >= 1000) throw fail(409, "EVALUATION_LIMIT");
        const row = await putRecord(c, {
          id: old.id,
          workspaceId: old.workspace_id,
          environment: old.environment,
          kind: old.kind,
          version: old.version,
          body: {
            ...old.body,
            state: runEvaluation(
              old.body.snapshot,
              old.body.state,
              input.input.type === "reply"
                ? { ...input.input, text: sanitizeSellerText(input.input.text) }
                : input.input,
            ),
          },
        });
        await audit(c, req, "evaluation.turn", row.id, {
          type: input.input.type,
          revision: row.version,
        });
        return { data: present(row) };
      },
    );
    return { data: result.data };
  });
  app.post("/v1/evaluations/:id/provider", async (req) => {
    writePermission(principal(req), "workflow");
    await scopedRecord(req, "flow_evaluation", (req.params as Body).id);
    throw fail(
      409,
      "PROVIDER_EVALUATION_NOT_ENABLED",
      "La evaluación externa requiere configuración, permiso y presupuesto propios. Esta entrega sólo ejecuta el doble determinista.",
    );
  });
}
