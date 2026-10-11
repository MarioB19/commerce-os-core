import { spawn } from 'node:child_process';
import { applyLocalEnv } from './local-env.mjs';
applyLocalEnv();
const entries=[['api','3001'],['ingress','3002'],['automation-worker','3003'],['channel-worker','3004']];
const children=entries.map(([app,port])=>spawn(process.execPath,['--import','tsx',`apps/${app}/src/index.ts`],{stdio:'inherit',env:{...process.env,PORT:port}}));
children.push(spawn('pnpm',['--filter','@commerce/web','dev'],{stdio:'inherit',env:process.env}));
console.log('Commerce OS: http://127.0.0.1:5173 · Simulación · procesos independientes');
let stopping=false;
function stop(code=0){if(stopping)return;stopping=true;children.forEach(c=>c.kill('SIGTERM'));setTimeout(()=>process.exit(code),800).unref();}
for(const c of children)c.on('exit',code=>{if(!stopping)stop(code||1);});
for(const s of ['SIGINT','SIGTERM'])process.on(s,()=>stop());
