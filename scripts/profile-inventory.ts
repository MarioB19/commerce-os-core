import pg from 'pg';
import {readFile,open} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readProfileCatalog,assessProfileCatalog,type ProfileInventoryPolicy} from '../packages/db/src/profile-inventory.js';

export function localInventoryTarget(raw:string|undefined) {
  if(!raw)throw new Error('PROFILE_INVENTORY_DATABASE_URL_REQUIRED');
  let target:URL;try{target=new URL(raw);}catch{throw new Error('PROFILE_INVENTORY_TARGET_INVALID');}
  if(!['postgres:','postgresql:'].includes(target.protocol)||!['127.0.0.1','localhost','[::1]'].includes(target.hostname)||target.hash||target.search) {
    throw new Error('PROFILE_INVENTORY_LOCAL_DATABASE_REQUIRED');
  }
  if(!/^\/[a-zA-Z0-9_-]+$/.test(target.pathname))throw new Error('PROFILE_INVENTORY_DATABASE_REQUIRED');
  return raw;
}
async function main() {
  if(process.argv.length!==4||process.argv[2]!=='--output')throw new Error('USAGE_PROFILE_INVENTORY_OUTPUT_REQUIRED');
  const output=resolve(process.argv[3]);
  const connectionString=localInventoryTarget(process.env.PROFILE_INVENTORY_DATABASE_URL);
  const policy=JSON.parse(await readFile(new URL('../packages/db/profile-inventory-policy.json',import.meta.url),'utf8')) as ProfileInventoryPolicy;
  // Reserve output before connecting; neither symlinks nor previous evidence is overwritten.
  const file=await open(output,'wx',0o600);
  const pool=new pg.Pool({connectionString,max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:1000});
  try {
    const catalog=await readProfileCatalog(pool,policy.runtime_roles);
    const assessment=assessProfileCatalog(catalog,policy);
    await file.writeFile(JSON.stringify({observed_at:new Date().toISOString(),assessment,catalog},null,2)+'\n');
    await file.sync();
    console.log(JSON.stringify({status:'LOCAL_SCHEMA_METADATA_CAPTURED',issue_count:assessment.issues.length,behavioral_isolation_verified:false,production_installation_proven:false}));
  } finally {await file.close();await pool.end();}
}
if(process.argv[1]===fileURLToPath(import.meta.url))main().catch(()=>{console.error('PROFILE_INVENTORY_FAILED_PRESERVE_OUTPUT');process.exitCode=2;});
