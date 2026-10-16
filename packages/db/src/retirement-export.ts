/** V7 F8-E: encrypted, verifiable export of the tables retired with V5
 * Inteligencia, SearchAPI, the R2 library and the creative studio, before
 * migration 0109 drops them. Run with the migration owner connection (the
 * installation superuser) inside the installation window, after producers stop:
 * on the V5 schema (68 migrations) before the V7 publication, or on 0108.
 *
 * Each table becomes `<table>.jsonl.enc`: one line per row, the row as
 * PostgreSQL renders it in JSONB (`to_jsonb(row)::text`, UTC and fixed output
 * settings), encrypted with the application data key. Rows are ordered by that
 * text, so the plaintext digest equals what 0109 recomputes in SQL over the
 * columns the export saw (columns a later V7 migration added, such as derived
 * scope columns, are not part of the digest). A receipt per table goes to
 * `platform_retirement_ledger` only after the files decrypt back to the same
 * rows and the database still holds exactly those rows; 0109 refuses to drop a
 * table with rows whose latest receipt does not match. Nothing here prints row data. */
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type pg from 'pg';
import {encrypt,decrypt,privateDataKeyFingerprint} from './index.js';
import {V7_RETIRED_TABLES,type RetiredTable} from './retired-tables.js';
export {V7_RETIRED_TABLES,type RetiredTable} from './retired-tables.js';

export const RETIREMENT_LEDGER_WORKSPACE='@v7-retirement';
export const RETIREMENT_LEDGER_KIND='V7_RETIREMENT_EXPORT';
export const RETIREMENT_EXPORT_FORMAT='commerce-v7-retirement-export/1';

export interface RetiredTableExport{table:RetiredTable;columns:string[];rowCount:number;plaintextSha256:string;fileSha256:string;file:string}
export interface RetirementManifest{format:typeof RETIREMENT_EXPORT_FORMAT;exportId:string;createdAt:string;database:string;lastMigration:string;keyFingerprint:string;tables:RetiredTableExport[]}
export interface RetiredTableStatus{table:RetiredTable;rows:number;receipt:boolean}
type Client=Pick<pg.ClientBase,'query'>;

export class RetirementExportError extends Error{constructor(readonly code:string){super(code);}}
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const ident=(table:string)=>{if(!(V7_RETIRED_TABLES as readonly string[]).includes(table))throw new RetirementExportError('RETIREMENT_TABLE_UNKNOWN');return '"'+table+'"';};
/** Output settings pinned, transaction-local, for the row text (0109 pins the same). */
export const RETIREMENT_TEXT_SETTINGS:readonly (readonly [string,string])[]=[['TimeZone','UTC'],['DateStyle','ISO, MDY'],['IntervalStyle','postgres'],['extra_float_digits','1'],['bytea_output','hex']];
/** Same expression as 0109: the ordered JSONB row texts (without `$1`, the
 * columns added after the export) joined by a newline. */
export const retiredDigestSql=(table:string)=>`SELECT count(*)::bigint AS n,encode(sha256(convert_to(coalesce(string_agg(j,E'\\n' ORDER BY j),''),'UTF8')),'hex') AS digest FROM (SELECT (to_jsonb(x)-$1::text[])::text AS j FROM ${ident(table)} x) s`;
const columnsSql="SELECT COALESCE(array_agg(attname::text ORDER BY attname::text),'{}') AS columns FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped";
const latestReceiptSql=`SELECT snapshot FROM platform_retirement_ledger WHERE workspace_id=$1 AND kind=$2 AND disposition='EXPORTED_VERIFIED' AND snapshot->>'table'=$3 ORDER BY id DESC LIMIT 1`;
async function pinTextSettings(client:Client){for(const [name,value] of RETIREMENT_TEXT_SETTINGS)await client.query('SELECT set_config($1,$2,true)',[name,value]);}
async function tableColumns(client:Client,table:RetiredTable){return (await client.query(columnsSql,['public.'+table])).rows[0].columns as string[];}
/** Whether the latest verified receipt for a table covers exactly its rows now. */
async function receiptMatches(client:Client,table:RetiredTable,rows:number){
 const snapshot=(await client.query(latestReceiptSql,[RETIREMENT_LEDGER_WORKSPACE,RETIREMENT_LEDGER_KIND,table])).rows[0]?.snapshot;
 if(!snapshot||!Array.isArray(snapshot.columns))return false;
 const current=await tableColumns(client,table);
 if(!snapshot.columns.every((column:unknown)=>typeof column==='string'&&current.includes(column)))return false;
 const {n,digest}=(await client.query(retiredDigestSql(table),[current.filter(column=>!snapshot.columns.includes(column))])).rows[0];
 return Number(n)===rows&&Number(snapshot.row_count)===rows&&digest===snapshot.plaintext_sha256;
}

