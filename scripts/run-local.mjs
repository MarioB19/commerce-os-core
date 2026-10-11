import { spawn } from 'node:child_process';
import { applyLocalEnv } from './local-env.mjs';
applyLocalEnv();
const [cmd,...args]=process.argv.slice(2);
if (!cmd) throw new Error('Falta comando');
const child=spawn(cmd,args,{stdio:'inherit',env:process.env});
child.on('exit',code=>process.exit(code||0));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
