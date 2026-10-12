/** Test artifacts live outside the checkout; verification never cleans source changes. */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
const sourceRoot=realpathSync(fileURLToPath(new URL('../..',import.meta.url)));
const fallback=join(homedir(),'.local/share/commerce-os-test-evidence',createHash('sha256').update(sourceRoot).digest('hex').slice(0,16),new Date().toISOString().replaceAll(':','-')+'-'+process.pid+'-'+randomUUID());
const within=(parent:string,path:string)=>{const part=relative(parent,path);return part===''||part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
function resolvedDestination(path:string){
 let ancestor=path;const missing:string[]=[];
 while(!existsSync(ancestor)){const parent=dirname(ancestor);if(parent===ancestor)throw Error('TEST_EVIDENCE_PARENT_MISSING');missing.unshift(relative(parent,ancestor));ancestor=parent;}
 return resolve(realpathSync(ancestor),...missing);
}
/** The runner supplies one absolute directory per run; local calls get a retained private directory. */
export function evidencePath(name:string):string{
 if(typeof name!=='string'||name.includes('\\')||isAbsolute(name)||name.split('/').some(part=>part==='.'||part==='..'||part!==''&&!/^[A-Za-z0-9._-]+$/.test(part))||name.includes('//'))throw Error('TEST_EVIDENCE_NAME_INVALID');
 const configured=process.env.COMMERCE_TEST_EVIDENCE_DIR;
 if(configured!==undefined&&(!configured||!isAbsolute(configured)))throw Error('TEST_EVIDENCE_DIRECTORY_INVALID');
 const destination=resolve(configured??fallback),resolved=resolvedDestination(destination);
 if(within(sourceRoot,destination)||within(sourceRoot,resolved)||within(resolved,sourceRoot))throw Error('TEST_EVIDENCE_MUST_BE_OUTSIDE_SOURCE');
 mkdirSync(destination,{recursive:true,mode:0o700});
 const base=realpathSync(destination);if(base!==resolved||within(sourceRoot,base))throw Error('TEST_EVIDENCE_DIRECTORY_CHANGED');
 const parts=name?name.split('/'):[];let path=base;
 for(const [index,part]of parts.entries()){
  path=join(path,part);
  try{if(lstatSync(path).isSymbolicLink())throw Error('TEST_EVIDENCE_SYMLINK_REJECTED');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(index<parts.length-1){mkdirSync(path,{recursive:true,mode:0o700});if(realpathSync(path)!==path)throw Error('TEST_EVIDENCE_DIRECTORY_CHANGED');}
 }
 return path;
}
