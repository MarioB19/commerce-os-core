import type {ProviderAdapter} from './client.js';
import {requireAi,type Input,type Model,type Scope} from './contracts.js';
import {request,requestIdentity} from './protocol.js';
export function credentialVerificationInput():Input{return {capability:'chat',instructions:'Return exactly OK. Do not call tools.',text:'OK'};}
export function credentialVerificationIdentity(model:Model){requireAi(model.capabilities.includes('chat'),'CAPABILITY');const input=credentialVerificationInput();return requestIdentity(model,input,request(model,input).bytes);}

/** Explicit caller action; fixed minimal content, original operation UUID and
 * existing business budgets. No automatic retry or alternative credential. */
export function invokeCredentialVerification(adapter:ProviderAdapter,scope:Scope,model:Model,budgetMicrousd:number,timeoutMs=15000){
 requireAi(scope.task==='credential.verify'&&scope.variantId==='credential-verification'&&scope.conversationId===undefined,'AUTHORITY');
 return adapter.invoke({scope,model,input:credentialVerificationInput(),budgetMicrousd,timeoutMs,parse:text=>{requireAi(text.trim()==='OK','OUTPUT_REJECTED');return 'OK' as const;}});
}
