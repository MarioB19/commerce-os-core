import { provisionUser } from '../apps/api/src/auth.js';
import { pool, withTransaction, putRecord, appendEvent } from '../packages/db/src/index.js';

const email=process.env.BOOTSTRAP_EMAIL;
const password=process.env.BOOTSTRAP_PASSWORD;
if(!email||!password||password.length<16)throw new Error('Supply BOOTSTRAP_EMAIL and strong BOOTSTRAP_PASSWORD through the protected environment');
const workspace=process.env.WORKSPACE_ID||'local';
try {
 const existing=(await pool.query('SELECT id FROM "user" WHERE email=$1',[email.toLowerCase()])).rows[0];
 if(!existing)await provisionUser({email,password,name:process.env.BOOTSTRAP_NAME||'Operador local',workspace_id:workspace,role:'owner'});
 await withTransaction(async c=>{
  for(let i=1;i<=10;i++){
   const alias=`Simulación ${String(i).padStart(2,'0')}`;
   const found=(await c.query("SELECT id FROM records WHERE workspace_id=$1 AND kind='channel_account' AND environment='SIMULATION' AND body->>'name'=$2",[workspace,alias])).rows[0];
   if(!found){const account=await putRecord(c,{workspaceId:workspace,environment:'SIMULATION',kind:'channel_account',body:{name:alias,alias,provider:'simulator',purpose:'Pruebas locales con identidades sintéticas',sending_enabled:false,status:'STOPPED'}});await appendEvent(c,{workspace_id:workspace,environment:'SIMULATION',event_type:'channel_account.created',aggregate_id:account.id,actor:{type:'bootstrap'},payload:{provider:'simulator'}});}
  }
 });
 console.log('Bootstrap local completo: usuario individual y diez cuentas SIMULATION. No cuentas reales ni autorizaciones de envío creadas.');
} finally { await pool.end(); }
