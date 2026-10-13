import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
import type {ProfileAuthority} from '../../../packages/domain/src/core/profile-authorization.js';
import {captureNumberLab} from '../../../packages/db/src/number-lab-snapshot.js';
import {numberLabKeys,startNumberLab,enqueueNumberLab,readNumberLab,readNumberLabStartOperation,listNumberLabOperations,latestNumberLab,numberLabRunScope,numberLabRunMaterial,attachNumberLabFile,listNumberLabAttachments,readNumberLabAttachment,NUMBER_LAB_ATTACHMENT_MAX} from '../../../packages/db/src/number-laboratory.js';
import {materialBytes} from '../../../packages/db/src/profile-materials.js';
import {sendPrivateFile} from './file-response.js';
import {diagnoseNumberTest,duringFix} from './number-test-diagnosis.js';
import {createHash} from 'node:crypto';
import {estimateNumberLab,labHash} from '../../../packages/domain/src/laboratory/number-lab.js';
import {numberLabActionSchema} from '../../../packages/contracts/src/number-laboratory.js';
import {laboratoryAiConfiguration,laboratoryGrants,type VariantAiSelection} from '../../../packages/ai-providers/src/variant-ai.js';
import {bindNumberLabReleases} from '../../../packages/ai-providers/src/number-laboratory.js';
import {readVariant} from '../../../packages/db/src/variant-workspace.js';
import {effectiveReceiptPolicy} from '../../../packages/db/src/receipt-policies.js';

/** V7 F6 (RF-19): «Probar número». One service for the web, the API and MCP.
 * - The configuration is captured on the server when the test starts and never
 *   changes afterwards (RF-19.b/m); a new test captures the current one.
 * - The price is estimated on the server; the caller only accepts a ceiling,
 *   and a start whose fresh estimate exceeds it is refused (RF-19.l).
 * - Actions are queued (202) and executed once by the laboratory worker in its
 *   own engine database: nothing reaches WhatsApp, REAL tables or quotas. */
