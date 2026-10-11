/** Internal derivative verification: uses a second supplied approved recipe and its exact authorization. */
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {compileRecipe,renderRecipe,inspectRecipe,derivativeChanges} from '../packages/creative-engine/src/index.js';
const root=process.argv[2],browser=process.argv[3];if(!root||!browser)throw new Error('Usage: provide pilot directory and explicit browser executable');
const original=JSON.parse(await readFile(resolve(root,'plan.json'),'utf8'));
const recipe=structuredClone(original.recipe);recipe.recipe_version+=1;recipe.content.ad_copy.headline=recipe.content.ad_copy.description;
const check=inspectRecipe(recipe,original.platform);if(!check.ok)throw new Error('REUSE_RECIPE_INVALID');const sha=check.fingerprints!.recipe;
const plan=compileRecipe(recipe,{platform:original.platform,inputApproval:{...original.input_approval,recipe_sha256:sha,source_reference:'Delegated internal reuse verification; headline reuses exact approved description; not publication'},authorization:{...original.authorization,recipe_sha256:sha,recipe_version:recipe.recipe_version,authorization_id:`${original.authorization.authorization_id}-reuse`},assets:original.asset_attestations});
const result=await renderRecipe(plan,{assetRoot:resolve(root,'assets'),workRoot:resolve(root,'../../creative-engine'),browserExecutable:browser,ffmpegPath:process.env.CREATIVE_FFMPEG??'/opt/homebrew/bin/ffmpeg',ffprobePath:process.env.CREATIVE_FFPROBE??'/opt/homebrew/bin/ffprobe',onProgress:e=>console.log(JSON.stringify(e))});
if(!result.reused)throw new Error('RENDER_NOT_REUSED');const report={purpose:'EVALUATION_ONLY',previous_recipe_sha256:original.recipe_sha256,new_recipe_sha256:sha,changes:derivativeChanges(original.recipe,recipe,original.platform),reused:result.reused,master_sha256:result.files.find(f=>f.kind==='master')!.sha256,copy_sha256:result.files.find(f=>f.kind==='copy')!.sha256,elapsed_ms:result.elapsed_ms,provider_operations:0};await writeFile(resolve(root,'reuse-evidence.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
