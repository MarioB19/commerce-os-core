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
