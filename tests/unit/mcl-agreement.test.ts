import {it,expect} from 'vitest';
import {acceptsAgreement} from '../../packages/domain/src/sales/agreement.js';
it.each(['Sí, acepto este acuerdo.','Acepto tu acuerdo','Me comprometo a pagar después de recibirlo y revisarlo.','Me comprometo a pagarte los $97 MXN después de revisar el material'])('accepts an explicit contextual commitment: %s',text=>expect(acceptsAgreement(text,['ACEPTO'],true)).toBe(true));
it.each(['sí','no acepto el acuerdo','¿acepto el acuerdo?','Acepto el acuerdo pero no voy a pagar','Me comprometo a pagar si puedo','ella dijo "acepto el acuerdo"','me interesa'])('requires clarification without an unambiguous commitment: %s',text=>expect(acceptsAgreement(text,['ACEPTO'],true)).toBe(false));
it('preserves legacy exact-phrase semantics',()=>{expect(acceptsAgreement('ACEPTO',['acepto'])).toBe(true);expect(acceptsAgreement('Acepto este acuerdo',['acepto'])).toBe(false);});
