/** V7 F8-E: export the retired V5 tables before migration 0109 drops them.
 * Run with the migration owner connection (admin.env: the installation
 * superuser) inside the installation window, after producers are stopped:
 * on the V5 schema before the V7 publication, or on 0108.
 *
 *   node --import tsx scripts/v7-retirement-export.ts status
 *   node --import tsx scripts/v7-retirement-export.ts export <absolute empty directory>
 *   node --import tsx scripts/v7-retirement-export.ts verify <absolute directory>
 *
 * `status` and `verify` change nothing (verify needs no database). `export`
 * writes one encrypted file per table (mode 0600) plus manifest.json, reads
 * them back and only then records one receipt per table. Output holds table
 * names, counts, digests and identifiers only: never row data or secrets. The
 * directory belongs in private storage outside the repository, and is kept
 * with the application data key that opens it. */
import {readdir} from 'node:fs/promises';
import {isAbsolute,relative,resolve} from 'node:path';
import pg from 'pg';
import {exportRetiredTables,retirementStatus,verifyRetirementExport,RetirementExportError} from '../packages/db/src/retirement-export.js';

const [command,target]=process.argv.slice(2);
const usage=()=>{process.stderr.write('USAGE_STATUS_EXPORT_OR_VERIFY\n');process.exit(2);};
if(!['status','export','verify'].includes(command??''))usage();
if(command!=='status'&&(!target||!isAbsolute(target)))usage();
const summary=(tables:{table:string;rowCount:number;fileSha256:string}[])=>tables.map(t=>({table:t.table,rows:t.rowCount,file_sha256:t.fileSha256}));

async function emptyOutsideRepository(directory:string){
 if(!relative(process.cwd(),resolve(directory)).startsWith('..'))throw new RetirementExportError('RETIREMENT_DIRECTORY_INSIDE_REPOSITORY');
 try{if((await readdir(directory)).length)throw new RetirementExportError('RETIREMENT_DIRECTORY_NOT_EMPTY');}
 catch(error){if(error instanceof RetirementExportError)throw error;if((error as {code?:string}).code!=='ENOENT')throw new RetirementExportError('RETIREMENT_DIRECTORY_UNREADABLE');}
}

try{
 if(command==='verify'){
  const manifest=await verifyRetirementExport(target!);
  process.stdout.write(JSON.stringify({verified:true,export_id:manifest.exportId,created_at:manifest.createdAt,last_migration:manifest.lastMigration,key_fingerprint:manifest.keyFingerprint,tables:summary(manifest.tables)})+'\n');
 }else{
  if(command==='export')await emptyOutsideRepository(target!);
  const client=new pg.Client({connectionString:process.env.DATABASE_URL});
  await client.connect();
  try{
   if(command==='status'){
    const status=await retirementStatus(client);
    process.stdout.write(JSON.stringify({tables:status,with_rows:status.filter(s=>s.rows>0).length,missing_receipts:status.filter(s=>s.rows>0&&!s.receipt).map(s=>s.table)})+'\n');
   }else{
    const manifest=await exportRetiredTables(client,target!);
    process.stdout.write(JSON.stringify({exported:true,export_id:manifest.exportId,created_at:manifest.createdAt,last_migration:manifest.lastMigration,key_fingerprint:manifest.keyFingerprint,tables:summary(manifest.tables)})+'\n');
   }
  }finally{await client.end();}
 }
}catch(error){
 const code=error instanceof RetirementExportError?error.code:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'RETIREMENT_EXPORT_FAILED';
 process.stderr.write(code+'\n');process.exitCode=1;
}
