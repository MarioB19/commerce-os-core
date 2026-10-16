import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {fixtureProfiles} from '../support/profile-fixture.js';

// V7 F7 (RF-11.a/c, RF-09.k): Campañas reads the profile's Meta insights and
// crosses them with its payments. Without a connected account it says so.
const P='campaigns-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:Awaited<ReturnType<typeof createApp>>;let cookie='';
const day=new Date(Date.now()-86400000).toISOString().slice(0,10);
const get=(path:string)=>app.inject({method:'GET',url:path,headers:{origin,cookie}});
beforeAll(async()=>{
 await fixtureProfiles({id:P,numbers:2});app=await createApp();
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Dueña',email,password,workspace_id:P,role:'owner'});
 const r=await app.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 cookie=[r.headers['set-cookie']].flat().filter(Boolean).map(v=>String(v).split(';')[0]).join('; ');
});
afterAll(async()=>{await app.close();await pool.end();});
it('reads spend per campaign only for the selected profile and never offers a write',async()=>{
 const empty=await get(`/v2/campaigns?from=${day}&to=${day}&environment=REAL`);expect(empty.statusCode,empty.body).toBe(200);
 expect(empty.json().data).toMatchObject({connected:false,report:null});
 const job=randomUUID();
 await pool.query("INSERT INTO meta_insight_jobs(id,workspace_id,environment,actor_id,request,status) VALUES($1,$2,'REAL','synthetic','{}','COMPLETE')",[job,P]);
 await pool.query("INSERT INTO meta_insight_accounts(workspace_id,environment,meta_ad_account_id,name,currency,timezone,status,last_success_at) VALUES($1,'REAL','act_1','Cuenta sintética','MXN','America/Mexico_City','SYNCED',now())",[P]);
 for(const [level,id,spend]of [['ad','100','2000'],['campaign','10','2000']])await pool.query("INSERT INTO meta_insight_days(workspace_id,environment,meta_ad_account_id,day,level,entity_id,campaign_id,name,campaign_name,currency,timezone,spend_minor,conversations,job_id) VALUES($1,'REAL','act_1',$2,$3,$4,'10','Anuncio sintético','Campaña sintética','MXN','America/Mexico_City',$5,3,$6)",[P,day,level,id,spend,job]);
 await pool.query("INSERT INTO meta_insight_coverage(workspace_id,environment,meta_ad_account_id,day,job_id) VALUES($1,'REAL','act_1',$2,$3)",[P,day,job]);
 await pool.query("INSERT INTO meta_ad_metadata(workspace_id,environment,meta_ad_account_id,ad_id,campaign_id,ad_name,campaign_name,source) VALUES($1,'REAL','act_1','100','10','Anuncio sintético','Campaña sintética','SYNTHETIC_FIXTURE')",[P]);
 const read=await get(`/v2/campaigns?from=${day}&to=${day}&currency=MXN&environment=REAL`);expect(read.statusCode,read.body).toBe(200);
 const v=read.json().data;
 // Data read earlier stays visible; «connected» says whether a verified token can refresh it (RF-11).
 expect(v).toMatchObject({connected:false,read_only:true,accounts:[{id:'act_1',name:'Cuenta sintética',currency:'MXN'}],sync:{credential:'MISSING',last_sync:null}});
 expect(v.report.summary).toMatchObject({spend_minor:2000,attributed_sales:0,attributed_revenue_minor:0});
 expect(v.report.groups.campaigns.map((c:{name:string;spend_minor:number})=>[c.name,c.spend_minor])).toEqual([['Campaña sintética',2000]]);
 // There is no write route for campaigns in V7 (only a request for a fresh read, POST /v2/campaigns/sync).
 for(const method of ['POST','PUT','PATCH','DELETE'] as const)expect((await app.inject({method,url:'/v2/campaigns',headers:{origin,cookie},payload:{}})).statusCode).toBe(404);
 for(const method of ['PUT','PATCH','DELETE'] as const)expect((await app.inject({method,url:'/v2/campaigns/sync',headers:{origin,cookie},payload:{}})).statusCode).toBe(404);
},120000);
it('serves the same help as the application, and as a Markdown download (RF-16.d)',async()=>{
 const list=await get('/v2/help?environment=REAL');expect(list.statusCode,list.body).toBe(200);
 expect(list.json().data.sections.map((s:{id:string})=>s.id)).toEqual(['empezar','dia-a-dia','probar','ia','whatsapp','privacidad','terminos','api']);
 const one=await get('/v2/help?section=privacidad');expect(one.json().data.section.body).toContain('30 días');
 expect((await get('/v2/help?section=nada')).statusCode).toBe(404);
 const file=await get('/v2/help/download');expect(file.statusCode).toBe(200);expect(file.headers['content-type']).toContain('text/markdown');expect(file.body).toContain('# Ayuda de Commerce OS');
 // Without a session there is no help either (it is a profile route).
 expect((await app.inject({method:'GET',url:'/v2/help',headers:{origin}})).statusCode).toBe(401);
});
