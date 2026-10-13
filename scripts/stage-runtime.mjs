// Copy a deployment-only source tree; the Codex factory remains untouched in the checkout.
import {cp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const target=process.argv[2];if(!target||!path.isAbsolute(target))throw Error('ABSOLUTE_STAGE_DESTINATION_REQUIRED');
await mkdir(target,{recursive:false});
const excluded=new Set(['studio.ts','studio-voice.ts','studio-factory.ts','creative-devices.ts','mcl-sponsorships.ts']);
const sensitiveSuffix=/\.(?:key|pem|p12|pfx|dump|backup|backup\.aes|tar|tar\.gz)$/i;
function runtimePathAllowed(value){
 const parts=value.split(path.sep),base=path.basename(value);
 return !parts.some(part=>['node_modules','dist','.secrets','.local','.runtime','__pycache__'].includes(part))&&!base.startsWith('.env')&&base!=='.DS_Store'&&!base.endsWith('.pyc')&&!base.endsWith('.log')&&!sensitiveSuffix.test(base);
}
for(const name of ['contracts','db','domain','fulfillment','jobs','messaging','commerce-client','ai-providers'])await cp(`packages/${name}`,path.join(target,'packages',name),{recursive:true,filter:p=>runtimePathAllowed(p)&&!p.endsWith('.test.ts')});
for(const name of ['api','automation-worker','channel-worker','ingress'])await cp(`apps/${name}`,path.join(target,'apps',name),{recursive:true,filter:p=>runtimePathAllowed(p)&&!excluded.has(path.basename(p))&&!p.endsWith('.test.ts')});
const scripts=['owner-api-token.ts','v5-token-envelope.mjs','v5-service-token.ts','bootstrap.ts','import-legacy-operational-config.ts','backup.mjs','waha-session-backup.mjs','backup-database.mjs','postgres-tool.mjs','restore.mjs','local-env.mjs','maintenance.sh','compose-release.sh','scheduled-backup.mjs','retention.ts','recovery-fixture.ts','run-local.mjs','prepare-production.mjs','start-staging-soak.py','staging-soak.ts','sanitize-test-artifacts.py','verify-deployment.mjs'];
for(const name of scripts)await cp(`scripts/${name}`,path.join(target,'scripts',name),{recursive:false});
await writeFile(path.join(target,'RUNTIME-CONTENTS.json'),JSON.stringify({version:5,renderer:false,remote_production:false,shared_services:['api','ingress','automation-worker','channel-worker'],source_factory_preserved:true,scripts},null,2)+'\n');
