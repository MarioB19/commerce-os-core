import {describe,it,expect} from 'vitest';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
describe('Intelligence worker authentication boundary',()=>{
 it('bundles the deployed automation entry without API routes, auth initialization or Better Auth',async()=>{
  const pkg=JSON.parse(await readFile('package.json','utf8'));
  const result=await build({entryPoints:['apps/automation-worker/src/index.ts'],bundle:true,platform:'node',target:'node24',format:'esm',write:false,metafile:true,external:Object.keys(pkg.dependencies),logLevel:'silent'});
  const inputs=Object.keys(result.metafile!.inputs),imports=Object.values(result.metafile!.outputs).flatMap(o=>o.imports.map(i=>i.path));
  expect(inputs).toContain('packages/intelligence/src/index.ts');
  expect(inputs.filter(path=>path.includes('apps/api/')&&path!=='apps/api/src/meta-client.ts'||path.includes('better-auth')||path.includes('packages/auth/'))).toEqual([]);
  expect(imports.filter(path=>path.includes('better-auth'))).toEqual([]);
  expect(result.outputFiles[0]!.text).not.toContain('BETTER_AUTH_SECRET');
 });
 it('imports and validates the shared domain in a real production process with no auth secret or database connection',async()=>{
  const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'production',DATABASE_URL:'postgres://unused:unused@127.0.0.1:1/unreachable'};
  delete env.BETTER_AUTH_SECRET;delete env.AUTH_SECRET;
  const {stdout,stderr}=await execute(process.execPath,['--import','tsx','--input-type=module','-e',`import {intelligenceFingerprint,parseIntelligenceAnalysis} from './packages/intelligence/src/index.ts';if(process.env.BETTER_AUTH_SECRET)throw Error('SECRET_MUST_BE_ABSENT');const fingerprint=intelligenceFingerprint({q:'domain fixture',country:'MX'});try{parseIntelligenceAnalysis({status:'incomplete',output:[]},[]);}catch(error){if(error.statusCode!==422||error.code!=='ANALYSIS_INCOMPLETE')throw error;}console.log(JSON.stringify({environment:process.env.NODE_ENV,fingerprint,secret_present:false}));`],{env,timeout:10000});
  expect(JSON.parse(stdout)).toMatchObject({environment:'production',secret_present:false,fingerprint:expect.stringMatching(/^[a-f0-9]{64}$/)});
  expect(stderr).not.toContain('BetterAuth');
 });
});
