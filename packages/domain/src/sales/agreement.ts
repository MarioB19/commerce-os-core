/** Called only while the pinned workflow is awaiting the explained agreement. */
export function acceptsAgreement(text:string,phrases:string[],contextual=false):boolean{
 const normalize=(value:string)=>value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[.!\s]+$/g,'').replace(/\s+/g,' ');
 const plain=normalize(text);if(phrases.some(p=>normalize(p)===plain))return true;
 if(!contextual)return false;
 const value=plain.normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 // A question, conditional promise, quotation, refusal or uncertainty needs
 // clarification. Recognize a small set of explicit commitments, not sentiment.
 if(/[?¿“”"«»]/.test(value)||/\b(no|pero|tal vez|quizas|puedo|pueda|podria|si pudiera|depende)\b/.test(value))return false;
 // Existing pinned sales recipes already accept "sí, envíamelo". The two
 // equivalent requests below should only count for that same recipe while
 // its explained commitment node is waiting, never for a stricter flow.
 if(phrases.some(p=>normalize(p)==='si, enviamelo')&&/^(?:si[,!\s]+envialo|ok[,!\s]+damelo)$/.test(value))return true;
 return /^(?:si[,!\s]+)?acepto (?:el|este|tu) acuerdo[.!\s]*$/.test(value)||/^(?:si[,!\s]+)?me comprometo a pagar(?:te)? (?:los \$?97(?:\s*mxn)? )?despues de (?:recibir(?:lo| el material| core)?(?: y revisar(?:lo)?)?|revisar(?:lo| el material| core)?)[.!\s]*$/.test(value);
}

export type ContextualAgreementDecision='ACCEPTED'|'DECLINED'|'QUESTION'|'CONDITIONAL'|'PAYMENT_CLAIM'|'UNRESOLVED'|'NOT_APPLICABLE';

/** Deterministic proposal used only while the version-pinned agreement is pending. */
export function classifyContextualAgreement(text:string,agreementPending:boolean):ContextualAgreementDecision{
 if(!agreementPending)return'NOT_APPLICABLE';
 const raw=text.trim();
 const value=raw.toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}$]+/gu,' ').trim().replace(/\s+/g,' ');
 if(!value)return'UNRESOLVED';
 if(/[?¿]/.test(raw))return'QUESTION';
 if(/["“”«»]/.test(raw))return'UNRESOLVED';
 if(/\b(?:ya\s+)?(?:pague|pago|deposite|transferi)\b|\bcomprobante\b/.test(value))return'PAYMENT_CLAIM';
 if(/^(?:no|nop|nunca|no gracias|gracias no)\b|\bno (?:acepto|quiero|me interesa)\b/.test(value))return'DECLINED';
 if(/\b(?:pero|tal vez|quizas|depende|primero|si funciona|si puedo|si me gusta)\b/.test(value))return'CONDITIONAL';
 if(new Set(['si','si lo quiero','lo quiero','acepto','acepto el acuerdo','de acuerdo','estoy de acuerdo','ok','okay','vale','va','adelante','si enviamelo','si mandamelo']).has(value))return'ACCEPTED';
 return'UNRESOLVED';
}

/**
 * V7.5.3 (F1, owner decision «opción 2», 13-nov-2026). While a version-pinned
 * contextual agreement is pending, the seller model may *propose* that the
 * customer accepted. The deterministic rule below decides whether that
 * proposal may change state. It never turns an arbitrary answer into
 * authority: the reply must be a short affirmative in the variant's language,
 * with no question, negation, condition, payment claim or other topic.
 */
export type AgreementReplyScreen='AFFIRMATIVE'|'NEGATIVE'|'QUESTION'|'CONDITIONAL'|'PAYMENT_CLAIM'|'OTHER';
const affirmativeMarkers=new Set(['si','sip','sii','siii','claro','ok','okay','okey','oki','va','vale','dale','sale','orale','adelante','listo','perfecto','acepto','aceptado','aceptada','quiero','hagamoslo','comprometo']);
const affirmativeVocabulary=new Set([...affirmativeMarkers,'de','acuerdo','estoy','trato','hecho','el','este','tu','lo','la','me','mi','el','mandamelo','mandalo','enviamelo','envialo','mandame','enviame','material','paquete','por','favor','porfa','porfavor','gracias','muchas','bueno','bien','super','genial','excelente','con','gusto','seguro','segura','asi','es','y','ya','entonces','a','pagar','pagarte','despues','recibir','recibirlo','revisar','revisarlo','cumplir','parte','palabra','cuenta','conmigo','hacemos','que','yo','pago','te','mucho','muy','cumplo','eso']);
const affirmativeEmoji=/[\u{1F44D}\u{1F44C}\u{2705}\u{1F64C}\u{1F49B}\u{2764}\u{1F60A}\u{263A}\u{1F642}\u{1F64F}\u{1F970}\u{1F60D}\u{2728}\u{1F917}]/u;
export function screenAgreementReply(text:string,language='es'):AgreementReplyScreen{
 const raw=String(text??'').trim();
 if(!raw||raw.length>160)return'OTHER';
 if(/[?¿]/.test(raw))return'QUESTION';
 if(/["“”«»]/.test(raw))return'OTHER';
 if(!/^es\b|^es-/.test(language.toLowerCase())&&language.toLowerCase()!=='es')return'OTHER';
 const value=raw.toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g,'');
 const words=value.replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(Boolean);
 const joined=' '+words.join(' ')+' ';
 if(/ (?:ya )?(?:pague|deposite|transferi|comprobante|ticket|recibo) /.test(joined)||/ ya (?:te )?(?:pague|deposite|transferi) /.test(joined))return'PAYMENT_CLAIM';
 if(/ (?:no|nop|nel|nunca|tampoco|jamas|ni) /.test(joined))return'NEGATIVE';
 if(/ (?:pero|aunque|tal vez|quizas?|a lo mejor|depende|primero|luego|manana|mas tarde|lo pienso|lo pensare|dejame|deja|si (?:me gusta|me sirve|me convence|me alcanza|puedo|funciona|tengo|quieres|lo reviso|lo veo|me agrada)|cuando|hasta) /.test(joined))return'CONDITIONAL';
 const emojiOnly=!words.length&&affirmativeEmoji.test(raw);
 if(emojiOnly)return'AFFIRMATIVE';
 if(!words.length)return'OTHER';
 if(words.some(w=>!affirmativeVocabulary.has(w.replace(/(.)\1{2,}/g,'$1$1'))))return'OTHER';
 if(!words.some(w=>affirmativeMarkers.has(w.replace(/(.)\1{2,}/g,'$1$1'))||/^si+$/.test(w))&&!/ de acuerdo | trato hecho | cuenta conmigo /.test(joined))return'OTHER';
 return'AFFIRMATIVE';
}

/** Claims a seller reply may only make with persisted evidence. Before the
 * agreement is committed none of them is true. */
export function unverifiedAgreementClaim(reply:string):string|undefined{
 const value=String(reply??'').toLocaleLowerCase('es').normalize('NFD').replace(/[̀-ͯ]/g,'');
 if(/(?:acuerdo|compromiso|pedido|compra)\s+(?:ya\s+)?(?:qued[oa]\s+|esta\s+|fue\s+)?(?:registrad|confirmad|aceptad|activad)/.test(value)||/(?:ya\s+)?(?:qued[oa]|esta)\s+registrad/.test(value)||/registr[eo]\s+(?:tu|el|su)\s+(?:acuerdo|compromiso)/.test(value))return'AGREEMENT_REGISTERED_CLAIM';
 if(/(?:ya\s+)?(?:te\s+|le\s+)?(?:envie|mande|comparti|entregue)\s+(?:tu|el|los|las|su|todo)/.test(value)||/(?:te|le)\s+(?:envio|mando|llega|llegan|comparto|entrego)\s+(?:ahorita|ahora|enseguida|en\s+(?:un|unos)\s+(?:momento|minutos)|ya|de\s+inmediato|tu|el|los|las|todo)/.test(value)||/(?:sistema|flujo)\s+te\s+(?:envia|manda|entrega)/.test(value)||/(?:material|paquete|archivos?|acceso|codigo)\s+(?:ya\s+)?(?:va|van|esta|estan)\s+en\s+camino/.test(value))return'DELIVERY_CLAIM';
 if(/acceso\s+(?:ya\s+)?(?:esta\s+|quedo\s+)?(?:habilitad|activad|listo)/.test(value))return'ACCESS_CLAIM';
 if(/(?:pago|comprobante|transferencia)\s+(?:ya\s+)?(?:esta\s+|quedo\s+|fue\s+)?(?:aprobad|confirmad|validad|acreditad)/.test(value))return'PAYMENT_CLAIM';
 return;
}

export type AgreementProposalDecision={decision:'ACCEPT'|'CLARIFY'|'PASS';reason:string};
/** Two keys: the model's schema-valid, confident proposal and this rule. */
export function decideAgreementProposal(input:{
 intent:string;confidence:number;tool:string;reply:string;customerText:string;language:string;
 contextual:boolean;agreementDelivered:boolean;orderCommitted:boolean;controlsClear:boolean;
}):AgreementProposalDecision{
 if(input.orderCommitted)return{decision:'PASS',reason:'AGREEMENT_ALREADY_COMMITTED'};
 if(!input.controlsClear)return{decision:'PASS',reason:'CONTROLS_BLOCKED'};
 if(['opt_out','human_handoff'].includes(input.intent)||input.tool==='request_human')return{decision:'PASS',reason:'HANDOFF_OR_OPT_OUT'};
 const screen=screenAgreementReply(input.customerText,input.language);
 const claim=unverifiedAgreementClaim(input.reply);
 if(input.intent==='commitment'){
  if(!input.agreementDelivered)return{decision:'PASS',reason:'AGREEMENT_NOT_DELIVERED'};
  if(!input.contextual)return{decision:'CLARIFY',reason:'LITERAL_PHRASE_REQUIRED'};
  if(!(input.confidence>=0.85))return{decision:'CLARIFY',reason:'LOW_CONFIDENCE'};
  if(input.tool!=='none')return{decision:'CLARIFY',reason:'TOOL_NOT_ALLOWED'};
  if(screen!=='AFFIRMATIVE')return{decision:'CLARIFY',reason:'REPLY_'+screen};
  return{decision:'ACCEPT',reason:'AI_PROPOSAL_RULE_CONFIRMED'};
 }
 if(claim&&input.agreementDelivered)return{decision:'CLARIFY',reason:claim};
 return{decision:'PASS',reason:'NOT_AN_AGREEMENT_PROPOSAL'};
}

/** Deterministic text when the rule cannot confirm the agreement. It never
 * says the agreement was registered or that anything was sent. */
export function agreementClarification(language:unknown,literalPhrase?:string){
 const family=String(language??'es').toLowerCase().split('-')[0];
 if(literalPhrase){
  if(family==='pt')return`Para continuar, preciso da sua confirmação com a frase «${literalPhrase}».`;
  if(family==='en')return`To continue, I need your confirmation with the phrase “${literalPhrase}”.`;
  return`Para continuar necesito tu confirmación con la frase «${literalPhrase}».`;
 }
 if(family==='pt')return'Antes de continuar, preciso confirmar: você aceita o acordo que expliquei?';
 if(family==='en')return'Before we continue, I need to confirm: do you accept the agreement I explained?';
 return'Antes de continuar necesito confirmarlo contigo: ¿aceptas el acuerdo que te expliqué? 💛';
}