/** Row security must never make a retired table look empty: only a role that
 * bypasses it (the installation superuser that runs migrations) may plan,
 * export or record receipts. 0109 applies the same rule. */
async function requireBypass(client:Client){
 const ok=(await client.query('SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user')).rows[0]?.bypass===true;
 if(!ok)throw new RetirementExportError('RETIREMENT_OWNER_BYPASS_REQUIRED');
}
async function present(client:Client){
 const tables:RetiredTable[]=[];
 for(const table of V7_RETIRED_TABLES)if((await client.query('SELECT to_regclass($1) IS NOT NULL AS ok',['public.'+table])).rows[0].ok)tables.push(table);
 return tables;
}
async function writePrivate(path:string,content:string){const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,content,{mode:0o600,flag:'wx'});await rename(temporary,path);}

/** Reads and verifies an export directory without a database: every file must
 * have its recorded digest and decrypt to rows with the recorded count/digest. */
export async function verifyRetirementExport(directory:string):Promise<RetirementManifest>{
 let manifest:RetirementManifest;
 try{manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));}catch{throw new RetirementExportError('RETIREMENT_MANIFEST_UNREADABLE');}
 if(manifest?.format!==RETIREMENT_EXPORT_FORMAT||!Array.isArray(manifest.tables)||typeof manifest.exportId!=='string')throw new RetirementExportError('RETIREMENT_MANIFEST_INVALID');
 if(manifest.keyFingerprint!==privateDataKeyFingerprint())throw new RetirementExportError('RETIREMENT_EXPORT_KEY_MISMATCH');
 const seen=new Set<string>();
 for(const entry of manifest.tables){
  ident(entry.table);
  if(seen.has(entry.table)||entry.file!==entry.table+'.jsonl.enc'||!Array.isArray(entry.columns)||!entry.columns.every(column=>typeof column==='string'))throw new RetirementExportError('RETIREMENT_MANIFEST_INVALID');
  seen.add(entry.table);
  let bytes:Buffer;
  try{bytes=await readFile(join(directory,entry.file));}catch{throw new RetirementExportError('RETIREMENT_FILE_MISSING:'+entry.table);}
  if(sha(bytes)!==entry.fileSha256)throw new RetirementExportError('RETIREMENT_FILE_DIGEST_MISMATCH:'+entry.table);
  const lines=bytes.toString('utf8').split('\n').filter(Boolean);let rows:string[];
  try{rows=lines.map(line=>decrypt(line));for(const row of rows)JSON.parse(row);}catch{throw new RetirementExportError('RETIREMENT_FILE_UNREADABLE:'+entry.table);}
  if(rows.length!==entry.rowCount||sha(rows.join('\n'))!==entry.plaintextSha256)throw new RetirementExportError('RETIREMENT_FILE_CONTENT_MISMATCH:'+entry.table);
 }
 return manifest;
}

/** Plan only: which retired tables exist, their row counts and whether a
 * matching verified receipt is already recorded. Changes nothing. */
