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
// V7 F7 (RF-15.d, RF-16.c): the profile MCP as one downloadable file for
// Claude Desktop/Code and Codex (stdio, Node 20+). Served by the web image.
mkdirSync('apps/web/dist/downloads',{recursive:true});
await build({entryPoints:['apps/commerce-mcp/src/index.ts'],outfile:'apps/web/dist/downloads/commerce-os-mcp.mjs',bundle:true,platform:'node',target:'node20',format:'esm',
 banner:{js:"import {createRequire as __commerceRequire} from 'node:module';const require=__commerceRequire(import.meta.url);"},legalComments:'none',logLevel:'info'});
// V7 F6: the laboratory engine installer for the release window (no tsx in the runtime image).
mkdirSync('dist/scripts',{recursive:true});
await build({entryPoints:['scripts/v7-number-lab-install.ts'],outfile:'dist/scripts/v7-number-lab-install.mjs',bundle:true,platform:'node',target:'node24',format:'esm',external,logLevel:'info'});
