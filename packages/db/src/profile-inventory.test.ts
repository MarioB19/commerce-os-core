import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {readProfileCatalog,assessProfileCatalog,type ProfileCatalog,type ProfileInventoryPolicy} from './profile-inventory.js';
import type {ProfileConnection} from './profile-context.js';
import {localInventoryTarget} from '../../../scripts/profile-inventory.js';
function fixture() {
  const catalog:ProfileCatalog={tables:[{name:'records',owner:'migration',rls:true,force_rls:true,columns:[{name:'workspace_id',type:'text',not_null:true}]},{name:'user',owner:'migration',rls:false,force_rls:false,columns:[]}],foreign_keys:[],policies:[{table:'records',name:'tenant',permissive:false,roles:['PUBLIC'],using:"workspace_id = current_setting('app.workspace_id', true)",with_check:"workspace_id = current_setting('app.workspace_id', true)"}],roles:[{name:'commerce_api',superuser:false,bypass_rls:false,can_login:false,create_role:false,runtime_memberships:['commerce_api']}],privileged_functions:[],grants:[],column_grants:[],schema_grants:[],function_grants:[],default_grants:[],views:[],other_relations:[],triggers:[],migrations:[{name:'0001.sql',sha256:'a'.repeat(64)}]};
  const policy:ProfileInventoryPolicy={schema_version:1,source_sha:'a'.repeat(40),private_tables:['records'],global_identity_tables:['user'],runtime_roles:['commerce_api'],children_requiring_tenant:{},reviewed_security_definers:{},reviewed_views:{},reviewed_triggers:{},reviewed_policies:{'records.tenant':createHash('sha256').update(JSON.stringify(catalog.policies[0])).digest('hex')}};
  return {catalog,policy};
}
describe('profile schema inventory',()=>{
  it('distinguishes metadata findings from behavioral and installed proof',()=>{
    const {catalog,policy}=fixture(),r=assessProfileCatalog(catalog,policy);
    expect(r.issues).toEqual([]);expect(r.schema_findings_resolved).toBe(true);
    expect(r.behavioral_isolation_verified).toBe(false);expect(r.production_installation_proven).toBe(false);
  });
  it('rejects missing and unclassified tables without granting global status by absence of tenant',()=>{
    const {catalog,policy}=fixture();catalog.tables[0].name='new_private';
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toContain('TABLE_NOT_CLASSIFIED');
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toContain('TABLE_MISSING');
  });
  it('flags missing/nullable tenant, disabled RLS and runtime ownership',()=>{
    const {catalog,policy}=fixture();Object.assign(catalog.tables[0],{columns:[],owner:'commerce_api',rls:false,force_rls:false});
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toEqual(expect.arrayContaining(['TENANT_COLUMN_MISSING','RLS_DISABLED','RLS_NOT_FORCED','RUNTIME_OWNS_PRIVATE_TABLE']));
    catalog.tables[0].columns=[{name:'workspace_id',type:'text',not_null:false}];
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toContain('TENANT_COLUMN_NULLABLE');
  });
  it('requires the matching tenant positions in private foreign keys, not an unrelated workspace column',()=>{
    const {catalog,policy}=fixture();catalog.foreign_keys=[{table:'records',name:'parent',columns:['workspace_id','id'],referenced_table:'records',referenced_schema:'public',referenced_columns:['id','workspace_id'],validated:false}];
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toEqual(expect.arrayContaining(['PRIVATE_FK_NOT_TENANT_SCOPED','PRIVATE_FK_NOT_VALIDATED']));
  });
  it('flags inherited runtime privilege, public grants, unknown SECURITY DEFINER and replaced policies',()=>{
    const {catalog,policy}=fixture();catalog.roles.push({name:'runtime_login',superuser:false,bypass_rls:true,can_login:true,create_role:false,runtime_memberships:['commerce_api']});
    catalog.grants.push({schema:'public',kind:'r',table:'records',grantee:'PUBLIC',privilege:'SELECT',grantable:false});
    catalog.privileged_functions.push({identity:'unsafe()',owner:'migration',config:[],definition_hash:'f'.repeat(64)});
    catalog.policies[0].using='true';
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toEqual(expect.arrayContaining(['RUNTIME_BYPASS_RLS','PUBLIC_PRIVATE_TABLE_GRANT','SECURITY_DEFINER_REVIEW_REQUIRED','SECURITY_DEFINER_SEARCH_PATH_MISSING','RLS_POLICY_REVIEW_REQUIRED']));
  });
  it('does not mistake views, column grants, TRUNCATE or default grants for row-level protection',()=>{
    const {catalog,policy}=fixture();
    catalog.views.push({schema:'public',kind:'v',name:'all_records',owner:'migration',options:[],definition_hash:'a'.repeat(64)});
    catalog.other_relations.push({schema:'unclassified',name:'records',kind:'r',owner:'migration'});
    catalog.column_grants.push({schema:'public',table:'records',column:'content',grantee:'PUBLIC',privilege:'SELECT',grantable:false});
    catalog.grants.push({schema:'public',kind:'r',table:'records',grantee:'commerce_api',privilege:'TRUNCATE',grantable:false});
    catalog.default_grants.push({owner:'migration',schema:null,object_type:'r',grantee:'PUBLIC',privilege:'SELECT'});
    catalog.triggers.push({schema:'public',table:'records',name:'write_guard',enabled:'D',function_identity:'write_guard()',definition_hash:'a'.repeat(64)});
    catalog.roles[0].create_role=true;
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toEqual(expect.arrayContaining([
      'VIEW_REVIEW_REQUIRED','RELATION_NOT_CLASSIFIED','PUBLIC_PRIVATE_COLUMN_GRANT',
      'RUNTIME_UNSCOPED_TABLE_PRIVILEGE','PUBLIC_DEFAULT_DATA_GRANT','TRIGGER_REVIEW_REQUIRED','RUNTIME_PRIVILEGE_ESCALATION',
    ]));
  });
  it('keeps pg-boss, public foreign tables and materialized views visible with their direct grant paths',()=>{
    const {catalog,policy}=fixture();
    catalog.other_relations.push({schema:'pgboss',name:'job',kind:'r',owner:'queue_owner'},{schema:'public',name:'foreign_orders',kind:'f',owner:'foreign_owner'});
    catalog.views.push({schema:'pgboss',name:'cached_jobs',kind:'m',owner:'queue_owner',options:[],definition_hash:'d'.repeat(64)});
    catalog.grants.push({schema:'pgboss',kind:'r',table:'job',grantee:'commerce_api',privilege:'SELECT',grantable:false});
    catalog.column_grants.push({schema:'pgboss',table:'job',column:'data',grantee:'PUBLIC',privilege:'SELECT',grantable:false});
    catalog.schema_grants.push({schema:'pgboss',owner:'queue_owner',grantee:'commerce_api',privilege:'CREATE',grantable:false});
    expect(assessProfileCatalog(catalog,policy).issues).toEqual(expect.arrayContaining([
      {code:'RELATION_NOT_CLASSIFIED',object:'pgboss.job'},{code:'RELATION_NOT_CLASSIFIED',object:'public.foreign_orders'},
      {code:'VIEW_REVIEW_REQUIRED',object:'pgboss.cached_jobs'},{code:'UNCLASSIFIED_RELATION_DIRECT_GRANT',object:'pgboss.job.commerce_api.SELECT'},
      {code:'UNCLASSIFIED_COLUMN_DIRECT_GRANT',object:'pgboss.job.data'},{code:'RUNTIME_SCHEMA_WRITE_OR_GRANT',object:'pgboss.commerce_api.CREATE'},
    ]));
  });
  it('binds privileged-function review to owner, configuration and caller grants as well as definition',()=>{
    const {catalog,policy}=fixture(),fn={identity:'public.read_private()',owner:'migration',config:['search_path=pg_catalog, public'],definition_hash:'e'.repeat(64)};
    catalog.privileged_functions.push(fn);
    policy.reviewed_security_definers[fn.identity]=createHash('sha256').update(JSON.stringify({function:fn,grants:[]})).digest('hex');
    expect(assessProfileCatalog(catalog,policy).issues).toEqual([]);
    catalog.function_grants.push({identity:fn.identity,owner:'migration',security_definer:true,grantee:'PUBLIC',privilege:'EXECUTE',grantable:false});
    expect(assessProfileCatalog(catalog,policy).issues.map(x=>x.code)).toContain('SECURITY_DEFINER_REVIEW_REQUIRED');
  });
  it('captures all reads in one read-only repeatable-read transaction and rolls back, without business rows',async()=>{
    const calls:string[]=[];const c={query:vi.fn(async(sql:string)=>{calls.push(sql);return {rows:[]};}),release:vi.fn()};
    await readProfileCatalog({connect:async()=>c as unknown as ProfileConnection},['commerce_api']);
    expect(calls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(calls.at(-1)).toBe('ROLLBACK');
    expect(calls.some(x=>/FROM public\.(records|memberships|service_tokens)/.test(x))).toBe(false);
    expect(c.release).toHaveBeenCalledWith(undefined);
  });
  it('discards the connection on rollback failure and preserves the query failure',async()=>{
    let n=0;const c={query:vi.fn(async()=>{if(++n>=3)throw new Error('query failure');return {rows:[]};}),release:vi.fn()};
    await expect(readProfileCatalog({connect:async()=>c as unknown as ProfileConnection},[])).rejects.toThrow('query failure');expect(c.release).toHaveBeenCalledWith(true);
  });
  it('CLI refuses remote, socket overrides and missing database before any connection',()=>{
    expect(localInventoryTarget('postgres://localhost/f2_synthetic')).toBe('postgres://localhost/f2_synthetic');
    for(const url of [undefined,'postgres://cloud.example/db','postgres://localhost/db?host=remote','postgres://localhost/','http://localhost/db'])expect(()=>localInventoryTarget(url)).toThrow();
  });
});
