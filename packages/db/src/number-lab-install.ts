import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';

/** V7 F6 (RF-19, ADR number-laboratory): installation of the dedicated lab
 * engine database. The engine runs the canonical schema of migrations
 * 0001–0068 plus the original transitions 001/010/012 and the 021 lab
 * components, in its own logical database `commerce_lab_engine_*`, with its
 * own NOLOGIN roles and one LOGIN per role (SET ROLE on connect). The control
 * login belongs to the main database (role commerce_number_lab, 0086).
 *
 * Idempotent: an existing installation is verified, never rebuilt or reseeded.
 * Passwords are generated here and returned once for the root-owned env file;
 * they are never logged. Requires a connection that may CREATE DATABASE/ROLE. */
const ROOT=new URL('../',import.meta.url);
const TRANSITIONS=['001_profile_identity.sql','010_continuous_authorization.sql','012_continuous_effects.sql'];
const COMPONENTS=['021_number_lab_engine.sql','021_number_lab_materialization.sql','021_number_lab_driver.sql','021_number_lab_transport.sql'];
export interface LabEngineSource {name:string;sql:string}
export async function numberLabEngineSources():Promise<LabEngineSource[]>{
 const migrations=(await readdir(new URL('migrations/',ROOT))).filter(n=>/^\d{4}_.+\.sql$/.test(n)&&n<'0069').sort();
 if(migrations.length!==68)throw new Error('LAB_ENGINE_MIGRATIONS_CHANGED');
 const sources:LabEngineSource[]=[];
 for(const name of migrations)sources.push({name:'migrations/'+name,sql:await readFile(new URL('migrations/'+name,ROOT),'utf8')});
 for(const name of TRANSITIONS)sources.push({name:'profile-transition/'+name,sql:await readFile(new URL('profile-transition/'+name,ROOT),'utf8')});
 for(const name of COMPONENTS)sources.push({name:'profile-transition/components/'+name,sql:await readFile(new URL('profile-transition/components/'+name,ROOT),'utf8')});
 return sources;
}
/** Identity of the engine code installed: changes whenever any source changes. */
export function numberLabEngineSha256(sources:LabEngineSource[]){
 const h=createHash('sha256');for(const s of sources){h.update(s.name);h.update('\0');h.update(s.sql);h.update('\0');}return h.digest('hex');
}
export interface LabInstallation {database:string;installationId:string;engineSha256:string;created:boolean;
 logins?:{engine:{user:string;password:string};seed:{user:string;password:string};control:{user:string;password:string};source:{user:string;password:string}}}
const ident=(v:string)=>{if(!/^[a-z][a-z0-9_]{2,62}$/.test(v))throw new Error('LAB_IDENTIFIER_INVALID');return '"'+v+'"';};
export async function installNumberLabEngine(adminUrl:string,options:{database?:string;suffix?:string}={}):Promise<LabInstallation>{
 const sources=await numberLabEngineSources(),engineSha256=numberLabEngineSha256(sources);
 const main=new pg.Client({connectionString:adminUrl});await main.connect();
 try{
  const existing=(await main.query("SELECT datname FROM pg_database WHERE datname ~ '^commerce_lab_engine_[a-z0-9_]+$' ORDER BY datname")).rows.map(r=>String(r.datname));
  if(existing.length>1)throw new Error('LAB_ENGINE_MULTIPLE_DATABASES');
  const database=options.database??existing[0]??'commerce_lab_engine_'+(options.suffix??randomBytes(4).toString('hex'));
  if(!/^commerce_lab_engine_[a-z0-9_]+$/.test(database))throw new Error('LAB_ENGINE_DATABASE_NAME');
  const engineUrl=new URL(adminUrl);engineUrl.pathname='/'+database;
  if(existing.includes(database)){
   const engine=new pg.Client({connectionString:engineUrl.toString()});await engine.connect();
   try{
    const row=(await engine.query('SELECT installation_id::text,database_name,engine_sha256 FROM commerce_number_lab_engine.installation WHERE singleton')).rows[0];
    if(!row||row.database_name!==database)throw new Error('LAB_ENGINE_INSTALLATION_INCOMPLETE');
    if(row.engine_sha256!==engineSha256)throw new Error('LAB_ENGINE_SOURCES_CHANGED');
    return{database,installationId:row.installation_id,engineSha256,created:false};
   }finally{await engine.end();}
  }
  await main.query('CREATE DATABASE '+ident(database));
  const engine=new pg.Client({connectionString:engineUrl.toString()});await engine.connect();
  try{
   // Exact canonical sources, each in its own transaction, in order.
   for(const s of sources){await engine.query('BEGIN');try{await engine.query(s.sql);await engine.query('COMMIT');}catch(e){await engine.query('ROLLBACK');throw Object.assign(new Error('LAB_ENGINE_SOURCE_FAILED'),{source:s.name,cause:e});}}
   const installationId=randomUUID();
   await engine.query('INSERT INTO commerce_number_lab_engine.installation(installation_id,database_name,engine_sha256) VALUES($1,$2,$3)',[installationId,database,engineSha256]);
   const suffix=database.slice('commerce_lab_engine_'.length).slice(0,20);
   const login=async(client:pg.Client,user:string,role:string)=>{const password=randomBytes(32).toString('hex');
    await client.query(`CREATE ROLE ${ident(user)} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`);
    await client.query(`GRANT ${ident(role)} TO ${ident(user)}`);return{user,password};};
   const logins={engine:await login(engine,'lab_engine_'+suffix,'commerce_lab_engine'),seed:await login(engine,'lab_seed_'+suffix,'commerce_lab_engine_seed'),
    control:await login(main,'lab_control_'+suffix,'commerce_number_lab'),
    // Material custody reads the REAL asset version it copies (commerce_api, read path only).
    source:await login(main,'lab_source_'+suffix,'commerce_api')};
   await main.query(`GRANT CONNECT ON DATABASE ${ident(database)} TO ${ident(logins.engine.user)},${ident(logins.seed.user)}`).catch(()=>undefined);
   return{database,installationId,engineSha256,created:true,logins};
  }finally{await engine.end();}
 }finally{await main.end();}
}
/** Connection URLs for the lab worker from the installation and its logins. */
export function numberLabUrls(adminUrl:string,installation:LabInstallation){
 if(!installation.logins)throw new Error('LAB_LOGINS_ALREADY_ISSUED');
 const make=(database:string|null,login:{user:string;password:string})=>{const u=new URL(adminUrl);if(database)u.pathname='/'+database;u.username=login.user;u.password=login.password;return u.toString();};
 return{LAB_ENGINE_DATABASE_URL:make(installation.database,installation.logins.engine),LAB_SEED_DATABASE_URL:make(installation.database,installation.logins.seed),
  LAB_CONTROL_DATABASE_URL:make(null,installation.logins.control),LAB_SOURCE_DATABASE_URL:make(null,installation.logins.source),LAB_ENGINE_DATABASE:installation.database,LAB_INSTALLATION_ID:installation.installationId,LAB_ENGINE_SHA256:installation.engineSha256};
}
