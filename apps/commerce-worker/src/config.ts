import {randomUUID} from 'node:crypto';
import {chmod, mkdir, readFile, rename, stat, writeFile, lstat, realpath, statfs, unlink} from 'node:fs/promises';
import {homedir, platform} from 'node:os';
import path from 'node:path';
export const WORKER_VERSION='0.1.2';
export const API_VERSION=1;
export const ENGINE_VERSION='1.1.0';
export const GiB=1024**3;
export interface WorkerConfig {apiOrigin:string;dataRoot:string;rootIdentity:{device:string;marker:string};deviceId?:string;workspaceId?:string;paused:boolean;requireAc:boolean;cacheBytes:number;reserveBytes:number;hours?:{start:number;end:number};}
export function privateRoot(){return process.env.COMMERCE_WORKER_PRIVATE_DIR|| (platform()==='win32'?path.join(process.env.LOCALAPPDATA||path.join(homedir(),'AppData','Local'),'CommerceWorkerPrivate'):path.join(homedir(),'Library','Application Support','Commerce Worker Private'));}
export function defaultDataRoot(){return platform()==='win32'?path.join(process.env.LOCALAPPDATA||path.join(homedir(),'AppData','Local'),'CommerceWorker'):path.join(homedir(),'Library','Application Support','Commerce Worker');}
export function validateOrigin(value:string){const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error('HTTPS_ORIGIN_REQUIRED');return u.origin;}
export async function atomicJson(file:string,value:unknown){await mkdir(path.dirname(file),{recursive:true,mode:0o700});const tmp=`${file}.${randomUUID()}.tmp`;await writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await rename(tmp,file);await chmod(file,0o600);}
export async function readConfig():Promise<WorkerConfig>{return JSON.parse(await readFile(path.join(privateRoot(),'config.json'),'utf8'));}
export async function saveConfig(config:WorkerConfig){await atomicJson(path.join(privateRoot(),'config.json'),config);}
export async function configure(apiOrigin:string,dataRoot=defaultDataRoot()):Promise<WorkerConfig>{
 apiOrigin=validateOrigin(apiOrigin);dataRoot=path.resolve(dataRoot);let previous:WorkerConfig|undefined;try{previous=await readConfig();}catch(e:any){if(e.code!=='ENOENT')throw e;}if(previous){try{const pending=JSON.parse(await readFile(path.join(previous.dataRoot,'journal.json'),'utf8'));if(!['DONE','STALE'].includes(pending.phase))throw Error('CONFIG_JOB_PENDING');}catch(e:any){if(e.code!=='ENOENT')throw e;}}
 // Never manufacture an absent external mount. The volume must already exist.
 if(process.platform==='darwin'&&dataRoot.startsWith('/Volumes/')){const volume=path.parse(dataRoot).root+dataRoot.split('/').slice(1,3).join('/');await stat(volume);const info=await stat(volume);if(info.dev===(await stat('/')).dev)throw Error('EXTERNAL_VOLUME_NOT_MOUNTED');}
 await mkdir(dataRoot,{recursive:true,mode:0o700});if((await lstat(dataRoot)).isSymbolicLink()||await realpath(dataRoot)!==dataRoot)throw Error('DATA_ROOT_SYMLINK');
 const markerFile=path.join(dataRoot,'.commerce-worker-volume');let marker:string;try{marker=(await readFile(markerFile,'utf8')).trim();}catch{marker=randomUUID();await writeFile(markerFile,marker,{mode:0o600,flag:'wx'});}
 const config:WorkerConfig={apiOrigin:validateOrigin(apiOrigin),dataRoot,rootIdentity:{device:String((await stat(dataRoot)).dev),marker},paused:true,requireAc:true,cacheBytes:30*GiB,reserveBytes:10*GiB};
 if(previous?.apiOrigin===apiOrigin){config.deviceId=previous.deviceId;config.workspaceId=previous.workspaceId;config.requireAc=previous.requireAc;config.cacheBytes=previous.cacheBytes;config.reserveBytes=previous.reserveBytes;config.hours=previous.hours;}else if(previous){for(const name of ['device-token','pairing.json'])await unlink(path.join(privateRoot(),name)).catch((e:any)=>{if(e.code!=='ENOENT')throw e;});}await saveConfig(config);return config;
}
export async function checkDataRoot(config:WorkerConfig){const s=await lstat(config.dataRoot);if(s.isSymbolicLink()||!s.isDirectory()||String(s.dev)!==config.rootIdentity.device||await realpath(config.dataRoot)!==config.dataRoot)throw Error('DATA_VOLUME_CHANGED');if((await readFile(path.join(config.dataRoot,'.commerce-worker-volume'),'utf8')).trim()!==config.rootIdentity.marker)throw Error('DATA_VOLUME_CHANGED');const fs=await statfs(config.dataRoot);return {freeBytes:fs.bavail*fs.bsize};}
export async function writeDeviceToken(token:string){if(!token||token.length>4096)throw Error('INVALID_DEVICE_TOKEN');await mkdir(privateRoot(),{recursive:true,mode:0o700});await writeFile(path.join(privateRoot(),'device-token'),token,{mode:0o600});await chmod(path.join(privateRoot(),'device-token'),0o600);}
export async function deviceToken(){return (await readFile(path.join(privateRoot(),'device-token'),'utf8')).trim();}
