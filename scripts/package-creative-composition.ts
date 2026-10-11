import {buildCreativeBundle} from '../packages/creative-engine/src/render.js';
if(!process.argv[2])throw Error('OUTPUT_REQUIRED');
await buildCreativeBundle(process.argv[2]);
