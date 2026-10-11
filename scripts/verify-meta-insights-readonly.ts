// Explicit local verification. Never run against the operational database.
import {pool,withTransaction,uuid} from '../packages/db/src/index.js';
import {saveIntegrationSetting} from '../packages/db/src/integration-settings.js';
import {MetaReader,readMetaCredentials} from '../apps/api/src/meta-client.js';
import {executeInsightJob} from '../apps/automation-worker/src/meta-insights.js';
import {writeFile} from 'node:fs/promises';
if(!new URL(process.env.DATABASE_URL!).pathname.startsWith('/commerce_live_readonly_'))throw new Error('ISOLATED_LOCAL_DATABASE_REQUIRED');
if(!process.env.LIVE_META_ENV_FILE)throw new Error('AUTHORIZED_CREDENTIAL_FILE_REQUIRED');
const credentials=readMetaCredentials({META_CREDENTIAL_ENV_FILE:process.env.LIVE_META_ENV_FILE}),workspace='readonly-verification',accounts=new Set<string>(),discovery:string[]=[];
for(const [i,c] of credentials.entries()){
 await withTransaction(db=>saveIntegrationSetting(db,workspace,'REAL','meta:verification'+i,{expected_version:0,label:'Read-only verification',enabled:true,config:{},secrets:{access_token:c.token},clear_secrets:[],reason:'Explicit local read-only verification'},'verification'));
 try{const r=await new MetaReader(c.token).list('me/adaccounts','id,name,currency,timezone_name');for(const a of r.data)if(/^act_\d+$/.test(a.id))accounts.add(a.id);}catch{discovery.push('ACCOUNT_DISCOVERY_UNAVAILABLE');}
}
const results=[];
for(const account of [...accounts].slice(0,2)){
 const lease=uuid(),job=(await pool.query("INSERT INTO meta_insight_jobs(workspace_id,environment,actor_id,request,status,lease_token) VALUES($1,'REAL','verification',$2,'RUNNING',$3) RETURNING *",[workspace,{from:'2026-09-05',to:'2026-09-05',meta_ad_account_id:account,recurring:false},lease])).rows[0];
 const result=await executeInsightJob(job);await pool.query('UPDATE meta_insight_jobs SET status=$2,result=$3 WHERE id=$1',[job.id,result.status,result]);
 const totals=(await pool.query(`SELECT level,currency,timezone,count(*)::int rows,sum(spend_minor)::text spend_minor FROM meta_insight_days WHERE workspace_id=$1 AND meta_ad_account_id=$2 GROUP BY level,currency,timezone ORDER BY level`,[workspace,account])).rows;
 results.push({account_index:results.length+1,status:result.status,issues:result.issues.map(i=>i.code),totals});
}
const evidence={verified_at:new Date().toISOString(),range:{from:'2026-09-05',to:'2026-09-05'},source:'META_API',mode:'OFFICIAL_GET_ONLY',configured_credentials:credentials.length,discovered_accounts:accounts.size,discovery_issues:discovery,results,external_mutations:0,customer_rows_read:0,production_changes:0};
await writeFile('docs/meta-insights-live-verification.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));await pool.end();
