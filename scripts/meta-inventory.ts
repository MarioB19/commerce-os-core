import {writeFileSync} from 'node:fs';
import {discoverMeta,readMetaCredentials} from '../apps/api/src/meta-client.js';
const credentials=readMetaCredentials();
if(!credentials.length)throw new Error('META_CREDENTIALS_NOT_CONFIGURED');
const result=await discoverMeta(credentials);
const destination=process.argv[2];
if(!destination)throw new Error('Indica el archivo del inventario sanitizado.');
writeFileSync(destination,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({source:result.source,version:result.graph_api_version,status:result.status,portfolios:result.portfolios.map(p=>({id:p.id,name:p.name,counts:p.assets.reduce<Record<string,number>>((all,a)=>(all[a.kind]=(all[a.kind]??0)+1,all),{})})),requests:result.requests.length,unavailable:result.requests.filter(r=>r.status==='UNAVAILABLE'),external_mutations:0}));
