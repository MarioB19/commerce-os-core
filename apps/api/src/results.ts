import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {resultOptions} from '../../../packages/db/src/result-options.js';
import {resultFiltersSchema,resultOptionQuerySchema} from '../../../packages/contracts/src/results.js';
import {resultsReport} from '../../../packages/db/src/results.js';
import {readResultGoal} from '../../../packages/db/src/result-goals.js';
import {resultGoalProgress} from '../../../packages/domain/src/sales/results.js';
import type {ProfileExecutor} from '../../../packages/db/src/profile-context.js';
async function report(db:ProfileExecutor,input:unknown){try{return await resultsReport(db,input);}catch(error){if(error instanceof Error&&error.message==='RESULT_PROJECTION_NOT_READY')throw Object.assign(error,{statusCode:503,code:'RESULT_PROJECTION_NOT_READY',publicMessage:'Tus resultados se están preparando. Vuelve a consultarlos en un minuto.'});throw error;}}
/** Composition remains inside the same selected, authorized database context. */
export async function resultsRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');});
 app.get('/v2/results/options',async req=>{const q=resultOptionQuerySchema.parse(req.query);return withProfileRequest(req,'REAL',{scope:'results:read',mutation:false},({db})=>resultOptions(db,q),deps);});
 app.get('/v2/results',async req=>{const q=resultFiltersSchema.parse(req.query);return withProfileRequest(req,'REAL',{scope:'results:read',mutation:false},async({db})=>({data:await report(db,q)}),deps);});
 app.get('/v2/goals/:id/progress',async req=>{
  z.object({}).strict().parse(req.query);const {id}=z.object({id:z.uuid()}).strict().parse(req.params);
  return withProfileRequest(req,'REAL',{scope:'goals:read',mutation:false},async({db})=>{
   const goal=await readResultGoal(db,id),f=goal.fields,result=await report(db,{from:f.from,to:f.to,currency:f.currency,...(f.family_id?{family_id:f.family_id}:{}),...(f.variant_id?{variant_id:f.variant_id}:{})});
   const today=(await db.query("SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS day",[result.timezone])).rows[0].day as string;
   return{data:{goal,progress:resultGoalProgress(f,result.summary,today),measured_at:result.measured_at}};
  },deps);
 });
}
