import {salesFlowConfigurationSchema,type Body} from '../../../contracts/src/index.js';
import {validateWorkflow,type FlowDefinition} from './workflow.js';
import {SALES_AGREEMENT_RECIPE_ID,SALES_AGREEMENT_RECIPE_REVISION,salesAgreementRecipeV1} from './sales-recipe-v2.js';

function assertSupportedTopology(flow:FlowDefinition,recipe:ReturnType<typeof salesAgreementRecipeV1>):void{
 if(flow.recipe_id!==SALES_AGREEMENT_RECIPE_ID||flow.recipe_revision!==SALES_AGREEMENT_RECIPE_REVISION||recipe.recipe_id!==SALES_AGREEMENT_RECIPE_ID||recipe.recipe_revision!==SALES_AGREEMENT_RECIPE_REVISION)throw new Error('SALES_FLOW_RECIPE_MISMATCH');
 const canonical=salesAgreementRecipeV1();
 if(recipe.steps.some((step,index)=>JSON.stringify(step)!==JSON.stringify(canonical.steps[index])))throw new Error('SALES_FLOW_RECIPE_MISMATCH');
 const recipeNodes=flow.nodes.filter(node=>Number.isInteger(node.config.recipe_step));
 if(recipeNodes.length!==10||new Set(recipeNodes.map(node=>Number(node.config.recipe_step))).size!==10||flow.nodes.length!==13)throw new Error('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
 const byStep=new Map(recipeNodes.map(node=>[Number(node.config.recipe_step),node]));
 const expectedTypes=['message','message','message','message','message','fulfillment','message','bank_instructions','message','fulfillment'];
 for(const step of canonical.steps){const node=byStep.get(step.order);if(!node||node.id!==step.id||node.type!==expectedTypes[step.order-1]||node.config.recipe_id!==SALES_AGREEMENT_RECIPE_ID||node.config.recipe_revision!==SALES_AGREEMENT_RECIPE_REVISION)throw new Error('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');}
 const commitment=flow.nodes.find(node=>node.id==='commitment'),receipt=flow.nodes.find(node=>node.id==='receipt'),end=flow.nodes.find(node=>node.id==='end');
 const chain=['presentation_audio','pack_image','offer_text','agreement_audio','agreement_prompt'];
 if(flow.entry_node_id!==chain[0]||chain.slice(0,-1).some((id,index)=>flow.nodes.find(node=>node.id===id)?.next!==chain[index+1]))throw new Error('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
 if(flow.nodes.find(node=>node.id==='agreement_prompt')?.next!=='commitment'||commitment?.type!=='commitment'||commitment.config.classifier!=='contextual_agreement'||commitment.next!=='prepayment_fulfillment')throw new Error('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
 if(flow.nodes.find(node=>node.id==='prepayment_fulfillment')?.config.release_on!=='commitment_accepted'||flow.nodes.find(node=>node.id==='prepayment_fulfillment')?.next!=='collection_audio'||flow.nodes.find(node=>node.id==='collection_audio')?.next!=='payment_instructions')throw new Error('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
 if(flow.nodes.find(node=>node.id==='payment_instructions')?.next!=='receipt'||receipt?.type!=='receipt'||receipt.next!=='receipt_thanks'||flow.nodes.find(node=>node.id==='receipt_thanks')?.next!=='postpayment_fulfillment')throw new Error('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
 if(flow.nodes.find(node=>node.id==='postpayment_fulfillment')?.config.release_on!=='receipt_approved'||flow.nodes.find(node=>node.id==='postpayment_fulfillment')?.next!=='end'||end?.type!=='end'||end.next)throw new Error('SALES_FLOW_RECIPE_TOPOLOGY_MISMATCH');
}

/**
 * Applies the guided offer snapshot to the matching immutable recipe. The
 * topology and gates remain owned by the published workflow; only the media
 * and copy explicitly versioned in the offer are overlaid.
 */
export function applyOfferSalesFlowContent(flow:FlowDefinition,offer:Body):FlowDefinition{
 const configured=salesFlowConfigurationSchema.safeParse(offer.sales_flow);
 if(!configured.success)return flow;
 const salesFlow=configured.data;
 const content=salesFlow.content;if(!content)return flow;
 if(flow.recipe_id!==salesFlow.recipe.recipe_id||flow.recipe_revision!==salesFlow.recipe.recipe_revision)throw new Error('SALES_FLOW_RECIPE_MISMATCH');
 assertSupportedTopology(flow,salesFlow.recipe);
 const next=structuredClone(flow),byStep=new Map(next.nodes.filter(node=>Number.isInteger(node.config.recipe_step)).map(node=>[Number(node.config.recipe_step),node]));
 for(const step of [1,2,3,4,5,7,8,9])if(!byStep.has(step))throw new Error(`SALES_FLOW_RECIPE_STEP_MISSING_${step}`);
 Object.assign(byStep.get(1)!.config,{kind:'audio',asset_id:content.presentation.audio_asset_id,content_source:'offer_sales_flow_v1'});
 Object.assign(byStep.get(2)!.config,{kind:'image',asset_id:content.presentation.pack_image_asset_id,content_source:'offer_sales_flow_v1'});
 Object.assign(byStep.get(3)!.config,{text:content.presentation.offer_text,content_source:'offer_sales_flow_v1'});
 Object.assign(byStep.get(4)!.config,{kind:'audio',asset_id:content.agreement.audio_asset_id,content_source:'offer_sales_flow_v1'});
 Object.assign(byStep.get(5)!.config,{text:content.agreement.prompt,remarketing_anchor:'awaiting_agreement',content_source:'offer_sales_flow_v1'});
 Object.assign(byStep.get(7)!.config,{kind:'audio',asset_id:content.collection.audio_asset_id,purpose:'collection',content_source:'offer_sales_flow_v1'});
 const payment=content.collection.payment_instructions.includes('{{bank_instructions}}')?content.collection.payment_instructions:`${content.collection.payment_instructions}\n\n{{bank_instructions}}`;
 Object.assign(byStep.get(8)!.config,{text:payment,remarketing_anchor:'awaiting_payment',content_source:'offer_sales_flow_v1'});
 Object.assign(byStep.get(9)!.config,{text:content.closure.receipt_thanks,content_source:'offer_sales_flow_v1'});
 const validation=validateWorkflow(next);if(!validation.valid)throw new Error('SALES_FLOW_CONTENT_INVALID_WORKFLOW');
 return next;
}
