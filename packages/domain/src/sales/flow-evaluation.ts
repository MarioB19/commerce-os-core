import {acceptsAgreement} from './agreement.js';
import {classifyEducation,collectionStopReason} from './education.js';
import type { Body } from "../../../contracts/src/index.js";
import {canonicalSalesVariable,canonicalSalesVariables} from './variables.js';
import {
  evaluateCondition,
  renderMessage,
  type FlowDefinition,
} from "./workflow.js";
import {
  sanitizeSellerText,
  composeSellerContext,
  deterministicSellerReply,
  type SellerSnapshot,
} from "./seller-context.js";
/** Copy only declarative evaluation inputs. Private asset/config payloads are not part of a test. */
export function evaluationFlow(body: Body): FlowDefinition {
  const allowed = new Set([
    "text",
    "kind",
    "purpose",
    "seconds",
    "cancel_on_response",
    "variable",
    "classifier",
    "education_intro",
    "field",
    "operator",
    "value",
    "stage",
    "accepted_phrases",
    "release_on",
    "workflow_version_id",
  ]);
  const clean = (value: any): any =>
    typeof value === "string"
      ? sanitizeSellerText(value, 4000)
      : Array.isArray(value)
        ? value.slice(0, 100).map(clean)
        : ["number", "boolean"].includes(typeof value) || value === null
          ? value
          : undefined;
  return {
    name: sanitizeSellerText(body.name, 160),
    entry_node_id: body.entry_node_id,
    max_steps: body.max_steps,
    nodes: body.nodes.map((n: any) => ({
      id: n.id,
      type: n.type,
      next: n.next,
      branches: n.branches,
      config: Object.fromEntries(
        Object.entries(n.config ?? {})
          .filter(([key]) => allowed.has(key))
          .map(([key, value]) => [key, clean(value)]),
      ),
    })),
  };
}
export interface EvaluationSnapshot {
  flow: FlowDefinition;
  workflow_id: string;
  workflow_revision: number;
  seller: SellerSnapshot;
  subflows: Record<string, FlowDefinition>;
  mode: "DETERMINISTIC";
}
export interface EvaluationState {
  node_id: string;
  workflow_id: string;
  status:
    | "RUNNING"
    | "WAITING"
    | "HUMAN_REVIEW"
    | "FINISHED"
    | "OPT_OUT"
    | "FAILED";
  review_resume?: { status: EvaluationState["status"]; waiting_for?: string };
  waiting_for?: string;
  waiting_node_id?: string;
  next?: string;
  virtual_seconds: number;
  wake_at?: number;
  steps: number;
  stage: string;
  variables: Body;
  order: Body;
  stack: Array<{ workflow_id: string; next?: string }>;
  history: Array<{
    role: "customer" | "seller";
    text: string;
    reason?: string;
    sources?: string[];
  }>;
  trace: Array<{
    node_id: string;
    workflow_id: string;
    type: string;
    reason: string;
  }>;
  deliveries: string[];
}
export type EvaluationInput =
  | { type: "reply"; text: string }
  | { type: "clock"; seconds: number }
  | { type: "receipt"; decision: "PENDING" | "APPROVED"; amount_minor?: number }
  | { type: "approve" };
