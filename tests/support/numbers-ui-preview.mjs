/** Read-only UI fixture server for native browser zoom QA. Not a backend or operational simulator. */
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve('apps/web/dist'),id='11111111-1111-4111-8111-111111111111';
const numbers=[['READY_TO_SELL','Disponible en 1 de 2 productos'],['PREPARE','Preparación automática pendiente'],['WARMING','En preparación'],['PREPARED','Preparación completada'],['DISCONNECTED','Sin conexión']].map(([state,reason],i)=>({id:i===0?id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,version:1,alias:i===0?'Equipo Centro':'Equipo '+i,masked_number:'•••• 1234',responsible:'Operador de ensayo',primary_state:state,reason_text:reason,connection:{state:i===4?'DISCONNECTED':'CONNECTED'},preparation:{stage:[0,3].includes(i)?'COMPLETED':'GRADUAL_AUTOMATIC',day:[0,3].includes(i)?15:i===1?2:7},observed_at:new Date().toISOString(),sales_readiness:[{assignment_id:'a',name:'Curso A',ready:i===0,checks:[]},{assignment_id:'b',name:'Curso B',ready:false,checks:[{code:'AUTHORIZATION_REQUIRED',text:'Falta permiso de envío para Curso B.'}]}],next_action:{code:'products',label:'Revisar productos'}}));
const server=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://127.0.0.1').pathname;
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET'){res.writeHead(405,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'READ_ONLY_VISUAL_FIXTURE'}}));return;}
 if(path.startsWith('/v1/')){
  let data=[];
  if(path==='/v1/me')data={user:{id:'visual-fixture',name:'Ensayo visual local',email:'fixture@example.invalid'},workspace_id:'visual-fixture',role:'viewer',permissions:['sales:read'],environment:'SIMULATION'};
  else if(path==='/v1/numbers')data=numbers;
  else if(path==='/v1/numbers/'+id)data=numbers[0];
  else if(path.endsWith('/preparation'))data={policy_version:'standard-15d/v2',episode:{id:'fixture',version:1,policy_version:'standard-15d/v2',completed_at:'2026-09-15T10:00:00Z'},progress:{day:15,automatic_days:14,required_automatic_days:14,manual:null,reason:'PREPARATION_COMPLETED',estimated_completion_date:'2026-09-15'},declarations:[]};
  else if(path==='/v1/channel-accounts/'+id)data={id,name:'Equipo Centro',provider:'simulator',status:'WORKING',version:1};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({data}));return;
 }
 const file=path.startsWith('/assets/')?resolve(root,'.'+path):resolve(root,'index.html');
 if(!file.startsWith(root+'/')){res.writeHead(404);res.end();return;}
 try{res.writeHead(200,{'content-type':({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[extname(file)]??'application/octet-stream'});res.end(await readFile(file));}catch{res.writeHead(404);res.end();}
});
server.listen(5349,'127.0.0.1',()=>console.log('Read-only native zoom fixture: http://127.0.0.1:5349/sales/channels/whatsapp'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close());
