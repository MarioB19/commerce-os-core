import {mkdtemp,realpath,rm,chmod,readFile,writeFile,lstat,symlink,link,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {afterEach,it,expect} from 'vitest';
import {withPrivateNamespaceLock,assertPrivateNamespaceLease,type PrivateNamespaceLease} from './private-namespace-lock.js';
const dirs:string[]=[];
async function fixture(){const root=await mkdtemp(join(await realpath(tmpdir()),'commerce-namespace-'));dirs.push(root);await chmod(root,0o700);return root;}
afterEach(async()=>{for(const d of dirs.splice(0))await rm(d,{recursive:true,force:true});});
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
