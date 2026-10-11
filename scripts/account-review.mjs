import {SMTPServer} from 'smtp-server';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {homedir} from 'node:os';
process.env.COMMERCE_CONFIG_DIR??=join(homedir(),'.config','commerce-os-account-review');
const {applyLocalEnv}=await import('./local-env.mjs');applyLocalEnv();
if(process.env.NODE_ENV==='production'||!['127.0.0.1','localhost'].includes(new URL(process.env.DATABASE_URL).hostname)||process.env.WORKSPACE_ID!=='account-review')throw new Error('ISOLATED_ACCOUNT_REVIEW_REQUIRED');
const web=process.env.PUBLIC_WEB_ORIGIN;
const messages=[];const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const smtp=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],logger:false,size:131072,
 onRcptTo(address,_session,done){done(/@(example\.invalid|commerce\.test)$/.test(address.address)?undefined:Object.assign(new Error('Sólo destinatarios sintéticos'),{responseCode:550}));},
 onData(stream,_session,done){let raw='';stream.on('data',chunk=>{if(raw.length<131072)raw+=chunk;});stream.on('end',()=>{const decoded=raw.replace(/=\r?\n/g,'').replace(/=([0-9A-F]{2})/g,(_,hex)=>String.fromCharCode(parseInt(hex,16)));const token=decoded.match(/reset-password#token=([A-Za-z0-9_-]+)/)?.[1];if(token){messages.unshift({token,at:Date.now()});messages.splice(10);}done();});}});
smtp.on('error',()=>{process.stderr.write('Local SMTP capture unavailable\n');});
await new Promise(resolve=>smtp.listen(2527,'127.0.0.1',resolve));
const inbox=createServer((req,res)=>{
 if(req.url!=='/'){res.writeHead(404);res.end();return;}
 while(messages.length&&messages.at(-1).at<Date.now()-30*60*1000)messages.pop();
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"});
 res.end(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Correo local · Commerce OS</title><style>body{font:16px/1.6 system-ui;background:#f4f6f5;color:#23382d;margin:40px auto;padding:20px;max-width:650px}a{color:#155c49}li{padding:20px;border-bottom:1px solid #ccd6d0}</style><main><h1>Bandeja SMTP local</h1><p>Captura en memoria, sin salida a Internet. Sólo cuentas sintéticas. Los enlaces desaparecen al reiniciar o después de 30 minutos.</p><p><a href="/">Actualizar bandeja</a> · <a href="${esc(web)}/forgot-password">Solicitar recuperación</a></p><ul>${messages.map(m=>`<li>${new Date(m.at).toLocaleTimeString('es-MX')} · <a href="${esc(web)}/reset-password#token=${esc(m.token)}">Restablecer contraseña</a></li>`).join('')||'<li>Aún no hay mensajes. Solicita recuperación desde el login y actualiza esta página.</li>'}</ul></main></html>`);
});
await new Promise(resolve=>inbox.listen(8027,'127.0.0.1',resolve));
// Configure only this isolated database. No commercial configuration is imported or updated.
const {default:pg}=await import('pg');const client=new pg.Client({connectionString:process.env.DATABASE_URL});await client.connect();
await client.query(`INSERT INTO identity_mail_settings(singleton,version,enabled,config,updated_by) VALUES(true,1,true,$1,'local-review') ON CONFLICT(singleton) DO UPDATE SET enabled=true,config=$1,secret_ciphertext=NULL,version=identity_mail_settings.version+1`,[{mode:'local',host:'localhost',port:2527,tls:'none',from:'security@example.invalid',name:'Commerce OS'}]);await client.end();
const child=spawn(process.execPath,['scripts/serve-build.mjs'],{stdio:'inherit',env:process.env});
console.log('Revisión aislada: '+web+' · Bandeja SMTP local: http://127.0.0.1:8027');
let stopping=false;function stop(code=0){if(stopping)return;stopping=true;child.kill('SIGTERM');inbox.close();smtp.close();setTimeout(()=>process.exit(code),1200).unref();}
child.on('exit',code=>stop(code??1));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
