import {startIdentityMailWorker} from './identity-mail.js';
import {createApp} from './app.js';
import {pool} from '../../../packages/db/src/index.js';
const app=await createApp();await app.listen({port:Number(process.env.API_PORT??process.env.PORT??3001),host:process.env.HOST??'0.0.0.0'});
const stopMail=startIdentityMailWorker();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(stopMail).then(()=>pool.end()).then(()=>process.exit(0));});
