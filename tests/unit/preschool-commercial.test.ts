import {expect,it} from 'vitest';
import {canonicalSalesVariables} from '../../packages/domain/src/sales/variables.js';
import {evaluateCondition,waitingCommitmentNode,type FlowState} from '../../packages/domain/src/sales/workflow.js';
import {newEvaluation,runEvaluation} from '../../packages/domain/src/sales/flow-evaluation.js';
import {composeSellerContext,deterministicSellerReply,proposalGroundingIssue} from '../../packages/domain/src/sales/seller-context.js';
import {summarizeDelivery} from '../../packages/domain/src/sales/delivery-status.js';
import {preschoolCorpus,preschoolEvaluation,preschoolSeller} from '../fixtures/preschool-commercial.js';

it('canonicalizes published aliases consistently in seller, evaluator and legacy conditions',()=>{
 const variables={grade:'primero',grado:'segundo',interest:'me interesa',private_code:'protected'};
 expect(canonicalSalesVariables(variables)).toMatchObject({grado:'segundo',interes:'me interesa'});
 expect(composeSellerContext(preschoolSeller,{text:'Hola',variables}).variables).toEqual({grado:'segundo',interes:'me interesa'});
 for(const field of ['grade','grado'])expect(evaluateCondition({field,operator:'equals',value:'segundo'},variables)).toBe(true);
 const legacy=structuredClone(preschoolEvaluation);legacy.flow.nodes.find(n=>n.id==='grade')!.config.variable='grade';
 let state=newEvaluation(legacy);state=runEvaluation(legacy,state,{type:'reply',text:'tercero'});
 expect(state.variables).toEqual({grado:'tercero'});
 state=runEvaluation(legacy,state,{type:'reply',text:'quiero saber más'});
 expect(state.variables).toEqual({grado:'tercero',interes:'quiero saber más'});
 expect(state.waiting_for).toBe('commitment');expect(state.deliveries).toEqual([]);
});
it.each(preschoolCorpus)('grounds approved corpus: $text',({text,reason,source})=>{
 const context=composeSellerContext(preschoolSeller,{text});const result=deterministicSellerReply(context);
 expect(result.reason).toBe(reason);expect(result.proposal.grounding).toEqual(source?[source]:[]);
 expect(proposalGroundingIssue(result.proposal,context)).toBeUndefined();
 if(!source)expect(result.proposal.tool).toBe('request_human');
});
it('matches only active commitment configuration, conservatively resolves legacy state',()=>{
 const flow={name:'Branched',entry_node_id:'first',nodes:[{id:'first',type:'commitment',config:{accepted_phrases:['acepto primero']},next:'a'},{id:'second',type:'commitment',config:{accepted_phrases:['acepto segundo']},next:'b'}]};
 const state:FlowState={node_id:'b',steps:3,stack:[],variables:{},status:'WAITING',waiting_for:'commitment',waiting_node_id:'second'};
 expect(waitingCommitmentNode(flow,state)?.id).toBe('second');delete state.waiting_node_id;expect(waitingCommitmentNode(flow,state)?.id).toBe('second');
 flow.nodes[0]!.next='b';expect(waitingCommitmentNode(flow,state)).toBeUndefined();
});
it.each([1,9600,9700,10699,10700,10701])('releases calendar for positive receipt and Kit at total threshold %i',amount_minor=>{
 let state=newEvaluation(preschoolEvaluation);
 for(const text of ['segundo','quiero saber más','SÍ, QUIERO MI CICLO LISTO'])state=runEvaluation(preschoolEvaluation,state,{type:'reply',text});
 expect(state.deliveries).toEqual(['core:commitment_accepted']);
 state=runEvaluation(preschoolEvaluation,state,{type:'receipt',decision:'APPROVED',amount_minor});
 expect(state.deliveries).toEqual(['core:commitment_accepted','calendar:receipt_approved',...(amount_minor>=10700?['kit:receipt_approved']:[])]);
});
it.each([
 [[], 'PENDING'],[['PROPOSED','READY'],'PENDING'],[['SENT','SENT'],'SENT'],[['DELIVERED','SENT'],'SENT'],
 [['DELIVERED','READ'],'DELIVERED'],[['READ','READ'],'READ'],[['SENT','FAILED'],'PARTIAL'],[['FAILED','CANCELLED'],'FAILED'],[['READ','UNKNOWN'],'UNKNOWN'],
] as Array<[string[],string]>)('summarizes provider notification facts %j as %s',(statuses,expected)=>expect(summarizeDelivery(statuses)).toBe(expected));
