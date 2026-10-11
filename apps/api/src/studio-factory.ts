import type {FastifyInstance,FastifyRequest} from 'fastify';
import {z} from 'zod';
import {pool,uuid,type QueryExecutor} from '../../../packages/db/src/index.js';
import {readGlobalBudget} from '../../../packages/provider-broker/src/global-budget.js';
import {receivePlaybook,intakeHash,intakeImpact,validateIntakeEvidence,type IntakeEvidence} from '../../../packages/creative-engine/src/playbook-intake.js';
import {BatchInputSchema,inspectBatch,type BatchVariant} from '../../../packages/creative-engine/src/batch-manifest.js';
import {principal,envOf,parseBody,mutate,fail,audit} from './context.js';
import {creativePermission,creativeProject,expectedVersion} from './creative-security.js';

async function receiptRecord(req:FastifyRequest,id:string,scope='studio:read',db:QueryExecutor=pool){
 const row=(await db.query('SELECT * FROM creative_playbook_receipts WHERE id=$1 AND workspace_id=$2 AND environment=$3',[id,principal(req).workspace_id,envOf(req)])).rows[0];
 if(!row)throw fail(404,'NOT_FOUND');await creativeProject(req,row.project_id,scope,db);return row;
}
async function batchRecord(req:FastifyRequest,id:string,scope='studio:read',db:QueryExecutor=pool){
 const row=(await db.query('SELECT b.*,v.manifest,v.sha256,v.receipt_id FROM creative_batches b JOIN creative_batch_versions v ON v.batch_id=b.id AND v.version=b.version WHERE b.id=$1 AND b.workspace_id=$2 AND b.environment=$3',[id,principal(req).workspace_id,envOf(req)])).rows[0];
 if(!row)throw fail(404,'NOT_FOUND');await creativeProject(req,row.project_id,scope,db);return row;
}
/** An individual pilot or a current batch binds exact bytes; neither grants production approval. */
export async function recipeIntakeReadiness(row:any,db:QueryExecutor=pool){
 if(row.recipe?.engine_version!=='1.1.0')return{issues:[],playbookIntake:undefined};
 const direct=(await db.query(`SELECT i.variant_id,p.receipt,p.sha256 FROM creative_recipe_intakes i
 JOIN creative_playbook_receipts p ON p.id=i.receipt_id
 WHERE i.workspace_id=$1 AND i.environment=$2 AND i.project_id=$3 AND i.recipe_id=$4 AND i.recipe_version=$5 AND i.recipe_sha256=$6
 ORDER BY i.created_at DESC,i.id DESC LIMIT 1`,[row.workspace_id,row.environment,row.project_id,row.id,row.version,row.sha256])).rows[0];
 if(direct){const evidence:IntakeEvidence={receipt:direct.receipt,variant_id:direct.variant_id,receipt_sha256:direct.sha256};return{issues:validateIntakeEvidence(row.recipe,evidence).map(i=>({code:i.code,path:i.field,message:i.message})),playbookIntake:evidence};}
 const binding=(await db.query(`SELECT v.manifest,p.receipt,p.sha256 FROM creative_batches b
 JOIN creative_batch_versions v ON v.batch_id=b.id AND v.version=b.version
 JOIN creative_playbook_receipts p ON p.id=v.receipt_id
 WHERE b.workspace_id=$1 AND b.environment=$2 AND b.project_id=$3 AND v.manifest->'variants' @> $4::jsonb
 ORDER BY v.created_at DESC,v.id DESC LIMIT 1`,[row.workspace_id,row.environment,row.project_id,JSON.stringify([{recipe_id:row.id,recipe_version:row.version,recipe_sha256:row.sha256}])])).rows[0];
 const variant=binding?.manifest.variants.find((v:BatchVariant)=>v.recipe_id===row.id&&v.recipe_version===row.version&&v.recipe_sha256===row.sha256);
 const evidence:IntakeEvidence|undefined=binding&&variant?{receipt:binding.receipt,variant_id:variant.variant_id,receipt_sha256:binding.sha256}:undefined;
 return{issues:validateIntakeEvidence(row.recipe,evidence).map(i=>({code:i.code,path:i.field,message:i.message})),playbookIntake:evidence};
}
async function batchProgress(req:FastifyRequest,row:any,db:QueryExecutor=pool){
 const variants=[];
 for(const variant of row.manifest.variants as BatchVariant[]){
  const current=(await db.query('SELECT version FROM creative_recipes WHERE id=$1 AND workspace_id=$2 AND environment=$3',[variant.recipe_id,row.workspace_id,row.environment])).rows[0];
  const jobs=(await db.query('SELECT id,status,error_code,created_at FROM creative_jobs WHERE workspace_id=$1 AND environment=$2 AND recipe_id=$3 AND recipe_version=$4 AND recipe_sha=$5 ORDER BY created_at DESC LIMIT 10',[row.workspace_id,row.environment,variant.recipe_id,variant.recipe_version,variant.recipe_sha256])).rows;
  const artifacts=(await db.query(`SELECT a.id,a.sha256,a.qa,a.job_id,
   (SELECT decision FROM creative_reviews r WHERE r.artifact_id=a.id AND r.sha256=a.sha256 AND r.kind='EDITORIAL' ORDER BY created_at DESC LIMIT 1) AS editorial,
   (SELECT decision FROM creative_reviews r WHERE r.artifact_id=a.id AND r.sha256=a.sha256 AND r.kind='PRODUCTION' ORDER BY created_at DESC LIMIT 1) AS production
   FROM creative_artifacts a JOIN creative_jobs j ON j.id=a.job_id WHERE a.workspace_id=$1 AND a.environment=$2 AND j.recipe_id=$3 AND j.recipe_version=$4 AND j.recipe_sha=$5 ORDER BY a.created_at DESC`,[row.workspace_id,row.environment,variant.recipe_id,variant.recipe_version,variant.recipe_sha256])).rows;
  const stale=current?.version!==variant.recipe_version,active=jobs.find(j=>['QUEUED','RUNNING','RETRY','REVIEW'].includes(j.status)),completed=artifacts.some(a=>a.qa?.status==='PASS'&&a.editorial==='APPROVED'&&a.production==='APPROVED');
  variants.push({...variant,state:stale?'STALE':completed?'APPROVED':artifacts.length?'REVIEW':active?.status??(jobs.length?'RETRY_AVAILABLE':'PENDING'),jobs,artifacts,resumable:!stale&&!active&&!artifacts.length&&!completed});
 }
 return{...row,variants,resume_plan:variants.filter(v=>v.resumable).map(v=>({variant_id:v.variant_id,recipe_id:v.recipe_id,expected_version:v.recipe_version,quote_path:`/v1/studio/recipes/${v.recipe_id}/quote`,submit_path:`/v1/studio/recipes/${v.recipe_id}/submit`,requires_fresh_quote:true})),auto_submit:false,approvals_preserved:true};
}
async function buildBatch(req:FastifyRequest,db:QueryExecutor,projectId:string,receiptId:string,input:unknown){
 const variants=BatchInputSchema.parse(input).variants,receipt=await receiptRecord(req,receiptId,'studio:write',db);
 if(receipt.project_id!==projectId)throw fail(409,'PLAYBOOK_PROJECT_MISMATCH');
 if(receipt.receipt.technical_conformance!=='PASS'||intakeHash(receipt.receipt)!==receipt.sha256)throw fail(409,'PLAYBOOK_RECEIPT_INVALID');
 const snapshots=(await db.query('SELECT r.id,r.version,v.sha256,v.recipe FROM creative_recipes r JOIN creative_recipe_versions v ON v.recipe_id=r.id AND v.version=r.version WHERE r.workspace_id=$1 AND r.environment=$2 AND r.project_id=$3 AND r.id=ANY($4::uuid[])',[principal(req).workspace_id,envOf(req),projectId,variants.map(v=>v.recipe_id)])).rows;
 const result=inspectBatch(variants,snapshots,receipt.receipt);if(!result.ok)throw fail(409,'BATCH_CONFORMANCE_FAILED','Corrige la matriz y sus fuentes exactas.',result.issues);return result.manifest;
}
export async function studioFactoryRoutes(app:FastifyInstance){
 app.get('/v1/studio/global-budget',async req=>{await creativePermission(req,'studio:admin');return{data:await readGlobalBudget(pool,principal(req).workspace_id)};});
 app.put('/v1/studio/global-budget',async(req,reply)=>{
  if(principal(req).service||principal(req).role!=='owner')throw fail(403,'HUMAN_OWNER_REQUIRED');
  const b=parseBody(req),version=expectedVersion(b),input=z.object({limit_usd:z.number().min(0).max(1500),authorization_source:z.string().min(10).max(1500),expires_at:z.string().datetime(),external_status:z.enum(['NONE','KNOWN','UNKNOWN']),external_reserved_usd:z.number().min(0).max(100000),external_source:z.string().min(10).max(1500).optional(),external_expires_at:z.string().datetime().optional()}).parse(b);
  const future=(s:string)=>Date.parse(s)>Date.now()&&Date.parse(s)<=Date.now()+32*86400000;
  if(!future(input.expires_at)||input.external_status==='KNOWN'&&(!input.external_source||!input.external_expires_at||!future(input.external_expires_at)))throw fail(400,'BUDGET_EXPIRY_REQUIRED');
  if(input.external_status==='NONE'&&input.external_reserved_usd!==0)throw fail(400,'EXTERNAL_RESERVATION_CONFLICT');
  const result=await mutate(req,'studio.global-budget',async c=>{
   const p=principal(req);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`creative-provider:${p.workspace_id}`]);
   const old=await readGlobalBudget(c,p.workspace_id);if(old.version!==version)throw fail(409,'VERSION_CONFLICT');
   if(Math.round((old.spent_usd+old.reserved_usd+input.external_reserved_usd)*1e6)>Math.round(input.limit_usd*1e6))throw fail(409,'BUDGET_BELOW_COMMITTED');
   await c.query(`INSERT INTO creative_global_budgets(workspace_id,limit_usd,authorization_source,actor_id,expires_at,external_status,external_reserved_usd,external_source,external_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT(workspace_id) DO UPDATE SET version=creative_global_budgets.version+1,limit_usd=EXCLUDED.limit_usd,authorization_source=EXCLUDED.authorization_source,actor_id=EXCLUDED.actor_id,expires_at=EXCLUDED.expires_at,external_status=EXCLUDED.external_status,external_reserved_usd=EXCLUDED.external_reserved_usd,external_source=EXCLUDED.external_source,external_expires_at=EXCLUDED.external_expires_at,updated_at=now()`,[p.workspace_id,input.limit_usd,input.authorization_source,p.user.id,input.expires_at,input.external_status,input.external_reserved_usd,input.external_source??null,input.external_expires_at??null]);
   await audit(c,req,'studio.global-budget.authorized',p.workspace_id,{...input,version:version+1});return{data:await readGlobalBudget(c,p.workspace_id)};
  });return reply.code(result.status??200).send(result);
 });
 app.post('/v1/studio/playbooks',async(req,reply)=>{
  const b=parseBody(req),projectId=z.string().uuid().parse(b.project_id),receipt=receivePlaybook(b.receipt,principal(req).user.id);
  if(Buffer.byteLength(JSON.stringify(receipt))>4*1024*1024)throw fail(413,'PLAYBOOK_TOO_LARGE');
  const result=await mutate(req,'studio.playbook.receive',async c=>{
   await creativeProject(req,projectId,'studio:write',c);const p=principal(req);
   const sources=(await c.query("SELECT id,sha256,status,rights,verification FROM creative_assets WHERE workspace_id=$1 AND environment=$2 AND project_id=$3 AND id=ANY($4::uuid[])",[p.workspace_id,envOf(req),projectId,receipt.sources.map(s=>s.source_id)])).rows;
   for(const source of receipt.sources){const a=sources.find(a=>a.id===source.source_id);if(!a||a.sha256!==source.sha256||a.status!=='READY'||!['OWNED','LICENSED'].includes(a.rights?.status)||!a.verification)throw fail(409,'PLAYBOOK_SOURCE_NOT_READY');}
   const id=uuid(),sha=intakeHash(receipt);await c.query('INSERT INTO creative_playbook_receipts(id,workspace_id,environment,project_id,receipt,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,p.workspace_id,envOf(req),projectId,receipt,sha,p.user.id]);
   await audit(c,req,'studio.playbook.received',id,{sha256:sha,technical_conformance:receipt.technical_conformance,editorial_approval:'PENDING'});return{data:{id,sha256:sha,receipt},status:201};
  });return reply.code(result.status??200).send(result);
 });
 app.get('/v1/studio/playbooks/:id',async req=>({data:await receiptRecord(req,z.string().uuid().parse((req.params as any).id))}));
 app.post('/v1/studio/playbooks/:id/compare',async req=>{const old=await receiptRecord(req,z.string().uuid().parse((req.params as any).id)),next=await receiptRecord(req,z.string().uuid().parse(parseBody(req).next_receipt_id));if(old.project_id!==next.project_id)throw fail(409,'PLAYBOOK_PROJECT_MISMATCH');return{data:intakeImpact(old.receipt,next.receipt)};});
 app.post('/v1/studio/recipes/:id/intake',async(req,reply)=>{
  const b=parseBody(req),version=expectedVersion(b),id=z.string().uuid().parse((req.params as any).id),receiptId=z.string().uuid().parse(b.receipt_id),variantId=z.string().regex(/^A0[1-6]-h[1-3]$/).parse(b.variant_id);
  const result=await mutate(req,'studio.recipe.intake',async c=>{const p=principal(req),row=(await c.query('SELECT r.*,v.recipe,v.sha256 FROM creative_recipes r JOIN creative_recipe_versions v ON v.recipe_id=r.id AND v.version=r.version WHERE r.id=$1 AND r.workspace_id=$2 AND r.environment=$3 FOR UPDATE OF r',[id,p.workspace_id,envOf(req)])).rows[0];
   if(!row)throw fail(404,'NOT_FOUND');await creativeProject(req,row.project_id,'studio:write',c);if(row.version!==version)throw fail(409,'VERSION_CONFLICT');if(row.recipe.engine_version!=='1.1.0')throw fail(409,'ENGINE_VERSION_REQUIRED');
   const receipt=await receiptRecord(req,receiptId,'studio:write',c);if(receipt.project_id!==row.project_id)throw fail(409,'PLAYBOOK_PROJECT_MISMATCH');const evidence:IntakeEvidence={receipt:receipt.receipt,variant_id:variantId,receipt_sha256:receipt.sha256},issues=validateIntakeEvidence(row.recipe,evidence);if(issues.length)throw fail(409,'PLAYBOOK_RECIPE_CONFORMANCE_FAILED','Corrige el recibo exacto de esta versión.',issues);
   const binding=(await c.query('INSERT INTO creative_recipe_intakes(id,workspace_id,environment,project_id,recipe_id,recipe_version,recipe_sha256,receipt_id,variant_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[uuid(),p.workspace_id,envOf(req),row.project_id,id,version,row.sha256,receiptId,variantId,p.user.id])).rows[0];
   await audit(c,req,'studio.recipe.intake-bound',id,{binding_id:binding.id,recipe_version:version,recipe_sha256:row.sha256,receipt_id:receiptId,variant_id:variantId});return{data:{...binding,editorial_approval:'PENDING',production_approval:'PENDING'},status:201};
  });return reply.code(result.status??200).send(result);
 });
 app.post('/v1/studio/batches',async(req,reply)=>{
  const b=parseBody(req),projectId=z.string().uuid().parse(b.project_id),receiptId=z.string().uuid().parse(b.receipt_id),title=z.string().min(1).max(160).parse(b.title);
  const result=await mutate(req,'studio.batch.create',async c=>{await creativeProject(req,projectId,'studio:write',c);const p=principal(req),manifest=await buildBatch(req,c,projectId,receiptId,{variants:b.variants}),id=uuid(),sha=intakeHash(manifest);
   await c.query('INSERT INTO creative_batches(id,workspace_id,environment,project_id,title,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,p.workspace_id,envOf(req),projectId,title,p.user.id]);
   await c.query('INSERT INTO creative_batch_versions(id,batch_id,version,receipt_id,manifest,sha256,created_by) VALUES($1,$2,1,$3,$4,$5,$6)',[uuid(),id,receiptId,manifest,sha,p.user.id]);await audit(c,req,'studio.batch.created',id,{sha256:sha,count:18});return{data:{id,version:1,manifest,sha256:sha},status:201};
  });return reply.code(result.status??200).send(result);
 });
 app.post('/v1/studio/batches/:id/versions',async(req,reply)=>{
  const b=parseBody(req),version=expectedVersion(b),id=z.string().uuid().parse((req.params as any).id),receiptId=z.string().uuid().parse(b.receipt_id);
  const result=await mutate(req,'studio.batch.version',async c=>{const old=await batchRecord(req,id,'studio:write',c);if(old.version!==version)throw fail(409,'VERSION_CONFLICT');const manifest=await buildBatch(req,c,old.project_id,receiptId,{variants:b.variants}),sha=intakeHash(manifest);
   if(!(await c.query('UPDATE creative_batches SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2',[id,version])).rowCount)throw fail(409,'VERSION_CONFLICT');
   await c.query('INSERT INTO creative_batch_versions(id,batch_id,version,receipt_id,manifest,sha256,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',[uuid(),id,version+1,receiptId,manifest,sha,principal(req).user.id]);await audit(c,req,'studio.batch.versioned',id,{sha256:sha,version:version+1});return{data:{id,version:version+1,manifest,sha256:sha},status:201};
  });return reply.code(result.status??200).send(result);
 });
 app.get('/v1/studio/batches/:id',async req=>({data:await batchProgress(req,await batchRecord(req,z.string().uuid().parse((req.params as any).id)))}));
}
