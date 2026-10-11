import {it,expect} from 'vitest';
import {directAgreementWorkflow} from './direct-agreement.js';
import {acceptsAgreement} from './agreement.js';
import {contextualAgreementPhrases} from './sales-recipe-v2.js';
import {validateWorkflow} from './workflow.js';
const flow=directAgreementWorkflow(),phrases=flow.nodes.find(n=>n.type==='commitment')!.config.accepted_phrases;
it('explains the agreement once, then delivers Core and bank without questions or timers',()=>{
 expect(validateWorkflow(flow).valid).toBe(true);
 expect(flow.nodes.map(n=>n.type)).toEqual(['message','commitment','fulfillment','bank_instructions','receipt','message','fulfillment','end']);
 expect(flow.nodes.find(n=>n.id==='core')!.next).toBe('bank');
});
it.each(['Sí','SI!','Sí, acepto.','Acepto el acuerdo','de acuerdo','sí, mándamelo','Me comprometo a pagar después de recibir el material'])('accepts clear contextual agreement: %s',text=>expect(acceptsAgreement(text,phrases,true)).toBe(true));
it.each(['No','no acepto','¿sí?','sí, pero primero quiero ver','si funciona acepto','tal vez','puedo pagar después?','"acepto"','me dijo que sí','no, gracias'])('does not turn hesitation or questions into consent: %s',text=>expect(acceptsAgreement(text,phrases,true)).toBe(false));
it('preserves a legacy strict agreement and rejects a bare yes there',()=>expect(acceptsAgreement('sí',['acepto'],true)).toBe(false));
it.each(['Si envíalo','Sí, envíalo.','Ok dámelo','OK, dámelo!'])('recognizes an unambiguous request in the pinned sales recipe: %s',text=>expect(acceptsAgreement(text,[...contextualAgreementPhrases],true)).toBe(true));
it.each(['¿Sí, envíalo?','Sí, envíalo pero no voy a pagar','Ok dámelo si funciona','No, dámelo','Me dijo "ok dámelo"'])('keeps ambiguous requests out of the commitment: %s',text=>expect(acceptsAgreement(text,[...contextualAgreementPhrases],true)).toBe(false));
it('does not broaden strict or other contextual workflows',()=>{
 expect(acceptsAgreement('Si envíalo',[...contextualAgreementPhrases])).toBe(false);
 expect(acceptsAgreement('Ok dámelo',['acepto'],true)).toBe(false);
});
