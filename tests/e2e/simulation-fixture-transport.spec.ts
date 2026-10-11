import {createServer,type Server,type ServerResponse} from 'node:http';
import {createConnection,type Socket} from 'node:net';
import {test,expect} from '@playwright/test';
import {useSimulationFixtureTransport} from './support/simulation-fixture-transport.js';

function fixtureCleanup(server:Server){
 const sockets=new Set<Socket>();
 server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 return async()=>{
  // All asserted requests have completed. Chromium may retain a preconnection
  // without a complete HTTP request; server.close alone can wait indefinitely.
  const closed=new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  for(const socket of sockets)socket.destroy();
  await closed;
 };
}

test('fixture transport preserves the exact REAL launch-status read while confining mutations and other reads to SIMULATION',async({page})=>{
 const received:{path:string;environment:string|null;method:string;body:unknown}[]=[];
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://fixture.test');
  if(url.pathname==='/'){res.end('<!doctype html><title>Isolated launch-status transport</title>');return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString();
  const entry={path:url.pathname,environment:url.searchParams.get('environment'),method:req.method!,body:raw?JSON.parse(raw):null};received.push(entry);
  res.setHeader('content-type','application/json');res.end(JSON.stringify({data:entry}));
 });
 const cleanup=fixtureCleanup(server);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('TEST_HTTP_ADDRESS_REQUIRED');
 try{
  await useSimulationFixtureTransport(page);await page.goto(`http://127.0.0.1:${address.port}`);
  const responses=await page.evaluate(async()=>{
   const reads=await Promise.all([
    '/v1/settings/launch?environment=REAL',
    '/v1/settings/launch?environment=SIMULATION',
    '/v1/settings/launch/?environment=REAL',
    '/v1/settings/operations?environment=REAL',
   ].map(async path=>(await(await fetch(path)).json()).data));
   const otherMethod=(await(await fetch('/v1/settings/launch?environment=REAL',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({environment:'REAL'})})).json()).data;
   const switched=(await(await fetch('/v1/settings/launch/switch?environment=REAL',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({environment:'REAL',action:'OPEN',expected_version:7,confirmation:'CONFIRM_REAL_SWITCH'})})).json()).data;
   return [...reads,otherMethod,switched];
  });
  expect(responses).toEqual([
   {path:'/v1/settings/launch',environment:'REAL',method:'GET',body:null},
   {path:'/v1/settings/launch',environment:'SIMULATION',method:'GET',body:null},
   {path:'/v1/settings/launch/',environment:'SIMULATION',method:'GET',body:null},
   {path:'/v1/settings/operations',environment:'SIMULATION',method:'GET',body:null},
   {path:'/v1/settings/launch',environment:'SIMULATION',method:'POST',body:{environment:'SIMULATION'}},
   {path:'/v1/settings/launch/switch',environment:'SIMULATION',method:'POST',body:{environment:'SIMULATION',action:'OPEN',expected_version:7,confirmation:'CONFIRM_REAL_SWITCH'}},
  ]);
  expect(received.filter(request=>request.environment==='REAL')).toEqual([{path:'/v1/settings/launch',environment:'REAL',method:'GET',body:null}]);
 }finally{
  await page.unrouteAll({behavior:'wait'});
  await cleanup();
 }
});

test('fixture transport preserves request rewriting, targeted aborts and teardown with responses in flight',async({page})=>{
 const received:{path:string;environment:string|null;method:string;body:unknown}[]=[],pending:ServerResponse[]=[];
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url!,'http://fixture.test');
  if(url.pathname==='/'){res.end('<!doctype html><title>Isolated fixture transport</title>');return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(chunk);
  const raw=Buffer.concat(chunks).toString();
  const entry={path:url.pathname,environment:url.searchParams.get('environment'),method:req.method!,body:raw?JSON.parse(raw):null};received.push(entry);
  res.setHeader('content-type','application/json');
  if(url.pathname.startsWith('/v1/pending/')){pending.push(res);return;}
  res.end(JSON.stringify({data:entry}));
 });
 const cleanup=fixtureCleanup(server);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('TEST_HTTP_ADDRESS_REQUIRED');
 const origin=`http://127.0.0.1:${address.port}`;
 try{
  await useSimulationFixtureTransport(page);await page.goto(origin);
  const rewritten=await page.evaluate(async()=>{
   const response=await fetch('/v1/workflows/copy?environment=REAL',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({environment:'REAL',expected_version:2,name:'Preserved local draft'})});
   return(await response.json()).data;
  });
  expect(rewritten).toEqual({path:'/v1/workflows/copy',environment:'SIMULATION',method:'PATCH',body:{environment:'SIMULATION',expected_version:2,name:'Preserved local draft'}});
  const offline='**/v1/workflows/copy?**';
  await page.route(offline,route=>route.request().method()==='PATCH'?route.abort('failed'):route.fallback());
  expect(await page.evaluate(async()=>{try{await fetch('/v1/workflows/copy?environment=REAL',{method:'PATCH'});return'UNEXPECTED_SUCCESS';}catch{return'NETWORK_FAILED';}})).toBe('NETWORK_FAILED');
  expect(received).toHaveLength(1);
  await page.unroute(offline);
  const reads=page.evaluate(()=>Promise.all(['one','two'].map(async id=>{
   const response=await fetch('/v1/pending/'+id+'?environment=REAL');return response.json();
  })));
  await expect.poll(()=>pending.length).toBe(2);
  let drained=false;const drain=page.unrouteAll({behavior:'wait'}).then(()=>{drained=true;});
  // Route handling must finish independently of the delayed HTTP response.
  // fetch + fulfill waits here, and removing its handlers can replay REAL.
  await expect.poll(()=>drained).toBe(true);
  for(const response of pending)response.end(JSON.stringify({data:'delayed fixture response'}));
  expect(await reads).toEqual([{data:'delayed fixture response'},{data:'delayed fixture response'}]);await drain;
  expect(received).toHaveLength(3);
  expect(received.every(request=>request.environment==='SIMULATION')).toBe(true);
 }finally{
  for(const response of pending)if(!response.writableEnded)response.end('{}');
  await page.unrouteAll({behavior:'wait'});
  await cleanup();
 }
});

test('fixture cleanup closes an unused connection with incomplete HTTP headers',async()=>{
 const server=createServer((_req,res)=>res.end('isolated fixture'));
 const cleanup=fixtureCleanup(server);
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw Error('TEST_HTTP_ADDRESS_REQUIRED');
 const socket=createConnection({host:'127.0.0.1',port:address.port});
 try{
  await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});
  socket.write('GET /unused HTTP/1.1\r\n');
  const disconnected=new Promise<void>(resolve=>socket.once('close',()=>resolve()));
  await cleanup();await disconnected;
  expect(server.listening).toBe(false);
 }finally{socket.destroy();if(server.listening)await cleanup();}
});
