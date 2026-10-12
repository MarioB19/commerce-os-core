import {createHash} from 'node:crypto';
import {buildPrivacyInventoryPlan,type PrivacyInventoryCatalog,type PrivacyInventoryPolicy} from './privacy-inventory-plan.js';
const quote=(v:string)=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v))throw Error('PRIVACY_ROW_IDENTIFIER');return '"'+v+'"';};
const literal=(v:string)=>"'"+v.replaceAll("'","''")+"'";
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
// Proof rows are physically backed up, but cannot recursively become purge pins.
const proofLedgers=new Set(['privacy_backup_row_sets','privacy_backup_row_pages','privacy_backup_row_entries','privacy_backup_row_seals']);
/** Privileged install proposal only. Exact028 metadata, never runtime names. */
export function buildPrivacyBackupRowPlan(catalog:PrivacyInventoryCatalog,policy:PrivacyInventoryPolicy){
 const inventory=buildPrivacyInventoryPlan(catalog,policy);
 const tables=[...catalog.tables.map(t=>({...t,schema:'public'})),...(catalog.non_public_tables??[])];
 const expected=tables.sort((a,b)=>(a.schema+'.'+a.name)<(b.schema+'.'+b.name)?-1:1).map(t=>({schema:t.schema,name:t.name,columns:t.columns.map(c=>({name:c.name,type:c.type,not_null:c.not_null})),primary_key:catalog.primary_keys.find(k=>k.schema===t.schema&&k.table===t.name)!.columns}));
 if(hash(JSON.stringify(expected))!==inventory.catalog_sha256)throw Error('PRIVACY_ROW_028_METADATA_CHANGED');
 const scans=expected.filter(t=>t.schema==='public'&&policy.relations[t.name]!.classification!=='EXCLUDED'&&!proofLedgers.has(t.name)).map(t=>({name:'public.'+t.name,table:t.name,keys:t.primary_key,environment:t.columns.some(c=>c.name==='environment'),nullable_environment:t.columns.some(c=>c.name==='environment'&&!c.not_null)}));
 const metadata=JSON.stringify(expected),specification=JSON.stringify({catalog_sha256:inventory.catalog_sha256,relations:scans});
 const grants=scans.map(t=>`GRANT SELECT ON public.${quote(t.table)} TO commerce_privacy_row_owner;
CREATE POLICY privacy_backup_row_source ON public.${quote(t.table)} FOR SELECT TO commerce_privacy_row_owner USING(workspace_id=NULLIF(current_setting('app.workspace_id',true),'') AND current_setting('app.environment',true)='REAL'${t.environment?(t.nullable_environment?" AND (environment='REAL' OR environment IS NULL)":" AND environment='REAL'"):''});`).join('\n');
 const sql=`-- Generated037, exact028 catalog ${inventory.catalog_sha256}; no mutation authority.
${grants}
CREATE FUNCTION privacy_backup_row_catalog() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $rows$
DECLARE expected jsonb:=${literal(metadata)}::jsonb;actual jsonb;
BEGIN
 SELECT COALESCE(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.relname,'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid=t.oid AND a.attnum>0 AND NOT a.attisdropped),'primary_key',(SELECT jsonb_agg(a.attname ORDER BY u.pos) FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY u(num,pos) JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=u.num WHERE k.conrelid=t.oid AND k.contype='p')) ORDER BY n.nspname COLLATE "C",t.relname COLLATE "C"),'[]') INTO actual FROM pg_class t JOIN pg_namespace n ON n.oid=t.relnamespace WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema' AND t.relkind IN('r','p','m','f');
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_CATALOG_CHANGED';END IF;
 RETURN ${literal(specification)}::jsonb;
END $rows$;
ALTER FUNCTION privacy_backup_row_catalog() OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION privacy_backup_row_catalog() FROM PUBLIC;

-- Private backend cursor in RR. Capture has no erasure authority or purge lease.
CREATE FUNCTION begin_privacy_backup_row_capture() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $rows$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');catalog jsonb;spec jsonb;key_name text;key_expression text;separator text;predicate text;query_text text:='';portal refcursor;token uuid:=gen_random_uuid();
BEGIN
 IF w IS NULL OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR current_setting('transaction_isolation')<>'repeatable read' OR to_regclass('pg_temp.privacy_backup_row_capture') IS NOT NULL THEN RAISE EXCEPTION 'PRIVACY_ROW_CAPTURE_CONTEXT';END IF;
 catalog:=public.privacy_backup_row_catalog();
 FOR spec IN SELECT value FROM jsonb_array_elements(catalog->'relations') LOOP
  key_expression:='jsonb_build_object(';separator:='';FOR key_name IN SELECT jsonb_array_elements_text(spec->'keys') LOOP key_expression:=key_expression||separator||format('%L,image->%L',key_name,key_name);separator:=',';END LOOP;key_expression:=key_expression||')';
  predicate:='r.workspace_id=$1'||CASE WHEN (spec->>'environment')::boolean THEN CASE WHEN (spec->>'nullable_environment')::boolean THEN ' AND (r.environment=''REAL'' OR r.environment IS NULL)' ELSE ' AND r.environment=''REAL''' END ELSE '' END;
  IF query_text<>'' THEN query_text:=query_text||' UNION ALL ';END IF;
  query_text:=query_text||format('SELECT %L::text relation,encode(public.digest((%s)::text,''sha256''),''hex'') key_sha256,encode(public.digest(image::text,''sha256''),''hex'') source_sha256,octet_length(image::text) bytes FROM (SELECT to_jsonb(r) image FROM public.%I r WHERE %s) x',spec->>'name',key_expression,spec->>'table',predicate);
 END LOOP;
 IF query_text='' THEN RAISE EXCEPTION 'PRIVACY_ROW_CAPTURE_CATALOG_EMPTY';END IF;
 portal:='privacy_rows_'||replace(token::text,'-','');OPEN portal NO SCROLL FOR EXECUTE 'SELECT * FROM ('||query_text||') rows ORDER BY relation COLLATE "C",key_sha256' USING w;
 CREATE TEMP TABLE privacy_backup_row_capture(singleton boolean PRIMARY KEY CHECK(singleton),token uuid NOT NULL,workspace_id text NOT NULL,catalog_sha256 text NOT NULL,portal text NOT NULL,page_index integer NOT NULL,total bigint NOT NULL,root_sha256 text NOT NULL,started_at timestamptz NOT NULL,complete boolean NOT NULL,previous_key text[]) ON COMMIT DROP;
 REVOKE ALL ON pg_temp.privacy_backup_row_capture FROM PUBLIC;
 INSERT INTO pg_temp.privacy_backup_row_capture VALUES(true,token,w,catalog->>'catalog_sha256',portal,0,0,encode(public.digest('PRIVACY_BACKUP_ROWS_V1','sha256'),'hex'),clock_timestamp(),false,NULL);
 RETURN jsonb_build_object('schema_version',1,'kind','PRIVATE_ROW_CAPTURE','token',token,'workspace_id',w,'environment','REAL','catalog_sha256',catalog->>'catalog_sha256','relations',(SELECT jsonb_agg(value->>'name') FROM jsonb_array_elements(catalog->'relations')));
END $rows$;
ALTER FUNCTION begin_privacy_backup_row_capture() OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION begin_privacy_backup_row_capture() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION begin_privacy_backup_row_capture() TO commerce_privacy_attestor;

CREATE FUNCTION read_privacy_backup_row_page(capture uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $rows$
DECLARE state record;row_value record;portal refcursor;entries jsonb:='[]';n integer:=0;page_hash text;root text;ended boolean:=false;current_key text[];
BEGIN
 IF current_setting('transaction_isolation')<>'repeatable read' OR current_setting('app.environment',true) IS DISTINCT FROM 'REAL' OR NOT EXISTS(SELECT 1 FROM pg_class WHERE relname='privacy_backup_row_capture' AND relnamespace=pg_my_temp_schema() AND relowner='commerce_privacy_row_owner'::regrole AND relpersistence='t') THEN RAISE EXCEPTION 'PRIVACY_ROW_CAPTURE_CONTEXT';END IF;
 SELECT * INTO STRICT state FROM pg_temp.privacy_backup_row_capture WHERE token=capture AND workspace_id=NULLIF(current_setting('app.workspace_id',true),'');
 IF state.complete THEN RAISE EXCEPTION 'PRIVACY_ROW_CAPTURE_COMPLETE';END IF;
 IF state.catalog_sha256 IS DISTINCT FROM public.privacy_backup_row_catalog()->>'catalog_sha256' THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_CATALOG_CHANGED';END IF;
 portal:=state.portal;
 WHILE n<2000 LOOP
  FETCH NEXT FROM portal INTO row_value;
  IF NOT FOUND THEN ended:=true;CLOSE portal;EXIT;END IF;
  current_key:=ARRAY[row_value.relation,row_value.key_sha256];
  IF row_value.bytes>12000000 OR (state.previous_key IS NOT NULL AND state.previous_key COLLATE "C">=current_key COLLATE "C") THEN RAISE EXCEPTION 'PRIVACY_ROW_CAPTURE_BOUND_OR_DUPLICATE';END IF;
  state.previous_key:=current_key;entries:=entries||jsonb_build_array(jsonb_build_object('relation',row_value.relation,'key_sha256',row_value.key_sha256,'source_sha256',row_value.source_sha256));n:=n+1;
 END LOOP;
 page_hash:=public.privacy_backup_row_page_hash(entries);root:=encode(public.digest(state.root_sha256||chr(10)||page_hash,'sha256'),'hex');
 UPDATE pg_temp.privacy_backup_row_capture SET page_index=state.page_index+1,total=state.total+n,root_sha256=root,complete=ended,previous_key=state.previous_key;
 RETURN jsonb_build_object('schema_version',1,'kind','PRIVATE_ROW_PAGE','capture_id',state.token,'workspace_id',state.workspace_id,'environment','REAL','catalog_sha256',state.catalog_sha256,'page_index',state.page_index,'entries',entries,'page_sha256',page_hash,'root_sha256',root,'row_count',(state.total+n)::text,'complete',ended,'started_at',state.started_at,'observed_at',clock_timestamp());
END $rows$;
ALTER FUNCTION read_privacy_backup_row_page(uuid) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION read_privacy_backup_row_page(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_privacy_backup_row_page(uuid) TO commerce_privacy_attestor;

-- One scan per relation for the candidate batch; native PK, not caller SQL.
CREATE FUNCTION privacy_current_backup_rows(relation_name text,key_filters text[],lease uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog SET TimeZone='UTC' AS $rows$
DECLARE w text:=NULLIF(current_setting('app.workspace_id',true),'');catalog jsonb;spec jsonb;key_name text;key_expression text:='jsonb_build_object(';separator text:='';predicate text;result jsonb;count_value bigint;max_bytes bigint;
BEGIN
 PERFORM public.privacy_writer_fence_assert(lease);catalog:=public.privacy_backup_row_catalog();
 SELECT value INTO spec FROM jsonb_array_elements(catalog->'relations') WHERE value->>'name'=relation_name;
 IF spec IS NULL OR key_filters IS NULL OR cardinality(key_filters)>20000 OR EXISTS(SELECT 1 FROM unnest(key_filters)k WHERE k IS NULL OR k!~'^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROW_RELATION';END IF;
 FOR key_name IN SELECT jsonb_array_elements_text(spec->'keys') LOOP key_expression:=key_expression||separator||format('%L,image->%L',key_name,key_name);separator:=',';END LOOP;key_expression:=key_expression||')';
 predicate:='r.workspace_id=$1'||CASE WHEN (spec->>'environment')::boolean THEN CASE WHEN (spec->>'nullable_environment')::boolean THEN ' AND (r.environment=''REAL'' OR r.environment IS NULL)' ELSE ' AND r.environment=''REAL''' END ELSE '' END;
 EXECUTE format('WITH images AS (SELECT to_jsonb(r) image FROM public.%I r WHERE %s), hashed AS (SELECT encode(public.digest((%s)::text,''sha256''),''hex'') key_sha256,encode(public.digest(image::text,''sha256''),''hex'') source_sha256,octet_length(image::text) bytes FROM images), selected AS (SELECT * FROM hashed WHERE key_sha256=ANY($2) LIMIT 20001) SELECT COALESCE(jsonb_agg(jsonb_build_object(''relation'',$3,''key_sha256'',key_sha256,''source_sha256'',source_sha256) ORDER BY key_sha256),''[]''),count(*),COALESCE(max(bytes),0) FROM selected',spec->>'table',predicate,key_expression)
 INTO result,count_value,max_bytes USING w,key_filters,relation_name;
 IF count_value>20000 OR max_bytes>12000000 OR octet_length(result::text)>8388608 THEN RAISE EXCEPTION 'PRIVACY_BACKUP_ROWS_BOUND';END IF;
 PERFORM public.privacy_writer_fence_assert(lease);RETURN result;
END $rows$;
ALTER FUNCTION privacy_current_backup_rows(text,text[],uuid) OWNER TO commerce_privacy_row_owner;
REVOKE ALL ON FUNCTION privacy_current_backup_rows(text,text[],uuid) FROM PUBLIC;
`;
 return{schema_version:1 as const,catalog_sha256:inventory.catalog_sha256,sql_sha256:hash(sql),relations:scans.map(t=>t.name),sql};
}
