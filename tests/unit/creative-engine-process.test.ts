import {afterEach,describe,expect,it} from 'vitest';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runMediaBytes,runMediaProcess} from '../../packages/creative-engine/src/process.js';

const directories:string[]=[];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error:any){if(error.code==='ESRCH')return false;throw error;}};
async function files(){const root=await mkdtemp(join(tmpdir(),'creative-process-'));directories.push(root);return{pid:join(root,'pid'),term:join(root,'term')};}
async function childText(path:string){const deadline=Date.now()+1500;for(;;){try{return await readFile(path,'utf8');}catch(error:any){if(error.code!=='ENOENT'||Date.now()>deadline)throw error;}await sleep(10);}}
// Cold Node startup can exceed 1.5s while other unit files transform in parallel.
// This readiness bound is separate from the runtime's unchanged 2s kill grace.
async function childPid(path:string,closed:()=>boolean){
  const deadline=performance.now()+5000;
  for(;;){
    try{const value=Number(await readFile(path,'utf8'));if(Number.isSafeInteger(value)&&value>1)return value;}
    catch(error:any){if(error.code!=='ENOENT')throw error;}
    if(closed())throw new Error('CHILD_CLOSED_BEFORE_FIXTURE_READY');
    if(performance.now()>=deadline)throw new Error('CHILD_FIXTURE_READINESS_TIMEOUT');
    await sleep(10);
  }
}
afterEach(async()=>{for(const root of directories.splice(0))await rm(root,{recursive:true,force:true});});

describe('media process close is the render lock boundary',()=>{
  for(const [name,run] of [['text',runMediaProcess],['bytes',runMediaBytes]] as const){
    it.skipIf(process.platform==='win32')(`${name}: waits for an actual SIGTERM-ignoring child to close, then rejects after SIGKILL escalation`,async()=>{
      const paths=await files(),controller=new AbortController();
      const code=`const fs=require('node:fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(paths.term)},'received'));fs.writeFileSync(${JSON.stringify(paths.pid)},String(process.pid));setInterval(()=>{},20);`;
      let released=false,pid:number|undefined;
      const finished=run(process.execPath,['-e',code],{signal:controller.signal}).then(value=>({value,error:null}),error=>({value:null,error})).finally(()=>{released=true;});
      try{
        pid=await childPid(paths.pid,()=>released);
        const start=Date.now();controller.abort(new Error('Memory pressure fixture'));
        expect(await childText(paths.term)).toBe('received');expect(alive(pid)).toBe(true);expect(released).toBe(false);
        const result=await finished;expect(result.error).toMatchObject({name:'AbortError',code:'ABORT_ERR'});expect(Date.now()-start).toBeGreaterThanOrEqual(1900);expect(alive(pid)).toBe(false);expect(released).toBe(true);
      }finally{controller.abort();if(pid&&alive(pid))process.kill(pid,'SIGKILL');await finished;}
    });
    it(`${name}: a pre-aborted signal does not spawn a process`,async()=>{const paths=await files(),controller=new AbortController();controller.abort();await expect(run(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(paths.pid)},String(process.pid))`],{signal:controller.signal})).rejects.toMatchObject({name:'AbortError',code:'ABORT_ERR'});await expect(stat(paths.pid)).rejects.toMatchObject({code:'ENOENT'});});
  }
  it('waits for close when the decoded output exceeds its bound',async()=>{const paths=await files(),controller=new AbortController(),code=`require('node:fs').writeFileSync(${JSON.stringify(paths.pid)},String(process.pid));setInterval(()=>process.stdout.write(Buffer.alloc(4096)),10);`;let released=false,pid:number|undefined;const finished=runMediaBytes(process.execPath,['-e',code],{maxBytes:1024,signal:controller.signal}).catch(error=>error).finally(()=>{released=true;});try{pid=await childPid(paths.pid,()=>released);expect(await finished).toMatchObject({message:'MEDIA_DECODE_SIZE_LIMIT'});expect(alive(pid)).toBe(false);}finally{controller.abort();if(pid&&alive(pid))process.kill(pid,'SIGKILL');await finished;}});
  it('preserves successful text/binary output and reports a failed spawn without hanging',async()=>{expect(await runMediaProcess(process.execPath,['-e',"process.stdout.write('media-probe')"])).toBe('media-probe');expect(await runMediaBytes(process.execPath,['-e','process.stdout.write(Buffer.from([0,1,255]))'])).toEqual(Buffer.from([0,1,255]));await expect(runMediaProcess((await files()).pid+'-missing-executable',[])).rejects.toMatchObject({code:'ENOENT'});});
});
