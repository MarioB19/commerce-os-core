import pg from 'pg';
import {performance} from 'node:perf_hooks';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

type Trace={sql:string;values:unknown[];duration_ms:number};
type Sample={duration_ms:number;query_count:number;write_like_queries:number};

const integer=(name:string,fallback:number)=>{
 const value=Number(process.env[name]??fallback);
 if(!Number.isInteger(value)||value<1)throw new Error(`${name}_MUST_BE_POSITIVE_INTEGER`);
 return value;
};
const percentile=(values:number[],fraction:number)=>{
 const sorted=[...values].sort((a,b)=>a-b);
 return sorted[Math.max(0,Math.ceil(sorted.length*fraction)-1)]!;
};
const summary=(samples:Sample[])=>{
 const durations=samples.map(sample=>sample.duration_ms),queries=samples.map(sample=>sample.query_count);
 return{
  iterations:samples.length,
  latency_ms:{
   min:Number(Math.min(...durations).toFixed(3)),
   median:Number(percentile(durations,0.5).toFixed(3)),
   p95:Number(percentile(durations,0.95).toFixed(3)),
   max:Number(Math.max(...durations).toFixed(3)),
   mean:Number((durations.reduce((sum,value)=>sum+value,0)/durations.length).toFixed(3)),
  },
  query_count:{min:Math.min(...queries),median:percentile(queries,0.5),max:Math.max(...queries)},
  write_like_queries:samples.reduce((sum,sample)=>sum+sample.write_like_queries,0),
  samples,
 };
};
const normalizedSql=(sql:string)=>sql.replace(/^\s*(?:\/\*[\s\S]*?\*\/\s*)*/,'').trimStart().toUpperCase();
const readOnly=(sql:string)=>/^(SELECT|WITH|SHOW|EXPLAIN)\b/.test(normalizedSql(sql));
const planNodes=(node:Record<string,unknown>):Record<string,unknown>[]=>[node,...((node.Plans as Record<string,unknown>[]|undefined)??[]).flatMap(planNodes)];

const envPath=join(process.env.COMMERCE_CONFIG_DIR??join(homedir(),'.config','commerce-os-local'),'runtime.env');
for(const line of readFileSync(envPath,'utf8').split('\n')){
 if(!line||line.startsWith('#'))continue;
 const separator=line.indexOf('=');if(separator<1)continue;
 process.env[line.slice(0,separator)]??=line.slice(separator+1);
}
const baseUrl=new URL(process.env.DATABASE_URL!);
const database=`commerce_numbers_benchmark_${Date.now()}_${randomUUID().slice(0,8)}`;
const admin=new pg.Client({connectionString:baseUrl.toString()});
await admin.connect();
await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
const benchmarkUrl=new URL(baseUrl.toString());benchmarkUrl.pathname=`/${database}`;
process.env.DATABASE_URL=benchmarkUrl.toString();
process.env.LOG_LEVEL='silent';
process.env.NODE_ENV='test';

