import {randomUUID} from 'node:crypto';
import {processCommands,processTimers} from '../apps/automation-worker/src/runtime.js';
import {processChannelCommands} from '../apps/channel-worker/src/lifecycle.js';
import {materializeEffectResults} from '../apps/automation-worker/src/effect-results.js';
import {pool} from '../packages/db/src/index.js';
import {buildIngress} from '../apps/ingress/src/server.js';

/** Existing commercial accounts are explicit legacy fixtures, created exclusively by API. */
export async function commercialLoad(call:(method:any,url:string,body?:any)=>Promise<any>,workspace:string){
 const ingress=await buildIngress();
 const policy=await call('POST','/v1/receipt-policies',{name:'Ensayo comercial sin dinero',allow_amount_mismatch:true,auto_approve:false});
 const asset=await call('POST','/v1/assets',{name:'Material sintético de entrega',kind:'link',url:'https://example.invalid/fixture'});
 const product=await call('POST','/v1/products',{name:'Producto sintético del banco de carga',initial_offer:{currency:'MXN',base_amount_minor:10000,billing_delay_seconds:30,receipt_policy_version_id:policy.id,fulfillment:[{asset_id:asset.id,release_on:'commitment_accepted'}]}});
 const accounts:string[]=[];for(let i=0;i<2;i++){const a=await call('POST','/v1/channel-accounts',{name:'Comercial legado de ensayo '+i,provider:'simulator'});accounts.push(a.id);await call('POST','/v1/channel-accounts/'+a.id+'/commands',{type:'connect'});}
 await processChannelCommands(20);
 let count=0;const timings:number[]=[];
 return {accounts,timings,get transactions(){return count;},async tick(){
  const account=accounts[count%accounts.length],started=performance.now();
  await call('POST','/v1/channel-accounts/'+account+'/commands',{type:'check_health'});await processChannelCommands(20);
  const incoming=await ingress.inject({method:'POST',url:`/webhooks/simulator/${workspace}/${account}`,headers:{authorization:'Bearer '+process.env.SIMULATOR_INGRESS_TOKEN},payload:{id:'load-in-'+randomUUID(),identity:'opaque:synthetic-inbox-'+count,text:'Consulta sintética de carga comercial'}});
  if(incoming.statusCode>=300)throw new Error('SYNTHETIC_INGRESS_FAILED_'+incoming.statusCode);
  const simulation=await call('POST','/v1/simulations',{account_id:account,offer_version_id:product.initial_offer.id,contact_name:'Cliente sintético de carga '+count});
  await processCommands(100);const command=(await pool.query('SELECT status,result FROM commands WHERE id=$1',[simulation.command_id])).rows[0];if(command.status!=='APPLIED')throw new Error('SALES_SIMULATION_NOT_APPLIED');
  const commitment=await call('POST','/v1/conversations/'+command.result.conversation_id+'/commands',{type:'commitment'});await processCommands(100);
  const result=(await pool.query('SELECT status FROM commands WHERE id=$1',[commitment.id])).rows[0];if(result.status!=='APPLIED')throw new Error('SALES_COMMITMENT_NOT_APPLIED');
  await processTimers(100);await materializeEffectResults(100);timings.push(performance.now()-started);count++;
 },async close(){await ingress.close();}};
}
