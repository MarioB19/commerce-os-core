import { readFile,mkdir,writeFile,realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderRecipe } from '../packages/creative-engine/src/render.js';
const args=Object.fromEntries(process.argv.slice(2).reduce<string[][]>((a,v,i,all)=>{if(v.startsWith('--'))a.push([v.slice(2),all[i+1]]);return a;},[]));
for(const key of ['plan','assets','work-root','ffmpeg','ffprobe','browser'])if(!args[key])throw new Error(`MISSING_ARGUMENT:${key}`);
await mkdir(resolve(args['work-root']),{recursive:true});const workRoot=await realpath(args['work-root']);
const plan=JSON.parse(await readFile(resolve(args.plan),'utf8'));let last=0;
const result=await renderRecipe(plan,{assetRoot:await realpath(args.assets),workRoot,ffmpegPath:args.ffmpeg,ffprobePath:args.ffprobe,browserExecutable:args.browser,onProgress:event=>{if(event.step!=='render'||Date.now()-last>15000){last=Date.now();console.log(JSON.stringify(event));}}});
await writeFile(resolve(workRoot,`result-${plan.recipe.id}-${Date.now()}.json`),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
