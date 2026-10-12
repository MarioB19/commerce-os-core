import {describe,it,expect} from 'vitest';
import {receiptDocumentEvidence} from './receipt-extraction.js';
const legacy={is_receipt:true,amount_minor:10000,currency:'MXN',destination_suffix:'6789',bank:'Synthetic',reference:'REF-1',status:'completed',confidence:0.87659,contradictions:[]};
describe('closed documentary extraction for policy023',()=>{
 it('does not mistake a suffix for a complete destination',()=>{expect(receiptDocumentEvidence(legacy,false).evidence.destination).toBeNull();expect(receiptDocumentEvidence(legacy,true).evidence.destination).toBe('6789');});
 it('keeps absent enriched observations unknown and rounds confidence down',()=>{expect(receiptDocumentEvidence(legacy,false).evidence).toMatchObject({beneficiary:null,paidAt:null,paidOn:null,concept:null,confidenceBps:8765});});
 it('extracts richer evidence but excludes it from the legacy public projection',()=>{const raw={...legacy,destination:'123456789',beneficiary:'Synthetic holder',paid_on:'2026-10-12',concept:'Synthetic concept'},v=receiptDocumentEvidence(raw,false);expect(v.evidence).toMatchObject({destination:raw.destination,beneficiary:raw.beneficiary,paidOn:raw.paid_on,concept:raw.concept});expect(v.legacy).toEqual(legacy);expect(v.document).toEqual(raw);});
 it.each([{...legacy,approved:true},{...legacy,confidence:NaN},{...legacy,currency:'mxn'},{...legacy,amount_minor:100.5},{...legacy,paid_on:'2026-02-30'},{...legacy,paid_at:'2026-10-12T01:00:00Z',paid_on:'2026-10-12'},{...legacy,reference:'a'.repeat(501)}])('rejects malformed or authority-bearing data',raw=>{expect(()=>receiptDocumentEvidence(raw,false)).toThrow();});
});
