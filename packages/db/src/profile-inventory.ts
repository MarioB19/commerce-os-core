import {createHash} from 'node:crypto';
import type {ProfileConnection, ProfilePool} from './profile-context.js';

export interface ProfileCatalog {
  tables: {name:string; owner:string; rls:boolean; force_rls:boolean; columns:{name:string;type:string;not_null:boolean}[]}[];
  foreign_keys: {name:string; table:string; columns:string[]; referenced_table:string; referenced_schema:string; referenced_columns:string[]; validated:boolean;deferrable?:boolean;initially_deferred?:boolean;match_type?:string;on_update?:string;on_delete?:string}[];
  non_public_tables?: (ProfileCatalog['tables'][number]&{schema:string})[];
  non_public_foreign_keys?: (ProfileCatalog['foreign_keys'][number]&{schema:string})[];
  policies: {table:string;name:string;command?:string;permissive:boolean;roles:string[];using:string|null;with_check:string|null}[];
  non_public_policies?: (ProfileCatalog['policies'][number]&{schema:string})[];
  primary_keys?: {schema:string;table:string;name:string;columns:string[];deferrable:boolean;initially_deferred:boolean}[];
  roles: {name:string;superuser:boolean;bypass_rls:boolean;can_login:boolean;create_role:boolean;runtime_memberships:string[]}[];
  privileged_functions: {identity:string;owner:string;config:string[];definition_hash:string}[];
  grants: {schema:string;kind:string;table:string;grantee:string;privilege:string;grantable:boolean}[];
  column_grants:{schema:string;table:string;column:string;grantee:string;privilege:string;grantable:boolean}[];
  schema_grants:{schema:string;owner:string;grantee:string;privilege:string;grantable:boolean}[];
  function_grants:{identity:string;owner:string;security_definer:boolean;grantee:string;privilege:string;grantable:boolean}[];
  default_grants:{owner:string;schema:string|null;object_type:string;grantee:string;privilege:string}[];
  views:{schema:string;kind:string;name:string;owner:string;options:string[];definition_hash:string}[];
  other_relations:{schema:string;name:string;kind:string;owner:string}[];
  triggers:{schema:string;table:string;name:string;enabled:string;function_identity:string;definition_hash:string}[];
  migrations: {name:string;sha256:string}[];
}
export interface ProfileInventoryPolicy {
  schema_version:number; source_sha:string; global_identity_tables:string[]; private_tables:string[];
  children_requiring_tenant:Record<string,string>;runtime_roles:string[];
  reviewed_security_definers:Record<string,string>; reviewed_policies:Record<string,string>;
  reviewed_views:Record<string,string>;reviewed_triggers:Record<string,string>;
}
export interface IsolationIssue {code:string;object:string}

