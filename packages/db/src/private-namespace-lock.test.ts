import {mkdtemp,realpath,rm,chmod,readFile,writeFile,lstat,symlink,link,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {afterEach,it,expect,vi} from 'vitest';
import {withPrivateNamespaceLock,assertPrivateNamespaceLease,type PrivateNamespaceLease} from './private-namespace-lock.js';
const readonlyLocks=vi.hoisted(()=>new Set<string>());
vi.mock('node:fs/promises',async importOriginal=>{
 const fs=await importOriginal<typeof import('node:fs/promises')>(),{constants}=await import('node:fs');
 return{...fs,open:(...args:Parameters<typeof fs.open>)=>{
  // A read-only bind rejects write access even when the lock already exists.
  if(readonlyLocks.has(String(args[0]))&&typeof args[1]==='number'&&(args[1]&(constants.O_WRONLY|constants.O_RDWR|constants.O_CREAT|constants.O_TRUNC)))return Promise.reject(Object.assign(Error('EROFS'),{code:'EROFS'}));
  return fs.open(...args);
 }};
});
const dirs:string[]=[];
async function fixture(){const root=await mkdtemp(join(await realpath(tmpdir()),'commerce-namespace-'));dirs.push(root);await chmod(root,0o700);return root;}
afterEach(async()=>{readonlyLocks.clear();for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
it('takes a shared lock on an existing read-only mount without requesting write access',async()=>{
 const root=await fixture(),path=join(root,'.private-namespace.lock');
 await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true);
 const before=await lstat(path);readonlyLocks.add(path);
 expect(await withPrivateNamespaceLock(root,'SHARED',async lease=>{
  await assertPrivateNamespaceLease(lease,root,'SHARED');
  return withPrivateNamespaceLock(root,'SHARED',async()=>42);
 })).toBe(42);
 await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).rejects.toMatchObject({code:'EROFS'});
 const after=await lstat(path);expect([after.ino,after.mode,after.size,after.mtimeMs]).toEqual([before.ino,before.mode,before.size,before.mtimeMs]);
});
it('fails closed on a read-only mount without a preexisting lock',async()=>{
 const root=await fixture(),path=join(root,'.private-namespace.lock');readonlyLocks.add(path);
 await expect(withPrivateNamespaceLock(root,'SHARED',async()=>true)).rejects.toMatchObject({code:'EROFS'});
 await expect(lstat(path)).rejects.toMatchObject({code:'ENOENT'});
});
it('names an uninitialized or read-only lock by a stable reason and keeps paths out of the message (V7.5.2 L01)',async()=>{
 const root=await fixture(),path=join(root,'.private-namespace.lock');readonlyLocks.add(path);
 const missing=await withPrivateNamespaceLock(root,'SHARED',async()=>true).then(()=>{throw Error('UNEXPECTED_SUCCESS');},e=>e as Error&{code?:string});
 expect([missing.message,missing.code]).toEqual(['PRIVATE_NAMESPACE_LOCK_UNINITIALIZED','EROFS']);expect(missing.message).not.toContain(root);
 readonlyLocks.clear();await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true);readonlyLocks.add(path);
 const writer=await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true).then(()=>{throw Error('UNEXPECTED_SUCCESS');},e=>e as Error&{code?:string});
 expect([writer.message,writer.code]).toEqual(['PRIVATE_NAMESPACE_READ_ONLY','EROFS']);expect(writer.message).not.toContain(root);
});
it('refuses a symbolic lock for readers and writers with the lock-file reason',async()=>{
 const root=await fixture(),outside=join(root,'other');await writeFile(outside,'');await chmod(outside,0o600);await symlink(outside,join(root,'.private-namespace.lock'));
 for(const mode of ['SHARED','EXCLUSIVE'] as const)await expect(withPrivateNamespaceLock(root,mode,async()=>true)).rejects.toMatchObject({message:'PRIVATE_NAMESPACE_LOCK_FILE',code:'ELOOP'});
 expect((await lstat(outside)).size).toBe(0);
});
it('a prepared lock (empty, 0600, owner) is reused by readers without being rewritten',async()=>{
 const root=await fixture(),path=join(root,'.private-namespace.lock');await writeFile(path,'',{mode:0o600});const before=await lstat(path);readonlyLocks.add(path);
 expect(await withPrivateNamespaceLock(root,'SHARED',async lease=>{await assertPrivateNamespaceLease(lease,root,'SHARED');return 7;})).toBe(7);
 const after=await lstat(path);expect([after.ino,after.mode&0o777,after.size,after.mtimeMs,after.nlink]).toEqual([before.ino,0o600,0,before.mtimeMs,1]);
});
it('initializes the same lock for two concurrent first readers',async()=>{
 const root=await fixture();
 expect(await Promise.all([1,2].map(n=>withPrivateNamespaceLock(root,'SHARED',async lease=>{await assertPrivateNamespaceLease(lease,root,'SHARED');return n;})))).toEqual([1,2]);
 expect((await lstat(join(root,'.private-namespace.lock'))).mode&0o777).toBe(0o600);
});
it('retains a kernel exclusive lock after the helper exits and releases it at completion',async()=>{
 const root=await fixture();await withPrivateNamespaceLock(root,'EXCLUSIVE',async lease=>{await assertPrivateNamespaceLease(lease,root,'EXCLUSIVE');await expect(withPrivateNamespaceLock(root,'SHARED',async()=>true)).rejects.toThrow('PRIVATE_NAMESPACE_BUSY');await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).rejects.toThrow('PRIVATE_NAMESPACE_BUSY');});
 expect(await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>42)).toBe(42);expect((await lstat(join(root,'.private-namespace.lock'))).size).toBe(0);
});
it('allows concurrent shared access while refusing upgrades to exclusive',async()=>{
 const root=await fixture();await withPrivateNamespaceLock(root,'SHARED',async one=>withPrivateNamespaceLock(root,'SHARED',async two=>{await assertPrivateNamespaceLease(one,root,'SHARED');await assertPrivateNamespaceLease(two,root,'SHARED');await expect(assertPrivateNamespaceLease(one,root,'EXCLUSIVE')).rejects.toThrow('LEASE');await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).rejects.toThrow('BUSY');}));
});
it('rejects forged, cross-root and escaped leases',async()=>{
 const root=await fixture(),other=await fixture();let escaped!:PrivateNamespaceLease;
 await expect(assertPrivateNamespaceLease({} as PrivateNamespaceLease,root,'SHARED')).rejects.toThrow('LEASE');
 await withPrivateNamespaceLock(root,'EXCLUSIVE',async lease=>{escaped=lease;await expect(assertPrivateNamespaceLease(lease,other,'SHARED')).rejects.toThrow('LEASE');});await expect(assertPrivateNamespaceLease(escaped,root,'SHARED')).rejects.toThrow('LEASE');
});
it('releases the kernel lock when callback work fails',async()=>{const root=await fixture();await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>{throw Error('ABORT');})).rejects.toThrow('ABORT');expect(await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).toBe(true);});
it('refuses a permissive root without modifying its mode',async()=>{const root=await fixture();await chmod(root,0o755);await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).rejects.toThrow('ROOT');expect((await lstat(root)).mode&0o777).toBe(0o755);});
it('refuses a symbolic lock file and preserves its target',async()=>{const root=await fixture(),outside=join(root,'other');await writeFile(outside,'preserve');await symlink(outside,join(root,'.private-namespace.lock'));await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).rejects.toThrow();expect(await readFile(outside,'utf8')).toBe('preserve');});
it('refuses preexisting content and hardlinks without overwriting',async()=>{
 const root=await fixture(),path=join(root,'.private-namespace.lock');await writeFile(path,'preserve',{mode:0o600});await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).rejects.toThrow('LOCK_FILE');expect(await readFile(path,'utf8')).toBe('preserve');
 await rm(path);await writeFile(path,'',{mode:0o600});await link(path,join(root,'other'));await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).rejects.toThrow('LOCK_FILE');
});
it('detects replacement of the fixed lock identity',async()=>{
 const root=await fixture(),path=join(root,'.private-namespace.lock');await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async lease=>{await rename(path,path+'.old');await writeFile(path,'',{mode:0o600});await assertPrivateNamespaceLease(lease,root,'EXCLUSIVE');})).rejects.toThrow('REPLACED');expect((await lstat(path+'.old')).size).toBe(0);
});
it('detects replacement of the namespace directory',async()=>{
 const root=await fixture(),old=root+'-old';dirs.push(old);await expect(withPrivateNamespaceLock(root,'EXCLUSIVE',async lease=>{await rename(root,old);await assertPrivateNamespaceLease(lease,root,'EXCLUSIVE');})).rejects.toThrow();expect((await lstat(join(old,'.private-namespace.lock'))).size).toBe(0);
});
it('process death releases the lock without deleting or stealing a lock file',async()=>{
 const root=await fixture(),module=new URL('./private-namespace-lock.ts',import.meta.url).href;
 const code='import {withPrivateNamespaceLock} from '+JSON.stringify(module)+'; await withPrivateNamespaceLock(process.argv[1],"EXCLUSIVE",async()=>{setInterval(()=>{},1000);process.stdout.write("READY\\n");await new Promise(()=>{});});';
 const child=spawn(process.execPath,['--input-type=module','-e',code,root],{stdio:['ignore','pipe','pipe']});
 const exit=once(child,'exit');let ready=false;try{
  await new Promise<void>((ok,fail)=>{let out='';const timer=setTimeout(()=>fail(Error('CHILD_READY_TIMEOUT')),5000);child.stdout!.on('data',data=>{out+=data.toString();if(out==='READY\n'){ready=true;clearTimeout(timer);ok();}});child.once('exit',()=>{if(!ready){clearTimeout(timer);fail(Error('CHILD_EXITED_EARLY'));}});});
  await expect(withPrivateNamespaceLock(root,'SHARED',async()=>true)).rejects.toThrow('BUSY');
 }finally{child.kill('SIGKILL');await exit;}
 expect(await withPrivateNamespaceLock(root,'EXCLUSIVE',async()=>true)).toBe(true);
});
