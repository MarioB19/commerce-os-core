import {constants} from 'node:fs';
import {lstat,open,realpath,statfs} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {isAbsolute,join,resolve} from 'node:path';
import type {FileHandle} from 'node:fs/promises';

export type PrivateNamespaceMode='SHARED'|'EXCLUSIVE';
declare const brand:unique symbol;
export interface PrivateNamespaceLease{readonly [brand]:true}
type Identity={dev:bigint;ino:bigint};
type State={root:string;mode:PrivateNamespaceMode;directory:Identity;handle:FileHandle;identity:Identity;active:boolean};
const states=new WeakMap<object,State>();
const lockName='.private-namespace.lock';
function need(v:unknown,code:string):asserts v{if(!v)throw Error(code);}
const same=(a:Identity,b:Identity)=>a.dev===b.dev&&a.ino===b.ino;
async function directory(root:string){
 need(isAbsolute(root)&&resolve(root)===root&&await realpath(root)===root,'PRIVATE_NAMESPACE_ROOT');
 const s=await lstat(root,{bigint:true});need(s.isDirectory()&&!s.isSymbolicLink()&&(s.mode&0o777n)===0o700n&&typeof process.getuid==='function'&&s.uid===BigInt(process.getuid()),'PRIVATE_NAMESPACE_ROOT');
 const fs=await statfs(root,{bigint:true});const supported=process.platform==='linux'?[0xef53n,0x58465342n,0x9123683en,0x01021994n,0x794c7630n]:[0x1an,0x11n];need(supported.includes(fs.type),'PRIVATE_NAMESPACE_FILESYSTEM');return s;
}
async function acquire(fd:number,mode:PrivateNamespaceMode){
 // The parent retains the original open file description after this helper
 // exits. No shell, command/path from the caller, unlock or lock conversion.
 const linux=process.platform==='linux';need(linux||process.platform==='darwin','PRIVATE_NAMESPACE_PLATFORM');
 const binary=linux?'/usr/bin/flock':'/usr/bin/python3';
 const args=linux?['-n',mode==='EXCLUSIVE'?'-x':'-s','-E','73','3']:['-I','-c',"import fcntl,sys\ntry: fcntl.flock(3,fcntl.LOCK_NB|("+(mode==='EXCLUSIVE'?'fcntl.LOCK_EX':'fcntl.LOCK_SH')+"))\nexcept BlockingIOError: sys.exit(73)"];
 await new Promise<void>((ok,fail)=>{
  const child=spawn(binary,args,{stdio:['ignore','ignore','ignore',fd],env:{PATH:'/usr/bin:/bin'},timeout:3000,killSignal:'SIGKILL'});
  child.once('error',()=>fail(Error('PRIVATE_NAMESPACE_LOCK_UNAVAILABLE')));
  child.once('exit',(code,signal)=>code===0&&!signal?ok():fail(Error(code===73?'PRIVATE_NAMESPACE_BUSY':'PRIVATE_NAMESPACE_LOCK_UNAVAILABLE')));
 });
}
export async function assertPrivateNamespaceLease(lease:PrivateNamespaceLease,root:string,required:PrivateNamespaceMode){
 const s=states.get(lease);need(s?.active&&s.root===root&&(required==='SHARED'||s.mode==='EXCLUSIVE'),'PRIVATE_NAMESPACE_LEASE');
 const d=await directory(root),a=await s.handle.stat({bigint:true}),b=await lstat(join(root,lockName),{bigint:true});
 need(same(d,s.directory)&&same(a,s.identity)&&same(a,b)&&a.isFile()&&b.isFile()&&!b.isSymbolicLink()&&a.nlink===1n&&b.nlink===1n&&a.size===0n&&b.size===0n&&(a.mode&0o777n)===0o600n&&a.uid===BigInt(process.getuid!()),'PRIVATE_NAMESPACE_REPLACED');
}
/** Internal host port. A lease serializes I/O; it is never deletion authority. */
export async function withPrivateNamespaceLock<T>(root:string,mode:PrivateNamespaceMode,work:(lease:PrivateNamespaceLease)=>Promise<T>):Promise<T>{
 need(mode==='SHARED'||mode==='EXCLUSIVE','PRIVATE_NAMESPACE_MODE');const d=await directory(root);
 const handle=await open(join(root,lockName),constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);
 let state:State|undefined;
 try{
  const a=await handle.stat({bigint:true});need(a.isFile()&&a.nlink===1n&&a.size===0n&&(a.mode&0o777n)===0o600n&&a.uid===BigInt(process.getuid!()),'PRIVATE_NAMESPACE_LOCK_FILE');
  const lease=Object.freeze({}) as PrivateNamespaceLease;state={root,mode,directory:d,identity:a,handle,active:true};states.set(lease,state);
  await acquire(handle.fd,mode);await assertPrivateNamespaceLease(lease,root,mode);
  const result=await work(lease);await assertPrivateNamespaceLease(lease,root,mode);return result;
 }finally{if(state)state.active=false;await handle.close();}
}