// Read catalog metadata only. Never inspect row contents, credentials or counts.
export const catalogQueries = {
  tables: `SELECT c.relname name, pg_get_userbyid(c.relowner) owner,
    c.relrowsecurity rls, c.relforcerowsecurity force_rls,
    COALESCE(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull)
      ORDER BY a.attnum) FILTER(WHERE a.attnum IS NOT NULL),'[]'::jsonb) columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN('r','p') GROUP BY c.oid ORDER BY c.relname`,
  foreign_keys: `SELECT k.conname name, t.relname "table", r.relname referenced_table, rn.nspname referenced_schema,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.pos) columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,pos)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.pos) referenced_columns,
    k.convalidated validated,k.condeferrable deferrable,k.condeferred initially_deferred,
    k.confmatchtype::text match_type,k.confupdtype::text on_update,k.confdeltype::text on_delete
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class r ON r.oid=k.confrelid
    JOIN pg_namespace rn ON rn.oid=r.relnamespace
    WHERE n.nspname='public' AND k.contype='f' ORDER BY t.relname,k.conname`,
  non_public_tables: `SELECT n.nspname "schema",c.relname name, pg_get_userbyid(c.relowner) owner,
    c.relrowsecurity rls, c.relforcerowsecurity force_rls,
    COALESCE(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull)
      ORDER BY a.attnum) FILTER(WHERE a.attnum IS NOT NULL),'[]'::jsonb) columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname<>'public' AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p') GROUP BY c.oid,n.nspname ORDER BY n.nspname,c.relname`,
  non_public_foreign_keys: `SELECT n.nspname "schema",k.conname name, t.relname "table", r.relname referenced_table, rn.nspname referenced_schema,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.pos) columns,
    ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,pos)
      JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.pos) referenced_columns,
    k.convalidated validated,k.condeferrable deferrable,k.condeferred initially_deferred,
    k.confmatchtype::text match_type,k.confupdtype::text on_update,k.confdeltype::text on_delete
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class r ON r.oid=k.confrelid
    JOIN pg_namespace rn ON rn.oid=r.relnamespace
    WHERE n.nspname<>'public' AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND k.contype='f' ORDER BY n.nspname,t.relname,k.conname`,
  policies: `SELECT c.relname "table", p.polname name,p.polcmd::text command,p.polpermissive permissive,
    ARRAY(SELECT CASE WHEN id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(id)::text END FROM unnest(p.polroles) id) roles,
    pg_get_expr(p.polqual,p.polrelid) "using",pg_get_expr(p.polwithcheck,p.polrelid) with_check
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,p.polname`,
  non_public_policies: `SELECT n.nspname "schema",c.relname "table",p.polname name,p.polcmd::text command,p.polpermissive permissive,
    ARRAY(SELECT CASE WHEN id=0 THEN 'PUBLIC' ELSE pg_get_userbyid(id)::text END FROM unnest(p.polroles) id) roles,
    pg_get_expr(p.polqual,p.polrelid) "using",pg_get_expr(p.polwithcheck,p.polrelid) with_check
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname<>'public' AND left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,c.relname,p.polname`,
  primary_keys: `SELECT n.nspname "schema",t.relname "table",k.conname name,
    ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos)
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.pos) columns,
    k.condeferrable deferrable,k.condeferred initially_deferred
    FROM pg_constraint k JOIN pg_class t ON t.oid=k.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND k.contype='p' ORDER BY n.nspname,t.relname,k.conname`,
  roles: `WITH RECURSIVE members(root,member) AS (
    SELECT oid,oid FROM pg_roles WHERE rolname=ANY($1::text[])
    UNION SELECT x.root,m.member FROM members x JOIN pg_auth_members m ON m.roleid=x.member),
    authorities(root,member) AS (
      SELECT root,member FROM members
      UNION SELECT x.root,m.roleid FROM authorities x JOIN pg_auth_members m ON m.member=x.member)
    SELECT r.rolname name,r.rolsuper superuser,r.rolbypassrls bypass_rls,r.rolcanlogin can_login,r.rolcreaterole create_role,
    array_agg(DISTINCT parent.rolname::text ORDER BY parent.rolname::text) runtime_memberships
    FROM authorities x JOIN pg_roles r ON r.oid=x.member JOIN pg_roles parent ON parent.oid=x.root
    GROUP BY r.rolname,r.rolsuper,r.rolbypassrls,r.rolcanlogin,r.rolcreaterole ORDER BY r.rolname`,
  privileged_functions: `SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) identity,pg_get_userbyid(p.proowner) owner,
    COALESCE(p.proconfig,'{}'::text[]) config,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') definition_hash
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND p.prosecdef ORDER BY identity`,
  grants: `SELECT n.nspname "schema",c.relkind kind,c.relname "table",CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,
    a.privilege_type privilege,a.is_grantable grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','f','v','m','S') ORDER BY n.nspname,c.relname,grantee,privilege`,
  column_grants: `SELECT n.nspname "schema",c.relname "table",att.attname "column",
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,
    a.privilege_type privilege,a.is_grantable grantable
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute att ON att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped
    CROSS JOIN LATERAL aclexplode(att.attacl) a
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p','f','v','m') ORDER BY n.nspname,c.relname,att.attname,grantee,privilege`,
  schema_grants: `SELECT n.nspname "schema",pg_get_userbyid(n.nspowner) owner,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,
    a.privilege_type privilege,a.is_grantable grantable
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY n.nspname,grantee,privilege`,
  function_grants: `SELECT format('%I.%I(%s)',n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) identity,
    pg_get_userbyid(p.proowner) owner,p.prosecdef security_definer,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,
    a.privilege_type privilege,a.is_grantable grantable
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' ORDER BY identity,grantee,privilege`,
  default_grants: `SELECT pg_get_userbyid(d.defaclrole) owner,n.nspname "schema",d.defaclobjtype object_type,
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END grantee,a.privilege_type privilege
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    ORDER BY owner,"schema",object_type,grantee,privilege`,
  views: `SELECT n.nspname "schema",c.relkind kind,c.relname name,pg_get_userbyid(c.relowner) owner,
    COALESCE(c.reloptions,'{}'::text[]) options,
    encode(sha256(convert_to(pg_get_viewdef(c.oid,true),'UTF8')),'hex') definition_hash
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('v','m')
    ORDER BY n.nspname,c.relname`,
  other_relations: `SELECT n.nspname "schema",c.relname name,c.relkind kind,pg_get_userbyid(c.relowner) owner
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
    AND (c.relkind IN('f','S') OR (n.nspname<>'public' AND c.relkind IN('r','p'))) ORDER BY n.nspname,c.relname`,
  triggers: `SELECT n.nspname "schema",c.relname "table",t.tgname name,t.tgenabled enabled,format('%I.%I(%s)',fn.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) function_identity,
    encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex') definition_hash
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace fn ON fn.oid=p.pronamespace
    WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND NOT t.tgisinternal ORDER BY n.nspname,c.relname,t.tgname`,
  migrations: 'SELECT name,sha256 FROM public.schema_migrations ORDER BY name',
} as const;

