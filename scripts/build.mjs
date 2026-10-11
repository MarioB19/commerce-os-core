import { build } from 'esbuild';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const external=Object.keys(pkg.dependencies);
// Prevent a reused checkout from shipping removed Studio/renderer bundles.
rmSync('dist',{recursive:true,force:true});
for(const app of ['api','ingress','automation-worker','channel-worker']){
 mkdirSync(`dist/apps/${app}`,{recursive:true});
 const result=await build({metafile:true,entryPoints:[`apps/${app}/src/index.ts`],outfile:`dist/apps/${app}/index.js`,bundle:true,platform:'node',target:'node24',format:'esm',sourcemap:true,external,logLevel:'info'});
 if(Object.keys(result.metafile.inputs).some(path=>/packages\/creative-engine\/|apps\/api\/src\/(studio(?:-voice|-factory)?|creative-devices)\.ts$/.test(path)))throw new Error('RETIRED_PRODUCER_IN_SERVER_BUNDLE');
}
const web=spawnSync('pnpm',['--filter','@commerce/web','build'],{stdio:'inherit'});
if(web.status!==0)process.exit(web.status||1);
