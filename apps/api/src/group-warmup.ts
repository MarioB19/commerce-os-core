import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {groupWarmupCreateSchema,groupWarmupPreviewSchema,groupWarmupCommandSchema,libraryImportSchema,warmupReadSchema} from '../../../packages/contracts/src/group-warmup.js';
import {groupWarmupOverview,listWarmupGroups,requestGroupRefresh,previewGroupWarmup,createGroupWarmup,commandGroupWarmup,listWarmupLibraries,libraryScripts,importWarmupLibrary,warmupError} from '../../../packages/db/src/group-warmup.js';
const parameter=z.object({id:z.uuid()}).strict(),noQuery=(q:unknown)=>z.object({}).strict().parse(q??{});
/** Session and personal token use exactly the same profile scopes. Starting a
 * group program is not an interactive-only sales assignment operation. */
export async function groupWarmupRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.get('/v2/warmup',async req=>{const q=warmupReadSchema.extend({days:z.coerce.number().refine(n=>n===7||n===30).default(7)}).parse(req.query??{});
  return{data:await withProfileRequest(req,q.environment,{scope:'warmup:read',mutation:false},({db})=>groupWarmupOverview(db,q.environment,undefined,q.days),deps)};});
 app.get('/v2/warmup/programs/:id',async req=>{const {id}=parameter.parse(req.params),q=warmupReadSchema.extend({days:z.coerce.number().refine(n=>n===7||n===30).default(7)}).parse(req.query??{});
  return{data:await withProfileRequest(req,q.environment,{scope:'warmup:read',mutation:false},async({db})=>{const result=await groupWarmupOverview(db,q.environment,id,q.days);if(!result.programs.length)warmupError('WARMUP_PROGRAM_NOT_FOUND',404);return result.programs[0];},deps)};});
 app.get('/v2/warmup/groups',async req=>{const q=warmupReadSchema.parse(req.query??{});return{data:await withProfileRequest(req,q.environment,{scope:'warmup:read',mutation:false},({db})=>listWarmupGroups(db,q.environment),deps)};});
 app.post('/v2/warmup/groups/refresh',{bodyLimit:2048},async req=>{noQuery(req.query);const input=warmupReadSchema.extend({operationId:z.uuid(),accountIds:z.array(z.uuid()).min(1).max(20).refine(a=>new Set(a).size===a.length)}).parse(req.body);
  return{data:await withProfileRequest(req,input.environment,{scope:'warmup:write',mutation:true},({db,profile})=>requestGroupRefresh(db,input.environment,input.operationId,input.accountIds,profile.authority.membership.userId),deps)};});
 app.get('/v2/warmup/operations/:id',async req=>{const {id}=parameter.parse(req.params),q=warmupReadSchema.parse(req.query??{});return{data:await withProfileRequest(req,q.environment,{scope:'warmup:read',mutation:false},async({db})=>{
  const operation=(await db.query('SELECT id,result,created_at FROM warmup_program_operations WHERE workspace_id=$1 AND environment=$2 AND id=$3',[db.workspaceId,q.environment,id])).rows[0];
  if(!operation)warmupError('WARMUP_OPERATION_NOT_FOUND',404);
  const job=(await db.query("SELECT id,state,result,version FROM number_operations WHERE workspace_id=$1 AND environment=$2 AND id=$3 AND action='GROUP_REFRESH'",[db.workspaceId,q.environment,id])).rows[0];return job??{...operation,state:'SUCCEEDED'};
 },deps)};});
 app.post('/v2/warmup/preview',{bodyLimit:4096},async req=>{noQuery(req.query);const input=groupWarmupPreviewSchema.parse(req.body);return{data:await withProfileRequest(req,input.environment,{scope:'warmup:read',mutation:false},({db})=>previewGroupWarmup(db,input.environment,input.config,input.programId),deps)};});
 app.post('/v2/warmup/programs',{bodyLimit:4096},async req=>{noQuery(req.query);const input=groupWarmupCreateSchema.parse(req.body);return{data:await withProfileRequest(req,input.environment,{scope:'warmup:write',mutation:true},({db,profile})=>createGroupWarmup(db,input.environment,input.operationId,input.config,profile.authority.membership.userId),deps)};});
 app.post('/v2/warmup/programs/:id/commands',{bodyLimit:4096},async req=>{noQuery(req.query);const {id}=parameter.parse(req.params),input=groupWarmupCommandSchema.parse(req.body);return{data:await withProfileRequest(req,input.environment,{scope:'warmup:write',mutation:true},({db,profile})=>commandGroupWarmup(db,input.environment,id,input,profile.authority.membership.userId),deps)};});
 app.get('/v2/warmup/libraries',async req=>{const q=warmupReadSchema.parse(req.query??{});return{data:await withProfileRequest(req,q.environment,{scope:'warmup:read',mutation:false},({db})=>listWarmupLibraries(db,q.environment),deps)};});
 app.get('/v2/warmup/library',async req=>{const q=warmupReadSchema.extend({version:z.string().min(3).max(100),search:z.string().max(100).default(''),offset:z.coerce.number().int().min(0).max(2000).default(0),limit:z.coerce.number().int().min(1).max(20).default(10)}).parse(req.query??{});
  return{data:await withProfileRequest(req,q.environment,{scope:'warmup:read',mutation:false},async({db})=>{const scripts=(await libraryScripts(db,q.environment,q.version)).filter(s=>(s.label+' '+s.topic+' '+s.turns.map(t=>t.text).join(' ')).toLocaleLowerCase('es').includes(q.search.toLocaleLowerCase('es')));return{version:q.version,total:scripts.length,scripts:scripts.slice(q.offset,q.offset+q.limit),nextOffset:q.offset+q.limit<scripts.length?q.offset+q.limit:null};},deps)};});
 app.post('/v2/warmup/libraries/import',{bodyLimit:16*1024*1024},async req=>{noQuery(req.query);const input=libraryImportSchema.parse(req.body);return{data:await withProfileRequest(req,input.environment,{scope:'warmup:write',mutation:true},({db,profile})=>importWarmupLibrary(db,input,profile.authority.membership.userId),deps)};});
}
