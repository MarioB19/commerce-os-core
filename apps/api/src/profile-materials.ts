import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {marketOperation} from '../../../packages/db/src/market-variants.js';
import {MaterialError,listMaterials,readMaterial,createMaterial,putMaterialPart,completeMaterial,cancelMaterial,archiveMaterial,materialBytes,MATERIAL_PART_BYTES} from '../../../packages/db/src/profile-materials.js';
import {assetFilename,byteRange} from './asset-preview.js';

/** V7 F4 /v2/materials (RF-06.c): list, upload in parts, preview, cancel and
 * remove from new configurations. Same service for UI, API and MCP. */
const messages:Record<string,string>={MATERIAL_NOT_FOUND:'No encontramos ese material.',MATERIAL_NOT_UPLOADING:'Ese material no tiene una subida en curso.',
 MATERIAL_PART_INVALID:'Parte inválida.',MATERIAL_PART_SIZE:'El tamaño de la parte no coincide.',MATERIAL_PART_MISSING:'Faltan partes por subir.',
 MATERIAL_CHECKSUM_MISMATCH:'El archivo no coincide con el que se anunció. Vuelve a subirlo.',MATERIAL_TYPE_MISMATCH:'El contenido no corresponde al tipo de archivo.',
 MATERIAL_IN_USE:'Una variante publicada usa este material. Quítalo de la variante y publícala antes de eliminarlo.',MATERIAL_ARCHIVED:'El material ya se eliminó.',
 MATERIAL_NOT_READY:'El material aún no está listo.',MATERIAL_INTEGRITY_FAILED:'El archivo guardado no pasó la verificación de integridad.',VERSION_CONFLICT:'Otra persona cambió el material. Actualiza.'};
async function mapped<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){if(error instanceof MaterialError)throw Object.assign(new Error(error.code),{code:error.code,statusCode:error.statusCode,publicMessage:messages[error.code]});throw error;}
}
const env=(req:FastifyRequest)=>z.object({environment:z.enum(['REAL','SIMULATION']).default('REAL')}).passthrough().parse(req.query??{}).environment;
const idParam=z.object({id:z.string().uuid()}).strict();
const actorOf=(profile:any)=>({id:profile.authority.membership.userId as string,kind:profile.authority.credential.kind==='session'?'human' as const:'personal_api' as const});
export async function profileMaterialRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.addHook('onRequest',async(req,reply)=>{if(req.url.startsWith('/v2/materials'))reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff');});
 const write=<T extends object>(req:FastifyRequest,request:unknown,work:(db:any,environment:'REAL'|'SIMULATION',actor:ReturnType<typeof actorOf>)=>Promise<T>)=>{
  const environment=env(req),operationId=z.string().uuid().parse(req.headers['idempotency-key']);
  return mapped(()=>withProfileRequest(req,environment,{scope:'materials:write',mutation:true},({db,profile})=>{const actor=actorOf(profile);
   return marketOperation(db,environment,actor.id,operationId,{route:req.routeOptions.url,params:req.params,request},()=>work(db,environment,actor));},deps));
 };
 const read=<T>(req:FastifyRequest,work:(db:any,environment:'REAL'|'SIMULATION')=>Promise<T>)=>{const environment=env(req);
  return mapped(()=>withProfileRequest(req,environment,{scope:'materials:read',mutation:false},({db})=>work(db,environment),deps));};
 app.get('/v2/materials',async req=>{const {environment:_,...q}=(req.query??{}) as Record<string,unknown>;return{data:await read(req,(db,e)=>listMaterials(db,e,q))};});
 app.get('/v2/materials/:id',async req=>{const {id}=idParam.parse(req.params);return{data:await read(req,(db,e)=>readMaterial(db,e,id))};});
 app.post('/v2/materials',{bodyLimit:8192},async(req,reply)=>{const data=await write(req,req.body,(db,e,actor)=>createMaterial(db,e,req.body,actor));reply.code(201);return{data};});
 // Parts are idempotent by content: the same part may be sent again safely.
 app.put('/v2/materials/:id/parts/:n',{bodyLimit:Math.ceil(MATERIAL_PART_BYTES*4/3)+1024},async req=>{
  const p=z.object({id:z.string().uuid(),n:z.coerce.number().int().min(1).max(10)}).strict().parse(req.params);
  const {base64}=z.object({base64:z.string().max(Math.ceil(MATERIAL_PART_BYTES*4/3)+8)}).strict().parse(req.body);const environment=env(req);
  return{data:await mapped(()=>withProfileRequest(req,environment,{scope:'materials:write',mutation:true},({db})=>putMaterialPart(db,environment,p.id,p.n,base64),deps))};
 });
 app.post('/v2/materials/:id/complete',{bodyLimit:256},async req=>{const {id}=idParam.parse(req.params);return{data:await write(req,{},(db,e,actor)=>completeMaterial(db,e,id,actor))};});
 app.post('/v2/materials/:id/cancel',{bodyLimit:256},async req=>{const {id}=idParam.parse(req.params);return{data:await write(req,{},(db,e,actor)=>cancelMaterial(db,e,id,actor))};});
 app.post('/v2/materials/:id/archive',{bodyLimit:256},async req=>{const {id}=idParam.parse(req.params);const {expected_version}=z.object({expected_version:z.number().int().positive()}).strict().parse(req.body);
  return{data:await write(req,req.body,(db,e,actor)=>archiveMaterial(db,e,id,expected_version,actor))};});
 app.get('/v2/materials/:id/content',async(req,reply)=>{const {id}=idParam.parse(req.params);
  const file=await read(req,(db,e)=>materialBytes(db,e,id));
  reply.header('Content-Security-Policy',"default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'");
  const filename=assetFilename(file.name,file.mime);
  reply.header('Content-Disposition',`inline; filename="material"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g,'%27')}`).header('Accept-Ranges','bytes').type(file.mime);
  let range;try{range=byteRange(req.headers.range,file.bytes.length);}catch{return reply.code(416).header('Content-Range',`bytes */${file.bytes.length}`).send();}
  if(range){reply.code(206).header('Content-Range',`bytes ${range.start}-${range.end}/${file.bytes.length}`).header('Content-Length',range.end-range.start+1);return reply.send(file.bytes.subarray(range.start,range.end+1));}
  return reply.header('Content-Length',file.bytes.length).send(file.bytes);
 });
}
