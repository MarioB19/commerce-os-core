import {createHash} from 'node:crypto';
import type {ProfileCatalog} from './profile-inventory.js';

export type ProfileRowScope=
 |{mode:'preserve';reason:string}
 |{mode:'scope';workspace:string;environment:string|null;roles:string[];initialize_permission:boolean};
export interface ProfileRowIsolationPolicy{schema_version:1;tables:Record<string,ProfileRowScope>}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
function demand(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function identifier(value:unknown):asserts value is string{demand(typeof value==='string'&&/^[A-Za-z_][A-Za-z_0-9]{0,62}$/.test(value),'PROFILE_ROW_IDENTIFIER_INVALID');}
const id=(v:string)=>{identifier(v);return '"'+v+'"';};
const lit=(v:string)=>"E'"+v.replaceAll('\\','\\\\').replaceAll("'","''")+"'";
const json=(v:unknown)=>lit(JSON.stringify(v))+'::jsonb';
const key=(schema:string,name:string)=>schema==='public'?name:schema+'.'+name;
function relation(value:string){const parts=value.split('.');demand(parts.length===1||parts.length===2,'PROFILE_ROW_IDENTIFIER_INVALID');const [schema,name]=parts.length===1?['public',parts[0]!]:parts;identifier(schema);identifier(name);demand(!schema.startsWith('pg_')&&schema!=='information_schema','PROFILE_ROW_SCHEMA_INVALID');return{schema,name,sql:id(schema)+'.'+id(name)};}

/** No I/O or authority grant. Other catalog gates remain separate prerequisites. */
export function planProfileRowIsolation(catalog:ProfileCatalog,policy:ProfileRowIsolationPolicy){
 demand(policy.schema_version===1&&policy.tables&&typeof policy.tables==='object','PROFILE_ROW_POLICY_INVALID');
 const privateTables=catalog.non_public_tables??[];
 demand(canonical(privateTables.map(t=>key(t.schema,t.name)).sort())===canonical(catalog.other_relations.filter(t=>['r','p'].includes(t.kind)).map(t=>key(t.schema,t.name)).sort()),'PROFILE_ROW_PRIVATE_CATALOG_REQUIRED');
 demand(!privateTables.length||Array.isArray(catalog.non_public_policies),'PROFILE_ROW_PRIVATE_POLICIES_REQUIRED');
 const tables=new Map([...catalog.tables.map(t=>[t.name,t] as const),...privateTables.map(t=>[key(t.schema,t.name),t] as const)]);
 demand(tables.size===catalog.tables.length+privateTables.length&&tables.size>0&&tables.size<=512,'PROFILE_ROW_TABLE_INVENTORY_INVALID');
 demand(canonical(Object.keys(policy.tables).sort())===canonical([...tables.keys()].sort()),'PROFILE_ROW_TABLE_UNCLASSIFIED');
 const policies=[...catalog.policies.map(p=>({...p,schema:'public'})),...(catalog.non_public_policies??[])],seenPolicies=new Set<string>();
 for(const p of policies){const k=key(p.schema,p.table);demand(['*','r','a','w','d'].includes(p.command??'')&&tables.has(k)&&!seenPolicies.has(k+'.'+p.name),'PROFILE_ROW_POLICY_INVENTORY_INVALID');seenPolicies.add(k+'.'+p.name);}
 const roles=new Map(catalog.roles.map(r=>[r.name,r]));demand(roles.size===catalog.roles.length,'PROFILE_ROW_ROLE_INVENTORY_INVALID');
 for(const r of catalog.roles)demand(!r.superuser&&!r.bypass_rls&&!r.create_role,'PROFILE_ROW_RUNTIME_PRIVILEGE');
 const changes:{table:string;workspace:string;environment:string|null;roles:string[];initialize_permission:boolean}[]=[];
 for(const [name,scope]of Object.entries(policy.tables)){
  relation(name);const table=tables.get(name)!;
  if(scope.mode==='preserve'){demand(Object.keys(scope).sort().join(',')==='mode,reason'&&typeof scope.reason==='string'&&scope.reason.trim().length>=12&&scope.reason.length<=512,'PROFILE_ROW_PRESERVATION_REASON_REQUIRED');continue;}
  demand(scope.mode==='scope'&&Object.keys(scope).sort().join(',')==='environment,initialize_permission,mode,roles,workspace','PROFILE_ROW_SCOPE_INVALID');
  identifier(scope.workspace);if(scope.environment!==null)identifier(scope.environment);
  demand(scope.workspace!==scope.environment,'PROFILE_ROW_SCOPE_INVALID');
  for(const name of [scope.workspace,scope.environment].filter((n):n is string=>n!==null)){const c=table.columns.find(c=>c.name===name);demand(c?.type==='text'&&c.not_null,'PROFILE_ROW_SCOPE_COLUMN_INVALID');}
  demand(Array.isArray(scope.roles)&&scope.roles.length>0&&scope.roles.length<=32&&new Set(scope.roles).size===scope.roles.length,'PROFILE_ROW_ROLE_INVALID');
  for(const role of scope.roles){identifier(role);demand(role!=='PUBLIC'&&roles.has(role)&&role!==table.owner,'PROFILE_ROW_ROLE_INVALID');}
  demand(typeof scope.initialize_permission==='boolean'&&(!scope.initialize_permission||!table.rls),'PROFILE_ROW_EXISTING_PERMISSION_PRESERVED');
  const suffix=digest(name).slice(0,20);demand(!policies.some(p=>key(p.schema,p.table)===name&&['profile_scope_guard_'+suffix,'profile_scope_access_'+suffix].includes(p.name)),'PROFILE_ROW_ALREADY_PLANNED');
  changes.push({table:name,workspace:scope.workspace,environment:scope.environment,roles:[...scope.roles].sort(),initialize_permission:scope.initialize_permission});
 }
 changes.sort((a,b)=>a.table.localeCompare(b.table));
 const all=[...tables.keys()].sort(),lines=['-- Local row-isolation proposal; no grant or installation authority.','DO $profile_rows$','BEGIN'," IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;",...all.map(t=>' LOCK TABLE '+relation(t).sql+' IN ACCESS EXCLUSIVE MODE;')];
 const inventory=all.map(t=>{const r=relation(t);return[r.schema,r.name];});
 lines.push(` IF (SELECT COALESCE(jsonb_agg(jsonb_build_array(n.nspname,c.relname) ORDER BY CASE WHEN n.nspname='public' THEN c.relname ELSE n.nspname||'.'||c.relname END COLLATE "C"),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN('r','p') AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema')<>${json(inventory)} THEN RAISE EXCEPTION 'PROFILE_ROW_TABLE_DRIFT'; END IF;`);
 for(const name of all){
  const t=tables.get(name)!,r=relation(name),expected={owner:t.owner,rls:t.rls,force_rls:t.force_rls,columns:t.columns};
  lines.push(` IF (SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'columns',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb)) FROM pg_class c WHERE c.oid=${lit(r.sql)}::regclass) IS DISTINCT FROM ${json(expected)} THEN RAISE EXCEPTION 'PROFILE_ROW_METADATA_DRIFT'; END IF;`);
  const previous=policies.filter(p=>key(p.schema,p.table)===name).map(({name,command,permissive,roles,using,with_check})=>({name,command,permissive,roles,using,with_check})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  lines.push(` IF (SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd::text,'permissive',p.polpermissive,'roles',ARRAY(SELECT CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x)::text END FROM unnest(p.polroles) x),'using',pg_get_expr(p.polqual,p.polrelid),'with_check',pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polname COLLATE "C"),'[]'::jsonb) FROM pg_policy p WHERE p.polrelid=${lit(r.sql)}::regclass)<>${json(previous)} THEN RAISE EXCEPTION 'PROFILE_ROW_POLICY_DRIFT'; END IF;`);
 }
 for(const role of [...new Set(changes.flatMap(c=>c.roles))].sort())lines.push(` IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=${lit(role)} AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication) THEN RAISE EXCEPTION 'PROFILE_ROW_ROLE_DRIFT'; END IF;`);
 for(const c of changes){
  const r=relation(c.table),suffix=digest(c.table).slice(0,20),scope=`${id(c.workspace)}=NULLIF(current_setting('app.workspace_id',true),'')`+(c.environment===null?'':` AND ${id(c.environment)}=NULLIF(current_setting('app.environment',true),'') AND current_setting('app.environment',true) IN('REAL','SIMULATION')`),to=c.roles.map(id).join(',');
  lines.push(` ALTER TABLE ${r.sql} ENABLE ROW LEVEL SECURITY;`,` ALTER TABLE ${r.sql} FORCE ROW LEVEL SECURITY;`,` CREATE POLICY ${id('profile_scope_guard_'+suffix)} ON ${r.sql} AS RESTRICTIVE TO ${to} USING(${scope}) WITH CHECK(${scope});`);
  if(c.initialize_permission)lines.push(` CREATE POLICY ${id('profile_scope_access_'+suffix)} ON ${r.sql} TO ${to} USING(${scope}) WITH CHECK(${scope});`);
 }
 lines.push('END','$profile_rows$;','');
 return{schema_version:1 as const,state:'LOCAL_ROW_ISOLATION_PROPOSAL' as const,catalog_sha256:digest(catalog),policy_sha256:digest(policy),changes,sql:lines.join('\n'),production_affected:false as const,global_isolation_verified:false as const};
}
