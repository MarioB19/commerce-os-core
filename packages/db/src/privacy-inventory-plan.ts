import {verifyPrivacySelectionAuthority} from './privacy-selection-authority.js';
import {createHash} from 'node:crypto';
import type {ProfileCatalog} from './profile-inventory.js';
export type PrivacyRelationClass='CONTENT'|'FINANCIAL'|'MINIMAL'|'INSPECT'|'EXCLUDED';
export interface PrivacyPrimaryKey {schema:string;table:string;name:string;columns:string[];deferrable:boolean;initially_deferred:boolean}
export interface PrivacyInventoryCatalog extends ProfileCatalog {primary_keys:PrivacyPrimaryKey[];non_public_tables?: (ProfileCatalog['tables'][number]&{schema:string})[]}
export interface PrivacyInventoryPolicy {schema_version:1;relations:Record<string,{classification:PrivacyRelationClass;reason:string}>}
const identifier=/^[A-Za-z_][A-Za-z0-9_]*$/;
const quote=(s:string)=>{if(!identifier.test(s))throw Error('PRIVACY_IDENTIFIER_INVALID');return '"'+s+'"';};
const literal=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const outsideIdentity=new Set(['platform_tokens','ai_profile_preferences','meta_profile_credential_versions','meta_profile_credentials','profile_onboarding','profile_session_context','profile_cutover_historical_tables','account','identity_audit','identity_mail_jobs','identity_mail_settings','identity_rate_limits','identity_reset_links','session','user','verification','schema_migrations','ai_model_prices','profiles','profile_quota_policy','profile_quota_load_admissions','profile_quota_coverage','profile_quota_entries','creative_devices','creative_pairings','privacy_writer_epochs','privacy_writer_leases','privacy_policy_adoptions','privacy_hold_events','privacy_backup_attestations','privacy_backup_revocations','privacy_jobs','privacy_result_seals','privacy_result_preservations','privacy_result_confirmations','privacy_reference_epoch','privacy_reference_leases','platform_admins','platform_operations','platform_backup_runs']);
const content=new Set(['records','record_versions','commands','domain_events','inbound_envelopes','outbox','effect_attempts','timers','idempotency','market_journey_snapshots','sales_command_proposals','sales_history_imports','commercial_remarketing_cycles','commercial_remarketing_attempts','physical_chats']);
const financial=new Set(['payment_contributions','reported_sales','receipt_order_policy_snapshots','commercial_buyer_exclusions','financial_retention_attestations','financial_retention_corrections']);
const minimal=new Set(['ai_attempts','ai_attempt_allocations','ai_attempt_events','ai_admission_denials','result_projection_sources','result_financial_context','privacy_closure_receipts','consumer_receipts','outbox_gate_schedule','financial_retention_installations','privacy_record_batches','privacy_record_apply_admissions','privacy_minimized_records','privacy_record_completions','privacy_backup_file_sets','privacy_opaque_implementations','privacy_opaque_passes','privacy_backup_row_sets','privacy_backup_row_pages','privacy_backup_row_entries','privacy_backup_row_seals','privacy_asset_batches','privacy_asset_apply_admissions','privacy_minimized_assets','privacy_asset_completions']);
function check(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
/** Every supplied relation must be explicitly reviewed. This helper classifies
 * known purposes only; its caller must supply the exact application table list.
 * A new relation is not silently excluded merely because it lacks tenant columns. */
export function privacyInventoryPolicy(names:readonly string[]):PrivacyInventoryPolicy{
 const relations:PrivacyInventoryPolicy['relations']={};
 for(const name of names){check(!relations[name],'PRIVACY_DUPLICATE_RELATION');
  const classification:PrivacyRelationClass=outsideIdentity.has(name)?'EXCLUDED':content.has(name)?'CONTENT':financial.has(name)?'FINANCIAL':minimal.has(name)?'MINIMAL':'INSPECT';
  relations[name]={classification,reason:classification==='EXCLUDED'?'Operator identity, global configuration, quota or retired devices; no conversation content reader access.':classification==='INSPECT'?'Any matching reference is unclassified and blocks erasure.':classification==='MINIMAL'?'Technical accounting/reference metadata; any later erasure still requires a reviewed field policy.':classification==='FINANCIAL'?'Five-year financial purpose; inventory does not authorize deleting or retaining arbitrary content.':'Conversation content or copies; inventory is not erasure authority.'};
 }
 return{schema_version:1,relations};
}

/** Read-only inventory port, pinned to native relation/column/PK metadata.
 * Installation requires a privileged migration connection. Runtime gets only
 * EXECUTE, never the owner's table privileges or an arbitrary SQL/name port. */
export function buildPrivacyInventoryPlan(catalog:PrivacyInventoryCatalog,policy:PrivacyInventoryPolicy){
 verifyPrivacySelectionAuthority(catalog);
 check(policy.schema_version===1,'PRIVACY_POLICY_VERSION');
 check(!(catalog.views??[]).some(x=>x.kind==='m')&&!(catalog.other_relations??[]).some(x=>['m','f'].includes(x.kind)),'PRIVACY_STORED_RELATION_UNCLASSIFIED');
 const names=catalog.tables.map(t=>t.name).sort();
 check(names.length===new Set(names).size&&JSON.stringify(names)===JSON.stringify(Object.keys(policy.relations).sort()),'PRIVACY_RELATION_CLASSIFICATION_INCOMPLETE');
 const tables=catalog.tables.slice().sort((a,b)=>a.name.localeCompare(b.name,'en'));
 const privateTables=catalog.non_public_tables??[];
 const privateNames=new Set(['commerce_number_lab.ai_bindings','commerce_number_lab.events','commerce_number_lab.operations','commerce_number_lab.run_releases','commerce_number_lab.runs']);
 for(const t of privateTables)check(privateNames.has(t.schema+'.'+t.name),'PRIVACY_PRIVATE_RELATION_UNCLASSIFIED');
 const expected=[...tables.map(t=>({...t,schema:'public'})),...privateTables].sort((a,b)=>(a.schema+'.'+a.name)<(b.schema+'.'+b.name)?-1:1).map(t=>{
  quote(t.schema);quote(t.name);const p=catalog.primary_keys.filter(k=>k.schema===t.schema&&k.table===t.name);check(p.length===1&&p[0]!.columns.length>0,'PRIVACY_PRIMARY_KEY_REQUIRED');
  const columns=t.columns.map(c=>({name:c.name,type:c.type,not_null:c.not_null}));for(const c of columns)quote(c.name);
  for(const k of p[0]!.columns)check(columns.some(c=>c.name===k),'PRIVACY_PRIMARY_KEY_COLUMN');
  const rule=t.schema==='public'?policy.relations[t.name]!:{classification:'EXCLUDED' as const,reason:'Dedicated RF19 control; its separate SIMULATION data retention does not authorize conversation erasure.'};check(['CONTENT','FINANCIAL','MINIMAL','INSPECT','EXCLUDED'].includes(rule.classification)&&rule.reason.trim().length>0,'PRIVACY_CLASSIFICATION_INVALID');
  if(rule.classification==='EXCLUDED')check(t.schema!=='public'||outsideIdentity.has(t.name),'PRIVACY_UNREVIEWED_EXCLUSION');
  else check(columns.some(c=>c.name==='workspace_id'&&c.type==='text'&&c.not_null),'PRIVACY_SCOPED_RELATION_REQUIRED');
  return{schema:t.schema,name:t.name,columns,primary_key:p[0]!.columns};
 });
 const scans=tables.filter(t=>policy.relations[t.name]!.classification!=='EXCLUDED').map(t=>({name:t.name,classification:policy.relations[t.name]!.classification,environment:t.columns.some(c=>c.name==='environment'),nullable_environment:t.columns.some(c=>c.name==='environment'&&!c.not_null),keys:expected.find(x=>x.schema==='public'&&x.name===t.name)!.primary_key,expands:content.has(t.name)||financial.has(t.name)}));
 const metadata=JSON.stringify(expected),scanJson=JSON.stringify(scans);
 const grants=scans.map(t=>`GRANT SELECT ON public.${quote(t.name)} TO commerce_privacy_inventory_owner;\nCREATE POLICY privacy_inventory_closed_reader ON public.${quote(t.name)} FOR SELECT TO commerce_privacy_inventory_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'')${t.environment?(t.nullable_environment?" AND (environment='REAL' OR environment IS NULL) AND current_setting('app.environment',true)='REAL'":" AND environment='REAL' AND current_setting('app.environment',true)='REAL'"):""});`).join('\n');
 const accessExpression=`SELECT encode(public.digest(jsonb_build_object('relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relowner,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text,(SELECT jsonb_agg(jsonb_build_array(a.attname,a.attacl::text) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped)) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND c.relkind IN('r','p')),'policies',(SELECT jsonb_agg(jsonb_build_array(p.polrelid,p.polname,p.polcmd,p.polpermissive,p.polroles::text,pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) ORDER BY p.polrelid,p.polname) FROM pg_policy p),'function',(SELECT jsonb_build_array(proowner,proacl::text,prosecdef,proconfig::text) FROM pg_proc WHERE oid='public.privacy_reference_inventory(uuid,integer)'::regprocedure),'roles',(SELECT jsonb_agg(jsonb_build_array(rolname,rolsuper,rolbypassrls,rolcanlogin,rolcreaterole,rolcreatedb,rolinherit,rolreplication) ORDER BY rolname) FROM pg_roles WHERE rolname IN('commerce_privacy_inventory_owner','commerce_privacy_worker')),'memberships',(SELECT COALESCE(jsonb_agg(jsonb_build_array(roleid,member,grantor,admin_option,inherit_option,set_option) ORDER BY roleid,member,grantor),'[]') FROM pg_auth_members WHERE roleid IN(SELECT oid FROM pg_roles WHERE rolname IN('commerce_privacy_inventory_owner','commerce_privacy_worker')) OR member IN(SELECT oid FROM pg_roles WHERE rolname IN('commerce_privacy_inventory_owner','commerce_privacy_worker'))))::text,'sha256'),'hex')`;
 const sql=`-- Generated028: metadata hash ${hash(metadata)}; read-only, no erasure authority.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN('commerce_privacy_inventory_owner','commerce_privacy_worker')) THEN RAISE EXCEPTION 'PRIVACY_ROLE_ALREADY_EXISTS';END IF;
 CREATE ROLE commerce_privacy_inventory_owner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
 CREATE ROLE commerce_privacy_worker NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
END $$;
GRANT USAGE ON SCHEMA public TO commerce_privacy_inventory_owner,commerce_privacy_worker;
${grants}
CREATE FUNCTION public.privacy_reference_inventory(target uuid,expected_version integer) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $privacy$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');e jsonb:=${literal(metadata)}::jsonb;
 scans jsonb:=${literal(scanJson)}::jsonb;actual jsonb;spec jsonb;row_value jsonb;row_key jsonb;row_hash text;key_hash text;
 root record;ids uuid[]:=ARRAY[target];next_ids uuid[];shared_ids uuid[]:=ARRAY[]::uuid[];seen text[]:=ARRAY[]::text[];entries jsonb:='[]';
 patterns text[];query_text text;predicate text;category text;identity uuid;candidate text;key_name text;
 access_pin text:='__PRIVACY_ACCESS_PIN__';actual_access text;rounds integer:=0;changed boolean:=true;observed timestamptz:=clock_timestamp();opaque boolean;
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_CONTEXT_REQUIRED';END IF;
 ${accessExpression} INTO actual_access;
 IF actual_access IS DISTINCT FROM access_pin THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_ACCESS_CHANGED';END IF;
 SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.relname,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),'primary_key',(SELECT jsonb_agg(a.attname ORDER BY u.pos) FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY u(num,pos) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.num WHERE k.conrelid=t.oid AND k.contype='p')) ORDER BY n.nspname COLLATE "C",t.relname COLLATE "C"),'[]') INTO actual FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND t.relkind IN('r','p','m','f');
 IF actual IS DISTINCT FROM e THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_SCHEMA_CHANGED';END IF;
 SELECT version,body INTO root FROM public.records WHERE id=target AND workspace_id=w AND environment='REAL' AND kind='conversation';
 IF NOT FOUND OR root.version IS DISTINCT FROM expected_version THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_SOURCE_CHANGED';END IF;
 WHILE changed LOOP
  rounds:=rounds+1;IF rounds>32 OR cardinality(ids)+cardinality(shared_ids)>10000 THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_BOUND';END IF;
  changed:=false;next_ids:=ids;SELECT array_agg('%'||x::text||'%') INTO patterns FROM unnest(ids) x;
  FOR spec IN SELECT value FROM jsonb_array_elements(scans) LOOP
   predicate:='r.workspace_id=$1'||CASE WHEN (spec->>'environment')::boolean THEN CASE WHEN (spec->>'nullable_environment')::boolean THEN ' AND (r.environment=''REAL'' OR r.environment IS NULL)' ELSE ' AND r.environment=''REAL''' END ELSE '' END;
   -- Opaque private response caches cannot be declared unrelated by inspecting
   -- ciphertext. They remain blockers pending the separately authenticated pass.
   query_text:=format('SELECT to_jsonb(r) FROM public.%I r WHERE %s AND (lower(to_jsonb(r)::text) LIKE ANY($2)%s) LIMIT 10001',spec->>'name',predicate,CASE WHEN spec->>'name'='idempotency' THEN ' OR (r.response ? ''_encrypted_response'' AND NOT(r.response ? ''_retained''))' WHEN spec->>'name'='sales_history_imports' THEN ' OR r.payload_ciphertext NOT LIKE ''REDACTED:%%''' WHEN spec->>'name'='records' THEN ' OR r.id=ANY($3)' WHEN spec->>'name'='record_versions' THEN ' OR r.record_id=ANY($3)' ELSE '' END);
   FOR row_value IN EXECUTE query_text USING w,patterns,shared_ids LOOP
    IF octet_length(row_value::text)>8388608 THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_ROW_BOUND';END IF;
    row_key:='{}';FOR key_name IN SELECT jsonb_array_elements_text(spec->'keys') LOOP row_key:=row_key||jsonb_build_object(key_name,row_value->key_name);END LOOP;
    key_hash:=encode(public.digest(row_key::text,'sha256'),'hex');
    IF (spec->>'name')||'.'||key_hash=ANY(seen) THEN CONTINUE;END IF;
    seen:=array_append(seen,(spec->>'name')||'.'||key_hash);IF cardinality(seen)>10000 THEN RAISE EXCEPTION 'PRIVACY_INVENTORY_BOUND';END IF;
    row_hash:=encode(public.digest(row_value::text,'sha256'),'hex');category:=spec->>'classification';identity:=NULL;
    IF row_value->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN identity:=(row_value->>'id')::uuid;END IF;
    IF spec->>'name' IN('records','record_versions') THEN
     category:=CASE WHEN row_value->>'kind'='conversation' AND COALESCE(identity,(row_value->>'record_id')::uuid)<>target THEN 'SHARED'
      WHEN row_value->'body'->>'conversation_id' IS NOT NULL AND row_value->'body'->>'conversation_id'<>target::text THEN 'SHARED'
      WHEN row_value->>'kind' IN('conversation','message','touchpoint','ai_run') THEN 'CONTENT'
      WHEN row_value->>'kind' IN('order','receipt','fulfillment') THEN 'FINANCIAL'
      WHEN row_value->>'kind' IN('asset','contact') THEN 'SHARED' ELSE 'UNCLASSIFIED' END;
    ELSIF category='INSPECT' THEN category:='UNCLASSIFIED';END IF;
    opaque:=(spec->>'name'='idempotency' AND row_value->'response' ? '_encrypted_response') OR spec->>'name'='sales_history_imports';
    IF opaque THEN category:='OPAQUE';END IF;
    entries:=entries||jsonb_build_array(jsonb_build_object('relation',spec->>'name','identity',identity,'key_sha256',key_hash,'source_sha256',row_hash,'classification',category));
    IF (spec->>'expands')::boolean AND category IN('CONTENT','FINANCIAL') AND identity IS NOT NULL AND NOT(identity=ANY(next_ids)) THEN next_ids:=array_append(next_ids,identity);changed:=true;END IF;
    -- Envelope IDs can be buried in immutable versions/events. Follow only
    -- actual envelopes, never arbitrary UUIDs for a product/account/contact.
    FOR candidate IN SELECT DISTINCT m[1] FROM regexp_matches(lower(row_value::text),'([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})','g') m LOOP
     IF category<>'SHARED' AND NOT(candidate::uuid=ANY(next_ids)) AND EXISTS(SELECT 1 FROM public.inbound_envelopes x WHERE x.id=candidate::uuid AND x.workspace_id=w AND x.environment='REAL') THEN next_ids:=array_append(next_ids,candidate::uuid);changed:=true;END IF;
     IF category<>'SHARED' AND NOT(candidate::uuid=ANY(shared_ids)) AND EXISTS(SELECT 1 FROM public.records x WHERE x.id=candidate::uuid AND x.workspace_id=w AND x.environment='REAL' AND x.kind IN('asset','contact')) THEN shared_ids:=array_append(shared_ids,candidate::uuid);changed:=true;END IF;
    END LOOP;
   END LOOP;
  END LOOP;
  ids:=next_ids;
 END LOOP;
 SELECT COALESCE(jsonb_agg(value ORDER BY value->>'relation',value->>'key_sha256'),'[]') INTO entries FROM jsonb_array_elements(entries);
 RETURN jsonb_build_object('schema_version',1,'workspace_id',w,'environment','REAL','journey_id',target,'source_version',root.version,'source_sha256',encode(public.digest(root.body::text,'sha256'),'hex'),'catalog_sha256',${literal(hash(metadata))},'observed_at',observed,'entries',entries,'inventory_sha256',encode(public.digest(entries::text,'sha256'),'hex'),'unclassified_references',(SELECT count(*) FROM jsonb_array_elements(entries) x WHERE x->>'classification' IN('UNCLASSIFIED','OPAQUE')),'erasure_authorized',false);
END $privacy$;
ALTER FUNCTION public.privacy_reference_inventory(uuid,integer) OWNER TO commerce_privacy_inventory_owner;
REVOKE ALL ON FUNCTION public.privacy_reference_inventory(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_reference_inventory(uuid,integer) TO commerce_privacy_worker;
DO $pin$ DECLARE definition text;fingerprint text;BEGIN
 PERFORM set_config('search_path','pg_catalog',true);
 ${accessExpression} INTO fingerprint;
 SELECT pg_get_functiondef('public.privacy_reference_inventory(uuid,integer)'::regprocedure) INTO definition;
 IF position('__PRIVACY_ACCESS_PIN__' IN definition)=0 THEN RAISE EXCEPTION 'PRIVACY_PIN_TEMPLATE_REQUIRED';END IF;
 EXECUTE replace(definition,'__PRIVACY_ACCESS_PIN__',fingerprint);
END $pin$;
`;
 const sealAt=sql.indexOf('DO $pin$');check(sealAt>0,'PRIVACY_SEAL_REQUIRED');
 // Trusted installer configures the dedicated login between these phases. Until
 // seal, the sentinel cannot match and runtime reads fail closed. No repin RPC.
 return{schema_version:1 as const,catalog_sha256:hash(metadata),sql_sha256:hash(sql),relations:expected.length,scanned_relations:scans.length,catalog:expected,sql,prepare_sql:sql.slice(0,sealAt),seal_sql:sql.slice(sealAt)};
}