export async function readProfileCatalog(pool:ProfilePool, runtimeRoles:string[]):Promise<ProfileCatalog> {
  const client:ProfileConnection=await pool.connect();let begun=false,discard=false;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');begun=true;
    await client.query("SET LOCAL statement_timeout = '15s'");
    const catalog={} as Record<keyof ProfileCatalog,unknown>;
    for(const [name,sql] of Object.entries(catalogQueries)) {
      catalog[name as keyof ProfileCatalog]=(await client.query(sql,name==='roles'?[runtimeRoles]:[])).rows;
    }
    await client.query('ROLLBACK');begun=false;
    return catalog as unknown as ProfileCatalog;
  } catch(error) {
    if(begun){try{await client.query('ROLLBACK');}catch{discard=true;}}
    else discard=true;
    throw error;
  } finally {client.release(discard||undefined);}
}

/** Fail closed on unknown objects. Findings remain findings in baseline mode;
 * this is an inventory, never an installation or RLS behavioral proof.
 */
export function assessProfileCatalog(catalog:ProfileCatalog, policy:ProfileInventoryPolicy) {
  const issues:IsolationIssue[]=[];
  const add=(code:string,object:string)=>issues.push({code,object});
  const privateTables=new Set(policy.private_tables),globalTables=new Set(policy.global_identity_tables);
  const known=new Set([...privateTables,...globalTables]);
  if(policy.schema_version!==1 || !/^[a-f0-9]{40}$/.test(policy.source_sha) || known.size!==privateTables.size+globalTables.size || privateTables.size!==policy.private_tables.length || globalTables.size!==policy.global_identity_tables.length || Object.entries(policy.children_requiring_tenant).some(([child,parent])=>!privateTables.has(child)||!privateTables.has(parent))) {
    throw new Error('PROFILE_INVENTORY_POLICY_INVALID');
  }
  const tableNames=new Set(catalog.tables.map(t=>t.name));
  if(tableNames.size!==catalog.tables.length)throw new Error('PROFILE_CATALOG_DUPLICATE_TABLE');
  const runtimes=new Set(catalog.roles.map(r=>r.name));
  for(const role of policy.runtime_roles)if(!runtimes.has(role))add('RUNTIME_ROLE_MISSING',role);
  for(const role of catalog.roles) {
    if(role.superuser||role.bypass_rls)add('RUNTIME_BYPASS_RLS',role.name);
    if(role.create_role||['pg_read_server_files','pg_write_server_files','pg_execute_server_program'].includes(role.name))add('RUNTIME_PRIVILEGE_ESCALATION',role.name);
  }
  for(const name of known)if(!tableNames.has(name))add('TABLE_MISSING',name);
  for(const table of catalog.tables) {
    if(!known.has(table.name)){add('TABLE_NOT_CLASSIFIED',table.name);continue;}
    if(!privateTables.has(table.name))continue;
    const tenant=table.columns.find(c=>c.name==='workspace_id');
    if(!tenant)add('TENANT_COLUMN_MISSING',table.name);
    else {if(!tenant.not_null)add('TENANT_COLUMN_NULLABLE',table.name);if(tenant.type!=='text')add('TENANT_COLUMN_TYPE_CHANGED',table.name);}
    if(!table.rls)add('RLS_DISABLED',table.name);
    if(!table.force_rls)add('RLS_NOT_FORCED',table.name);
    if(runtimes.has(table.owner))add('RUNTIME_OWNS_PRIVATE_TABLE',table.name);
    if(!catalog.policies.some(p=>p.table===table.name))add('RLS_POLICY_MISSING',table.name);
  }
  for(const fk of catalog.foreign_keys)if(privateTables.has(fk.table)&&privateTables.has(fk.referenced_table)) {
    const index=fk.columns.indexOf('workspace_id');
    if(fk.referenced_schema!=='public'||index===-1||fk.referenced_columns[index]!=='workspace_id')add('PRIVATE_FK_NOT_TENANT_SCOPED',fk.table+'.'+fk.name);
    if(!fk.validated)add('PRIVATE_FK_NOT_VALIDATED',fk.table+'.'+fk.name);
  }
  for(const p of catalog.policies)if(privateTables.has(p.table)) {
    const digest=createHash('sha256').update(JSON.stringify(p)).digest('hex');
    if(policy.reviewed_policies[p.table+'.'+p.name]!==digest)add('RLS_POLICY_REVIEW_REQUIRED',p.table+'.'+p.name);
  }
  for(const fn of catalog.privileged_functions) {
    if(policy.reviewed_security_definers[fn.identity]!==createHash('sha256').update(JSON.stringify({function:fn,grants:catalog.function_grants.filter(g=>g.identity===fn.identity)})).digest('hex'))add('SECURITY_DEFINER_REVIEW_REQUIRED',fn.identity);
    if(!fn.config.some(c=>c.startsWith('search_path=')))add('SECURITY_DEFINER_SEARCH_PATH_MISSING',fn.identity);
  }
  for(const grant of catalog.grants) {
    const object=grant.schema+'.'+grant.table;
    if((grant.schema!=='public'||!known.has(grant.table)||!['r','p'].includes(grant.kind))&&(grant.grantee==='PUBLIC'||runtimes.has(grant.grantee)))add('UNCLASSIFIED_RELATION_DIRECT_GRANT',object+'.'+grant.grantee+'.'+grant.privilege);
    if(grant.schema!=='public'||!privateTables.has(grant.table))continue;
    if(grant.grantee==='PUBLIC')add('PUBLIC_PRIVATE_TABLE_GRANT',grant.table+'.'+grant.privilege);
    if((grant.grantee==='PUBLIC'||runtimes.has(grant.grantee))&&(grant.privilege==='TRUNCATE'||grant.grantable))add('RUNTIME_UNSCOPED_TABLE_PRIVILEGE',grant.table+'.'+grant.grantee+'.'+grant.privilege);
  }
  for(const grant of catalog.column_grants) {
    if((grant.schema!=='public'||!known.has(grant.table))&&(grant.grantee==='PUBLIC'||runtimes.has(grant.grantee)))add('UNCLASSIFIED_COLUMN_DIRECT_GRANT',grant.schema+'.'+grant.table+'.'+grant.column);
    if(grant.schema!=='public'||!privateTables.has(grant.table))continue;
    if(grant.grantee==='PUBLIC')add('PUBLIC_PRIVATE_COLUMN_GRANT',grant.table+'.'+grant.column);
    if(runtimes.has(grant.grantee)&&grant.grantable)add('RUNTIME_GRANTABLE_COLUMN',grant.table+'.'+grant.column);
  }
  for(const grant of catalog.schema_grants)if((grant.grantee==='PUBLIC'||runtimes.has(grant.grantee))&&(grant.privilege==='CREATE'||grant.grantable))add('RUNTIME_SCHEMA_WRITE_OR_GRANT',grant.schema+'.'+grant.grantee+'.'+grant.privilege);
  for(const grant of catalog.function_grants)if((grant.grantee==='PUBLIC'||runtimes.has(grant.grantee))&&grant.grantable)add('RUNTIME_FUNCTION_GRANTABLE',grant.identity+'.'+grant.grantee);
  for(const grant of catalog.default_grants)if(grant.grantee==='PUBLIC'&&['r','S'].includes(grant.object_type))add('PUBLIC_DEFAULT_DATA_GRANT',grant.owner+'.'+grant.object_type+'.'+grant.privilege);
  for(const view of catalog.views)if(policy.reviewed_views[view.schema+'.'+view.name]!==createHash('sha256').update(JSON.stringify(view)).digest('hex'))add('VIEW_REVIEW_REQUIRED',view.schema+'.'+view.name);
  for(const relation of catalog.other_relations)add('RELATION_NOT_CLASSIFIED',relation.schema+'.'+relation.name);
  for(const trigger of catalog.triggers)if(policy.reviewed_triggers[trigger.schema+'.'+trigger.table+'.'+trigger.name]!==createHash('sha256').update(JSON.stringify(trigger)).digest('hex'))add('TRIGGER_REVIEW_REQUIRED',trigger.schema+'.'+trigger.table+'.'+trigger.name);
  issues.sort((a,b)=>a.object.localeCompare(b.object)||a.code.localeCompare(b.code));
  return {schema_version:1,kind:'PROFILE_SCHEMA_METADATA_INVENTORY',source_sha:policy.source_sha,
    catalog_sha256:createHash('sha256').update(JSON.stringify(catalog)).digest('hex'),issues,
    schema_findings_resolved:issues.length===0,behavioral_isolation_verified:false,
    production_installation_proven:false};
}
