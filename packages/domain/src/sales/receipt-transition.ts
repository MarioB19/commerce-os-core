import {validateWorkflow,type FlowDefinition} from './workflow.js';
/** Proposals for NEW catalog versions only. Never edits a sealed version or runs a workflow. */
export function proposeReceiptTransition<T extends Record<string,any>>(kind:'offer'|'workflow',body:T):T{
 const proposed:Record<string,any>=structuredClone(body);delete proposed.status;
 if(kind==='offer')proposed.fulfillment=(proposed.fulfillment??[]).map((f:Record<string,any>)=>({...f,release_on:f.release_on==='reconciled'?'receipt_approved':f.release_on}));
 else{proposed.nodes=(proposed.nodes??[]).map((n:Record<string,any>)=>({...n,type:n.type==='reconcile'?'receipt':n.type,config:{...n.config,...(n.config?.release_on==='reconciled'?{release_on:'receipt_approved'}:{})}}));if(!validateWorkflow(proposed as unknown as FlowDefinition).valid)throw new Error('INVALID_TRANSITION_PROPOSAL');}
 return proposed as T;
}
