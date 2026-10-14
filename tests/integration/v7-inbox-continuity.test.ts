import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,withTransaction} from '../../packages/db/src/index.js';
import {materializeMessage} from '../../apps/automation-worker/src/inbound.js';
import {fixtureProfiles} from '../support/profile-fixture.js';
import {roleExecutor} from '../support/database-role.js';
import type {Role} from '../../packages/contracts/src/index.js';

// CONT-INBOX (RF-18.a): the V7 application keeps the sales inbox. Every message
// of a conversation and its order are there, with the same filters, handoff and
// reply; a viewer reads without acting and another profile sees nothing.
const P='inbox-'+randomUUID(),Q='inbox-other-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
const withRole=roleExecutor(pool);
let app:Awaited<ReturnType<typeof createApp>>;const cookies:Record<string,string>={};
const call=(who:string,method:string,path:string,body?:unknown)=>app.inject({method:method as 'GET',url:path+(path.includes('?')?'&':'?')+'environment=REAL',payload:body as object,headers:{origin,cookie:cookies[who]!,'idempotency-key':randomUUID()}});
const data=(r:{statusCode:number;body:string;json():any},status=200)=>{expect(r.statusCode,r.body).toBe(status);return r.json().data;};
async function login(who:string,workspace:string,role:Role){
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:who,email,password,workspace_id:workspace,role});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookies[who]=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
}
async function inProfile<T>(work:(c:import('pg').PoolClient)=>Promise<T>){
 const c=await pool.connect();
 try{await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id',$1,true),set_config('app.environment','REAL',true)",[P]);const r=await work(c);await c.query('COMMIT');return r;}
 catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
let number:any,first='',second='',order='';
beforeAll(async()=>{
 await fixtureProfiles({id:P,numbers:2},{id:Q,numbers:1});app=await createApp();
 await login('owner',P,'owner');await login('operator',P,'operator');await login('viewer',P,'viewer');await login('stranger',Q,'owner');
 number=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','channel_account',$2) RETURNING *",[P,{name:'Ventas inbox',provider:'simulator',status:'WORKING'}])).rows[0]);
 const inbound=(identity:string,text:string)=>withRole('commerce_automation',()=>withTransaction(c=>materializeMessage(c,number,{key:randomUUID(),type:'message',providerAt:new Date().toISOString(),identity,kind:'text',text,payload:{}},randomUUID())));
 first=(await inbound('opaque:cliente-uno','Hola, ¿tienen el curso?'))!.id;
 for(const text of ['¿Cuánto cuesta?','Quiero pagar por transferencia'])expect((await inbound('opaque:cliente-uno',text))!.id).toBe(first);
 second=(await inbound('opaque:cliente-dos','Buenas tardes'))!.id;
 order=await inProfile(async c=>(await c.query("INSERT INTO records(workspace_id,environment,kind,body) VALUES($1,'REAL','order',$2) RETURNING id",[P,{conversation_id:first,status:'COMMITTED',receipt_status:'NONE',total_minor:9700,currency:'MXN'}])).rows[0].id);
},120000);
afterAll(async()=>{await app?.close();await pool.end();});

it('lists every conversation with its filters and keeps all messages and the order (CONT-INBOX)',async()=>{
 const all=data(await call('operator','GET','/v1/conversations'));
 expect(all.map((c:{id:string})=>c.id).sort()).toEqual([first,second].sort());
 // Filters: by number and by text.
 expect(data(await call('operator','GET',`/v1/conversations?account_id=${number.id}`)).length).toBe(2);
 expect(data(await call('operator','GET',`/v1/conversations?account_id=${randomUUID()}`))).toEqual([]);
 // Detail: the three messages in order, the order and the controls.
 const detail=data(await call('operator','GET',`/v1/conversations/${first}`));
 expect(detail.messages.map((m:{text?:string})=>m.text)).toEqual(['Hola, ¿tienen el curso?','¿Cuánto cuesta?','Quiero pagar por transferencia']);
 expect(detail.order).toMatchObject({id:order});expect(detail.controls).toMatchObject({paused:false,takeover:false});
 const orders=data(await call('operator','GET',`/v1/orders?conversation_id=${first}`));
 expect(orders.map((o:{id:string})=>o.id)).toEqual([order]);
});

it('lets the operator take over and reply; the viewer only reads; another profile sees nothing (CONT-INBOX)',async()=>{
 // Handoff: a person takes the chat (AI stops) and answers from the inbox.
 const taken=await call('operator','POST',`/v1/conversations/${first}/controls`,{takeover:true,paused:true,reason:'Atiendo yo esta conversación'});
 expect([200,202]).toContain(taken.statusCode);
 expect(data(await call('operator','GET',`/v1/conversations/${first}`)).controls).toMatchObject({takeover:true,paused:true});
 const current=data(await call('operator','GET',`/v1/conversations/${first}`));
 const reply=await call('operator','POST',`/v1/conversations/${first}/commands`,{type:'send_message',kind:'text',text:'Hola, te atiendo yo.',expected_version:current.version});
 expect(reply.statusCode,reply.body).toBe(202);expect(reply.json().data).toMatchObject({kind:'conversation_command',resource_id:first});
 // Release: back to automation.
 const released=await call('operator','POST',`/v1/conversations/${first}/controls`,{takeover:false,paused:false,reason:'Regresa a la automatización'});
 expect([200,202]).toContain(released.statusCode);
 // The viewer reads the same inbox but cannot act.
 expect(data(await call('viewer','GET','/v1/conversations')).length).toBe(2);
 expect((await call('viewer','POST',`/v1/conversations/${second}/controls`,{takeover:true,reason:'No debería poder'})).statusCode).toBe(403);
 expect((await call('viewer','POST',`/v1/conversations/${second}/commands`,{type:'send_message',kind:'text',text:'x',expected_version:1})).statusCode).toBe(403);
 // Another profile: nothing listed and the conversation is not found.
 expect(data(await call('stranger','GET','/v1/conversations'))).toEqual([]);
 expect((await call('stranger','GET',`/v1/conversations/${first}`)).statusCode).toBe(404);
 // No message was lost along the way.
 expect(data(await call('owner','GET',`/v1/conversations/${first}`)).messages).toHaveLength(3);
});
