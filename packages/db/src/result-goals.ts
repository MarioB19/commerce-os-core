import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {hash,stableJson} from './index.js';
import {requireProfileId,type ProfileExecutor} from './profile-context.js';
import {goalFieldsSchema,goalCreateSchema,goalUpdateSchema,type GoalFields} from '../../contracts/src/results.js';
const uuid=z.uuid().transform(v=>v.toLowerCase());
export class ResultGoalError extends Error{constructor(code:string,readonly statusCode=409){super(code);this.name='ResultGoalError';}}
function need(v:unknown,code:string,status=409):asserts v{if(!v)throw new ResultGoalError(code,status);}
function decimal(v:string){return v.includes('.')?v.replace(/\.?0+$/,''):v;}
function view(row:Record<string,any>){return{id:row.id,workspace_id:row.workspace_id,version:row.version,active:row.active,fields:goalFieldsSchema.parse({from:row.from_day,to:row.to_day,currency:row.currency,family_id:row.family_id,variant_id:row.variant_id,metric:row.metric,target:decimal(row.target)}),created_at:new Date(row.created_at).toISOString(),updated_at:new Date(row.updated_at).toISOString()};}
const columns='id,workspace_id,version,active,from_day::text,to_day::text,currency,family_id,variant_id,metric,target::text,created_at,updated_at';
async function scope(db:ProfileExecutor){requireProfileId(db.workspaceId);const r=(await db.query("SELECT current_user AS role,current_setting('app.workspace_id',true) AS workspace")).rows[0];need(r?.role==='commerce_api'&&r.workspace===db.workspaceId,'GOAL_PROFILE_CONTEXT_REQUIRED',403);}
async function validateFamily(db:ProfileExecutor,f:GoalFields){
 if(f.family_id)need((await db.query("SELECT 1 FROM market_families WHERE workspace_id=$1 AND environment='REAL' AND id=$2",[db.workspaceId,f.family_id])).rowCount===1,'GOAL_FAMILY_NOT_FOUND',404);
 if(f.variant_id)need((await db.query("SELECT 1 FROM market_variants WHERE workspace_id=$1 AND environment='REAL' AND family_id=$2 AND id=$3",[db.workspaceId,f.family_id,f.variant_id])).rowCount===1,'GOAL_VARIANT_NOT_FOUND',404);
}
function parameters(f:GoalFields){return[f.family_id,f.variant_id,f.from,f.to,f.currency,f.metric,f.target];}
export async function readResultGoal(db:ProfileExecutor,id:string){await scope(db);id=uuid.parse(id);const r=(await db.query(`SELECT ${columns} FROM result_goals WHERE workspace_id=$1 AND id=$2`,[db.workspaceId,id])).rows[0];need(r,'GOAL_NOT_FOUND',404);return view(r);}
export async function listResultGoals(db:ProfileExecutor,after?:string,limit=50){await scope(db);if(after)uuid.parse(after);need(Number.isInteger(limit)&&limit>=1&&limit<=100,'GOAL_LIMIT_INVALID',400);const rows=(await db.query(`SELECT ${columns} FROM result_goals WHERE workspace_id=$1 AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3`,[db.workspaceId,after??null,limit+1])).rows;return{data:rows.slice(0,limit).map(view),next:rows.length>limit?rows[limit-1]!.id as string:null};}
export async function createResultGoal(db:ProfileExecutor,actor:string,input:unknown){
 await scope(db);requireProfileId(actor);const {fields:f}=goalCreateSchema.parse(input);await validateFamily(db,f);
 const row=(await db.query(`INSERT INTO result_goals(id,workspace_id,created_by,updated_by,family_id,variant_id,from_day,to_day,currency,metric,target)
  VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,[randomUUID(),db.workspaceId,actor,...parameters(f)])).rows[0];const result=view(row);
 await db.query("INSERT INTO result_goal_events(workspace_id,goal_id,version,event,actor_id,after_state) VALUES($1,$2,1,'CREATED',$3,$4)",[db.workspaceId,result.id,actor,result]);return result;
}
export async function updateResultGoal(db:ProfileExecutor,actor:string,id:string,input:unknown){
 await scope(db);requireProfileId(actor);id=uuid.parse(id);const q=goalUpdateSchema.parse(input);
 const old=(await db.query(`SELECT ${columns} FROM result_goals WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[db.workspaceId,id])).rows[0];need(old,'GOAL_NOT_FOUND',404);need(old.version===q.expected_version,'GOAL_VERSION_CONFLICT');await validateFamily(db,q.fields);
 const row=(await db.query(`UPDATE result_goals SET family_id=$4,variant_id=$5,from_day=$6,to_day=$7,currency=$8,metric=$9,target=$10,
  active=$11,updated_by=$3,version=version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 RETURNING ${columns}`,[db.workspaceId,id,actor,...parameters(q.fields),q.active])).rows[0];const result=view(row);
 await db.query("INSERT INTO result_goal_events(workspace_id,goal_id,version,event,actor_id,before_state,after_state) VALUES($1,$2,$3,'UPDATED',$4,$5,$6)",[db.workspaceId,id,result.version,actor,view(old),result]);return result;
}
export async function resultGoalOperation<T>(db:ProfileExecutor,actor:string,operationId:string,request:unknown,work:()=>Promise<T>):Promise<T>{
 await scope(db);requireProfileId(actor);operationId=uuid.parse(operationId);const requestHash=hash(stableJson(request));
 await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['result-goal-operation',db.workspaceId,actor,operationId])]);
 const prior=(await db.query('SELECT request_hash,result FROM result_goal_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3',[db.workspaceId,actor,operationId])).rows[0];
 if(prior){need(prior.request_hash===requestHash,'GOAL_OPERATION_CONFLICT');return prior.result as T;}
 const result=await work();await db.query('INSERT INTO result_goal_operations(workspace_id,actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4,$5)',[db.workspaceId,actor,operationId,requestHash,result]);return result;
}
export async function readResultGoalOperation(db:ProfileExecutor,actor:string,id:string){await scope(db);requireProfileId(actor);id=uuid.parse(id);return(await db.query('SELECT result FROM result_goal_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3',[db.workspaceId,actor,id])).rows[0]?.result??null;}
