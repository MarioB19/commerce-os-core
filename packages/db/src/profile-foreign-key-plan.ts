import {createHash} from 'node:crypto';
import type {ProfileCatalog} from './profile-inventory.js';

export type ProfileTableScope={workspace:string;environment:string|null;nullable_columns?:string[]}|null;
export interface ProfileForeignKeyReview{
 /** Hash of exact normalized native FK metadata, not just its name. */
 original_sha256:string;
 /** Narrow extra environment dimension on an already fully composed edge. */
 source_scope?:{workspace:string;environment:string};
 target_scope?:{workspace:string;environment:string};
 preserve_delete_cascade?:true;
}
export interface ProfileForeignKeyPolicy{
 schema_version:1;
 /** Explicit complete table inventory; private keys are schema.table.
  * null denotes a reviewed global table, never an unknown private schema. */
 tables:Record<string,ProfileTableScope>;
 reviewed_edges?:Record<string,ProfileForeignKeyReview>;
}
export interface ProfileForeignKeyChange{
 source_table:string;source_schema:string;target_schema:string;source_constraint:string;source_columns:string[];
 target_table:string;target_columns:string[];foreign_key_name:string;unique_name:string;
 original:ProfileCatalog['foreign_keys'][number];
}
export interface ProfileForeignKeyPlan{
 schema_version:1;state:'LOCAL_SCOPED_FK_PROPOSAL';catalog_sha256:string;policy_sha256:string;
 changes:ProfileForeignKeyChange[];sql:string;production_affected:false;
}
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
 return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
