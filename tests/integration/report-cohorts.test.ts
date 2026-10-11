import {describe,it,expect,beforeAll,afterAll} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool,putRecord} from '../../packages/db/src/index.js';
import {summary,visibleReportCut} from '../../apps/api/src/reports.js';

const workspace='reports-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string;
beforeAll(async()=>{
 app=await createApp();
 const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
 await provisionUser({name:'Synthetic analyst',email,password,workspace_id:workspace,role:'analyst'});
 const login=await app.inject({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.73',headers:{origin},payload:{email,password}});
 expect(login.statusCode).toBe(200);cookie=login.cookies.map(value=>`${value.name}=${value.value}`).join('; ');
});
afterAll(async()=>{await app.close();await pool.end();});

describe('Evidence-linked report cohort boundaries and currencies',()=>{
 it('keeps the cohort boundary, human labels, sample coverage and exact visible export grouping',async()=>{
  const base={workspaceId:workspace,environment:'SIMULATION' as const};
  const product=await putRecord(pool,{...base,kind:'product',body:{name:'Producto de muestra'}});
  const accountA=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Número Norte'}}),accountB=await putRecord(pool,{...base,kind:'channel_account',body:{name:'Número Sur'}});
  const offers=await Promise.all(['Oferta Inicial','Oferta Avanzada'].map(name=>putRecord(pool,{...base,kind:'offer',body:{name,product_id:product.id}})));
  const agents=await Promise.all(['Agente Uno','Agente Dos'].map(name=>putRecord(pool,{...base,kind:'agent',body:{name,product_id:product.id}})));
  const records=[];
  for(const [index,currency,account,started,source,classification]of [[0,'MXN',accountA,'2026-01-01T00:00:00.000Z','observed-source','observed'],[1,'USD',accountB,'2026-01-02T00:00:00.000Z','inferred-source','inferred'],[2,'MXN',accountA,'2026-02-01T00:00:00.000Z','unknown','unknown']] as const){
   const offer=offers[index%2]!,agent=agents[index%2]!,contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Synthetic '+index}});
   const conversation=await putRecord(pool,{...base,kind:'conversation',body:{contact_id:contact.id,account_id:account.id,product_id:product.id,offer_version_id:offer.id,agent_version_id:agent.id,started_at:started,origin:{source,classification}}});
   const order=await putRecord(pool,{...base,kind:'order',body:{conversation_id:conversation.id,account_id:account.id,product_id:product.id,offer_version_id:offer.id,agent_version_id:agent.id,currency,sale_currency:currency,sale_amount_minor:1000*(index+1),status:'RECEIPT_APPROVED',sale_status:'RECOGNIZED',sale_definition:'receipt_sales_v1',committed_at:started,origin:{source,classification}}});
   const touch=await putRecord(pool,{...base,kind:'touchpoint',body:{conversation_id:conversation.id,classification,source,evidence_ref:'synthetic-'+index}});
   records.push({contact,conversation,order,touch});
  }

  const filters={from:'2026-01-01T00:00:00.000Z',to:'2026-02-01T00:00:00.000Z',group_by:'account_id' as const};
  const mixed=await summary(workspace,'SIMULATION',filters);
  expect(mixed.cohort).toMatchObject({size:2,from:filters.from,to_exclusive:filters.to});
  expect(mixed.counts).toMatchObject({conversations:2,reconciled:2});
  expect(mixed.revenue_state).toBe('NOT_COMPARABLE');
  expect(mixed.currency).toBeNull();
  expect(mixed.revenue_minor).toBeNull();
  expect(mixed.revenue_by_currency).toEqual([{currency:'MXN',revenue_minor:1000},{currency:'USD',revenue_minor:2000}]);
  expect(mixed.attribution).toMatchObject({observed:1,inferred:1,unknown:0,observed_coverage:0.5,evidence_coverage:1});
  expect(mixed.by_offer.map(row=>row.label)).toEqual(['Oferta Avanzada','Oferta Inicial']);
  expect(mixed.by_account.map(row=>row.label).sort()).toEqual(['Número Norte','Número Sur']);
  expect(mixed.by_agent.map(row=>row.label)).toEqual(['Agente Dos','Agente Uno']);
  expect(mixed.by_source.map(row=>row.label).sort()).toEqual(['Origen inferido','Origen observado']);
  expect(mixed.by_account.every(row=>row.sample_size===1&&row.attribution.evidence_coverage===1)).toBe(true);
  expect(mixed.evidence.order_ids).toContain(records[0]!.order.id);
  expect(mixed.evidence.order_ids).not.toContain(records[2]!.order.id);
  expect(visibleReportCut(mixed,'account_id').rows).toEqual(mixed.segments);

  const filtered=await summary(workspace,'SIMULATION',{account_id:accountA.id,source:'observed-source'});
  expect(filtered.counts.conversations).toBe(1);
  expect(filtered.revenue_state).toBe('VERIFIED');
  expect(filtered.revenue_minor).toBe(1000);
  expect(filtered.conversion_rate).toBe(1);

  const real=await summary(workspace,'REAL');
  expect(real.counts.orders).toBe(0);
  expect(real.revenue_state).toBe('ZERO');
  expect(real.revenue_minor).toBe(0);

  const query='environment=SIMULATION&from='+encodeURIComponent(filters.from)+'&to='+encodeURIComponent(filters.to);
  const legacy=await app.inject({method:'GET',url:'/v1/reports/export?'+query,headers:{cookie,origin}});
  expect(legacy.statusCode,legacy.body).toBe(200);
  expect(legacy.headers['content-disposition']).toContain('commerce-sales.json');
  expect(legacy.json()).toMatchObject({meta:{schema_version:1,cohort_basis:'conversation.started_at'}});
  expect(legacy.json().data.map((row:{conversation_id:string})=>row.conversation_id).sort()).toEqual([records[0]!.conversation.id,records[1]!.conversation.id].sort());
  expect(legacy.json().data[0]).not.toHaveProperty('group_by');

  const grouped=await app.inject({method:'GET',url:'/v1/reports/export?'+query+'&group_by=account_id',headers:{cookie,origin}});
  expect(grouped.statusCode,grouped.body).toBe(200);
  expect(grouped.json().meta).toMatchObject({schema_version:2,group_by:'account_id',cohort:{size:2,from:filters.from,to_exclusive:filters.to}});
  expect(grouped.json().data.every((row:{group_by:string})=>row.group_by==='account_id')).toBe(true);
  expect(grouped.json().data.map((row:{label:string})=>row.label).sort()).toEqual(['Número Norte','Número Sur']);

  const legacyCsv=await app.inject({method:'GET',url:'/v1/reports/export?'+query+'&format=csv',headers:{cookie,origin}});
  expect(legacyCsv.statusCode,legacyCsv.body).toBe(200);
  expect(legacyCsv.body.split('\n')[0]).toBe('id,environment,product_id,offer_version_id,account_id,conversation_id,stage,financial_status,declared_amount_minor,reconciled_amount_minor,sale_amount_minor,sale_definition,currency,source,source_classification,evidence_asset_id,created_at');
  const groupedCsv=await app.inject({method:'GET',url:'/v1/reports/export?'+query+'&format=csv&group_by=account_id',headers:{cookie,origin}});
  expect(groupedCsv.statusCode,groupedCsv.body).toBe(200);
  expect(groupedCsv.body.split('\n')[0]).toContain('group_by,key,label,conversations');

  const spec=(await app.inject({method:'GET',url:'/v1/openapi.json',headers:{cookie,origin}})).json();
  const operation=spec.paths['/v1/reports/export'].get;
  expect(operation.parameters.find((parameter:{name:string})=>parameter.name==='group_by').description).toContain('schema_version 2');
  expect(operation.responses[200].content['application/json'].schema.oneOf).toHaveLength(2);
  expect(operation.responses[200].content['text/csv'].schema).toEqual({type:'string'});
 });

 it('derives distinct human offer labels from the associated product instead of UUIDs',async()=>{
  const base={workspaceId:workspace,environment:'SIMULATION' as const};
  const product=await putRecord(pool,{...base,kind:'product',body:{name:'Curso claridad'}});
  const offers=await Promise.all([0,1].map(()=>putRecord(pool,{...base,kind:'offer',body:{product_id:product.id}})));
  for(const [index,offer] of offers.entries()){
   const contact=await putRecord(pool,{...base,kind:'contact',body:{name:'Contacto '+index}});
   await putRecord(pool,{...base,kind:'conversation',body:{contact_id:contact.id,product_id:product.id,offer_version_id:offer.id,started_at:`2026-03-0${index+1}T00:00:00.000Z`}});
  }
  const report=await summary(workspace,'SIMULATION',{product_id:product.id});
  expect(report.by_offer.map(row=>row.label).sort()).toEqual(['Oferta de Curso claridad · versión 1','Oferta de Curso claridad · versión 2']);
  expect(report.by_offer.every(row=>!row.label.includes(row.id))).toBe(true);
 });
});
