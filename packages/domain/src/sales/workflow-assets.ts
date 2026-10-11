import type {Body} from '../../../contracts/src/index.js';
/** Direct messages and conditioned follow-ups share the same material readiness gate. */
export function workflowAssetIds(workflow:Body):string[]{
 return [...new Set<string>((workflow.nodes??[]).flatMap((n:Body)=>[n.config?.asset_id,...(n.config?.followups?.touches??[]).map((t:Body)=>t.asset_id)]).filter((value:unknown):value is string=>typeof value==='string'&&!!value))];
}

/** Assets embedded in a versioned offer's three-slot sales-flow policy. */
export function offerSalesFlowAssetIds(offer:Body):string[]{
 const content=offer.sales_flow?.content;
 return [...new Set<string>([
  content?.presentation?.audio_asset_id,
  content?.presentation?.pack_image_asset_id,
  content?.agreement?.audio_asset_id,
  content?.collection?.audio_asset_id,
  ...(offer.sales_flow?.remarketing?.slots??[]).flatMap((slot:Body)=>[
  slot.stages?.awaiting_agreement?.asset_id,
  slot.stages?.awaiting_payment?.asset_id,
  ]),
 ].filter((value:unknown):value is string=>typeof value==='string'&&!!value))];
}
