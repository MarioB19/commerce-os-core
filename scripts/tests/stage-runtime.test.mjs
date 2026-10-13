import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,access,readFile,readdir,mkdir,writeFile,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
test('runtime staging preserves deployment maintenance and shared services, excludes the Codex renderer',async()=>{const directory=await mkdtemp(path.join(tmpdir(),'commerce-runtime-test-')),target=path.join(directory,'stage');try{execFileSync(process.execPath,['scripts/stage-runtime.mjs',target]);for(const file of ['scripts/owner-api-token.ts','packages/db/src/personal-access-tokens.ts','packages/db/src/release-hold-capability.json','scripts/v5-token-envelope.mjs','scripts/v5-service-token.ts','scripts/bootstrap.ts','scripts/import-legacy-operational-config.ts','scripts/backup.mjs','scripts/postgres-tool.mjs','scripts/restore.mjs','packages/db/src/warmup.ts','packages/db/src/operational-settings.ts','packages/ai-providers/src/index.ts','apps/api/src/auth.ts','apps/automation-worker/src/index.ts','apps/channel-worker/src/index.ts'])await access(path.join(target,file));for(const file of ['packages/creative-engine','packages/intelligence','packages/provider-broker','apps/commerce-worker','apps/api/src/studio.ts','apps/api/src/studio-voice.ts','apps/api/src/studio-factory.ts','apps/api/src/creative-devices.ts','apps/automation-worker/src/mcl-sponsorships.ts','scripts/creative-engine-render.ts'])await assert.rejects(access(path.join(target,file)));const staged=JSON.parse(await readFile(path.join(target,'RUNTIME-CONTENTS.json'),'utf8'));assert.equal(staged.renderer,false);const scriptFiles=await readdir(path.join(target,'scripts'));assert.ok(scriptFiles.includes('bootstrap.ts'));}finally{await rm(directory,{recursive:true,force:true});}});

test('runtime staging rejects ignored credentials and backups even if they exist locally',async()=>{
 const suffix=`${process.pid}-${Date.now()}`,directory=await mkdtemp(path.join(tmpdir(),'commerce-runtime-sensitive-')),target=path.join(directory,'stage');
 const secretParent=path.resolve('apps/api/.secrets'),secretScope=path.join(secretParent,`runtime-test-${suffix}`),secret=path.join(secretScope,'sentinel.key'),backup=path.resolve(`packages/db/runtime-test-${suffix}.backup`);
 await mkdir(secretScope,{recursive:true});await writeFile(secret,'synthetic-secret');await writeFile(backup,'synthetic-backup');
 try{
  execFileSync(process.execPath,['scripts/stage-runtime.mjs',target]);
  await assert.rejects(access(path.join(target,path.relative(process.cwd(),secret))));
  await assert.rejects(access(path.join(target,path.relative(process.cwd(),backup))));
 }finally{
  await rm(secretScope,{recursive:true,force:true});await rm(backup,{force:true});await rmdir(secretParent).catch(()=>{});await rm(directory,{recursive:true,force:true});
 }
});
