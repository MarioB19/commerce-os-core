import {buildIngress} from './server.js';
const app=await buildIngress();await app.listen({host:process.env.HOST??'0.0.0.0',port:Number(process.env.PORT??process.env.INGRESS_PORT??3002)});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void app.close().then(()=>process.exit(0));});
