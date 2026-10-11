import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
export async function serveMaterials(files:Map<string,{path:string;type:string}>){
  const token=randomBytes(24).toString('hex');
  const server=createServer(async(req,res)=>{try{const prefix=`/${token}/`;if(!req.url?.startsWith(prefix)||!['GET','HEAD'].includes(req.method??'')){res.writeHead(404).end();return;}const file=files.get(req.url.slice(prefix.length));if(!file){res.writeHead(404).end();return;}const size=(await stat(file.path)).size;let start=0,end=size-1;const range=req.headers.range;if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`}).end();return;}}
    res.writeHead(range?206:200,{'Content-Type':file.type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Access-Control-Allow-Origin':'*','Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});if(req.method==='HEAD'){res.end();return;}const stream=createReadStream(file.path,{start,end});res.on('close',()=>stream.destroy());stream.on('error',()=>res.destroy());stream.pipe(res);
  }catch{res.writeHead(500).end();}});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const address=server.address();if(typeof address!=='object'||!address)throw new Error('LOCAL_MEDIA_SERVER_FAILED');
  return {url:(id:string)=>`http://127.0.0.1:${address.port}/${token}/${id}`,close:()=>new Promise<void>((resolve,reject)=>{server.closeAllConnections();server.close(error=>error?reject(error):resolve());})};
}
