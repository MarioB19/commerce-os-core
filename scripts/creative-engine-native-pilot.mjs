import {createHash} from 'node:crypto';
import {readFile,mkdir,realpath,stat,writeFile,lstat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {pathToFileURL} from 'node:url';

// Runs with the Node shipped by Desktop. No system browser, font, FFmpeg or Node fallback.
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>{if(v.startsWith('--'))a.push([v.slice(2),all[i+1]]);return a;},[]));
for(const key of ['runtime','inputs','output'])if(!args[key])throw new Error(`MISSING_ARGUMENT:${key}`);
const runtime=await realpath(args.runtime),inputs=await realpath(args.inputs);await mkdir(resolve(args.output),{recursive:true});const output=await realpath(args.output);
const hashFile=async path=>{const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');};
async function contained(root,path){if(isAbsolute(path)||path.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))throw new Error('UNSAFE_PILOT_PATH');const target=resolve(root,path);if(relative(root,target).startsWith(`..${sep}`)||(await lstat(target)).isSymbolicLink()||await realpath(target)!==target)throw new Error('UNSAFE_PILOT_PATH');return target;}
const manifest=JSON.parse(await readFile(resolve(inputs,'manifest.json'),'utf8'));
if(manifest.schema_version!==1||manifest.purpose!=='EVALUATION_ONLY'||manifest.originals_modified!==false||!Array.isArray(manifest.files)||manifest.files.length>150||!Array.isArray(manifest.products)||manifest.products.length>2)throw new Error('INVALID_PILOT_MANIFEST');
let total=0;const files=new Map();for(const file of manifest.files){if(typeof file.sha256!=='string'||! /^[a-f0-9]{64}$/.test(file.sha256)||!Number.isInteger(file.bytes)||file.bytes<=0||files.has(file.path.toLowerCase()))throw new Error('INVALID_PILOT_FILE');const path=await contained(inputs,file.path),actual=await stat(path);total+=actual.size;if(actual.size!==file.bytes||total>500*1024*1024||await hashFile(path)!==file.sha256)throw new Error('PILOT_FILE_MISMATCH');files.set(file.path.toLowerCase(),file);}
const resources=JSON.parse(await readFile(resolve(runtime,'engine-resources.json'),'utf8'));
const {renderRecipe,compileRecipe,verifyAudioSync}=await import(pathToFileURL(resolve(runtime,'engine.mjs')).href);
const results=[];for(const product of manifest.products){if(!/^[a-z0-9-]{1,80}$/.test(product.id))throw new Error('INVALID_PILOT_PRODUCT');if(args.product&&args.product!==product.id)continue;const planFile=`${product.id}/plan.json`;if(!files.has(planFile))throw new Error('PILOT_PLAN_NOT_VERIFIED');const saved=JSON.parse(await readFile(await contained(inputs,planFile),'utf8'));
 const plan=compileRecipe(saved.recipe,{platform:`${process.platform}-${process.arch}`,inputApproval:saved.input_approval,authorization:saved.authorization,assets:saved.asset_attestations});
 for(const asset of plan.recipe.assets){const file=files.get(`${product.id}/assets/${asset.asset_id}`.toLowerCase());if(!file||file.sha256!==asset.sha256||file.bytes!==asset.bytes)throw new Error('PILOT_ASSET_NOT_VERIFIED');}
 const workRoot=resolve(output,product.id);await mkdir(workRoot,{recursive:true});let last=0;
 const options={assetRoot:await realpath(resolve(inputs,product.id,'assets')),workRoot:await realpath(workRoot),browserExecutable:await contained(runtime,resources.browser),ffmpegPath:await contained(runtime,resources.ffmpeg),ffprobePath:await contained(runtime,resources.ffprobe),fontPath:await contained(runtime,'font.woff2'),bundlePath:await contained(runtime,'composition'),onProgress:event=>{if(event.step!=='render'||Date.now()-last>15000){last=Date.now();process.stdout.write(JSON.stringify({product:product.id,...event})+'\n');}}};
 const result=await renderRecipe(plan,options),master=result.files.find(f=>f.kind==='master');if(!master||result.reused||result.qa.status!=='PASS')throw new Error('PILOT_NEW_RENDER_QA_REQUIRED');
 const sync=await verifyAudioSync(resolve(inputs,product.id,'assets',plan.recipe.voice.asset.asset_id),master.path,options.ffmpegPath,plan.recipe.duration_frames/plan.recipe.fps);if(!sync.passed)throw new Error('PILOT_EXPORTED_AUDIO_SYNC_FAILED');
 const receipt={product:product.id,purpose:'EVALUATION_ONLY',platform:`${process.platform}-${process.arch}`,node:process.version,engine_resources_sha256:await hashFile(resolve(runtime,'engine-resources.json')),inputs_manifest_sha256:await hashFile(resolve(inputs,'manifest.json')),result,exported_audio_sync:sync,human_editorial_review:'PENDING',production_approval:'PENDING',colleague_installation:'NOT_TESTED_BY_CI'};
 await writeFile(resolve(output,`${product.id}-receipt.json`),JSON.stringify(receipt,null,2)+'\n');results.push(receipt);process.stdout.write(JSON.stringify({product:product.id,platform:receipt.platform,master_sha256:master.sha256,master_bytes:master.sizeBytes,qa:result.qa.status,audio_sync:sync.passed,elapsed_ms:result.elapsed_ms})+'\n');
}
if(!results.length)throw new Error('NO_PILOT_SELECTED');await writeFile(resolve(output,'native-pilot-results.json'),JSON.stringify(results,null,2)+'\n');
