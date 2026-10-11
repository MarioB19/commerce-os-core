import {explicitFixtureEnvironment} from './explicit-fixture-environment.js';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {createApp} from '../../apps/api/src/app.js';
import {provisionUser} from '../../apps/api/src/auth.js';
import {pool} from '../../packages/db/src/index.js';
import {preschoolWorkflow} from '../../packages/domain/src/sales/preschool.js';

const workspace='preschool-catalog-'+randomUUID();
const origin=(process.env.TRUSTED_ORIGINS??'http://localhost:5173').split(',')[0]!;
let app:FastifyInstance,cookie:string;
beforeAll(async()=>{
  app=await createApp();
  const email=randomUUID()+'@example.invalid',password=randomBytes(24).toString('base64url');
  await provisionUser({name:'Synthetic preschool operator',email,password,workspace_id:workspace,role:'owner'});
  const login=await app.inject(explicitFixtureEnvironment({method:'POST',url:'/api/auth/sign-in/email',remoteAddress:'192.0.2.38',payload:{email,password},headers:{origin}}));
  expect(login.statusCode).toBe(200);
  cookie=(Array.isArray(login.headers['set-cookie'])?login.headers['set-cookie']:[login.headers['set-cookie']]).filter(Boolean).map(x=>String(x).split(';')[0]).join('; ');
});
afterAll(async()=>{await app.close();await pool.end();});
async function api(path:string,body:Record<string,unknown>,key:string,method:'POST'|'PUT'|'PATCH'='POST'){
  const response=await app.inject(explicitFixtureEnvironment({method,url:'/v1'+path,headers:{cookie,origin,'idempotency-key':'preschool-test:'+key},payload:{...body,environment:'REAL'}}));
  expect(response.statusCode,`${method} ${path}: ${response.statusCode}`).toBeLessThan(300);
  return response.json().data;
}
async function prepareCatalog(){
  const ids:Record<string,string>={};
  for(const name of ['pitch','agreement','collection','calendar']){
    const bytes=Buffer.from(name==='calendar'?'%PDF-1.7\nSynthetic test material\n':'ID3Synthetic audio fixture');
    const asset=await api('/assets',{name:'Synthetic '+name,kind:'file',adapter:'private_file',mime_type:name==='calendar'?'application/pdf':'audio/mpeg',size_bytes:bytes.length},'asset:'+name);
    ids[name]=asset.id;
    await api(`/assets/${asset.id}/content`,{base64:bytes.toString('base64')},'upload:'+name,'PUT');
    await api(`/assets/${asset.id}/complete`,{},'complete:'+name);
  }
  for(const tier of ['core','kit']){
    const asset=await api('/assets',{name:'Synthetic portal '+tier,kind:'access',adapter:'link',delivery_reference:JSON.stringify({url:'https://example.com/synthetic-preschool',code:'synthetic-access-'+tier,instructions:'Synthetic test only'})},'access:'+tier);
    expect(JSON.stringify(asset)).not.toContain('synthetic-access-');ids[tier]=asset.id;
  }
  const bank=await api('/bank-profiles',{name:'Synthetic preschool bank',bank:'Synthetic bank',holder:'Synthetic operator',account_number:'000000000000000000',currency:'MXN',instructions:'Synthetic test only'},'bank');
  const policy=await api('/receipt-policies',{name:'Synthetic preschool review',allow_amount_mismatch:true,allow_pending:false,require_currency:true,require_destination:true,min_amount_minor:1,auto_approve:false},'policy');
  const product=await api('/products',{name:'Synthetic preschool',slug:'synthetic-preschool',description:'Synthetic import validation',asset_ids:Object.values(ids)},'product');
  const flow=await api('/workflows',{...preschoolWorkflow({pitch:ids.pitch!,agreement:ids.agreement!,collection:ids.collection!}),product_id:product.id},'workflow');
  const publishedFlow=await api(`/workflows/${flow.id}/publish`,{expected_version:1},'publish-workflow');
  const fulfillment=[{asset_id:ids.core,release_on:'commitment_accepted'},{asset_id:ids.calendar,release_on:'reconciled',min_amount_minor:1},{asset_id:ids.kit,release_on:'reconciled',min_amount_minor:10700}];
  const offer=await api(`/products/${product.id}/offers`,{name:'Synthetic agreement 97 / kit 107',currency:'MXN',base_amount_minor:9700,payment_profile_version_id:bank.id,receipt_policy_version_id:policy.id,workflow_version_id:publishedFlow.id,billing_delay_seconds:0,fulfillment},'offer');
  const publishedOffer=await api(`/offers/${offer.id}/publish`,{expected_version:1},'publish-offer');
  expect(publishedOffer).toMatchObject({status:'PUBLISHED',base_amount_minor:9700,currency:'MXN',fulfillment});
  const updated=await api(`/products/${product.id}`,{expected_version:product.version,workflow_template_version_id:publishedFlow.id},'product-defaults','PATCH');
  const publishedProduct=await api(`/products/${product.id}/transition`,{expected_version:updated.version,status:'PUBLISHED'},'publish-product');
  expect(publishedProduct.status).toBe('PUBLISHED');
  return{product:product.id,flow:publishedFlow.id,offer:publishedOffer.id,ids};
}
it('prepares and idempotently replays the real-environment preschool API sequence without activating or sending',async()=>{
  const first=await prepareCatalog();
  expect(await prepareCatalog()).toEqual(first);
  const counts=(await pool.query(`SELECT kind,count(*)::int AS count FROM records WHERE workspace_id=$1 GROUP BY kind`,[workspace])).rows;
  expect(Object.fromEntries(counts.map(row=>[row.kind,row.count]))).toEqual({asset:6,bank_profile:1,receipt_policy:1,product:1,workflow:2,offer:2});
  expect((await pool.query('SELECT count(*)::int AS count FROM outbox WHERE workspace_id=$1',[workspace])).rows[0].count).toBe(0);
  expect((await pool.query('SELECT count(*)::int AS count FROM operation_authorizations WHERE workspace_id=$1',[workspace])).rows[0].count).toBe(0);
  expect((await pool.query("SELECT count(*)::int AS count FROM records WHERE workspace_id=$1 AND kind='asset' AND body->>'status'='READY'",[workspace])).rows[0].count).toBe(6);
});
