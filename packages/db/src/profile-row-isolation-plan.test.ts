import {describe,it,expect} from 'vitest';
import type {ProfileCatalog} from './profile-inventory.js';
import {planProfileRowIsolation,type ProfileRowIsolationPolicy} from './profile-row-isolation-plan.js';
function fixture(){
 const table={name:'records',owner:'migration',rls:false,force_rls:false,columns:[{name:'workspace_id',type:'text',not_null:true},{name:'environment',type:'text',not_null:true}]};
 const catalog:ProfileCatalog={tables:[table,{name:'user',owner:'migration',rls:false,force_rls:false,columns:[]}],foreign_keys:[],policies:[],roles:[{name:'commerce_api',superuser:false,bypass_rls:false,can_login:false,create_role:false,runtime_memberships:['commerce_api']}],privileged_functions:[],grants:[],column_grants:[],schema_grants:[],function_grants:[],default_grants:[],views:[],other_relations:[],triggers:[],migrations:[]};
 const policy:ProfileRowIsolationPolicy={schema_version:1,tables:{records:{mode:'scope',workspace:'workspace_id',environment:'environment',roles:['commerce_api'],initialize_permission:true},user:{mode:'preserve',reason:'Global authenticated identity is separately reviewed.'}}};return{catalog,policy};
}
describe('explicit row-isolation proposals',()=>{
 it('emits scoped permission and restrictive guard for a previously unprotected table, without granting SQL',()=>{
  const {catalog,policy}=fixture(),p=planProfileRowIsolation(catalog,policy);expect(p.global_isolation_verified).toBe(false);expect(p.production_affected).toBe(false);
  expect(p.sql).toContain('FORCE ROW LEVEL SECURITY');expect(p.sql).toContain('AS RESTRICTIVE TO "commerce_api"');expect(p.sql).toContain("current_setting('app.environment',true) IN('REAL','SIMULATION')");expect(p.sql).not.toMatch(/\b(?:GRANT|DROP|OWNER TO|DISABLE)\b/);expect(p.changes).toHaveLength(1);
 });
 it('rejects omitted, extra or duplicated table classifications',()=>{
  const {catalog,policy}=fixture();delete policy.tables.user;expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('TABLE_UNCLASSIFIED');policy.tables.extra={mode:'preserve',reason:'Explicit but absent relation.'};expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('TABLE_UNCLASSIFIED');
 });
 it('never infers global identity from absent tenant columns or permits nullable tenant defaults',()=>{
  const {catalog,policy}=fixture();catalog.tables[0]!.columns[0]!.not_null=false;expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('SCOPE_COLUMN_INVALID');catalog.tables[0]!.columns=[];expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('SCOPE_COLUMN_INVALID');
 });
 it('requires nontrivial explicit reasons for preserved boundaries',()=>{
  const {catalog,policy}=fixture();policy.tables.user={mode:'preserve',reason:''};expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('PRESERVATION_REASON_REQUIRED');
 });
 it('refuses to initialize a permissive policy on an already protected table',()=>{
  const {catalog,policy}=fixture();catalog.tables[0]!.rls=true;expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('EXISTING_PERMISSION_PRESERVED');
 });
 it('restricts existing policies without widening a READY, consent or authorization condition',()=>{
  const {catalog,policy}=fixture();catalog.tables[0]!.rls=true;(policy.tables.records as Exclude<typeof policy.tables.records,{mode:'preserve'}>).initialize_permission=false;
  catalog.policies.push({table:'records',name:'ready',command:'r',permissive:true,roles:['commerce_api'],using:"phase = 'READY'",with_check:null});
  const p=planProfileRowIsolation(catalog,policy);expect(p.sql).toContain('PROFILE_ROW_POLICY_DRIFT');expect(p.sql).not.toContain('CREATE POLICY "profile_scope_access_');expect(p.sql).toContain("phase = ''READY''");
 });
 it('rejects unreviewed command metadata for old policies',()=>{
  const {catalog,policy}=fixture();catalog.policies.push({table:'records',name:'old',permissive:true,roles:['PUBLIC'],using:'true',with_check:null});expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('POLICY_INVENTORY_INVALID');
 });
 it('closes PUBLIC, missing roles, duplicates and owner roles',()=>{
  const {catalog,policy}=fixture(),scope=policy.tables.records as Exclude<typeof policy.tables.records,{mode:'preserve'}>;
  for(const roles of [['PUBLIC'],['missing'],['commerce_api','commerce_api'],['migration']]){scope.roles=roles;expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('ROLE_INVALID');}
 });
 it('rejects bypass or inherited privileged runtime authority before SQL',()=>{
  for(const flag of ['superuser','bypass_rls','create_role'] as const){const {catalog,policy}=fixture();catalog.roles[0]![flag]=true;expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('RUNTIME_PRIVILEGE');}
 });
 it('requires full private table and policy metadata',()=>{
  const {catalog,policy}=fixture();catalog.other_relations.push({schema:'private',name:'jobs',kind:'r',owner:'migration'});expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('PRIVATE_CATALOG_REQUIRED');catalog.non_public_tables=[{...catalog.tables[0]!,schema:'private',name:'jobs'}];policy.tables['private.jobs']=structuredClone(policy.tables.records!);expect(()=>planProfileRowIsolation(catalog,policy)).toThrow('PRIVATE_POLICIES_REQUIRED');
 });
 it('quotes private schemas and exact scope columns independently',()=>{
  const {catalog,policy}=fixture();catalog.other_relations.push({schema:'private',name:'jobs',kind:'r',owner:'migration'});catalog.non_public_tables=[{...catalog.tables[0]!,schema:'private',name:'jobs'}];catalog.non_public_policies=[];policy.tables['private.jobs']=structuredClone(policy.tables.records!);const p=planProfileRowIsolation(catalog,policy);expect(p.sql).toContain('LOCK TABLE "private"."jobs" IN ACCESS EXCLUSIVE MODE');expect(p.changes).toHaveLength(2);
 });
 it('preserves global counting owner policy while targeting only runtime roles',()=>{
  const {catalog,policy}=fixture();catalog.policies.push({table:'records',name:'closed_counter',command:'*',permissive:true,roles:['commerce_quota_owner'],using:'true',with_check:'true'});const p=planProfileRowIsolation(catalog,policy);expect(p.sql).not.toContain('TO "commerce_quota_owner"');expect(p.sql).not.toContain('TO PUBLIC');expect(p.sql).toContain('closed_counter');
 });
 it('pins the full inventory, columns, owners, policy commands and role flags before first DDL',()=>{
  const {catalog,policy}=fixture(),p=planProfileRowIsolation(catalog,policy);for(const code of ['TABLE_DRIFT','METADATA_DRIFT','POLICY_DRIFT','ROLE_DRIFT'])expect(p.sql.indexOf('PROFILE_ROW_'+code)).toBeLessThan(p.sql.indexOf(' ALTER TABLE '));expect(p.sql).toContain('NOT rolreplication');expect(p.sql).toContain('NOT rolcreatedb');
 });
 it('is deterministic and leaves the caller inputs untouched',()=>{
  const {catalog,policy}=fixture(),before=JSON.stringify({catalog,policy}),a=planProfileRowIsolation(catalog,policy),b=planProfileRowIsolation(catalog,policy);expect(a).toEqual(b);expect(JSON.stringify({catalog,policy})).toBe(before);
 });
});
