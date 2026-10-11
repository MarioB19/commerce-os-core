import {defaultOperationalSettings,operationalSettingsSchema,type Environment,type OperationalSettings} from '../../contracts/src/index.js';
import type {QueryExecutor} from './index.js';

export interface OperationalSettingsRecord {version:number;body:OperationalSettings;updated_at:Date|null;updated_by:string|null;release_hold:boolean;release_hold_at:Date|null}
// Advisory locks also protect the absent (version 0) row. Call lock options only inside a transaction.
export async function readOperationalSettings(client:QueryExecutor,workspace:string,environment:Environment,options:{lock?:'share'|'update'}={}):Promise<OperationalSettingsRecord>{
  if(options.lock)await client.query(`SELECT ${options.lock==='update'?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared'}(hashtextextended($1,0))`,[`operations:${workspace}:${environment}`]);
  const row=(await client.query(`SELECT version,body,updated_at,updated_by,release_hold,release_hold_at FROM operational_settings WHERE workspace_id=$1 AND environment=$2${options.lock==='update'?' FOR UPDATE':''}`,[workspace,environment])).rows[0];
  if(!row)return{version:0,body:{...defaultOperationalSettings},updated_at:null,updated_by:null,release_hold:false,release_hold_at:null};
  const body=operationalSettingsSchema.parse(row.body);
  return{...row,body:row.release_hold?{...body,dispatch_frozen:true}:body};
}

export async function writeOperationalSettings(client:QueryExecutor,workspace:string,environment:Environment,expectedVersion:number,body:OperationalSettings,actorId:string):Promise<OperationalSettingsRecord>{
  const current=await readOperationalSettings(client,workspace,environment,{lock:'update'});
  if(current.release_hold)throw Object.assign(new Error('RELEASE_HOLD_ACTIVE'),{statusCode:409,code:'RELEASE_HOLD_ACTIVE'});
  if(current.version!==expectedVersion)throw Object.assign(new Error('VERSION_CONFLICT'),{statusCode:409,code:'VERSION_CONFLICT'});
  const parsed=operationalSettingsSchema.parse(body);
  const row=(await client.query(`INSERT INTO operational_settings(workspace_id,environment,version,body,updated_by) VALUES($1,$2,1,$3,$4) ON CONFLICT(workspace_id,environment) DO UPDATE SET version=operational_settings.version+1,body=EXCLUDED.body,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING version,body,updated_at,updated_by,release_hold,release_hold_at`,[workspace,environment,parsed,actorId])).rows[0];
  return {...row,body:operationalSettingsSchema.parse(row.body)};
}

// Integration changes and settings mutations share one revision and lock order.
export async function bumpOperationalRevision(client:QueryExecutor,workspace:string,environment:Environment,actorId='integration-change'):Promise<OperationalSettingsRecord>{
  const current=await readOperationalSettings(client,workspace,environment,{lock:'update'});
  return writeOperationalSettings(client,workspace,environment,current.version,{...current.body,dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false},actorId);
}
