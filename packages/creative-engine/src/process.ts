import { spawn } from 'node:child_process';
import { dirname } from 'node:path';

interface Capture<T> {
  stdout:(data:Buffer)=>Error|undefined;
  stderr:(data:Buffer)=>Error|undefined;
  result:()=>T;
  failure:(code:number|null)=>Error;
}
const abortError=(signal:AbortSignal)=>Object.assign(new Error('The operation was aborted',{cause:signal.reason}),{name:'AbortError',code:'ABORT_ERR'});

/** Never settle before close: callers retain the render lock while the child is alive. */
function runChild<T>(command:string,args:string[],options:{signal?:AbortSignal;timeoutMs:number},capture:Capture<T>):Promise<T>{
  if(options.signal?.aborted)return Promise.reject(abortError(options.signal));
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,...(process.platform==='darwin'?{DYLD_LIBRARY_PATH:dirname(command)}:{})},shell:false});
    let failure:Error|undefined,closed=false,stopping=false,forceTimer:ReturnType<typeof setTimeout>|undefined;
    const kill=(signal:NodeJS.Signals)=>{if(!closed&&child.pid&&child.exitCode===null&&child.signalCode===null)child.kill(signal);};
    const stop=(error:Error,graceful:boolean)=>{
      failure??=error;
      if(closed||stopping)return;
      stopping=true;clearTimeout(timeout);
      if(graceful){kill('SIGTERM');forceTimer=setTimeout(()=>kill('SIGKILL'),2000);}
      else kill('SIGKILL');
    };
    const timeout=setTimeout(()=>stop(capture.failure(null),false),options.timeoutMs);
    const onAbort=()=>stop(abortError(options.signal!),true);
    const consume=(handler:Capture<T>['stdout'],data:Buffer)=>{
      if(stopping)return;
      try{const error=handler(data);if(error)stop(error,false);}catch(error){stop(error instanceof Error?error:new Error('MEDIA_CAPTURE_FAILED'),false);}
    };
    child.stdout.on('data',data=>consume(capture.stdout,data));
    child.stderr.on('data',data=>consume(capture.stderr,data));
    // Spawn/kill errors also precede close. Recording the error must not release the lock.
    child.on('error',error=>{failure??=error;});
    child.once('close',code=>{
      closed=true;clearTimeout(timeout);if(forceTimer)clearTimeout(forceTimer);options.signal?.removeEventListener('abort',onAbort);
      if(failure)reject(failure);else if(code!==0)reject(capture.failure(code));else resolve(capture.result());
    });
    options.signal?.addEventListener('abort',onAbort,{once:true});
    if(options.signal?.aborted)onAbort();
  });
}

export async function runMediaProcess(command:string,args:string[],options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<string>{
  let output='';
  const append=(data:Buffer)=>{output+=data.toString();return output.length>2_000_000?new Error('MEDIA_PROCESS_OUTPUT_LIMIT'):undefined;};
  return runChild(command,args,{...options,timeoutMs:options.timeoutMs??600_000},{stdout:append,stderr:append,result:()=>output,failure:code=>new Error(`MEDIA_PROCESS_FAILED (${code}): ${output.slice(-4000)}`)});
}

export async function runMediaBytes(command:string,args:string[],options:{signal?:AbortSignal;maxBytes?:number}={}):Promise<Buffer>{
  const parts:Buffer[]=[];let size=0,errorText='';
  return runChild(command,args,{...options,timeoutMs:60000},{
    stdout:data=>{size+=data.length;if(size>(options.maxBytes??1024*1024))return new Error('MEDIA_DECODE_SIZE_LIMIT');parts.push(data);},
    stderr:data=>{errorText=(errorText+data.toString()).slice(-4000);return undefined;},
    result:()=>Buffer.concat(parts),failure:code=>new Error(`MEDIA_DECODE_FAILED (${code}): ${errorText}`)
  });
}