let application:Awaited<ReturnType<(typeof import('../apps/api/src/app.js'))['createApp']>>|undefined;
let benchmarkPool:(typeof import('../packages/db/src/index.js'))['pool']|undefined;
try{
 const {migrate}=await import('../packages/db/src/migrate.js');
 const originalLog=console.log;console.log=()=>{};
 try{await migrate();}finally{console.log=originalLog;}
 const [{createApp},{provisionUser},{pool}]=await Promise.all([
  import('../apps/api/src/app.js'),
  import('../apps/api/src/auth.js'),
  import('../packages/db/src/index.js'),
 ]);
 benchmarkPool=pool;
 application=await createApp();
 const workspace=`numbers-benchmark-${randomUUID()}`,origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
 const email=`${randomUUID()}@example.invalid`,password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Numbers benchmark',email,password,workspace_id:workspace,role:'owner'});
 const login=await application.inject({method:'POST',url:'/api/auth/sign-in/email',payload:{email,password},headers:{origin}});
 if(login.statusCode!==200)throw new Error(`BENCHMARK_LOGIN_FAILED:${login.statusCode}`);
 const cookie=[login.headers['set-cookie']].flat().filter(Boolean).map(value=>String(value).split(';')[0]).join('; ');
 const accountIds=Array.from({length:20},()=>randomUUID()),bindingIds=Array.from({length:20},()=>randomUUID()),productId=randomUUID();
 await pool.query("INSERT INTO records(id,workspace_id,environment,kind,body) VALUES($1,$2,'SIMULATION','product',$3)",[productId,workspace,{name:'Benchmark product',status:'PUBLISHED'}]);
 await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body)
  SELECT account_id,$1,'SIMULATION','channel_account',jsonb_build_object(
   'name','Benchmark batch '||lpad((position-1)::text,2,'0'),'responsible','Operador interno',
   'device_ref','Benchmark device '||position,'provider','simulator','session','default',
   'status','NEW','sending_enabled',false,'identity_verified',false
  ) FROM unnest($2::uuid[]) WITH ORDINALITY seeded(account_id,position)`,[workspace,accountIds]);
 await pool.query(`INSERT INTO records(id,workspace_id,environment,kind,body)
  SELECT binding_id,$1,'SIMULATION','binding',jsonb_build_object(
   'account_id',account_id::text,'product_id',$4::text,'valid_from','2026-01-01T00:00:00.000Z',
   'source','numbers-list-benchmark','evidence','Isolated synthetic assignment','confidence','confirmed'
  ) FROM unnest($2::uuid[],$3::uuid[]) seeded(account_id,binding_id)`,[workspace,accountIds,bindingIds,productId]);
 await pool.query(`INSERT INTO commercial_assignments(workspace_id,environment,account_id,product_id,binding_id)
  SELECT $1,'SIMULATION',account_id,$4,binding_id FROM unnest($2::uuid[],$3::uuid[]) seeded(account_id,binding_id)`,[workspace,accountIds,bindingIds,productId]);
 const healthHistoryPerDimension=integer('BENCHMARK_HEALTH_HISTORY',200),healthDimensions=['infrastructure','session','transport','restriction','quality','ownership'];
 await pool.query(`WITH generated AS(
  SELECT account_id,dimension,sequence,
   clock_timestamp()-(($3-sequence)::text||' minutes')::interval observed_at
  FROM unnest($2::uuid[]) account_id
  CROSS JOIN unnest($4::text[]) dimension
  CROSS JOIN generate_series(1,$3) sequence
 )
 INSERT INTO records(workspace_id,environment,kind,body,created_at)
 SELECT $1,'SIMULATION','health_signal',jsonb_build_object(
  'account_id',account_id::text,'dimension',dimension,'scope','account','source','provider_read',
  'status',CASE WHEN sequence=$3 THEN 'OK' WHEN sequence%29=0 THEN 'BLOCKED' WHEN sequence%17=0 THEN 'UNKNOWN' ELSE 'OK' END,
  'availability',CASE WHEN dimension='quality' THEN 'observed' ELSE 'available' END,
  'value',CASE WHEN dimension='restriction' AND sequence=$3 THEN jsonb_build_object('latest_read',jsonb_build_object('timelock',true,'capping',true)) ELSE jsonb_build_object('sample',sequence) END,
  'observed_at',observed_at,'expires_at',observed_at+CASE WHEN sequence=$3 THEN interval '10 minutes' ELSE interval '30 seconds' END
 ),observed_at FROM generated`,[workspace,accountIds,healthHistoryPerDimension,healthDimensions]);

 const applicationFingerprint=async()=>{
  const [records,outbox,commands,events,assignments]=await Promise.all([
   pool.query('SELECT count(*)::int count,max(updated_at) updated_at FROM records WHERE workspace_id=$1',[workspace]),
   pool.query('SELECT count(*)::int count,max(updated_at) updated_at FROM outbox WHERE workspace_id=$1',[workspace]),
   pool.query('SELECT count(*)::int count,max(updated_at) updated_at FROM commands WHERE workspace_id=$1',[workspace]),
   pool.query('SELECT count(*)::int count,max(occurred_at) occurred_at FROM domain_events WHERE workspace_id=$1',[workspace]),
   pool.query('SELECT count(*)::int count,max(updated_at) updated_at FROM commercial_assignments WHERE workspace_id=$1',[workspace]),
  ]);
  return JSON.stringify({records:records.rows[0],outbox:outbox.rows[0],commands:commands.rows[0],events:events.rows[0],assignments:assignments.rows[0]});
 };
 const beforeFingerprint=await applicationFingerprint();
 let representativeHealthTrace:Trace|undefined;
 const execute=async(path:string,expected:number):Promise<Sample>=>{
  const traces:Trace[]=[],originalQuery=pool.query.bind(pool);
  (pool as any).query=async(...args:any[])=>{
   const config=args[0],sql=typeof config==='string'?config:String(config?.text??''),values=(Array.isArray(args[1])?args[1]:config?.values??[]) as unknown[],started=performance.now();
   try{return await (originalQuery as any)(...args);}finally{const trace={sql,values,duration_ms:performance.now()-started};traces.push(trace);if(!representativeHealthTrace&&sql.includes("kind='health_signal'"))representativeHealthTrace=trace;}
  };
  const started=performance.now();let response;
  try{response=await application!.inject({method:'GET',url:path,headers:{origin,cookie}});}
  finally{(pool as any).query=originalQuery;}
  const duration=performance.now()-started;
  if(response.statusCode!==200)throw new Error(`BENCHMARK_REQUEST_FAILED:${response.statusCode}:${response.body}`);
  const body=response.json();
  if(!Array.isArray(body.data)||body.data.length!==expected)throw new Error(`BENCHMARK_RESPONSE_INVALID:${body.data?.length}`);
  return{duration_ms:Number(duration.toFixed(3)),query_count:traces.length,write_like_queries:traces.filter(trace=>!readOnly(trace.sql)).length};
 };
 const iterations=integer('BENCHMARK_ITERATIONS',12),warmups=integer('BENCHMARK_WARMUPS',3);
 const scenarios=[
  {name:'page_3_of_20',path:'/v1/numbers?environment=SIMULATION&q=Benchmark%20batch&limit=3',expected:3},
  {name:'full_20',path:'/v1/numbers?environment=SIMULATION&q=Benchmark%20batch&limit=20',expected:20},
 ];
 const results:Record<string,ReturnType<typeof summary>>={};
 for(const scenario of scenarios){
  for(let index=0;index<warmups;index++)await execute(scenario.path,scenario.expected);
  const samples=[];for(let index=0;index<iterations;index++)samples.push(await execute(scenario.path,scenario.expected));
  results[scenario.name]=summary(samples);
 }
 const afterFingerprint=await applicationFingerprint();
 if(afterFingerprint!==beforeFingerprint)throw new Error('GET_NUMBERS_MUTATED_APPLICATION_STATE');
 if(!representativeHealthTrace)throw new Error('HEALTH_QUERY_NOT_OBSERVED');
 const explained=(await pool.query({text:`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${representativeHealthTrace.sql}`,values:representativeHealthTrace.values})).rows[0]['QUERY PLAN'][0] as Record<string,unknown>;
 const rootPlan=explained.Plan as Record<string,unknown>,nodes=planNodes(rootPlan);
 const healthQueryPlan={
  query_sha256:createHash('sha256').update(representativeHealthTrace.sql).digest('hex'),
  planning_time_ms:explained['Planning Time'],execution_time_ms:explained['Execution Time'],
  root_node:rootPlan['Node Type'],actual_rows:rootPlan['Actual Rows'],shared_hit_blocks:rootPlan['Shared Hit Blocks'],shared_read_blocks:rootPlan['Shared Read Blocks'],
  node_types:[...new Set(nodes.map(node=>String(node['Node Type'])))],
  indexes:[...new Set(nodes.map(node=>node['Index Name']).filter((value):value is string=>typeof value==='string'))],
 };
 const output={
  benchmark:'GET /v1/numbers',
  revision:process.env.BENCHMARK_REVISION??'unspecified',
  sha:process.env.BENCHMARK_SHA??'unspecified',
  measured_at:new Date().toISOString(),
  runtime:{node:process.version,postgres:String((await pool.query('SHOW server_version')).rows[0].server_version)},
  fixture:{environment:'SIMULATION',channel_accounts:20,canonical_assignments:20,published_products:1,health_dimensions:healthDimensions.length,health_history_per_account_dimension:healthHistoryPerDimension,health_signals:accountIds.length*healthDimensions.length*healthHistoryPerDimension,provider_calls:0,external_effects:false},
  method:{warmups,iterations,transport:'Fastify inject',database:'fresh isolated PostgreSQL database per revision',order:'page_3_of_20 then full_20'},
  results,health_query_plan:healthQueryPlan,
  application_state_unchanged:true,
  limitations:['Local single-process latency is directional, not a production SLA.','The fixture intentionally omits live provider sessions and performs no network/provider calls.'],
 };
 console.log(`NUMBERS_BENCHMARK_RESULT=${JSON.stringify(output)}`);
}finally{
 if(application)await application.close();
 if(benchmarkPool)await benchmarkPool.end();
 await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()',[database]);
 await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
 await admin.end();
}
