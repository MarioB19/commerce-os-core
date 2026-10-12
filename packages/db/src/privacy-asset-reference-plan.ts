import {createHash} from 'node:crypto';
import {buildPrivacyInventoryPlan,privacyInventoryPolicy,type PrivacyInventoryCatalog} from './privacy-inventory-plan.js';
const quote=(v:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))throw Error('PRIVACY_ASSET_IDENTIFIER');return '"'+v+'"';};
const literal=(v:string)=>"'"+v.replaceAll("'","''")+"'";
const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
/** The same028 catalog/PK validation supplies this global negative-reference
 * reader. It emits no runtime EXECUTE and accepts no caller rows, asset IDs,
 * classifications or proofs. Installation remains a privileged reviewed step. */
export function buildPrivacyAssetReferencePlan(catalog:PrivacyInventoryCatalog){
 const inventory=buildPrivacyInventoryPlan(catalog,privacyInventoryPolicy(catalog.tables.map(t=>t.name)));
 const expected=inventory.catalog;const required=['records','record_versions','privacy_record_batches','privacy_jobs','privacy_opaque_passes','privacy_reference_epoch','privacy_reference_leases'];
 if(required.some(n=>!expected.some(t=>t.schema==='public'&&t.name===n)))throw Error('PRIVACY_ASSET_DEPENDENCIES');
 const specs=JSON.stringify(expected),relations=expected.map(t=>`${quote(t.schema)}.${quote(t.name)}`);
 // These declared closed audit schemas preserve technical UUID references, never
 // ciphertext or a capability to read a file. All other references are scanned.
 const technical=['privacy_writer_epochs','privacy_writer_leases','privacy_reference_epoch','privacy_reference_leases','privacy_policy_adoptions','privacy_hold_events','privacy_backup_attestations','privacy_backup_revocations','privacy_jobs','privacy_closure_receipts','privacy_record_batches','privacy_record_apply_admissions','privacy_minimized_records','privacy_record_completions','financial_retention_attestations','financial_retention_installations','financial_retention_corrections','commercial_resolution_receipts','privacy_backup_file_sets','privacy_opaque_implementations','privacy_opaque_passes','privacy_result_seals','privacy_result_preservations','privacy_result_confirmations','privacy_asset_batches','privacy_asset_apply_admissions','privacy_minimized_assets','privacy_asset_completions','privacy_backup_row_sets','privacy_backup_row_pages','privacy_backup_row_entries','privacy_backup_row_seals'];
 // Fixed scalar types and scope labels cannot encode an asset reference. Other
 // columns remain native predicates, including every JSON/text/UUID and bytea.
 // Filtering before to_jsonb avoids materializing unrelated source rows.
 const scans=expected.map(t=>{
  const conditions:string[]=[];
  for(const c of t.columns){
   const column=`r.${quote(c.name)}`;
   if(c.type==='bytea'){conditions.push(`${column} IS NOT NULL`);continue;}
   if(/^(?:smallint|integer|bigint|boolean|real|double precision|numeric(?:\([0-9,]+\))?|date|time(?:stamp)?(?:\([0-9]+\))? (?:with|without) time zone|interval)$/.test(c.type))continue;
   if(['workspace_id','environment'].includes(c.name)&&c.type==='text')continue;
   conditions.push(`lower(${column}::text) LIKE ANY($1)`);
   conditions.push(`${column}::text ~* '(ciphertext|encrypted|v1[.])'`);
   if(/ciphertext|encrypted/i.test(c.name)&&!/_sha256$|_bytes$/.test(c.name))conditions.push(`${column} IS NOT NULL AND ${column}::text NOT IN ('','null')`);
  }
  return{schema:t.schema,name:t.name,predicate:conditions.length?'('+conditions.join(' OR ')+')':'false'};
 });
 const grants=expected.map(t=>`GRANT SELECT ON ${quote(t.schema)}.${quote(t.name)} TO commerce_privacy_asset_reference;\nCREATE POLICY privacy_asset_closed_reader ON ${quote(t.schema)}.${quote(t.name)} FOR SELECT TO commerce_privacy_asset_reference USING(true);`).join('\n');
 const sql=`-- Generated035, same028 catalog ${inventory.catalog_sha256}. No runtime EXECUTE.
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commerce_privacy_asset_reference') THEN RAISE EXCEPTION 'PRIVACY_ASSET_ROLE_EXISTS';END IF;
 CREATE ROLE commerce_privacy_asset_reference NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;END $$;
${[...new Set(expected.map(t=>t.schema))].map(s=>`GRANT USAGE ON SCHEMA ${quote(s)} TO commerce_privacy_asset_reference;`).join('\n')}
${grants}
GRANT EXECUTE ON FUNCTION public.privacy_record_authority(uuid,uuid),public.read_privacy_opaque_pass(uuid,uuid,uuid,uuid),public.privacy_reference_fence_assert(uuid),public.privacy_reference_fences_assert() TO commerce_privacy_asset_reference;
CREATE FUNCTION public.privacy_reference_has_opaque(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $opaque$
DECLARE pending jsonb[]:=ARRAY[value];v jsonb;k text;n integer:=0;BEGIN
 WHILE cardinality(pending)>0 LOOP
  v:=pending[1];pending:=pending[2:];n:=n+1;IF n>20000 THEN RAISE EXCEPTION 'PRIVACY_ASSET_JSON_BOUND';END IF;
  IF jsonb_typeof(v)='string' AND (v#>>'{}')~'^v1[.]' THEN RETURN true;END IF;
  IF jsonb_typeof(v)='object' THEN FOR k,value IN SELECT key,x.value FROM jsonb_each(v)x LOOP
   IF k~*'(ciphertext|encrypted)' AND k!~*'(_sha256|_bytes)$' AND value NOT IN('null'::jsonb,'""'::jsonb) THEN RETURN true;END IF;
   pending:=array_append(pending,value);END LOOP;
  ELSIF jsonb_typeof(v)='array' THEN FOR value IN SELECT x.value FROM jsonb_array_elements(v)x LOOP pending:=array_append(pending,value);END LOOP;END IF;
 END LOOP;RETURN false;
END $opaque$;
REVOKE ALL ON FUNCTION public.privacy_reference_has_opaque(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_reference_has_opaque(jsonb) TO commerce_privacy_asset_reference;
CREATE FUNCTION public.privacy_asset_body_closed(body jsonb,asset_id uuid) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $shape$
DECLARE k text;kind text:=COALESCE(body->>'kind','file');status text:=body->>'status';BEGIN
 IF jsonb_typeof(body)<>'object' OR octet_length(body::text)>1048576 OR NOT(body ?& ARRAY['name','status']) OR jsonb_typeof(body->'name')<>'string' OR length(body->>'name') NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;
 FOR k IN SELECT jsonb_object_keys(body) LOOP
  IF k<>ALL(ARRAY['name','kind','mime_type','size_bytes','sha256','url','adapter','delivery_ciphertext','status','storage_key','approval_hash','authorization_id','source','immutable','message_id','envelope_id','channel_event_id']) THEN RETURN false;END IF;
 END LOOP;
 IF body ? 'approval_hash' AND body->'approval_hash'<>'null'::jsonb OR body ? 'authorization_id' AND body->'authorization_id'<>'null'::jsonb THEN RETURN false;END IF;
 IF body ? 'source' AND body->>'source'<>'channel_ingress' OR body ? 'immutable' AND body->'immutable'<>'true'::jsonb THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['message_id','envelope_id','channel_event_id'] LOOP IF body ? k AND COALESCE(body->>k!~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$',true) THEN RETURN false;END IF;END LOOP;
 IF body ? 'source' AND (kind<>'file' OR NOT(body ?& ARRAY['message_id','envelope_id','channel_event_id','immutable'])) THEN RETURN false;END IF;
 IF body ? 'mime_type' AND (jsonb_typeof(body->'mime_type')<>'string' OR length(body->>'mime_type') NOT BETWEEN 1 AND 256) THEN RETURN false;END IF;
 IF body ? 'size_bytes' AND (jsonb_typeof(body->'size_bytes')<>'number' OR COALESCE(body->>'size_bytes'!~'^(0|[1-9][0-9]{0,8})$',true)) THEN RETURN false;END IF;
 IF body ? 'sha256' AND COALESCE(body->>'sha256'!~'^[a-f0-9]{64}$',true) THEN RETURN false;END IF;
 IF kind='file' THEN
  IF status NOT IN('UPLOAD_PENDING','UPLOADED','READY') OR COALESCE(body->>'adapter','private_file')<>'private_file' OR body ?| ARRAY['url','delivery_ciphertext'] THEN RETURN false;END IF;
  IF NOT(body ? 'storage_key') THEN RETURN status='UPLOAD_PENDING';END IF;
  RETURN COALESCE(body->>'storage_key'~('^'||asset_id::text||'(-[a-f0-9]{64})?$'),false) AND (body->>'storage_key'=asset_id::text OR body->>'storage_key'=asset_id::text||'-'||(body->>'sha256'));
 ELSIF kind='link' THEN
  RETURN status='READY' AND COALESCE(body->>'adapter','link')='link' AND NOT(body ?| ARRAY['storage_key','delivery_ciphertext']) AND COALESCE(body->>'url'~'^https://',false);
 ELSIF kind='access' THEN
  RETURN status='READY' AND body->>'adapter' IN('link','webhook') AND NOT(body ?| ARRAY['storage_key','url']) AND COALESCE(body->>'delivery_ciphertext'~'^v1[.]',false);
 END IF;RETURN false;
END $shape$;
REVOKE ALL ON FUNCTION public.privacy_asset_body_closed(jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.privacy_asset_body_closed(jsonb,uuid) TO commerce_privacy_asset_reference;
CREATE FUNCTION public.read_privacy_asset_references(record_batch uuid,opaque_pass uuid,profile_lease uuid,reference_lease uuid) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $assets$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');b public.privacy_record_batches%ROWTYPE;j public.privacy_jobs%ROWTYPE;
 e jsonb;h jsonb;current_row jsonb;hist jsonb;spec jsonb;actual jsonb;row_value jsonb;key_value jsonb;key_name text;key_hash text;row_hash text;
 r public.records%ROWTYPE;v public.record_versions%ROWTYPE;pass jsonb;epoch bigint;candidate uuid;candidate_ids uuid[]:=ARRAY[]::uuid[];owned_ids uuid[]:=ARRAY[]::uuid[];
 facts jsonb:='[]';asset_facts jsonb:='[]';asset jsonb;matches jsonb;classification text;reason text;owned boolean;opaque boolean;covered boolean;
 record_count integer;history_count integer;row_count integer:=0;total_bytes bigint:=0;relation_rows bigint;checked_rows bigint:=0;coverage jsonb:='[]';patterns text[];predicate text;reference_hash text;kind text;storage text;body_kind text;bad boolean;
BEGIN
 epoch:=public.privacy_reference_fence_assert(reference_lease);PERFORM public.privacy_reference_fences_assert();
 j:=public.privacy_record_authority(record_batch,profile_lease);
 SELECT * INTO STRICT b FROM public.privacy_record_batches WHERE id=record_batch AND workspace_id=w AND environment='REAL';
 IF b.job_sha256<>j.manifest_sha256 OR b.journey_id<>j.journey_id THEN RAISE EXCEPTION 'PRIVACY_ASSET_BATCH_CHANGED';END IF;
 pass:=public.read_privacy_opaque_pass(opaque_pass,j.journey_id,j.backup_id,profile_lease);
 -- Source33 membership/current/history must still be byte-exact before deriving IDs.
 FOR e IN SELECT value FROM jsonb_array_elements(b.manifest) LOOP
  SELECT to_jsonb(x) INTO current_row FROM public.records x WHERE x.id=(e->>'record_id')::uuid AND x.workspace_id=w AND x.environment='REAL';
  IF current_row IS NULL OR encode(public.digest(current_row::text,'sha256'),'hex')<>e->>'source_sha256' THEN RAISE EXCEPTION 'PRIVACY_ASSET_RECORD_CHANGED';END IF;
  owned_ids:=array_append(owned_ids,(e->>'record_id')::uuid);history_count:=0;
  FOR h IN SELECT value FROM jsonb_array_elements(e->'history') LOOP
   SELECT to_jsonb(x) INTO hist FROM public.record_versions x WHERE x.record_id=(e->>'record_id')::uuid AND x.workspace_id=w AND x.environment='REAL' AND x.version=(h->>'version')::integer;
   IF hist IS NULL OR encode(public.digest(hist::text,'sha256'),'hex')<>h->>'source_sha256' THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;history_count:=history_count+1;
   FOR candidate IN SELECT DISTINCT m[1]::uuid FROM regexp_matches(lower((hist->'body')::text),'([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})','g')m LOOP
    IF NOT(candidate=ANY(candidate_ids)) AND EXISTS(SELECT 1 FROM public.records a WHERE a.id=candidate AND a.kind='asset') THEN candidate_ids:=array_append(candidate_ids,candidate);END IF;
   END LOOP;
  END LOOP;
  SELECT count(*) INTO record_count FROM public.record_versions WHERE record_id=(e->>'record_id')::uuid;
  IF record_count<>history_count OR history_count<>(current_row->>'version')::integer THEN RAISE EXCEPTION 'PRIVACY_ASSET_HISTORY_CHANGED';END IF;
 END LOOP;
 IF cardinality(candidate_ids)>1000 THEN RAISE EXCEPTION 'PRIVACY_ASSET_BOUND';END IF;
 -- Exact metadata is rechecked independently of the guard table list.
 SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.relname,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),'primary_key',(SELECT jsonb_agg(a.attname ORDER BY u.pos) FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY u(num,pos) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.num WHERE k.conrelid=t.oid AND k.contype='p')) ORDER BY n.nspname COLLATE "C",t.relname COLLATE "C"),'[]') INTO actual FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND t.relkind IN('r','p','m','f');
 IF actual IS DISTINCT FROM ${literal(specs)}::jsonb THEN RAISE EXCEPTION 'PRIVACY_ASSET_CATALOG_CHANGED';END IF;
 FOR spec IN SELECT value FROM jsonb_array_elements(${literal(specs)}::jsonb) LOOP
  PERFORM public.privacy_reference_fence_assert(reference_lease);
  EXECUTE format('SELECT count(*) FROM %I.%I',spec->>'schema',spec->>'name') INTO relation_rows;
  checked_rows:=checked_rows+relation_rows;coverage:=coverage||jsonb_build_array(jsonb_build_object('relation',(spec->>'schema')||'.'||(spec->>'name'),'rows',relation_rows::text));
  IF cardinality(candidate_ids)=0 OR spec->>'schema'='public' AND spec->>'name'=ANY(ARRAY[${technical.map(literal).join(',')}]) THEN CONTINUE;END IF;
  SELECT array_agg('%'||a::text||'%') INTO patterns FROM unnest(candidate_ids)a;
  -- Native SQL streams every row through the predicate. Only potentially relevant
  -- rows enter PL/pgSQL RAM; a large unrelated database is not truncated.
  SELECT x->>'predicate' INTO STRICT predicate FROM jsonb_array_elements(${literal(JSON.stringify(scans))}::jsonb)x WHERE x->>'schema'=spec->>'schema' AND x->>'name'=spec->>'name';
  FOR row_value IN EXECUTE format('SELECT to_jsonb(r) FROM %I.%I r WHERE %s LIMIT 10001',spec->>'schema',spec->>'name',predicate) USING patterns LOOP
   row_count:=row_count+1;total_bytes:=total_bytes+octet_length(row_value::text);
   IF row_count>10000 OR total_bytes>67108864 OR octet_length(row_value::text)>8388608 THEN RAISE EXCEPTION 'PRIVACY_ASSET_SCAN_BOUND';END IF;
   key_value:='{}';FOR key_name IN SELECT jsonb_array_elements_text(spec->'primary_key') LOOP key_value:=key_value||jsonb_build_object(key_name,row_value->key_name);END LOOP;
   key_hash:=encode(public.digest(key_value::text,'sha256'),'hex');row_hash:=encode(public.digest(row_value::text,'sha256'),'hex');
   opaque:=public.privacy_reference_has_opaque(row_value) OR EXISTS(SELECT 1 FROM jsonb_array_elements(spec->'columns') c WHERE c->>'type'='bytea' AND row_value->(c->>'name')<>'null'::jsonb);covered:=false;
   IF opaque AND spec->>'schema'='public' AND row_value->>'workspace_id'=w AND spec->>'name' IN('idempotency','sales_history_imports') THEN
    covered:=EXISTS(SELECT 1 FROM jsonb_array_elements(pass->'bindings')x WHERE x->>'relation'=spec->>'name' AND x->>'key_sha256'=key_hash AND x->>'source_sha256'=row_hash AND x->'asset_refs'='[]'::jsonb);
   END IF;
   -- No schema name alone proves encrypted bytes asset-free. A reviewed, 
   -- authenticated purpose binding is required even for the candidate itself.
   FOR candidate IN SELECT unnest(candidate_ids) LOOP
    IF spec->>'schema'='public' AND spec->>'name' IN('records','record_versions') AND COALESCE(row_value->>'id',row_value->>'record_id')=candidate::text AND NOT(opaque AND NOT covered) THEN CONTINUE;END IF;
    IF (opaque AND NOT covered) OR position(candidate::text IN lower(row_value::text))>0 THEN
     owned:=false;
     IF row_value->>'workspace_id'=w AND row_value->>'environment'='REAL' AND spec->>'schema'='public' THEN
      IF spec->>'name' IN('records','record_versions') THEN owned:=COALESCE(row_value->>'id',row_value->>'record_id')=ANY(SELECT unnest(owned_ids)::text);
      ELSIF spec->>'name'='outbox' THEN owned:=row_value->>'conversation_id'=j.journey_id::text;
      ELSIF spec->>'name'='commands' THEN owned:=row_value->>'resource_id'=ANY(SELECT unnest(owned_ids)::text);
      ELSIF spec->>'name'='domain_events' THEN owned:=row_value->>'aggregate_id'=ANY(SELECT unnest(owned_ids)::text);
      END IF;
     END IF;
     facts:=facts||jsonb_build_array(jsonb_build_object('asset_id',candidate,'relation',(spec->>'schema')||'.'||(spec->>'name'),'key_sha256',key_hash,'source_sha256',row_hash,'classification',CASE WHEN opaque AND NOT covered THEN 'BLOCKED' WHEN owned THEN 'OWNED' ELSE 'SHARED' END));
     IF jsonb_array_length(facts)>10000 OR octet_length(facts::text)>8388608 THEN RAISE EXCEPTION 'PRIVACY_ASSET_REFERENCE_BOUND';END IF;
    END IF;
   END LOOP;
  END LOOP;
 END LOOP;
 FOR candidate IN SELECT unnest(candidate_ids) ORDER BY 1 LOOP
  SELECT a.* INTO STRICT r FROM public.records a WHERE a.id=candidate AND a.kind='asset';hist:='[]';history_count:=0;bad:=false;kind:=COALESCE(r.body->>'kind','file');storage:=r.body->>'storage_key';
  IF r.workspace_id<>w OR r.environment<>'REAL' THEN classification:='SHARED';reason:='ASSET_OTHER_SCOPE';ELSE classification:='OWNED';reason:='EXCLUSIVE_OWNERSHIP';END IF;
  bad:=NOT public.privacy_asset_body_closed(r.body,r.id) OR (kind='file' AND storage IS NULL);
  FOR v IN SELECT * FROM public.record_versions WHERE record_id=r.id ORDER BY version LOOP
   history_count:=history_count+1;body_kind:=COALESCE(v.body->>'kind','file');
   IF v.version<>history_count OR (v.workspace_id,v.environment,v.kind) IS DISTINCT FROM(r.workspace_id,r.environment,r.kind) OR body_kind<>kind OR NOT public.privacy_asset_body_closed(v.body,r.id) OR (kind='file' AND v.body ? 'storage_key' AND v.body->>'storage_key' IS DISTINCT FROM storage) OR (kind<>'file' AND v.body ? 'storage_key') OR (v.version=r.version AND v.body<>r.body) THEN bad:=true;END IF;
   hist:=hist||jsonb_build_array(jsonb_build_object('version',v.version,'fullrow_sha256',encode(public.digest(to_jsonb(v)::text,'sha256'),'hex')));
  END LOOP;
  IF history_count<>r.version OR history_count<1 THEN bad:=true;END IF;
  SELECT COALESCE(jsonb_agg(value ORDER BY value->>'relation',value->>'key_sha256'),'[]') INTO matches FROM jsonb_array_elements(facts)x WHERE x->>'asset_id'=candidate::text;
  IF bad OR EXISTS(SELECT 1 FROM jsonb_array_elements(matches)x WHERE x->>'classification'='BLOCKED') THEN classification:='BLOCKED';reason:=CASE WHEN bad THEN 'ASSET_HISTORY_OR_ADAPTER_UNRESOLVED' ELSE 'OPAQUE_REFERENCE_UNRESOLVED' END;
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(matches)x WHERE x->>'classification'='SHARED') THEN classification:='SHARED';reason:='OTHER_PURPOSE_REFERENCE';END IF;
  reference_hash:=encode(public.digest(matches::text,'sha256'),'hex');
  asset_facts:=asset_facts||jsonb_build_array(jsonb_build_object('asset_id',candidate,'source_sha256',encode(public.digest(to_jsonb(r)::text,'sha256'),'hex'),'history',hist,'reference_sha256',reference_hash,'classification',classification,'reason_code',reason));
 END LOOP;
 PERFORM public.privacy_record_authority(record_batch,profile_lease);PERFORM public.privacy_reference_fence_assert(reference_lease);PERFORM public.privacy_reference_fences_assert();
 RETURN jsonb_build_object('schema_version',1,'workspace_id',w,'environment','REAL','journey_id',j.journey_id,'record_batch_id',record_batch,'record_manifest_sha256',b.manifest_sha256,'opaque_pass_sha256',pass->>'receipt_sha256','reference_epoch',epoch::text,'catalog_sha256',${literal(inventory.catalog_sha256)},'reference_set_sha256',encode(public.digest(asset_facts::text,'sha256'),'hex'),'coverage',jsonb_build_object('relations',jsonb_array_length(coverage),'rows_checked',checked_rows::text,'relevant_rows',row_count),'assets',asset_facts,'erasure_authorized',false);
END $assets$;
ALTER FUNCTION public.read_privacy_asset_references(uuid,uuid,uuid,uuid) OWNER TO commerce_privacy_asset_reference;
REVOKE ALL ON FUNCTION public.read_privacy_asset_references(uuid,uuid,uuid,uuid) FROM PUBLIC;
`;
 return{schema_version:1 as const,catalog_sha256:inventory.catalog_sha256,relations:relations.length,sha256:sha(sql),sql};
}
