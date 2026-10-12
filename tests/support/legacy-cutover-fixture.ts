import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';

/** Synthetic pre-V7 installation (migrations 0001–0068) for the F2 cutover
 * tests. One principal workspace with every historical membership role, the
 * main commercial record kinds and the custody tables the 020 components
 * adopt, plus one orphan workspace that holds data but no membership. No real
 * person, phone number, token or customer appears here. */
export interface LegacyInstallation {
 principal:string;orphan:string;
 users:{owner:string;operator:string;analyst:string;viewer:string;seller:string;reconciler:string};
 ids:Record<string,string>;
 tokens:{personalHash:string;serviceHash:string};
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function seedLegacyInstallation(db:Pick<pg.Pool,'query'>,suffix=randomUUID().slice(0,8)):Promise<LegacyInstallation>{
 const principal='legacy-principal-'+suffix,orphan='legacy-orphan-'+suffix;
 const users={owner:'legacy-owner-'+suffix,operator:'legacy-operator-'+suffix,analyst:'legacy-analyst-'+suffix,viewer:'legacy-viewer-'+suffix,seller:'legacy-seller-'+suffix,reconciler:'legacy-reconciler-'+suffix};
 const roles:[keyof typeof users,string,boolean][]=[['owner','owner',true],['operator','operator',true],['analyst','analyst',true],['viewer','viewer',true],['seller','seller',false],['reconciler','reconciler',false]];
 for(const[key,role,active]of roles){
  await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',[users[key],'Synthetic '+role,`${users[key]}@example.invalid`]);
  await db.query('INSERT INTO memberships(user_id,workspace_id,role,active) VALUES($1,$2,$3,$4)',[users[key],principal,role,active]);
 }
 const ids:Record<string,string>={};
 const put=async(name:string,workspace:string,environment:'REAL'|'SIMULATION',kind:string,body:Record<string,unknown>)=>{
  ids[name]=(await db.query('INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,$2,$3,$4) RETURNING id',[workspace,environment,kind,body])).rows[0].id;
  return ids[name];
 };
 await put('product',principal,'REAL','product',{name:'Synthetic product'});
 await put('simProduct',principal,'SIMULATION','product',{name:'Synthetic simulation product'});
 await put('asset',principal,'REAL','asset',{name:'Synthetic material',kind:'link',url:'https://example.invalid/material'});
 await put('account',principal,'REAL','channel_account',{name:'Synthetic number',provider:'simulator',sending_enabled:false,status:'STOPPED'});
 await put('retiredAccount',principal,'REAL','channel_account',{name:'Synthetic retired number',provider:'simulator',sending_enabled:false,status:'STOPPED',deleted_at:new Date().toISOString()});
 await put('simAccount',principal,'SIMULATION','channel_account',{name:'Synthetic simulation number',provider:'simulator',sending_enabled:false,status:'STOPPED'});
 await put('contact',principal,'REAL','contact',{name:'Synthetic customer',identity:'opaque:legacy-'+suffix});
 await put('conversation',principal,'REAL','conversation',{account_id:ids.account,contact_id:ids.contact,product_id:ids.product,stage:'new'});
 await put('order',principal,'REAL','order',{conversation_id:ids.conversation,contact_id:ids.contact,product_id:ids.product,currency:'MXN',amount_minor:12000});
 await put('orphanProduct',orphan,'REAL','product',{name:'Synthetic orphan product'});
 await put('orphanAccount',orphan,'REAL','channel_account',{name:'Synthetic orphan number',provider:'simulator',sending_enabled:false,status:'STOPPED'});
 await db.query('INSERT INTO session_ownership(account_id,workspace_id,owner_id,lease_expires_at) VALUES($1,$2,$3,now()+interval \'1 hour\'),($4,$2,$3,now()+interval \'1 hour\')',[ids.account,principal,'channel-legacy',randomUUID()]);
 await db.query("INSERT INTO manual_controls(workspace_id,scope_type,scope_id,paused,reason,actor_id) VALUES($1,'workspace',$1,true,'Synthetic stop',$2),($1,'conversation',$3,true,'Synthetic pause',$2),($1,'conversation',$4,true,'Synthetic orphan pause',$2)",[principal,users.owner,ids.conversation,randomUUID()]);
 for(const[key,response]of [['legacy-env-1',{environment:'SIMULATION',id:randomUUID()}],['legacy-env-2',{data:{environment:'REAL'}}],['legacy-env-3',{_encrypted_response:'v1.synthetic'}]] as const)
  await db.query('INSERT INTO idempotency(workspace_id,actor_id,operation,key,request_hash,response,status_code) VALUES($1,$2,$3,$4,$5,$6,201)',[principal,users.owner,'legacy.operation',key,sha(key),response]);
 const sync=randomUUID();
 await db.query("INSERT INTO meta_syncs(id,workspace_id,actor_id,inventory) VALUES($1,$2,$3,$4)",[sync,principal,users.owner,{source:'META_API',portfolios:[]}]);
 await db.query("INSERT INTO meta_links(id,workspace_id,environment,sync_id,chain_id,revision,actor_id,body) VALUES($1,$2,'REAL',$3,$1,1,$4,$5)",[randomUUID(),principal,sync,users.owner,{scope_key:'synthetic'}]);
 const effect=(await db.query("INSERT INTO outbox(workspace_id,environment,account_id,conversation_id,contact_id,logical_key,payload,config_hash,status) VALUES($1,'REAL',$2,$3,$4,'legacy-effect',$5,$6,'CANCELLED') RETURNING id",[principal,ids.account,ids.conversation,ids.contact,{kind:'text',text:'Synthetic message'},sha('legacy-effect')])).rows[0].id;
 ids.effect=effect;
 await db.query("INSERT INTO effect_attempts(effect_id,claim_id,status) VALUES($1,'legacy-claim','CANCELLED')",[effect]);
 await db.query("INSERT INTO timers(workspace_id,environment,conversation_id,kind,due_at,logical_key) VALUES($1,'REAL',$2,'followup',now()+interval '1 day','legacy-timer')",[principal,ids.conversation]);
 await db.query("INSERT INTO commands(workspace_id,environment,kind,resource_id,actor_id,idempotency_key,status) VALUES($1,'REAL','channel_command',$2,$3,'legacy-command','APPLIED')",[principal,ids.account,users.owner]);
 const event=(await db.query("INSERT INTO domain_events(workspace_id,environment,event_type,aggregate_id,correlation_id) VALUES($1,'REAL','legacy.event',$2,$2) RETURNING id",[principal,ids.conversation])).rows[0].id;
 await db.query("INSERT INTO consumer_receipts(consumer,event_id) VALUES('legacy-consumer',$1)",[event]);
 const personal='cos_pat_'+'A'.repeat(20)+suffix.replace(/[^A-Za-z0-9]/g,'a').padEnd(23,'b').slice(0,23),service='cos_v5_legacy_'+suffix;
 await db.query("INSERT INTO personal_access_tokens(id,workspace_id,user_id,name,token_hash,allowed_environments,expires_at) VALUES($1,$2,$3,'Synthetic owner key',$4,'[\"REAL\",\"SIMULATION\"]',now()+interval '30 days')",[randomUUID(),principal,users.owner,sha(personal)]);
 await db.query("INSERT INTO service_tokens(workspace_id,actor_id,name,token_hash,scopes,expires_at) VALUES($1,$2,'Synthetic automation',$3,'[\"products:read\"]',now()+interval '30 days')",[principal,users.owner,sha(service)]);
 return{principal,orphan,users,ids,tokens:{personalHash:sha(personal),serviceHash:sha(service)}};
}
