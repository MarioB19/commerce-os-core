import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {receiptQueue,receiptDetail,receiptDocument,decideReceipt,ReceiptQueueError} from '../../../packages/db/src/receipt-queue.js';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';

/** V7 F5 (RF-09.g/h/l, RF-17.g): the receipt queue under the selected profile.
 * Reading needs receipts:read; deciding needs receipts:review and an
 * Idempotency-Key, and is applied by the worker (202). */
const messages:Record<string,string>={
 RECEIPT_NOT_FOUND:'No encontramos ese comprobante en este perfil.',VERSION_CONFLICT:'El comprobante cambió. Vuelve a abrirlo antes de decidir.',
 RECEIPT_DECISION_PENDING:'Ya hay una decisión en curso para este comprobante.',RECEIPT_ALREADY_DECIDED:'Este comprobante ya tiene una decisión.',
 RECEIPT_DECISION_OPERATION_CONFLICT:'Esa operación ya se usó con otra decisión.',RECEIPT_DOCUMENT_UNAVAILABLE:'El archivo del comprobante no está disponible.',
 RECEIPT_DOCUMENT_CHANGED:'El archivo del comprobante no coincide con el recibido.',RECEIPT_AMOUNT_REQUIRED:'No se pudo leer el monto: indica cuánto pagó el cliente para aprobarlo.',
 RECEIPT_CURRENCY_MISMATCH:'La moneda del comprobante no es la de la venta; recházalo o revisa la conversación.'};
const env=(req:FastifyRequest)=>z.object({environment:z.enum(['REAL','SIMULATION']).default('REAL')}).passthrough().parse(req.query??{}).environment;
const idParam=z.object({id:z.string().uuid()}).strict();
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization');}
async function mapped<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  if(error instanceof ReceiptQueueError)throw Object.assign(new Error(error.code),{code:error.code,statusCode:error.statusCode,publicMessage:messages[error.code]});
  throw error;
 }
}
export async function receiptQueueRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.get('/v2/receipts',async(req,reply)=>{headers(reply);const environment=env(req),{environment:_,...q}=(req.query??{}) as Record<string,unknown>;
  return{data:await mapped(()=>withProfileRequest(req,environment,{scope:'receipts:read',mutation:false},({db})=>receiptQueue(db,environment,q),deps))};});
 app.get('/v2/receipts/:id',async(req,reply)=>{headers(reply);const environment=env(req),{id}=idParam.parse(req.params);
  return{data:await mapped(()=>withProfileRequest(req,environment,{scope:'receipts:read',mutation:false},({db})=>receiptDetail(db,environment,id),deps))};});
 app.get('/v2/receipts/:id/document',async(req,reply)=>{const environment=env(req),{id}=idParam.parse(req.params);
  const doc=await mapped(()=>withProfileRequest(req,environment,{scope:'receipts:read',mutation:false},({db})=>receiptDocument(db,environment,id),deps));
  return reply.header('Cache-Control','private, no-store').header('Vary','Cookie, Authorization').header('Content-Type',doc.mimeType).header('Content-Disposition','inline')
   .header('X-Content-Type-Options','nosniff').header('Content-Security-Policy',"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox").send(doc.bytes);});
 app.post('/v2/receipts/:id/decision',{bodyLimit:2048},async(req,reply)=>{headers(reply);const environment=env(req),{id}=idParam.parse(req.params),operationId=z.string().uuid().parse(req.headers['idempotency-key']);
  const data=await mapped(()=>withProfileRequest(req,environment,{scope:'receipts:review',mutation:true},({db,profile})=>decideReceipt(db,environment,id,req.body,{id:profile.authority.membership.userId},operationId),deps));
  reply.code(202);return{data};});
}
