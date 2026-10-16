/** V7 F6 (RF-19): installs the dedicated number-laboratory engine database.
 * Run once in the installation window with the migration owner connection
 * (admin.env), after the V7 migrations:
 *
 *   node --import tsx scripts/v7-number-lab-install.ts --write-env /etc/commerce-os/lab.env
 *   node dist/scripts/v7-number-lab-install.mjs --sources /app/packages/db --write-env …
 *
 * Creates `commerce_lab_engine_*` with the canonical engine sources, seals the
 * installation and creates the three logins; their URLs are written only to the
 * root-owned env file (0600) and never printed. An existing installation is
 * verified and left untouched. Output: database, installation id and engine
 * SHA-256 only. */
import {writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {installNumberLabEngine,numberLabUrls} from '../packages/db/src/number-lab-install.js';

const args=process.argv.slice(2),envIndex=args.indexOf('--write-env'),envFile=envIndex>=0?args[envIndex+1]:undefined,sourcesIndex=args.indexOf('--sources'),sources=sourcesIndex>=0?args[sourcesIndex+1]:undefined;
if(sources!==undefined&&!sources.startsWith('/')){process.stderr.write('USAGE_SOURCES_ABSOLUTE\n');process.exit(2);}
if(!process.env.DATABASE_URL||!envFile||!envFile.startsWith('/')){process.stderr.write('USAGE_ENV_FILE_ABSOLUTE\n');process.exit(2);}
try{
 const installation=await installNumberLabEngine(process.env.DATABASE_URL,sources?{sourcesRoot:pathToFileURL(sources.endsWith('/')?sources:sources+'/')}:{});
 if(installation.created){
  const urls=numberLabUrls(process.env.DATABASE_URL,installation);
  await writeFile(envFile,Object.entries(urls).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
 }
 process.stdout.write(JSON.stringify({database:installation.database,installation_id:installation.installationId,engine_sha256:installation.engineSha256,created:installation.created,env_file_written:installation.created})+'\n');
}catch(error){
 const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'LAB_INSTALL_FAILED';
 process.stderr.write(code+(error&&typeof error==='object'&&'source' in error?' '+String((error as {source:unknown}).source):'')+'\n');process.exitCode=1;
}
