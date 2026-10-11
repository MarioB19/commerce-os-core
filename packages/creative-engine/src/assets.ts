import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AssetRef } from '../../creative-contracts/src/index.js';

export async function sha256File(path:string):Promise<string>{const hash=createHash('sha256');for await(const part of createReadStream(path))hash.update(part);return hash.digest('hex');}
export function safeAssetName(value:string):string {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[._]|$)/i.test(value))throw new Error('UNSAFE_ASSET_NAME');
  return value;
}
export async function confinedPath(root:string,path:string):Promise<string>{
  if(!isAbsolute(root)||!isAbsolute(path))throw new Error('ABSOLUTE_LOCAL_ROOT_REQUIRED');
  const base=await realpath(root),candidate=resolve(path),rel=relative(base,candidate);
  if(!rel||rel==='..'||rel.startsWith(`..${sep}`)||isAbsolute(rel))throw new Error('ASSET_OUTSIDE_ROOT');
  let parent=base;for(const piece of rel.split(sep)){parent=resolve(parent,piece);if((await lstat(parent)).isSymbolicLink())throw new Error('ASSET_SYMLINK_REJECTED');}
  const actual=await realpath(candidate);if(actual!==candidate)throw new Error('ASSET_SYMLINK_REJECTED');return actual;
}
const extensions:Record<string,string>={'image/png':'.png','image/jpeg':'.jpg','image/webp':'.webp','video/mp4':'.mp4','audio/mpeg':'.mp3','audio/wav':'.wav','audio/mp4':'.m4a','font/woff2':'.woff2'};
export function assetExtension(asset:AssetRef):string {return extensions[asset.media_type??'']??'.bin';}
export async function materializeAsset(asset:AssetRef,options:{assetRoot:string;destination:string;sourcePath?:string}):Promise<string>{
  safeAssetName(asset.asset_id);
  const source=await confinedPath(options.assetRoot,options.sourcePath??resolve(options.assetRoot,asset.asset_id));
  const info=await stat(source);
  if(!info.isFile()||info.size<=0||info.size>500*1024*1024||(asset.bytes!==undefined&&info.size!==asset.bytes))throw new Error(`ASSET_SIZE_MISMATCH:${asset.asset_id}`);
  if(await sha256File(source)!==asset.sha256)throw new Error(`ASSET_HASH_MISMATCH:${asset.asset_id}`);
  await copyFile(source,options.destination,constants.COPYFILE_EXCL);
  // Hash the copied bytes, so replacing an input during materialization cannot cross the gate.
  if(await sha256File(options.destination)!==asset.sha256)throw new Error(`ASSET_CHANGED_DURING_COPY:${asset.asset_id}`);
  return options.destination;
}