const messages:Record<string,string>={
 LAB_NOT_INSTALLED:'El laboratorio de pruebas no está instalado en este servidor.',
 LAB_ACCOUNT_NOT_FOUND:'No encontramos ese número en este perfil.',
 LAB_ASSIGNMENT_COVERAGE:'Este número no vende ninguna variante. Asígnale una para probarlo.',
 LAB_ASSIGNMENT_NOT_CURRENT:'La venta de este número no está vigente.',
 LAB_SOURCE_NOT_PUBLISHED:'Publica la variante antes de probarla.',LAB_ASSET_NOT_READY:'Un material de la variante no está listo.',
 LAB_CONFIGURATION_INCOMPLETE:'La variante tiene partes sin configurar (oferta, flujo, vendedor, cobro o materiales).',
 LAB_AI_DEPENDENCY_REQUIRED:'Configura la IA del perfil (clave verificada y modelo predeterminado) para probar el número.',
 LAB_AI_SCOPE:'La configuración de IA cambió mientras se preparaba la prueba. Vuelve a intentarlo.',
 LAB_AI_GRANT_REQUIRED:'La persona Dueña debe confirmar la IA de la prueba desde la aplicación.',
 LAB_ESTIMATE_INCREASED:'El costo máximo subió desde la estimación. Revísalo y vuelve a iniciar.',
 LAB_ESTIMATE_EXPIRED:'La estimación venció. Vuelve a estimar.',LAB_SNAPSHOT_STALE:'La captura tardó demasiado. Vuelve a intentarlo.',
 LAB_CAPTURE_EXPIRED:'La captura tardó demasiado. Vuelve a intentarlo.',
 LAB_AUTOMATIC_UNAVAILABLE:'El comprador automático todavía no está disponible; usa la prueba conversada.',
 LAB_RUN_NOT_FOUND:'No encontramos esa prueba en este perfil.',LAB_RUN_UNAVAILABLE:'La prueba terminó o venció. Inicia otra.',
 LAB_VERSION_CHANGED:'La prueba avanzó. Actualiza antes de continuar.',LAB_OPERATION_ADMISSION:'La prueba avanzó. Actualiza antes de continuar.',
 LAB_OPERATION_PENDING:'Espera a que termine la acción anterior.',LAB_OPERATION_CONFLICT:'Esa operación ya se usó con otros datos.',
 LAB_MATERIAL_NOT_FOUND:'Ese material no forma parte de esta prueba.',LAB_MATERIAL_CHANGED:'El material cambió después de iniciar la prueba. Inicia otra para verlo.',
 LAB_ATTACHMENT_TYPE:'Adjunta una imagen (PNG, JPG o WEBP) o un PDF de comprobante.',LAB_ATTACHMENT_SIZE:'El comprobante debe pesar máximo 4 MB.',
 LAB_ATTACHMENT_LIMIT:'Esta prueba ya tiene 20 comprobantes. Inicia otra.',LAB_ATTACHMENT_NOT_FOUND:'No encontramos ese comprobante en esta prueba.',
 LAB_CATALOG_AMBIGUOUS:'El número tiene asignaciones ambiguas. Revisa sus variantes.',LAB_SOURCE_LIMIT:'La configuración del número es demasiado grande para una prueba.',
};
const status:Record<string,number>={LAB_NOT_INSTALLED:503,LAB_ACCOUNT_NOT_FOUND:404,LAB_RUN_NOT_FOUND:404,LAB_MATERIAL_NOT_FOUND:404,LAB_ATTACHMENT_NOT_FOUND:404,LAB_ATTACHMENT_TYPE:400,LAB_ATTACHMENT_SIZE:400};
function fail(code:string,statusCode=409):never{throw Object.assign(new Error(code),{code,statusCode,publicMessage:messages[code]});}
async function mapped<T>(work:()=>Promise<T>):Promise<T>{
 try{return await work();}catch(error){
  const code=error instanceof Error?(error as {code?:string}).code??error.message:'';
  if((error as {statusCode?:number}).statusCode)throw error;
  if(code==='23505')fail('LAB_OPERATION_PENDING');
  if(code in messages)fail(code,status[code]??409);
  throw error;
 }
}
function headers(reply:FastifyReply){reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization');}
const operationKey=(req:FastifyRequest)=>z.string().uuid().parse(req.headers['idempotency-key']);
const runParam=z.object({id:z.string().uuid()}).strict();
const startSchema=z.object({account_id:z.string().uuid(),mode:z.enum(['CHAT','AUTOMATIC']).default('CHAT'),accepted_maximum_microusd:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict();
const estimateSchema=z.object({account_id:z.string().uuid(),mode:z.enum(['CHAT','AUTOMATIC']).default('CHAT')}).strict();
const actionSchema=z.object({expected_version:z.number().int().positive(),action:numberLabActionSchema}).strict();

/** Capture, selections and estimate, all from the server's current state. */
async function prepare(db:ProfileExecutor,authority:ProfileAuthority,accountId:string,mode:'CHAT'|'AUTOMATIC'){
 const engineSha256=process.env.LAB_ENGINE_SHA256;if(!engineSha256||!/^[a-f0-9]{64}$/.test(engineSha256))fail('LAB_NOT_INSTALLED',503);
 const version=Number((await db.query("SELECT version FROM ai_profile_preferences WHERE workspace_id=$1 AND environment='REAL'",[db.workspaceId])).rows[0]?.version??0);
 if(!version)fail('LAB_AI_DEPENDENCY_REQUIRED');
 const captured=await captureNumberLab(db,authority,accountId,{engineSha256,aiConfigurationVersion:version});
 const selections:Record<string,VariantAiSelection>={},names:Record<string,string>={};
 for(const c of captured.snapshot.candidates){
  const v=await readVariant(db,'REAL',c.release.variant_id).catch(()=>null);
  selections[c.release.variant_id]=(v?.document as {ai?:VariantAiSelection}|undefined)?.ai??{primary:null,fallback:null};
 }
 Object.assign(names,await variantNames(db,captured.snapshot.candidates.map(c=>c.release.variant_id)));
 const ai=await laboratoryAiConfiguration(db,selections);if(!ai.config)fail('LAB_AI_DEPENDENCY_REQUIRED');
 const now=new Date((await db.query('SELECT clock_timestamp() AS now')).rows[0].now).getTime();
 const estimate=estimateNumberLab(captured.snapshot,mode,ai.config,ai.models,now);
 return{captured,estimate,selections,names};
}
/** RF-19.d: each variant's receipt rules as they are now, fixed with the test.
 * A variant without rules is left out: its receipts go to a person. */
async function receiptPolicies(db:ProfileExecutor,variantIds:string[]){
 const out:Record<string,unknown>={};
 for(const id of [...new Set(variantIds)]){await db.query('SAVEPOINT lab_receipt_policy');
  try{out[id]=await effectiveReceiptPolicy(db,'REAL',id);await db.query('RELEASE SAVEPOINT lab_receipt_policy');}
  catch{await db.query('ROLLBACK TO SAVEPOINT lab_receipt_policy');}}
 return out;
}
function presentEstimate(p:Awaited<ReturnType<typeof prepare>>){
 const byVariant=[...new Set(p.estimate.cases.map(c=>c.variant_id))].map(variantId=>{const cases=p.estimate.cases.filter(c=>c.variant_id===variantId),q=cases[0]!.quote;
  return{variant_id:variantId,name:p.names[variantId]??'Variante',provider:q.provider,model:q.model,cases:cases.length,maximum_ai_calls:cases.reduce((s,c)=>s+c.maximum_ai_calls,0),maximum_microusd:cases.reduce((s,c)=>s+c.maximum_ai_calls*c.quote.maximumMicrousd,0)};});
 return{mode:p.estimate.mode,currency:'USD' as const,maximum_microusd:p.estimate.maximum_microusd,maximum_ai_calls:p.estimate.maximum_ai_calls,valid_until:p.estimate.valid_until,
  captured_at:p.captured.snapshot.captured_at,variants:byVariant,paid_by:'PROFILE_KEY' as const,
  note:'Es un máximo: cada respuesta de la IA se cobra a la clave de tu perfil y cuenta en tu presupuesto mensual. Nada se envía por WhatsApp.'};
}
const reasonLabels:Record<string,string>={LAB_CONVERSATION_REQUIRED:'Primero escribe un mensaje como cliente.',LAB_ATTACHMENT_DRIVER_REQUIRED:'Este servidor no tiene habilitados los comprobantes de prueba.',LAB_ATTACHMENT_NOT_FOUND:'No encontramos ese comprobante en esta prueba.',LAB_RECEIPT_NOT_FOUND:'Ese comprobante no es de esta conversación.',
 AUTOMATIC_DRIVER_REQUIRED:'El comprador automático aún no está disponible.',CANONICAL_MESSAGE_LIMIT:'El mensaje es demasiado largo.',LAB_SELLER_GRANT_REQUIRED:'Falta confirmar la IA de la prueba.'};
const stateLabels:Record<string,string>={QUEUED:'En cola',INTENT:'Ejecutando',APPLIED:'Aplicada',FAILED:'No se pudo aplicar',UNKNOWN:'Resultado incierto'};
/** «Producto · Variante», so several variants of one market stay distinguishable. */
async function variantNames(db:ProfileExecutor,ids:string[]):Promise<Record<string,string>>{
 const rows=(await db.query(`SELECT v.id::text,v.document->>'name' AS variant,p.body->>'name' AS product FROM market_variants v
  LEFT JOIN records p ON p.workspace_id=v.workspace_id AND p.environment=v.environment AND p.kind='product' AND p.id=v.family_id
  WHERE v.workspace_id=$1 AND v.environment='REAL' AND v.id=ANY($2::uuid[])`,[db.workspaceId,ids])).rows;
 return Object.fromEntries(rows.map(r=>[r.id,[r.product,r.variant].filter(Boolean).join(' · ')||'Variante']));
}
/** What the tester can do next, from the flow state the last action left. */
function nextStep(flow:{status:string|null;waiting_for:string|null;ai_status:string|null}){
 if(flow.ai_status==='HUMAN_REVIEW'||flow.status==='HUMAN_REVIEW')return{action:'none',label:'La conversación pasó a una persona: en producción la atendería tu equipo.'};
 switch(flow.waiting_for){
  case'simulation_continue':return{action:'continue',label:'El negocio tiene otro mensaje listo. Pulsa Continuar para verlo.'};
  case'commitment':return{action:'message',label:'Esperando que el cliente acepte la oferta.'};
  case'receipt_approved':return{action:'receipt',label:'Esperando el comprobante de pago.'};
  case'customer_reply':case'ai_customer_message':return{action:'message',label:'Esperando la respuesta del cliente.'};
  default:return flow.status==='FINISHED'?{action:'none',label:'El flujo terminó.'}:{action:'message',label:'Escribe como cliente o adelanta el reloj.'};
 }
}
/** Run, operations and the conversation as the last settled operation saw it. */
async function view(db:ProfileExecutor,authority:ProfileAuthority,runId:string){
 const key=numberLabKeys().control,run=await readNumberLab(db,authority,runId);if(!run)fail('LAB_RUN_NOT_FOUND',404);
 const scope=await numberLabRunScope(db,authority,runId,key),operations=await listNumberLabOperations(db,authority,runId,key);
 const names=await variantNames(db,scope?.variants.map(v=>v.variant_id)??[]);
 type Result={variant_id?:string|null;conversation_id?:string|null;state?:string;reason?:string|null;transcript?:unknown[];timers?:unknown[];flow?:{status:string|null;waiting_for:string|null;ai_status:string|null};ai_result?:{human_review?:boolean;dependency?:string|null}|undefined;transport_result?:unknown;receipt_result?:{dependency?:string|null}|undefined};
 const settled=operations.filter(o=>o.result).map(o=>({o,r:o.result as Result}));
 const last=[...settled].reverse().find(x=>x.r.transcript),selected=[...settled].reverse().find(x=>x.r.variant_id)?.r.variant_id??null;
 return{run:{...run,state_label:{READY:'Lista',RUNNING:'En curso',PARTIAL:'En curso',COMPLETED:'Terminada',STOPPED:'Detenida'}[run.state]},
  captured:scope?{captured_at:scope.captured_at,estimate:scope.estimate}:null,
  variants:(scope?.variants??[]).map(v=>({...v,name:names[v.variant_id]??'Variante'})),selected_variant_id:selected,
  operations:operations.map(o=>{const r=o.result as Result|null;return{operation_id:o.operation_id,state:o.state,state_label:stateLabels[o.state],created_at:o.created_at,action:o.action,
   result:r?{state:r.state??null,reason:r.reason??null,reason_label:r.reason?reasonLabels[r.reason]??r.reason:null,variant_id:r.variant_id??null,
    ai:r.ai_result?{human_review:!!r.ai_result.human_review,dependency:r.ai_result.dependency??null}:null,
    // RF-19.i: the screen that fixes what stopped this step, when there is one.
    fix:duringFix(r.reason)??duringFix(r.ai_result?.dependency)??duringFix(r.receipt_result?.dependency)}:null};}),
  pending:operations.some(o=>['QUEUED','INTENT'].includes(o.state)),
  // RF-19.g: each business message names the variant that produced it.
  conversation:{transcript:(last?.r.transcript??[]).map(e=>{const entry=e as {from?:string};return entry.from==='business'&&selected?{...entry,variant_id:selected,variant_name:names[selected]??'Variante'}:entry;}),timers:last?.r.timers??[],waiting_for:last?.r.flow?.waiting_for??null,
   next_step:settled.at(-1)?.r.state==='SELECTION_REQUIRED'?{action:'select',label:'El número vende varias variantes y el mensaje no dice cuál. Elige por cuál llega el cliente, como si viniera de su anuncio.'}
    :last?.r.flow?nextStep(last.r.flow):{action:'message',label:'Escribe como cliente para empezar.'}},
  isolation:{environment:'SIMULATION',whatsapp:false,real_records:false,label:'Prueba aislada: no envía mensajes reales, no registra ventas ni consume la cuota del número.'}};
}

export async function numberTestRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.addHook('onRequest',async(req,reply)=>{if(req.url.startsWith('/v2/number-tests'))headers(reply);});
 app.post('/v2/number-tests/estimate',{bodyLimit:1024},async req=>{const q=estimateSchema.parse(req.body);
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:run',mutation:true},async({db,profile})=>presentEstimate(await prepare(db,profile.authority,q.account_id,q.mode)),deps))};});
 app.post('/v2/number-tests',{bodyLimit:1024},async(req,reply)=>{const q=startSchema.parse(req.body),operationId=operationKey(req);
  const data=await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:run',mutation:true},async({db,profile})=>{
   const a=profile.authority as ProfileAuthority,key=numberLabKeys().control;
   // A lost response is answered from the original operation, never a second run.
   const prior=await readNumberLabStartOperation(db,a,operationId);if(prior)return{run:prior,created:false};
   if(q.mode==='AUTOMATIC')fail('LAB_AUTOMATIC_UNAVAILABLE');
   const p=await prepare(db,a,q.account_id,q.mode);
   if(p.estimate.maximum_microusd>q.accepted_maximum_microusd)fail('LAB_ESTIMATE_INCREASED');
   const {missing}=await laboratoryGrants(db,a,p.estimate.cases,p.selections);if(missing.length)fail('LAB_AI_GRANT_REQUIRED');
   const run=await startNumberLab(db,a,{operation_id:operationId,account_id:q.account_id,snapshot_sha256:labHash(p.captured.snapshot),estimate_sha256:p.estimate.sha256,mode:q.mode},p.captured,p.estimate,key,{receipt_policies:await receiptPolicies(db,p.captured.snapshot.candidates.map(c=>c.release.variant_id))});
   if(run.created)await bindNumberLabReleases(db,run.run_id,p.captured.snapshot,p.estimate);
   return{run,created:run.created};
  },deps));
  reply.code(data.created?201:200);return{data:data.run};});
 // RF-19.i: before starting, everything that keeps the number from being
 // tested (blocking) or from being tested completely (warning), with links.
 app.get('/v2/number-tests/diagnose',async req=>{const q=z.object({account_id:z.string().uuid(),environment:z.literal('REAL').optional()}).strict().parse(req.query??{});
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:read',mutation:false},async({db})=>{
   const value=await diagnoseNumberTest(db,q.account_id,{installed:/^[a-f0-9]{64}$/.test(process.env.LAB_ENGINE_SHA256??'')});
   if(!value)fail('LAB_ACCOUNT_NOT_FOUND',404);return value;},deps))};});
 app.get('/v2/number-tests/latest',async req=>{const q=z.object({account_id:z.string().uuid().optional(),environment:z.literal('REAL').optional()}).strict().parse(req.query??{});
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:read',mutation:false},async({db,profile})=>{
   const run=await latestNumberLab(db,profile.authority,q.account_id??null);return run?view(db,profile.authority,run.run_id):null;},deps))};});
 app.get('/v2/number-tests/:id',async req=>{const {id}=runParam.parse(req.params);
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:read',mutation:false},({db,profile})=>view(db,profile.authority,id),deps))};});
 // RF-19.c: the chat previews a file the business sent, read privately with the
 // profile fence. Only a material the run captured is served, and only while
 // the REAL material still holds exactly the captured bytes (else 409).
 app.get('/v2/number-tests/:id/materials/:material',async(req,reply)=>{const {id,material}=z.object({id:z.string().uuid(),material:z.string().uuid()}).strict().parse(req.params);
  const file=await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:read',mutation:false},async({db,profile})=>{
   if(!await readNumberLab(db,profile.authority,id))fail('LAB_RUN_NOT_FOUND',404);
   const captured=await numberLabRunMaterial(db,profile.authority,id,material,numberLabKeys().control);if(!captured)fail('LAB_MATERIAL_NOT_FOUND',404);
   const current=await materialBytes(db,'REAL',captured.source_id).catch(()=>fail('LAB_MATERIAL_CHANGED'));
   if(current.bytes.length!==captured.size_bytes||createHash('sha256').update(current.bytes).digest('hex')!==captured.sha256)fail('LAB_MATERIAL_CHANGED');
   return{bytes:current.bytes,mime:captured.mime_type,name:captured.name};},deps));
  return sendPrivateFile(req,reply,file);
 });
 // RF-19.d: example receipts. Uploaded as the customer would send them (image
 // or PDF ≤4 MB), kept sealed with the test and read back only by its profile.
 const attachmentParam=z.object({id:z.string().uuid(),attachment:z.string().uuid()}).strict();
 app.post('/v2/number-tests/:id/attachments',{bodyLimit:Math.ceil(NUMBER_LAB_ATTACHMENT_MAX*4/3)+4096},async(req,reply)=>{const {id}=runParam.parse(req.params);
  const q=z.object({mime_type:z.enum(['image/png','image/jpeg','image/webp','application/pdf']),base64:z.string().min(4).max(Math.ceil(NUMBER_LAB_ATTACHMENT_MAX*4/3)+4).regex(/^[A-Za-z0-9+/]+={0,2}$/)}).strict().parse(req.body);
  const data=await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:run',mutation:true},async({db,profile})=>{
   if(!await readNumberLab(db,profile.authority,id))fail('LAB_RUN_NOT_FOUND',404);
   return attachNumberLabFile(db,profile.authority,id,q,numberLabKeys().control);},deps));
  reply.code(data.created?201:200);const {created:_created,...out}=data;return{data:out};});
 app.get('/v2/number-tests/:id/attachments',async req=>{const {id}=runParam.parse(req.params);
  return{data:await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:read',mutation:false},async({db,profile})=>{
   if(!await readNumberLab(db,profile.authority,id))fail('LAB_RUN_NOT_FOUND',404);return listNumberLabAttachments(db,profile.authority,id);},deps))};});
 app.get('/v2/number-tests/:id/attachments/:attachment',async(req,reply)=>{const {id,attachment}=attachmentParam.parse(req.params);
  const file=await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:read',mutation:false},async({db,profile})=>{
   if(!await readNumberLab(db,profile.authority,id))fail('LAB_RUN_NOT_FOUND',404);
   const found=await readNumberLabAttachment(db,id,attachment,numberLabKeys().control);if(!found)fail('LAB_ATTACHMENT_NOT_FOUND',404);
   return{bytes:found.bytes,mime:found.mime_type,name:'comprobante-de-prueba'};},deps));
  return sendPrivateFile(req,reply,file);
 });
 app.post('/v2/number-tests/:id/actions',{bodyLimit:16384},async(req,reply)=>{const {id}=runParam.parse(req.params),q=actionSchema.parse(req.body),operationId=operationKey(req);
  const data=await mapped(()=>withProfileRequest(req,'REAL',{scope:'tests:run',mutation:true},async({db,profile})=>{
   if(!await readNumberLab(db,profile.authority,id))fail('LAB_RUN_NOT_FOUND',404);
   return enqueueNumberLab(db,profile.authority,id,{operation_id:operationId,expected_version:q.expected_version,action:q.action},numberLabKeys().control);},deps));
  reply.code(202);return{data};});
}
