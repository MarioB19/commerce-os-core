import type {Body} from '../../../contracts/src/index.js';
import type {AgentProposal} from './ai.js';
import {proposalGroundingIssue, type SellerContext, type SellerSource} from './seller-context.js';

/** A customer statement, a commitment and an unreviewed receipt carry no payment authority. */
export function paymentVerifiedForSeller(order?: Body): boolean {
  if (order?.sale_definition === 'receipt_sales_v1' || order?.sale_status !== undefined) {
    return order?.sale_status === 'RECOGNIZED' && Number(order.sale_amount_minor) > 0;
  }
  return order?.receipt_status === 'APPROVED';
}

const normalized = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function priceObjection(text: string) {
  if (/\b(no (?:esta|es|parece) (?:tan |muy )?car[oa]|not (?:too )?expensive)\b/.test(text)) return false;
  const expensive = /^(?:(?:muy|demasiado|que) )?car[oa]s?$|\b(?:esta[n]?|es|son|parece[n]?|resulta[n]?|se me hace[n]?|que) (?:muy |bastante |demasiado |tan |un poco )?(?:car[oa]s?|costos[oa]s?)\b/;
  return expensive.test(text) || /\b(carisim[oa]s?|precio (?:muy |demasiado )?(?:alt[oa]|elevado)|fuera de (?:mi )?presupuesto|se (?:me )?sale de (?:mi )?presupuesto|no me alcanza|no (?:me )?puedo permitir(?:lo|melo)?|no puedo pagar (?:tanto|ese precio|esa cantidad)|(?:mucho|demasiado) dinero|expensive|too (?:much|pricey)|out of (?:my )?budget|cannot afford|can t afford|fora do (?:meu )?orcamento|muito dinheiro)\b/.test(text);
}

function paymentConcern(text: string): 'price' | 'timing' | undefined {
  const price = priceObjection(text);
  const timing = /\b(?:no (?:te )?puedo pagar(?:lo|te)? (?:hoy|ahora|ahorita)|pagar(?:lo|te)? (?:manana|mas tarde|despues|el (?:lunes|martes|miercoles|jueves|viernes|sabado|domingo))|(?:hasta que|cuando) (?:me paguen|cobre)|pay (?:later|tomorrow|on payday)|(?:can t|cannot) pay (?:now|today)|(?:nao (?:posso|consigo) pagar (?:hoje|agora)|pagar (?:amanha|depois)))\b/.test(text);
  if (price === timing) return;
  return price ? 'price' : 'timing';
}

function approvedAnswer(source: SellerSource) {
  // Compiled seller FAQs store the published question and answer on separate lines.
  const prefix = source.title + '\n';
  return (source.content.startsWith(prefix) ? source.content.slice(prefix.length) : source.content).trim();
}

function matchedFaq(context: SellerContext): SellerSource | undefined {
  if (context.conflicts.length) return;
  const text = normalized(context.customer_text);
  const sources = context.sources.filter(s => s.topic === 'faq' || s.topic === 'objection');
  const exact = sources.filter(s => normalized(s.title) === text);
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const concern = paymentConcern(text);
  if (!concern) return;
  const matching = sources.filter(s => paymentConcern(normalized(s.title)) === concern);
  if (matching.length === 1) return matching[0];
}

const clarification = {
  es: {
    offer: '¿Qué te gustaría aclarar sobre la oferta o el acuerdo antes de decidir?',
    material: '¿Qué parte del material o de la entrega te gustaría que te explique?',
    payment: '¿Tu duda es sobre cómo hacer el pago o cómo compartir tu comprobante?',
    receipt: '¿Qué te gustaría aclarar mientras se revisa tu comprobante?',
    general: '¿Me cuentas un poco más? Puedo orientarte sobre lo que incluye la oferta o cómo continuar.',
  },
  en: {
    offer: 'What would you like to clarify about the offer or the agreement before you decide?',
    material: 'What would you like to know about the materials or their delivery?',
    payment: 'Would you like help making the payment or sharing your receipt?',
    receipt: 'What would you like to clarify while your receipt is being reviewed?',
    general: 'Could you tell me a little more? I can explain the offer or how to continue.',
  },
  pt: {
    offer: 'O que você gostaria de esclarecer sobre a oferta ou o acordo antes de decidir?',
    material: 'Qual é a sua dúvida sobre o material ou a entrega?',
    payment: 'Sua dúvida é sobre como pagar ou como enviar o comprovante?',
    receipt: 'O que você gostaria de esclarecer enquanto o comprovante é analisado?',
    general: 'Pode me contar um pouco mais? Posso explicar a oferta ou como continuar.',
  },
};

export type BeforePaymentReply = {proposal: AgentProposal; reason: 'APPROVED_FAQ' | 'PREPAYMENT_CLARIFICATION'};

/** Choose a published answer or a fact-free clarification. A valid model answer stays in the normal seller path. */
export function beforePaymentReply(context: SellerContext, proposed: AgentProposal | undefined,
  options: {waitingFor?: string; language?: string}): BeforePaymentReply | undefined {
  if (paymentVerifiedForSeller(context.order) || proposed?.intent === 'opt_out') return;
  const source = matchedFaq(context);
  if (source) {
    const reply = approvedAnswer(source);
    const proposal: AgentProposal = {reply, intent: 'question', confidence: 1, tool: 'none', grounding: [source.id]};
    if (reply && !proposalGroundingIssue(proposal, context)) return {proposal, reason: 'APPROVED_FAQ'};
  }
  // The seller cannot instruct a transfer to a new destination or promise an unavailable handoff.
  const unsafeReply = proposed && /(?:te (?:paso|comunico|transfiero|derivo|canalizo) (?:a|con)|(?:te|tu caso) (?:pasar[aá]|ser[aá] (?:revisado|atendido)) por|transfer(?:ring)? you to|escalat(?:e|ing) (?:this|your)|encaminh(?:ar|ando) (?:voc[eê]|seu caso)|https?:\/\/|\b[0-9][0-9 -]{6,32}[0-9]\b)/i.test(proposed.reply);
  if (proposed && !unsafeReply && proposed.reply.trim() && proposed.intent !== 'unknown' && proposed.intent !== 'human_handoff' &&
      proposed.tool !== 'request_human' && proposed.confidence >= 0.8 && !proposalGroundingIssue(proposed, context)) return;
  const locale = options.language?.toLowerCase().split(/[-_]/)[0];
  const copy = clarification[locale === 'en' || locale === 'pt' ? locale : 'es'];
  let reply = copy.general;
  if (['RECEIVED','PENDING','HUMAN_REVIEW','ANALYZING'].includes(context.order.receipt_status)) reply = copy.receipt;
  else if (options.waitingFor === 'commitment') reply = copy.offer;
  else if (options.waitingFor === 'prepayment_delivery_confirmed') reply = copy.material;
  else if (options.waitingFor === 'receipt_approved' || options.waitingFor === 'reconciled') reply = copy.payment;
  return {reason: 'PREPAYMENT_CLARIFICATION', proposal: {reply, intent: 'question', confidence: 1, tool: 'none', grounding: []}};
}
