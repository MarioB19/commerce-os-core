import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {receiptPolicyId,receiptPolicyQuery,receiptProfilePolicyWrite,receiptVariantPolicyWrite} from '../../../packages/contracts/src/receipt-policy-store.js';
import {readReceiptPolicy,writeReceiptPolicy,effectiveReceiptPolicy,readReceiptPolicyOperation} from '../../../packages/db/src/receipt-policies.js';
const params=z.object({id:receiptPolicyId}).strict();
/** Prepared plugin. Profile authority owns the complete SQL-only transaction. */
export async function receiptPolicyRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');});
 app.get('/v2/payments/policies/profile',async req=>{const {environment}=receiptPolicyQuery.parse(req.query);return withProfileRequest(req,environment,{scope:'receipt-rules:read',mutation:false},async({db})=>({data:await readReceiptPolicy(db,environment,null)}),deps);});
 app.put('/v2/payments/policies/profile',async req=>{const {environment}=receiptPolicyQuery.parse(req.query),body=receiptProfilePolicyWrite.parse(req.body),op=receiptPolicyId.parse(req.headers['idempotency-key']);return withProfileRequest(req,environment,{scope:'receipt-rules:write',mutation:true},async({db,profile})=>({data:await writeReceiptPolicy(db,environment,null,body,profile.authority.membership.userId,op)}),deps);});
 app.get('/v2/payments/policies/variants/:id',async req=>{const {environment}=receiptPolicyQuery.parse(req.query),{id}=params.parse(req.params);return withProfileRequest(req,environment,{scope:'receipt-rules:read',mutation:false},async({db})=>({data:await readReceiptPolicy(db,environment,id),effective:await effectiveReceiptPolicy(db,environment,id)}),deps);});
 app.put('/v2/payments/policies/variants/:id',async req=>{const {environment}=receiptPolicyQuery.parse(req.query),{id}=params.parse(req.params),body=receiptVariantPolicyWrite.parse(req.body),op=receiptPolicyId.parse(req.headers['idempotency-key']);return withProfileRequest(req,environment,{scope:'receipt-rules:write',mutation:true},async({db,profile})=>({data:await writeReceiptPolicy(db,environment,id,body,profile.authority.membership.userId,op)}),deps);});
 app.get('/v2/payments/policies/operations/:id',async req=>{const {environment}=receiptPolicyQuery.parse(req.query),{id}=params.parse(req.params);return withProfileRequest(req,environment,{scope:'receipt-rules:read',mutation:false},async({db,profile})=>({data:await readReceiptPolicyOperation(db,environment,profile.authority.membership.userId,id)}),deps);});
}
