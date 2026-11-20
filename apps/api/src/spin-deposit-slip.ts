import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {readSpinSlip} from '../../../packages/db/src/spin-deposit-slip.js';

export async function spinDepositSlipRoute(app:FastifyInstance){
 app.post('/v2/customer/spin-deposit',{bodyLimit:3072,schema:{summary:'Read the payment destinations fixed for one order',description:'The buyer presents the signed grant from their private payment link in the POST body.',security:[]},config:{rateLimit:{max:40,timeWindow:'1 minute'}}},async(req,reply)=>{
  reply.header('Cache-Control','private, no-store').header('Referrer-Policy','no-referrer');
  const input=z.object({token:z.string().max(2048)}).strict().safeParse(req.body);
  const slip=input.success?await readSpinSlip(input.data.token):null;
  if(!slip)return reply.code(404).send({error:'Ficha no disponible.'});
  return slip;
 });
}
