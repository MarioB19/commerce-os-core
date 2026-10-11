import type {Body} from '../../../contracts/src/index.js';
/** Receipt totals only. A tier selection or unknown payment never creates credit. */
export function creditedPaymentTier(offer:Body,currency:string,approvedTotal:number){
 if(!Number.isSafeInteger(approvedTotal)||approvedTotal<0)throw new Error('INVALID_APPROVED_TOTAL');
 if(offer.tier_policy==='mcl-receipt-total-v5'||offer.madrina?.enabled){
  if(currency!=='MXN'||offer.base_amount_minor!==9700)return {credited_tier:null,credited_tier_policy:'INVALID_CONFIGURATION',payment_extra_minor:0};
  return {credited_tier:approvedTotal>10700?'madrina':approvedTotal>=10700?'kit':approvedTotal>=9700?'acuerdo':null,credited_tier_policy:'mcl-receipt-total-v5',payment_extra_minor:Math.max(0,approvedTotal-10700),payment_extra_included_in_total:true};
 }
 const tiers=(offer.tiers??[]).filter((t:Body)=>Number.isSafeInteger(t.minimum_total_minor)&&approvedTotal>=t.minimum_total_minor).sort((a:Body,b:Body)=>b.minimum_total_minor-a.minimum_total_minor);
 const tier=approvedTotal>0?tiers[0]:undefined;
 return {credited_tier:tier?.id??null,credited_tier_policy:'offer-version',payment_extra_minor:tier?.included_extra_from_minor===undefined?0:Math.max(0,approvedTotal-tier.included_extra_from_minor),payment_extra_included_in_total:true};
}
