import type {SalesRouteCandidate} from '../../../contracts/src/sales-flow.js';

export type ProductAliasEvidence={product_id:string;aliases:string[]};
export type ProductAliasResolution=
 |{status:'MATCHED';reason:'EXPLICIT_ALIAS';product_id:string;evidence:ProductAliasEvidence[];normalized_text:string}
 |{status:'AMBIGUOUS';reason:'CONFLICTING_ALIASES';product_ids:string[];evidence:ProductAliasEvidence[];normalized_text:string}
 |{status:'NO_MATCH';reason:'GENERIC_OR_PAYMENT_SIGNAL'|'NO_EXPLICIT_ALIAS';evidence:[];normalized_text:string};

const reservedPhrases=new Set([
 'si','si lo quiero','lo quiero','quiero','acepto','acepto el acuerdo','de acuerdo','ok','okay','vale','va','adelante',
 'ya pague','pague','pago','pago realizado','transferencia','deposito','comprobante','envio comprobante','adjunto comprobante',
]);

export function normalizeProductRouteText(value:string):string{
 return value.normalize('NFKC').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}

export function isGenericProductSelectionSignal(value:string):boolean{
 const normalized=normalizeProductRouteText(value);
 if(!normalized)return false;
 if(reservedPhrases.has(normalized))return true;
 if(/^(?:ya\s+)?(?:pague|pago|deposite|transferi)(?:\s+(?:\d+(?:\s+\d+)?|el monto|lo acordado))?(?:\s+(?:mxn|pesos?))?$/.test(normalized))return true;
 if(/^(?:te\s+)?(?:envio|adjunto|mando)(?:\s+el|\s+mi)?\s+comprobante$/.test(normalized))return true;
 return /^(?:mxn\s*)?\d+(?:\s+\d+)?(?:\s*(?:mxn|pesos?))?$/.test(normalized);
}

function safeAlias(value:string):string|null{
 const normalized=normalizeProductRouteText(value);
 return normalized&&!isGenericProductSelectionSignal(normalized)&&/[\p{L}]/u.test(normalized)?normalized:null;
}

const clauseBoundaries=new Set(['|','pero','sino','aunque','salvo','excepto','y','o']);
const negationTokens=new Set(['no','ni','sin','nunca','jamas','tampoco','descarto','descartar','rechazo','rechazar','evito','evitar']);

function routingTokens(value:string):string[]{
 return value.normalize('NFKC').toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[,.!?;:\n\r]+/g,' | ').replace(/[^\p{L}\p{N}|]+/gu,' ').trim().replace(/\s+/g,' ').split(' ').filter(Boolean);
}

function occurrenceIsNegated(messageTokens:string[],start:number,length:number):boolean{
 let clauseStart=start;
 while(clauseStart>0&&!clauseBoundaries.has(messageTokens[clauseStart-1]!))clauseStart--;
 const before=messageTokens.slice(clauseStart,start);
 const negatedBefore=before.some((token,index)=>negationTokens.has(token)&&!(token==='no'&&['solo','solamente'].includes(before[index+1]??'')));
 const after=messageTokens.slice(start+length,start+length+2);
 return negatedBefore||['no','tampoco','menos'].includes(after[0]??'');
}

function containsWholePhrase(messageTokens:string[],phrase:string):boolean{
 const phraseTokens=phrase.split(' ');
 if(phraseTokens.length>messageTokens.length)return false;
 for(let start=0;start<=messageTokens.length-phraseTokens.length;start++){
  if(phraseTokens.every((token,index)=>messageTokens[start+index]===token)&&!occurrenceIsNegated(messageTokens,start,phraseTokens.length))return true;
 }
 return false;
}

/**
 * Matches only explicit product aliases belonging to the supplied assignments.
 * A generic acceptance, amount or payment claim remains unresolved by design.
 */
export function matchAssignedProductAliases(message:string,candidates:readonly SalesRouteCandidate[]):ProductAliasResolution{
 const normalizedText=normalizeProductRouteText(message);
 const messageTokens=routingTokens(message);
 const evidence:ProductAliasEvidence[]=[];
 for(const candidate of candidates){
  const matches=[...new Set(candidate.aliases.map(safeAlias).filter((alias):alias is string=>!!alias&&containsWholePhrase(messageTokens,alias)))];
  if(matches.length)evidence.push({product_id:candidate.product_id,aliases:matches.sort((a,b)=>b.length-a.length||a.localeCompare(b))});
 }
 if(evidence.length===1)return{status:'MATCHED',reason:'EXPLICIT_ALIAS',product_id:evidence[0]!.product_id,evidence,normalized_text:normalizedText};
 if(evidence.length>1)return{status:'AMBIGUOUS',reason:'CONFLICTING_ALIASES',product_ids:evidence.map(item=>item.product_id),evidence,normalized_text:normalizedText};
 return{status:'NO_MATCH',reason:isGenericProductSelectionSignal(message)?'GENERIC_OR_PAYMENT_SIGNAL':'NO_EXPLICIT_ALIAS',evidence:[],normalized_text:normalizedText};
}
