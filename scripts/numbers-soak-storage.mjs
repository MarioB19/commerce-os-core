import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const command=promisify(execFile);
/** Read the actual PostgreSQL backing filesystem, not the macOS mount containing this checkout. */
export async function databaseBackingStorage(){
 const container=process.env.PG_CONTAINER_NAME;
 if(!container||!/^commerce-numbers(?:-soak)?-postgres-\d+$/.test(container))throw Error('ISOLATED_POSTGRES_CONTAINER_REQUIRED');
 const {stdout}=await command('docker',['exec',container,'df','-Pk','/var/lib/postgresql/data'],{timeout:5000,maxBuffer:8192});
 const row=stdout.trim().split('\n').at(-1)?.trim().split(/\s+/);
 if(!row||row.length<6||![row[1],row[2],row[3]].every(value=>/^\d+$/.test(value)))throw Error('POSTGRES_FILESYSTEM_UNREADABLE');
 return{source:'docker exec isolated PostgreSQL: df -Pk /var/lib/postgresql/data',total_bytes:Number(row[1])*1024,used_bytes:Number(row[2])*1024,available_bytes:Number(row[3])*1024};
}
