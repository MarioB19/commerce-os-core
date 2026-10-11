import {expect,it} from 'vitest';
import {creditedPaymentTier} from './payment-tier.js';
const mcl={base_amount_minor:9700,madrina:{enabled:true},tier_policy:'mcl-receipt-total-v5'};
it.each([[0,null,0],[9600,null,0],[9700,'acuerdo',0],[10700,'kit',0],[10701,'madrina',1],[19400,'madrina',8700],[99900,'madrina',89200]])('credits total %s once as tier %s', (amount,tier,extra)=>{expect(creditedPaymentTier(mcl,'MXN',Number(amount))).toMatchObject({credited_tier:tier,payment_extra_minor:extra,payment_extra_included_in_total:true});});
it('does not apply MCL rules to another offer or wrong currency',()=>{expect(creditedPaymentTier({base_amount_minor:9700},'MXN',19400).credited_tier).toBeNull();expect(creditedPaymentTier(mcl,'USD',19400).credited_tier).toBeNull();expect(creditedPaymentTier({tiers:[{id:'standard',minimum_total_minor:12000}]},'USD',12000).credited_tier).toBe('standard');});
