import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pool as adminPool,encrypt} from '../../packages/db/src/index.js';
const execute=promisify(execFile),workspace='creative-roles-'+randomUUID(),actor=randomUUID(),search=randomUUID();
const database='commerce_roles_'+randomUUID().replaceAll('-',''),fixtureConnection=new URL(process.env.DATABASE_URL!);fixtureConnection.pathname='/'+database;
let pool:pg.Pool;
beforeAll(async()=>{await adminPool.query(`CREATE DATABASE "${database}" TEMPLATE template0`);await execute(process.execPath,['--import','tsx','packages/db/src/migrate.ts'],{env:{...process.env,DATABASE_URL:fixtureConnection.toString()},timeout:30000});pool=new pg.Pool({connectionString:fixtureConnection.toString()});});
afterAll(async()=>{await pool?.end();await adminPool.query(`DROP DATABASE IF EXISTS "${database}"`);await adminPool.end();});
async function withTransaction<T>(run:(client:pg.PoolClient)=>Promise<T>){const c=await pool.connect();try{await c.query('BEGIN');const result=await run(c);await c.query('COMMIT');return result;}catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}}
const model='gpt-5.4-mini-2026-03-17';
describe('Creative published database roles, isolated PostgreSQL and fixture transport',()=>{
 it('runs the actual API mutations and automation search/analysis loop under their limited roles',async()=>{
  await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_api');
   for(const provider of ['searchapi','openai']){await c.query("INSERT INTO creative_settings(workspace_id,environment,provider,enabled,config,secret_ciphertext) VALUES($1,'SIMULATION',$2,true,$3,$4)",[workspace,provider,{models:[model]},encrypt({api_key:'ISOLATED_FIXTURE_ONLY'})]);await c.query("INSERT INTO creative_budgets(id,workspace_id,environment,provider,limit_usd,max_units,authorization_source,actor_id,expires_at) VALUES($1,$2,'SIMULATION',$3,1,100000,'Isolated role verification',$4,now()+interval '1 hour')",[randomUUID(),workspace,provider,actor]);}
  });
  async function runtime(role:string,program:string){
   const connection=new URL(fixtureConnection);connection.searchParams.set('options','-c role='+role);
   const runtimeEnv:NodeJS.ProcessEnv={...process.env,DATABASE_URL:connection.toString(),CREATIVE_ROLE_FIXTURE:JSON.stringify({workspace,actor,search})};if(role==='commerce_automation'){runtimeEnv.NODE_ENV='production';delete runtimeEnv.BETTER_AUTH_SECRET;}
   const {stdout}=await execute(process.execPath,['--import','tsx','--input-type=module','-e',program],{cwd:process.cwd(),env:runtimeEnv,timeout:30000,maxBuffer:1024*1024});return JSON.parse(stdout.trim());
  }
  const api=await runtime('commerce_api',`
   import Fastify from 'fastify';import {randomUUID} from 'node:crypto';
   import {pool} from './packages/db/src/index.ts';import {principalMap} from './apps/api/src/context.ts';import {intelligenceRoutes} from './apps/api/src/intelligence.ts';
   const f=JSON.parse(process.env.CREATIVE_ROLE_FIXTURE),app=Fastify();app.addHook('preHandler',async req=>{principalMap.set(req,{user:{id:f.actor,name:'Fixture',email:''},workspace_id:f.workspace,role:'owner',permissions:[],service:false,scopes:[]});});await intelligenceRoutes(app);
   async function call(method,url,payload){const r=await app.inject({method,url:url+'?environment=SIMULATION',payload,headers:{'idempotency-key':randomUUID()}});if(r.statusCode>=400)throw Error('API_ROLE_'+r.statusCode+':'+r.body);return r.json().data;}
   const s=await call('POST','/v1/intelligence/searches',{name:'Role fixture',query:{q:'isolated role fixture',country:'MX',pages:1,max_ads:50}});
   const tracked=await call('PATCH','/v1/intelligence/searches/'+s.id,{expected_version:1,tracking_enabled:true,daily_budget_minor:1});
   await call('PATCH','/v1/intelligence/searches/'+s.id,{expected_version:tracked.version,tracking_enabled:false});
   await call('POST','/v1/intelligence/searches/'+s.id+'/refresh',{expected_version:3});
   const role=(await pool.query('SELECT current_user role')).rows[0].role;
   await app.close();await pool.end();console.log(JSON.stringify({role,search:s.id}));
  `);
  expect(api.role).toBe('commerce_api');
  const searchRuntime=`
   import {pool,hash,stableJson} from './packages/db/src/index.ts';import {processIntelligenceQueue} from './packages/intelligence/src/index.ts';
   const f=JSON.parse(process.env.CREATIVE_ROLE_FIXTURE);let calls=0;
   globalThis.fetch=async url=>{calls++;if(String(url).includes('searchapi.io'))return Response.json({search_metadata:{id:'fixture-search'},ads:[{ad_archive_id:'role-ad',page_id:'fixture-school',snapshot:{page_name:'Isolated advertiser',title:'Fixture offer',body:{text:'Synthetic evidence for database role verification.'},link_url:'https://example.invalid/role-fixture'}}]});
    if(String(url).includes('api.openai.com'))return Response.json({id:'fixture-analysis',status:'completed',usage:{input_tokens:100,output_tokens:100},output:[{content:[{type:'output_text',text:JSON.stringify({summary_es:'Análisis sintético.',observed_offer:'Texto sintético',audience_inference:'Desconocida',angles:[],claims:[],unknowns:['Sólo fixture'],modalities_analyzed:['text']})}]}]});throw Error('UNEXPECTED_FIXTURE_TRANSPORT');};
   await processIntelligenceQueue();
   const role=(await pool.query('SELECT current_user role')).rows[0].role;
   const runs=(await pool.query('SELECT status,error_code FROM intelligence_runs WHERE workspace_id=$1',[f.workspace])).rows;
   const analyses=(await pool.query('SELECT status FROM intelligence_analyses WHERE workspace_id=$1',[f.workspace])).rows;
   await pool.end();console.log(JSON.stringify({role,calls,runs,analyses}));
  `;
  const searched=await runtime('commerce_automation',searchRuntime);expect(searched,JSON.stringify(searched)).toMatchObject({role:'commerce_automation',calls:1,runs:[{status:'COMPLETED'}]});
  const edited=await runtime('commerce_api',`
   import Fastify from 'fastify';import {randomUUID} from 'node:crypto';import {pool} from './packages/db/src/index.ts';import {principalMap} from './apps/api/src/context.ts';import {intelligenceRoutes} from './apps/api/src/intelligence.ts';
   const f=JSON.parse(process.env.CREATIVE_ROLE_FIXTURE),app=Fastify();app.addHook('preHandler',async req=>principalMap.set(req,{user:{id:f.actor,name:'Fixture',email:''},workspace_id:f.workspace,role:'owner',permissions:[],service:false,scopes:[]}));await intelligenceRoutes(app);
   async function call(method,url,payload){const r=await app.inject({method,url:url+'?environment=SIMULATION',payload,headers:{'idempotency-key':randomUUID()}});if(r.statusCode>=400)throw Error('API_ROLE_'+r.statusCode+':'+r.body);return r.json().data;}
   const offers=await call('GET','/v1/intelligence/offers'),o=offers[0];await call('PATCH','/v1/intelligence/offers/'+o.id,{expected_version:o.version,title:'Corrected fixture',group_label:'Fixture',reason:'Explicit fixture correction'});
   const detail=await call('GET','/v1/intelligence/offers/'+o.id);await call('POST','/v1/intelligence/offers/'+o.id+'/analyze',{expected_version:detail.version});
   await call('POST','/v1/intelligence/opportunities',{offer_id:o.id,title:'Synthetic opportunity'});await call('GET','/v1/intelligence/opportunities');
   await app.close();await pool.end();console.log(JSON.stringify({offer:o.id}));
  `);expect(edited.offer).toBeTruthy();
  const analyzed=await runtime('commerce_automation',searchRuntime);expect(analyzed).toMatchObject({calls:1,analyses:[{status:'COMPLETED'}]});
  await withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_api');await c.query("UPDATE intelligence_searches SET tracking_enabled=true,daily_budget_minor=1,next_run_at=now()-interval '1 second' WHERE id=$1",[api.search]);});
  const scheduled=await runtime('commerce_automation',searchRuntime);expect(scheduled).toMatchObject({calls:1,runs:[{status:'COMPLETED'},{status:'COMPLETED'}]});
  expect((await pool.query('SELECT next_run_at>now() scheduled FROM intelligence_searches WHERE id=$1',[api.search])).rows[0].scheduled).toBe(true);
  const receipts=(await pool.query('SELECT provider,status,confirmed_units FROM creative_provider_operations WHERE workspace_id=$1 ORDER BY provider',[workspace])).rows;expect(receipts).toHaveLength(3);expect(receipts.every(r=>r.status==='CONFIRMED')).toBe(true);
 });
 it('allows API voice and broker state but denies unrelated worker/identity/destructive access',async()=>{
  const rows=(await pool.query("SELECT role_name,table_name,has_table_privilege(role_name,table_name,'SELECT') can_read,has_table_privilege(role_name,table_name,'INSERT') can_insert,has_table_privilege(role_name,table_name,'UPDATE') can_update,has_table_privilege(role_name,table_name,'DELETE') can_delete FROM unnest(ARRAY['commerce_api','commerce_automation','commerce_channel','commerce_ingress']) role_name CROSS JOIN unnest(ARRAY['intelligence_searches','intelligence_runs','intelligence_offers','intelligence_observations','intelligence_analyses','intelligence_opportunities','creative_voice_operations','creative_settings','creative_budgets','creative_provider_operations']) table_name")).rows;
  expect(rows.find(r=>r.role_name==='commerce_api'&&r.table_name==='creative_voice_operations')).toMatchObject({can_read:true,can_insert:true,can_update:true,can_delete:false});
  for(const table of ['creative_settings','creative_budgets','creative_provider_operations'])expect(rows.find(r=>r.role_name==='commerce_automation'&&r.table_name===table)).toMatchObject({can_read:true,can_insert:true,can_update:true,can_delete:false});
  for(const row of rows.filter(r=>['commerce_channel','commerce_ingress'].includes(r.role_name)))expect(row).toMatchObject({can_read:false,can_insert:false,can_update:false,can_delete:false});
  for(const table of ['intelligence_opportunities','creative_voice_operations'])expect(rows.find(r=>r.role_name==='commerce_automation'&&r.table_name===table)).toMatchObject({can_read:false,can_insert:false,can_update:false,can_delete:false});
  await expect(withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_automation');await c.query('SELECT password FROM account');})).rejects.toThrow('permission denied');
  await expect(withTransaction(async c=>{await c.query('SET LOCAL ROLE commerce_api');await c.query('DELETE FROM intelligence_observations');})).rejects.toThrow('permission denied');
 });
});
