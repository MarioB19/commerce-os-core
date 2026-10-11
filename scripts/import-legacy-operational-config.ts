/** Explicit one-time private migration. No remote provider call, no secret-bearing output. */
import {readdir,readFile,lstat} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import {pool,withTransaction,bumpOperationalRevision} from '../packages/db/src/index.js';
import {readIntegrationSettings,saveIntegrationSetting} from '../packages/db/src/integration-settings.js';
import {isLegacyIntegrationVariable,planLegacyIntegrations,type LegacyEnv} from '../packages/db/src/legacy-integrations.js';
async function main(){
 const args=process.argv.slice(2),dirIndex=args.indexOf('--dir');if(dirIndex<0||!args[dirIndex+1]||args.length!==2)throw new Error('LEGACY_PRIVATE_DIRECTORY_REQUIRED');const directory=resolve(args[dirIndex+1]!);if(!isAbsolute(args[dirIndex+1]!))throw new Error('LEGACY_ABSOLUTE_DIRECTORY_REQUIRED');
 const directoryStat=await lstat(directory);if(!directoryStat.isDirectory()||directoryStat.isSymbolicLink()||directoryStat.mode&0o077)throw new Error('LEGACY_PRIVATE_DIRECTORY_PERMISSIONS');
 const workspace=process.env.WORKSPACE_ID;if(!workspace)throw new Error('LEGACY_WORKSPACE_REQUIRED');
 const already=(await pool.query("SELECT 1 FROM integration_imports WHERE workspace_id=$1 AND import_key='legacy-env-v1'",[workspace])).rowCount;if(already)return{already_imported:true,imported_profiles:0,external_calls:0};
 const env:LegacyEnv={};let files=0;const sources=[directory];const pilot=join(directory,'pilot');try{const stat=await lstat(pilot);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.mode&0o077)throw new Error('LEGACY_PRIVATE_DIRECTORY_PERMISSIONS');sources.push(pilot);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 for(const sourceDir of sources)for(const file of(await readdir(sourceDir)).filter(name=>/^[a-zA-Z0-9_.-]+\.env$/.test(name)).sort()){
  const path=join(sourceDir,file),stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.size>262144)throw new Error('LEGACY_PRIVATE_FILE_PERMISSIONS');
  const source=await readFile(path,'utf8');files++;
  for(const line of source.split(/\r?\n/)){const match=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(!match||!isLegacyIntegrationVariable(match[1]!))continue;const key=match[1]!,value=match[2]!.replace(/^(['"])(.*)\1$/,'$2');if(key in env&&env[key]!==value)throw new Error('LEGACY_SOURCE_CONFIGURATION_CONFLICT');env[key]=value;}
 }
 const plans=planLegacyIntegrations(env,workspace);
 return withTransaction(async c=>{
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['legacy-integrations:'+workspace]);if((await c.query("SELECT 1 FROM integration_imports WHERE workspace_id=$1 AND import_key='legacy-env-v1'",[workspace])).rowCount)return{already_imported:true,imported_profiles:0,external_calls:0};
  // Lock policy first; imported credentials never enable operations.
  await bumpOperationalRevision(c,workspace,'REAL','private-integration-import');let imported=0,kept=0,disabled=0;
  for(const plan of plans){if(await readIntegrationSettings(c,workspace,'REAL',plan.key,{secrets:false})){kept++;continue;}await saveIntegrationSetting(c,workspace,'REAL',plan.key,plan.patch,'private-integration-import');imported++;if(!plan.patch.enabled)disabled++;}
  const report={source_files:files,imported_profiles:imported,existing_profiles_preserved:kept,profiles_requiring_setup:disabled,external_calls:0,real_dispatch_frozen:true};await c.query("INSERT INTO integration_imports(workspace_id,import_key,result) VALUES($1,'legacy-env-v1',$2)",[workspace,report]);return report;
 });
}
try{console.log(JSON.stringify(await main()));}catch(error){const code=error instanceof Error&&/^LEGACY_[A-Z_]+$/.test(error.message)?error.message:'LEGACY_IMPORT_FAILED';console.error(JSON.stringify({ok:false,code,external_calls:0}));process.exitCode=1;}finally{await pool.end();}
