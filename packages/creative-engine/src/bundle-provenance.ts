import {readFile,readdir,lstat,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {ENGINE_SOURCE_SHA256} from './engine-source.js';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const marker='commerce-composition.json';
async function inventory(root:string){const files:Array<{path:string;sha256:string}>=[];async function walk(dir:string){for(const name of (await readdir(dir)).sort()){const p=resolve(dir,name),st=await lstat(p);if(st.isSymbolicLink())throw Error('BUNDLE_SYMLINK');if(st.isDirectory())await walk(p);else if(st.isFile()&&relative(root,p)!==marker)files.push({path:relative(root,p).split('\\').join('/'),sha256:sha(await readFile(p))});}}await walk(root);return files;}
export async function writeBundleProvenance(root:string){const files=await inventory(root),document={schema_version:1,engine_version:'1.1.0',engine_source_sha256:ENGINE_SOURCE_SHA256,files,bundle_sha256:sha(Buffer.from(JSON.stringify(files)))};await writeFile(resolve(root,marker),JSON.stringify(document,null,2)+'\n');return document;}
export async function verifyBundleProvenance(root:string){if(!isAbsolute(root))throw Error('BUNDLE_ABSOLUTE_PATH_REQUIRED');const m=JSON.parse(await readFile(resolve(root,marker),'utf8'));if(m.engine_source_sha256!==ENGINE_SOURCE_SHA256||m.engine_version!=='1.1.0'||!Array.isArray(m.files)||!m.files.length)throw Error('BUNDLE_SOURCE_MISMATCH');const files=await inventory(root);if(JSON.stringify(files)!==JSON.stringify(m.files)||sha(Buffer.from(JSON.stringify(files)))!==m.bundle_sha256)throw Error('BUNDLE_BYTES_CHANGED');return m;}
