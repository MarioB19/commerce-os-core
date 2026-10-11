import {describe,expect,it} from 'vitest';
import {schemas} from '../../packages/contracts/src/index.js';

const ids={campaign:'00000000-0000-4000-8000-000000000001',adSet:'00000000-0000-4000-8000-000000000002',account:'00000000-0000-4000-8000-000000000003',product:'00000000-0000-4000-8000-000000000004',offer:'00000000-0000-4000-8000-000000000005',workflow:'00000000-0000-4000-8000-000000000006'};
const attribution={method:'conversation_first_observed_v1',source:'meta',destination:'whatsapp',prefill_keyword:'MI CICLO LISTO'};

describe('paused WhatsApp acquisition records',()=>{
 it('accepts a complete campaign, ad set and ad with no scheduling or spend',()=>{
  const campaign=schemas.acquisition_campaign!.parse({name:'MCL_WA_MX_A01_480_ACUERDO_20260921',platform:'meta',source:'approved-local-master',evidence:'manifest:A01',status:'PAUSED',objective:'OUTCOME_ENGAGEMENT',destination:'WHATSAPP',account_id:ids.account,product_id:ids.product,offer_version_id:ids.offer,workflow_version_id:ids.workflow,attribution});
  const adSet=schemas.ad_set!.parse({name:'MCL_8571_MX_A01_DOCENTES',campaign_id:ids.campaign,source:'approved-local-master',evidence:'manifest:A01',status:'PAUSED',account_id:ids.account,product_id:ids.product,offer_version_id:ids.offer,workflow_version_id:ids.workflow,attribution});
  const ad=schemas.ad!.parse({name:'MCL_A01_h1_480_97_8571_v1',ad_set_id:ids.adSet,source:'approved-local-master',evidence:'manifest:A01-h1',status:'PAUSED',creative_ref:'masters/A01-h1.mp4',creative_sha256:'65c5c270a7d5e34a5da472576b6ddcd5e04eec336b2e11173d0e7c4cda4261c5',primary_text:'Texto completo del anuncio.',headline:'Elige qué trabajar esta semana',description:'$97 MXN · Acepta, recibe, revisa y después paga',call_to_action:'SEND_WHATSAPP_MESSAGE',prefilled_message:'MI CICLO LISTO'});
  expect(campaign).not.toHaveProperty('start_time');expect(campaign).not.toHaveProperty('spend_minor');expect(adSet.status).toBe('PAUSED');expect(ad.status).toBe('PAUSED');
 });
 it('rejects schedule fields and inconsistent attribution vocabulary',()=>{expect(schemas.acquisition_campaign!.safeParse({name:'Bad schedule',platform:'meta',source:'fixture',evidence:'fixture',status:'PAUSED',start_time:new Date().toISOString()}).success).toBe(false);expect(schemas.ad!.safeParse({name:'Bad CTA',ad_set_id:ids.adSet,source:'fixture',evidence:'fixture',call_to_action:'BUY_NOW'}).success).toBe(false);});
});