export const profileForeignKeyOriginalHash=(foreign:ProfileCatalog['foreign_keys'][number]&{schema?:string})=>digest({...foreign,schema:foreign.schema??'public'});
function requireValue(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function name(value:unknown):asserts value is string{requireValue(typeof value==='string'&&/^[A-Za-z_][A-Za-z_0-9]{0,62}$/.test(value),'PROFILE_FK_IDENTIFIER_INVALID');}
const ident=(value:string)=>{name(value);return '"'+value+'"';};
const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const relationKey=(schema:string,table:string)=>schema==='public'?table:schema+'.'+table;
function relation(key:string){const parts=key.split('.');requireValue(parts.length===1||parts.length===2,'PROFILE_FK_IDENTIFIER_INVALID');const [schema,table]=parts.length===1?['public',parts[0]!]:parts;name(schema);name(table);return {schema,table,sql:(schema==='public'?'public':ident(schema))+'.'+ident(table)};}
const columns=(values:string[])=>values.map(ident).join(',');
const array=(values:string[])=>'ARRAY['+values.map(literal).join(',')+']::text[]';
/** Pure proposal: no queries, no row reads, no profile defaults or weakened FK.
 * Execution is a separate reviewed migration after the complete catalog exists. */
export function planProfileForeignKeys(catalog:ProfileCatalog,policy:ProfileForeignKeyPolicy):ProfileForeignKeyPlan{
 requireValue(policy.schema_version===1&&policy.tables&&typeof policy.tables==='object','PROFILE_FK_POLICY_INVALID');
 const privateTables=catalog.non_public_tables??[],privateForeign=catalog.non_public_foreign_keys??[];
 const expectedPrivate=catalog.other_relations.filter(t=>['r','p'].includes(t.kind)).map(t=>relationKey(t.schema,t.name)).sort();
 requireValue(canonical(privateTables.map(t=>relationKey(t.schema,t.name)).sort())===canonical(expectedPrivate)&&(!privateTables.length||Array.isArray(catalog.non_public_foreign_keys)),'PROFILE_FK_PRIVATE_CATALOG_REQUIRED');
 for(const table of privateTables){name(table.schema);requireValue(table.schema!=='public'&&!table.schema.startsWith('pg_')&&table.schema!=='information_schema','PROFILE_FK_SCHEMA_INVALID');}
 const tables=new Map([...catalog.tables.map(t=>[t.name,t] as const),...privateTables.map(t=>[relationKey(t.schema,t.name),t] as const)]);
 requireValue(tables.size===catalog.tables.length+privateTables.length&&tables.size>0&&tables.size<=512,'PROFILE_FK_TABLE_INVENTORY_INVALID');
 const declared=Object.keys(policy.tables).sort();requireValue(canonical(declared)===canonical([...tables.keys()].sort()),'PROFILE_FK_TABLE_UNCLASSIFIED');
 for(const [table,scope]of Object.entries(policy.tables)){
  relation(table);if(scope===null)continue;
  requireValue(scope&&['environment,workspace','environment,nullable_columns,workspace'].includes(Object.keys(scope).sort().join(',')),'PROFILE_FK_SCOPE_INVALID');name(scope.workspace);if(scope.environment!==null)name(scope.environment);
  requireValue(scope.workspace!==scope.environment,'PROFILE_FK_SCOPE_INVALID');
  const nullable=scope.nullable_columns??[];requireValue(Array.isArray(nullable)&&new Set(nullable).size===nullable.length&&nullable.every(c=>c===scope.workspace||c===scope.environment),'PROFILE_FK_SCOPE_INVALID');
  for(const key of [scope.workspace,scope.environment].filter((v):v is string=>v!==null)){
   const column=tables.get(table)!.columns.find(c=>c.name===key);requireValue(column?.type==='text'&&column.not_null===!nullable.includes(key),'PROFILE_FK_SCOPE_COLUMN_INVALID');
  }
 }
 for(const foreign of privateForeign){name(foreign.schema);requireValue(foreign.schema!=='public'&&!foreign.schema.startsWith('pg_')&&foreign.schema!=='information_schema','PROFILE_FK_SCHEMA_INVALID');}
 const changes:ProfileForeignKeyChange[]=[],seen=new Set<string>(),reviewed=new Set<string>(),reviewedOriginals:((ProfileCatalog['foreign_keys'][number])&{schema:string})[]=[];
 const reviews=policy.reviewed_edges??{};requireValue(reviews&&typeof reviews==='object'&&!Array.isArray(reviews),'PROFILE_FK_REVIEW_INVALID');
 requireValue(catalog.foreign_keys.length+privateForeign.length<=4096,'PROFILE_FK_INVENTORY_BOUND');
 for(const foreign of [...catalog.foreign_keys.map(f=>({...f,schema:'public'})),...privateForeign]){
  const f=structuredClone(foreign);name(f.name);name(f.table);name(f.referenced_table);name(f.schema);name(f.referenced_schema);
  const sourceKey=relationKey(f.schema,f.table),targetKey=relationKey(f.referenced_schema,f.referenced_table);
  requireValue(tables.has(sourceKey)&&tables.has(targetKey),'PROFILE_FK_TABLE_UNCLASSIFIED');
  requireValue(f.validated&&Array.isArray(f.columns)&&Array.isArray(f.referenced_columns)&&f.columns.length>0&&f.columns.length===f.referenced_columns.length,'PROFILE_FK_ORIGINAL_INVALID');
  const key=sourceKey+'.'+f.name;requireValue(!seen.has(key),'PROFILE_FK_DUPLICATE');seen.add(key);
  for(const [table,keys]of [[sourceKey,f.columns],[targetKey,f.referenced_columns]] as const){
   requireValue(new Set(keys).size===keys.length,'PROFILE_FK_DUPLICATE_COLUMN');
   for(const k of keys){name(k);requireValue(tables.get(table)!.columns.some(c=>c.name===k),'PROFILE_FK_COLUMN_MISSING');}
  }
  const review=Object.hasOwn(reviews,key)?reviews[key]:undefined;
  if(review){
   requireValue(review&&typeof review==='object'&&Object.keys(review).every(k=>['original_sha256','source_scope','target_scope','preserve_delete_cascade'].includes(k))&&review.original_sha256===profileForeignKeyOriginalHash(f),'PROFILE_FK_REVIEW_DRIFT');
   requireValue(review.source_scope||review.target_scope||review.preserve_delete_cascade===true,'PROFILE_FK_REVIEW_INVALID');
   requireValue(!Object.hasOwn(review,'preserve_delete_cascade')||review.preserve_delete_cascade===true,'PROFILE_FK_REVIEW_INVALID');reviewed.add(key);reviewedOriginals.push(f);
  }
  function effective(base:ProfileTableScope|undefined,override:ProfileForeignKeyReview['source_scope'],table:string){
   if(!override)return base;
   requireValue(base&&override&&Object.keys(override).sort().join(',')==='environment,workspace'&&override.workspace===base.workspace&&(base.environment===null||base.environment===override.environment),'PROFILE_FK_REVIEW_WEAKENING');
   name(override.environment);requireValue(override.environment!==override.workspace,'PROFILE_FK_SCOPE_INVALID');
   const column=tables.get(table)!.columns.find(c=>c.name===override.environment);requireValue(column?.type==='text'&&column.not_null,'PROFILE_FK_SCOPE_COLUMN_INVALID');
   return {...base,environment:override.environment};
  }
  const child=effective(policy.tables[sourceKey],review?.source_scope,sourceKey),parent=effective(policy.tables[targetKey],review?.target_scope,targetKey);if(parent===null){requireValue(!review,'PROFILE_FK_REVIEW_UNUSED');continue;}
  requireValue(child!==null&&child!==undefined&&parent!==undefined,'PROFILE_FK_GLOBAL_CHILD_TO_PRIVATE');
  requireValue(parent.environment===null||child.environment!==null,'PROFILE_FK_ENVIRONMENT_DERIVATION_REQUIRED');
  const source=[...f.columns],target=[...f.referenced_columns];
  for(const [left,right]of [[child.workspace,parent.workspace],...(parent.environment===null?[]:[[child.environment!,parent.environment]])]){
   const li=source.indexOf(left!),ri=target.indexOf(right!);
   if(li!==-1||ri!==-1){requireValue(li===ri&&li!==-1,'PROFILE_FK_SCOPE_POSITION_MISMATCH');continue;}
   requireValue(tables.get(sourceKey)!.columns.find(c=>c.name===left)?.not_null&&tables.get(targetKey)!.columns.find(c=>c.name===right)?.not_null,'PROFILE_FK_NULLABLE_AUGMENTATION');
   source.push(left!);target.push(right!);
  }
  requireValue(!(review?.source_scope||review?.target_scope)||source.length===f.columns.length,'PROFILE_FK_REVIEW_SCOPE_NOT_NATIVE');
  if(source.length===f.columns.length){requireValue(!review?.preserve_delete_cascade,'PROFILE_FK_REVIEW_UNUSED');continue;}
  const cascade=review?.preserve_delete_cascade===true;requireValue(!cascade||(f.on_delete==='c'&&f.on_update==='a'),'PROFILE_FK_REVIEW_UNUSED');
  requireValue(typeof f.deferrable==='boolean'&&typeof f.initially_deferred==='boolean'&&(!f.initially_deferred||f.deferrable)&&f.match_type==='s'&&['a','r'].includes(f.on_update??'')&&(['a','r'].includes(f.on_delete??'')||cascade),'PROFILE_FK_ACTION_REVIEW_REQUIRED');
  const unique='profile_scope_u_'+digest([targetKey,target]).slice(0,24),fk='profile_scope_f_'+digest([sourceKey,f.name,source,targetKey,target]).slice(0,24);
  changes.push({source_table:sourceKey,source_schema:f.schema,target_schema:f.referenced_schema,source_constraint:f.name,source_columns:source,target_table:targetKey,target_columns:target,foreign_key_name:fk,unique_name:unique,original:f});
 }
 requireValue(Object.keys(reviews).length===reviewed.size,'PROFILE_FK_REVIEW_UNUSED');
 changes.sort((a,b)=>(a.source_table+'.'+a.source_constraint).localeCompare(b.source_table+'.'+b.source_constraint));
 const locked=[...new Set([...changes.flatMap(c=>[c.source_table,c.target_table]),...reviewedOriginals.flatMap(f=>[relationKey(f.schema,f.table),relationKey(f.referenced_schema,f.referenced_table)])])].sort();
 const lines=['-- Local proposal only: preserve every old constraint and row.','DO $profile_fk$', 'BEGIN'," IF current_user<>'commerce_owner' AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolsuper) THEN RAISE EXCEPTION 'PROFILE_MIGRATION_OWNER_REQUIRED'; END IF;",...locked.map(t=>' LOCK TABLE '+relation(t).sql+' IN ACCESS EXCLUSIVE MODE;')];
 for(const table of locked){
  const scope=policy.tables[table]!;
  for(const column of [scope.workspace,scope.environment].filter((v):v is string=>v!==null))lines.push(` IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=${literal(relation(table).sql)}::regclass AND attname=${literal(column)} AND attnum>0 AND NOT attisdropped AND attnotnull=${!(scope.nullable_columns??[]).includes(column)} AND atttypid='pg_catalog.text'::regtype) THEN RAISE EXCEPTION 'PROFILE_FK_SCOPE_DRIFT'; END IF;`);
 }
 const preflight=new Map(changes.map(c=>[c.source_table+'.'+c.source_constraint,{...c.original,schema:c.source_schema}]));
 for(const f of reviewedOriginals){
  const source=relationKey(f.schema,f.table),target=relationKey(f.referenced_schema,f.referenced_table),review=reviews[source+'.'+f.name]!;preflight.set(source+'.'+f.name,f);
  for(const [table,scope]of [[source,review.source_scope],[target,review.target_scope]] as const)if(scope)lines.push(` IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=${literal(relation(table).sql)}::regclass AND attname=${literal(scope.environment)} AND attnum>0 AND NOT attisdropped AND attnotnull AND atttypid='pg_catalog.text'::regtype) THEN RAISE EXCEPTION 'PROFILE_FK_SCOPE_DRIFT'; END IF;`);
 }
 for(const f of preflight.values()){
  lines.push(` IF NOT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class r ON r.oid=k.confrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE k.conrelid=${literal(relation(relationKey(f.schema,f.table)).sql)}::regclass AND k.conname=${literal(f.name)} AND k.contype='f' AND k.convalidated AND k.condeferrable=${f.deferrable} AND k.condeferred=${f.initially_deferred} AND k.confmatchtype::text=${literal(f.match_type!)} AND k.confupdtype::text=${literal(f.on_update!)} AND k.confdeltype::text=${literal(f.on_delete!)} AND n.nspname=${literal(f.referenced_schema)} AND r.relname=${literal(f.referenced_table)} AND ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,pos) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.pos)=${array(f.columns)} AND ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,pos) JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.pos)=${array(f.referenced_columns)}) THEN RAISE EXCEPTION 'PROFILE_FK_ORIGINAL_DRIFT'; END IF;`);
 }
 const unique=new Set<string>();
 for(const c of changes){
  if(!unique.has(c.unique_name)){lines.push(` ALTER TABLE ${relation(c.target_table).sql} ADD CONSTRAINT ${ident(c.unique_name)} UNIQUE(${columns(c.target_columns)});`);unique.add(c.unique_name);}
  const f=c.original,action=(code:string)=>code==='c'?'CASCADE':code==='r'?'RESTRICT':'NO ACTION',timing=f.deferrable?'DEFERRABLE INITIALLY '+(f.initially_deferred?'DEFERRED':'IMMEDIATE'):'NOT DEFERRABLE';
  lines.push(` ALTER TABLE ${relation(c.source_table).sql} ADD CONSTRAINT ${ident(c.foreign_key_name)} FOREIGN KEY(${columns(c.source_columns)}) REFERENCES ${relation(c.target_table).sql}(${columns(c.target_columns)}) MATCH SIMPLE ON UPDATE ${action(f.on_update!)} ON DELETE ${action(f.on_delete!)} ${timing};`);
 }
 lines.push('END','$profile_fk$;','');
 return{schema_version:1,state:'LOCAL_SCOPED_FK_PROPOSAL',catalog_sha256:digest(catalog),policy_sha256:digest(policy),changes,sql:lines.join('\n'),production_affected:false};
}
