import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {withProfileRequest,type ProfileRequestDependencies} from './profile-request.js';
import {goalCreateSchema,goalUpdateSchema} from '../../../packages/contracts/src/results.js';
import {createResultGoal,updateResultGoal,readResultGoal,listResultGoals,resultGoalOperation,readResultGoalOperation} from '../../../packages/db/src/result-goals.js';
const idSchema=z.object({id:z.uuid()}).strict(),empty=z.object({}).strict();
const operation=z.uuid(),list=z.object({after:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
/** REAL business goals only; no caller-controlled workspace or environment. */
export async function resultGoalRoutes(app:FastifyInstance,deps?:ProfileRequestDependencies){
 app.addHook('onRequest',async(_req,reply)=>{reply.header('Cache-Control','no-store').header('Vary','Cookie, Authorization, X-Commerce-Profile-Id, X-Commerce-Profile-Version');});
 app.get('/v2/goals',async req=>{const q=list.parse(req.query);return withProfileRequest(req,'REAL',{scope:'goals:read',mutation:false},({db})=>listResultGoals(db,q.after,q.limit),deps);});
 app.get('/v2/goals/operations/:id',async req=>{empty.parse(req.query);const {id}=idSchema.parse(req.params);return withProfileRequest(req,'REAL',{scope:'goals:read',mutation:false},async({db,profile})=>({data:await readResultGoalOperation(db,profile.authority.membership.userId,id)}),deps);});
 app.get('/v2/goals/:id',async req=>{empty.parse(req.query);const {id}=idSchema.parse(req.params);return withProfileRequest(req,'REAL',{scope:'goals:read',mutation:false},async({db})=>({data:await readResultGoal(db,id)}),deps);});
 app.post('/v2/goals',async req=>{
  empty.parse(req.query);const body=goalCreateSchema.parse(req.body),op=operation.parse(req.headers['idempotency-key']);
  return withProfileRequest(req,'REAL',{scope:'goals:write',mutation:true},async({db,profile})=>({data:await resultGoalOperation(db,profile.authority.membership.userId,op,{operation:'create',body},()=>createResultGoal(db,profile.authority.membership.userId,body))}),deps);
 });
 app.put('/v2/goals/:id',async req=>{
  empty.parse(req.query);const {id}=idSchema.parse(req.params),body=goalUpdateSchema.parse(req.body),op=operation.parse(req.headers['idempotency-key']);
  return withProfileRequest(req,'REAL',{scope:'goals:write',mutation:true},async({db,profile})=>({data:await resultGoalOperation(db,profile.authority.membership.userId,op,{operation:'update',id,body},()=>updateResultGoal(db,profile.authority.membership.userId,id,body))}),deps);
 });
}
