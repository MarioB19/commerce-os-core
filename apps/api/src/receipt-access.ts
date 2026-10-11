import type {FastifyInstance,FastifyRequest} from 'fastify';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {timingSafeEqual} from 'node:crypto';
import {privateIntegrationDigest,decrypt} from '@commerce/db';
import {principal,scopedRecord,envOf,fail} from './context.js';
import type {Body} from '@commerce/contracts';
function reviewer(req:FastifyRequest){const p=principal(req);if(p.service||!['owner','operator','reconciler'].includes(p.role))throw fail(403,'FORBIDDEN');return p;}
const signature=(req:FastifyRequest,id:string,expires:number)=>privateIntegrationDigest({purpose:'receipt_document_v1',workspace:principal(req).workspace_id,actor:principal(req).user.id,environment:envOf(req),id,expires});
export async function receiptAccessRoutes(app:FastifyInstance){
 app.get('/v1/receipts/:id/access',async req=>{reviewer(req);const receipt=await scopedRecord(req,'receipt',(req.params as Body).id),expires=Math.floor(Date.now()/1000)+60;await scopedRecord(req,'asset',receipt.body.asset_id);return{data:{url:`/v1/receipts/${receipt.id}/document?environment=${envOf(req)}&expires=${expires}&signature=${signature(req,receipt.id,expires)}`,expires_at:new Date(expires*1000).toISOString()}};});
 app.get('/v1/receipts/:id/document',async(req,reply)=>{reviewer(req);const q=req.query as Body,id=(req.params as Body).id,expires=Number(q.expires);if(!Number.isInteger(expires)||expires<Math.floor(Date.now()/1000)||expires>Math.floor(Date.now()/1000)+60||!/^\w{64}$/.test(q.signature??''))throw fail(403,'RECEIPT_ACCESS_EXPIRED');if(!timingSafeEqual(Buffer.from(q.signature),Buffer.from(signature(req,id,expires))))throw fail(403,'RECEIPT_ACCESS_INVALID');const receipt=await scopedRecord(req,'receipt',id),asset=await scopedRecord(req,'asset',receipt.body.asset_id);if(asset.body.status!=='READY'||!asset.body.storage_key)throw fail(409,'EVIDENCE_NOT_READY');const root=process.env.PRIVATE_STORAGE_DIR??process.env.ASSET_STORAGE_DIR;if(!root)throw fail(503,'PRIVATE_STORAGE_UNAVAILABLE');const content=decrypt(await readFile(join(root,'assets',asset.body.storage_key+'.enc'),'utf8'));reply.header('Cache-Control','no-store, private').header('Content-Disposition',`inline; filename="comprobante-${receipt.id}.pdf"`).type(asset.body.mime_type);return reply.send(Buffer.from(content,'base64'));});
}