export async function retirementStatus(client:Client):Promise<RetiredTableStatus[]>{
 await requireBypass(client);
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  await pinTextSettings(client);
  const out:RetiredTableStatus[]=[];
  for(const table of await present(client)){
   const rows=Number((await client.query(`SELECT count(*)::bigint AS n FROM ${ident(table)}`)).rows[0].n);
   out.push({table,rows,receipt:rows>0&&await receiptMatches(client,table,rows)});
  }
  return out;
 }finally{await client.query('ROLLBACK');}
}

/** Exports, reads back and records receipts. Throws before recording anything
 * if a file does not decrypt to the exported rows or the database changed. */
export async function exportRetiredTables(client:Client,directory:string,options:{now?:()=>Date}={}):Promise<RetirementManifest>{
 await requireBypass(client);
 const now=options.now??(()=>new Date()),exportId=randomUUID(),keyFingerprint=privateDataKeyFingerprint();
 await mkdir(directory,{recursive:true,mode:0o700});
 const tables:RetiredTableExport[]=[];let database:string,lastMigration:string;
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 try{
  database=String((await client.query('SELECT current_database() AS d')).rows[0].d);
  lastMigration=String((await client.query('SELECT max(name) AS m FROM schema_migrations')).rows[0].m??'');
  await pinTextSettings(client);
  for(const table of await present(client)){
   const columns=await tableColumns(client,table);
   const rows=(await client.query(`SELECT to_jsonb(x)::text AS j FROM ${ident(table)} x ORDER BY 1`)).rows.map(r=>String(r.j));
   const {n,digest}=(await client.query(retiredDigestSql(table),[[]])).rows[0];
   const plaintextSha256=sha(rows.join('\n'));
   if(Number(n)!==rows.length||digest!==plaintextSha256)throw new RetirementExportError('RETIREMENT_EXPORT_INCONSISTENT:'+table);
   const content=rows.map(row=>encrypt(row)+'\n').join(''),file=table+'.jsonl.enc';
   await writePrivate(join(directory,file),content);
   tables.push({table,columns,rowCount:rows.length,plaintextSha256,fileSha256:sha(content),file});
  }
 }finally{await client.query('ROLLBACK');}
 const manifest:RetirementManifest={format:RETIREMENT_EXPORT_FORMAT,exportId,createdAt:now().toISOString(),database,lastMigration,keyFingerprint,tables};
 const manifestText=JSON.stringify(manifest,null,1)+'\n';
 await writePrivate(join(directory,'manifest.json'),manifestText);
 await verifyRetirementExport(directory);
 const manifestSha256=sha(manifestText);
 await client.query('BEGIN');
 try{
  await pinTextSettings(client);
  for(const entry of tables){
   await client.query(`LOCK TABLE ${ident(entry.table)} IN SHARE MODE`);
   if(JSON.stringify(await tableColumns(client,entry.table))!==JSON.stringify(entry.columns))throw new RetirementExportError('RETIREMENT_SOURCE_CHANGED:'+entry.table);
   const {n,digest}=(await client.query(retiredDigestSql(entry.table),[[]])).rows[0];
   if(Number(n)!==entry.rowCount||digest!==entry.plaintextSha256)throw new RetirementExportError('RETIREMENT_SOURCE_CHANGED:'+entry.table);
   await client.query(`INSERT INTO platform_retirement_ledger(workspace_id,environment,kind,resource_id,snapshot,disposition) VALUES($1,'REAL',$2,$3,$4,'EXPORTED_VERIFIED')`,
    [RETIREMENT_LEDGER_WORKSPACE,RETIREMENT_LEDGER_KIND,entry.table+'@'+exportId,{table:entry.table,columns:entry.columns,row_count:entry.rowCount,plaintext_sha256:entry.plaintextSha256,file_sha256:entry.fileSha256,export_id:exportId,manifest_sha256:manifestSha256,key_fingerprint:keyFingerprint,last_migration:lastMigration,exported_at:manifest.createdAt}]);
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK').catch(()=>undefined);throw error;}
 return manifest;
}