export function newEvaluation(snapshot: EvaluationSnapshot): EvaluationState {
  return runEvaluation(snapshot, {
    node_id: snapshot.flow.entry_node_id,
    workflow_id: snapshot.workflow_id,
    status: "RUNNING",
    virtual_seconds: 0,
    steps: 0,
    stage: "NEW",
    variables: {},
    order: {
      status: "OFFERED",
      receipt_status: "NONE",
      amount_minor: snapshot.seller.offer.base_amount_minor,
    },
    stack: [],
    history: [],
    trace: [],
    deliveries: [],
  });
}
export function runEvaluation(
  snapshot: EvaluationSnapshot,
  previous: EvaluationState,
  input?: EvaluationInput,
): EvaluationState {
  const state = structuredClone(previous),
    seller = snapshot.seller;
  state.variables = canonicalSalesVariables(state.variables);
  const flow = () =>
    state.workflow_id === snapshot.workflow_id
      ? snapshot.flow
      : snapshot.subflows[state.workflow_id]!;
  const deliver = (release: string) => {
    for (const [index, rule] of (seller.offer.delivery_rules ?? []).entries()) {
      const key = `${rule.material_ref ?? index}:${release === "reconciled" ? "receipt_approved" : release}`;
      if (
        (rule.release_on === release ||
          (rule.release_on === "reconciled" &&
            release === "receipt_approved")) &&
        (release === "commitment_accepted"
          ? state.order.committed === true
          : state.order.receipt_status === "APPROVED") &&
        (!rule.min_amount_minor ||
          Number(state.order.sale_amount_minor ?? state.order.amount_minor) >=
            rule.min_amount_minor) &&
        !state.deliveries.includes(key)
      )
        state.deliveries.push(key);
    }
  };
  const answer = (text: string) => {
    const context = composeSellerContext(seller, {
      text,
      history: state.history.slice(0, -1),
      stage: state.stage,
      order: state.order,
      variables: state.variables,
    });
    const result = deterministicSellerReply(context);
    state.history.push({
      role: "seller",
      text: result.proposal.reply,
      reason: result.reason,
      sources: result.proposal.grounding,
    });
    if (result.proposal.intent === "opt_out") state.status = "OPT_OUT";
    if (result.proposal.tool === "request_human") {
      state.review_resume = {
        status: state.status,
        waiting_for: state.waiting_for,
      };
      state.status = "HUMAN_REVIEW";
      state.waiting_for = "human_approved";
    }
    return result;
  };
  if (input?.type === "reply") {
    const text = input.text.trim();
    state.history.push({ role: "customer", text });
    if (/^(stop|baja|no me escribas|cancelar suscripcion)$/i.test(text)) {
      answer(text);
      return state;
    }
    if (flow().nodes.some(n=>n.config.classifier==='education_grade')&&collectionStopReason(text)) {
      state.status = "OPT_OUT";
      return state;
    }
    if (
      ["HUMAN_REVIEW", "FINISHED", "OPT_OUT", "FAILED"].includes(state.status)
    )
      return state;
    if (/humano|persona|asesor/i.test(text)) {
      answer(text);
      return state;
    }
    if (state.waiting_for === "customer_reply") {
      const node = flow().nodes.find((n) => n.id === state.waiting_node_id);
      if (node?.config.classifier === "education_grade") {
        const {valid,clarification,...selection}=classifyEducation(text,state.variables);Object.assign(state.variables,selection);
        if(!valid){state.history.push({role:"seller",text:clarification!,reason:"EDUCATION_CLARIFICATION"});return state;}
      } else if (node?.config.variable) state.variables[canonicalSalesVariable(node.config.variable)] = text;
      state.status = "RUNNING";
    } else if (state.waiting_for === "commitment") {
      const node = flow().nodes.find((n) => n.id === state.waiting_node_id);
      const phrases = node?.config.accepted_phrases ?? [
        "acepto",
        "me comprometo",
        "confirmo mi compromiso",
      ];
      if (acceptsAgreement(text, phrases, node?.config.classifier === "contextual_agreement")) {
        state.order.status = "COMMITTED";
        state.order.committed = true;
        deliver("commitment_accepted");
        state.stage = "COMMITTED";
        state.status = "RUNNING";
      } else {
        answer(text);
        return state;
      }
    } else {
      answer(text);
      if (state.status === "WAITING" && state.waiting_for === "ai")
        state.status = "RUNNING";
      else return state;
    }
  } else if (input?.type === "clock") {
    state.virtual_seconds += input.seconds;
    if (
      state.status === "WAITING" &&
      state.waiting_for === "timer" &&
      state.virtual_seconds >= (state.wake_at ?? Infinity)
    )
      state.status = "RUNNING";
    else return state;
  } else if (input?.type === "receipt") {
    if (["OPT_OUT", "HUMAN_REVIEW", "FAILED"].includes(state.status))
      return state;
    state.order.receipt_status = input.decision;
    if (input.decision === "APPROVED") {
      const first = !state.order.sale_definition;
      state.order.sale_definition = "receipt_sales_v1";
      state.order.status = "RECEIPT_APPROVED";
      state.order.sale_amount_minor =
        input.amount_minor ?? seller.offer.base_amount_minor;
      if (first) deliver("receipt_approved");
      if (state.status === "WAITING" && state.waiting_for === "timer") {
        const receipt = flow().nodes.find((n) => n.type === "receipt");
        if (receipt?.next) {
          state.next = receipt.next;
          state.waiting_for = "receipt_approved";
          delete state.wake_at;
        }
      }
    }
    if (
      state.status === "WAITING" &&
      state.waiting_for === "receipt_approved" &&
      input.decision === "APPROVED"
    )
      state.status = "RUNNING";
    else return state;
  } else if (input?.type === "approve") {
    if (state.status === "HUMAN_REVIEW") {
      if (state.review_resume) {
        state.status = state.review_resume.status;
        state.waiting_for = state.review_resume.waiting_for;
        delete state.review_resume;
        return state;
      }
      state.status = "RUNNING";
    } else return state;
  }
  if (state.status === "RUNNING" && state.waiting_for) {
    state.node_id = state.next ?? state.node_id;
    delete state.waiting_for;
    delete state.waiting_node_id;
    delete state.next;
    delete state.wake_at;
  }
  let wrote = false;
  for (let batch = 0; batch < 1000 && state.status === "RUNNING"; batch++) {
    if (++state.steps > (snapshot.flow.max_steps ?? 100)) {
      state.status = "FAILED";
      break;
    }
    const node = flow()?.nodes.find((n) => n.id === state.node_id);
    if (!node) {
      state.status = "FAILED";
      break;
    }
    let next = node.next;
    state.trace.push({
      node_id: node.id,
      workflow_id: state.workflow_id,
      type: node.type,
      reason: "DETERMINISTIC_GRAPH",
    });
    const wait = (reason: string) => {
      state.status = "WAITING";
      state.waiting_for = reason;
      state.waiting_node_id = node.id;
      state.next = next;
    };
    switch (node.type) {
      case "condition":
        next =
          node.branches?.[
            evaluateCondition(node.config, {
              ...state.variables,
              customer_text: state.history
                .filter((m) => m.role === "customer")
                .at(-1)?.text,
              conversation: { stage: state.stage },
              order: state.order,
            })
              ? "true"
              : "false"
          ];
        break;
      case "message":
        state.history.push({
          role: "seller",
          text: renderMessage(
            String(node.config.text ?? "[Material de prueba]"),
            {
              product_name: seller.offer.name,
              offer_name: seller.offer.name,
              price: (Number(seller.offer.base_amount_minor) / 100).toFixed(2),
              currency: seller.offer.currency,
            },
          ),
          reason: "FLOW_MESSAGE",
          sources: ["workflow:" + snapshot.workflow_id],
        });
        wrote = true;
        break;
      case "reply":
        wait("customer_reply");
        break;
      case "commitment":
        if (!state.order.committed) wait("commitment");
        break;
      case "receipt":
      case "reconcile":
        if (state.order.receipt_status !== "APPROVED") wait("receipt_approved");
        break;
      case "wait":
        wait("timer");
        state.wake_at = state.virtual_seconds + Number(node.config.seconds);
        break;
      case "ai":
        wait("ai");
        if (!wrote) {
          const text = state.history
            .filter((m) => m.role === "customer")
            .at(-1)?.text;
          if (text) {
            answer(text);
            if ((state.status as string) === "WAITING") {
              state.status = "RUNNING";
              delete state.waiting_for;
            }
          }
        }
        break;
      case "stage":
        state.stage = String(node.config.stage ?? "QUALIFIED");
        break;
      case "approval":
      case "handoff":
        state.status = "HUMAN_REVIEW";
        state.waiting_for = "human_approved";
        state.next = next;
        break;
      case "bank_instructions":
        state.history.push({
          role: "seller",
          text: "Instrucciones de cobro ficticias. No realizar transferencias.",
          reason: "SIMULATED_COLLECTION",
        });
        wrote = true;
        break;
      case "fulfillment":
      case "post_receipt": {
        const release = node.config.release_on ?? "receipt_approved";
        deliver(String(release));
        break;
      }
      case "subflow":
        if (
          state.stack.length >= 5 ||
          !snapshot.subflows[node.config.workflow_version_id]
        ) {
          state.status = "FAILED";
          break;
        }
        state.stack.push({ workflow_id: state.workflow_id, next });
        state.workflow_id = node.config.workflow_version_id;
        next = flow().entry_node_id;
        break;
      case "end": {
        const frame = state.stack.pop();
        if (frame) {
          state.workflow_id = frame.workflow_id;
          next = frame.next;
        } else state.status = "FINISHED";
        break;
      }
    }
    if (state.status === "RUNNING") {
      if (next) state.node_id = next;
      else state.status = "FINISHED";
    }
  }
  state.history = state.history.slice(-40);
  state.trace = state.trace.slice(-1000);
  return state;
}
