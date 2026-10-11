import { spawn } from 'node:child_process';
import { applyLocalEnv } from './local-env.mjs';
applyLocalEnv();
// Explicitly opted-in loopback capture for isolated E2E, never production.
if(process.env.IDENTITY_TEST_SMTP==='true'){
 if(process.env.NODE_ENV==='production'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))throw new Error('LOCAL_SMTP_TEST_ONLY');
 const smtpPort=Number(process.env.IDENTITY_TEST_SMTP_PORT??2527);
 if(!Number.isInteger(smtpPort)||smtpPort<1024||smtpPort>65535)throw new Error('LOCAL_SMTP_TEST_PORT_INVALID');
 process.env.SMTP_ALLOWED_TARGETS=JSON.stringify([{host:'localhost',port:smtpPort,addresses:['127.0.0.1'],mode:'local'}]);
 process.env.PUBLIC_WEB_ORIGIN=process.env.E2E_BASE_URL??'http://127.0.0.1:5173';
}
// Production JS/assets, local HTTP cookies for browser tests. Production Compose uses HTTPS/Secure cookies.
const children=['api','ingress','automation-worker','channel-worker'].map((app,i)=>spawn(process.execPath,[`dist/apps/${app}/index.js`],{stdio:'inherit',env:{...process.env,HOST:'127.0.0.1',PORT:String(process.env[['API_PORT','INGRESS_PORT','AUTOMATION_PORT','CHANNEL_PORT'][i]]??(Number(process.env.API_PORT??3001)+i))}}));
children.push(spawn('pnpm',['--filter','@commerce/web','preview','--host','127.0.0.1','--port',process.env.WEB_PORT??'5173','--strictPort'],{stdio:'inherit',env:process.env}));
let stopping=false;function stop(code=0){if(stopping)return;stopping=true;children.forEach(c=>c.kill('SIGTERM'));setTimeout(()=>process.exit(code),1000).unref();}
for(const c of children)c.on('exit',code=>{if(!stopping)stop(code||1);});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop());
