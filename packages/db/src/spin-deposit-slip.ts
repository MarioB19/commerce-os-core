import {timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {profileIdSchema} from '../../contracts/src/profiles.js';
import {identityDigest} from './identity.js';
import {decrypt,pool} from './index.js';
import {withProfileTransaction} from './profile-context.js';
import {bindProfileEnvironment} from './profile-environment.js';

const scopeSchema=z.tuple([profileIdSchema,z.enum(['REAL','SIMULATION']),z.string().uuid(),z.string().uuid(),z.string().uuid()]);
type SlipScope=z.infer<typeof scopeSchema>;

// The fragment contains an order-scoped bearer grant. Neither the request URL
// nor a link preview includes the grant. The signed scope contains no bank data.
export function spinDepositLink(origin:string,workspace:string,environment:string,conversation:string,order:string,collection:string){
 const scope=scopeSchema.parse([workspace,environment,conversation,order,collection]);
 const payload=Buffer.from(JSON.stringify(scope)).toString('base64url');
 const mac=identityDigest('spin-deposit-slip',payload);
 return new URL('/deposito-spin.html#'+payload+'.'+mac,origin).href;
}

export function spinSlipScope(token:string):SlipScope|null{
 if(token.length>2048)return null;
 const match=/^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(token);
 if(!match)return null;
 const mac=identityDigest('spin-deposit-slip',match[1]!);
 if(!timingSafeEqual(Buffer.from(mac,'hex'),Buffer.from(match[2]!,'hex')))return null;
 try{return scopeSchema.parse(JSON.parse(Buffer.from(match[1]!,'base64url').toString()));}
 catch{return null;}
}

export async function readSpinSlip(token:string){
 const scope=spinSlipScope(token);
 if(!scope)return null;
 const [workspace,environment,conversation,order,bankId]=scope;
 return withProfileTransaction(pool,workspace,async db=>{
  await bindProfileEnvironment(db,environment);
  const row=(await db.query(`SELECT bank.body AS bank,
    (o.body->>'commercial_classification'='TEST' OR o.body ? 'launch_test_scope_id' OR c.body->>'is_test'='true' OR c.body ? 'number_flow_test_id') AS test_order
   FROM market_journey_snapshots s
   JOIN records c ON c.id=s.journey_id AND c.workspace_id=s.workspace_id AND c.environment=s.environment AND c.kind='conversation'
   JOIN records o ON o.workspace_id=c.workspace_id AND o.environment=c.environment AND o.kind='order' AND o.body->>'conversation_id'=c.id::text
   JOIN record_versions bank ON bank.workspace_id=s.workspace_id AND bank.environment=s.environment AND bank.kind='bank_profile'
    AND bank.record_id=$3 AND bank.record_id::text=s.body#>>'{release,configuration,collection,id}'
    AND bank.version=(s.body#>>'{release,configuration,collection,revision}')::int
   WHERE s.workspace_id=$1 AND s.environment=$4 AND s.journey_id=$2 AND o.id=$5
    AND o.body->>'payment_profile_version_id'=bank.record_id::text AND o.body->>'currency'='MXN'
    AND o.body->>'status' IN ('OFFERED','COMMITTED') AND o.body->>'receipt_status' IS DISTINCT FROM 'APPROVED'
    AND c.body->>'privacy_erased' IS DISTINCT FROM 'true' AND c.body->>'stage' IS DISTINCT FROM 'CLOSED' AND COALESCE(o.body->>'sale_status','')<>'RECOGNIZED'
    AND bank.body#>>'{methods,spin}'='true'`,[workspace,conversation,bankId,environment,order])).rows[0];
  if(!row)return null;
  if(environment==='SIMULATION'||row.test_order===true)return {
   spin:{card_number:'0000000000000000',holder:'SIMULACIÓN · SIN VALIDEZ'},
   spei:row.bank.methods.spei?{bank:'SIMULACIÓN',clabe:'000000000000000000',holder:'SIN VALIDEZ'}:null,
  };
  const secret=JSON.parse(decrypt(row.bank.secret_ciphertext));
  if(!secret.spin)return null;
  return {spin:{card_number:secret.spin.card_number,holder:secret.spin.holder},
   spei:secret.spei?{bank:row.bank.spei_bank,clabe:secret.spei.clabe,holder:secret.spei.holder}:null};
 });
}
