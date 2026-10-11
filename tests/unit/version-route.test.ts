import Fastify from 'fastify';
import swagger from '@fastify/swagger';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {registerVersionRoute,runtimeVersion} from '../../apps/api/src/version.js';

afterEach(()=>vi.unstubAllEnvs());

describe('public core release readback',()=>{
 it('exposes only a validated release id and exact source SHA without authentication',async()=>{
  vi.stubEnv('COMMERCE_RELEASE_SHA','a'.repeat(40));
  vi.stubEnv('COMMERCE_RELEASE_ID','ci-123-1-aaaaaaaaaa');
  const app=Fastify();
  await app.register(swagger,{openapi:{info:{title:'fixture',version:'1'}}});
  registerVersionRoute(app);
  const response=await app.inject({method:'GET',url:'/api/version'});
  expect(response.statusCode).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.json()).toEqual({service:'commerce-api',release:'ci-123-1-aaaaaaaaaa',sha:'a'.repeat(40),configured:true});
  const operation=(app.swagger() as any).paths['/api/version'].get;
  expect(operation.security).toEqual([]);
 expect(operation.responses['200'].content['application/json'].schema.required).toEqual(['service','release','sha','configured']);
 await app.close();
 });

 it('is registered by the real API app and retained in its OpenAPI document',async()=>{
  vi.stubEnv('COMMERCE_RELEASE_SHA','c'.repeat(40));
  vi.stubEnv('COMMERCE_RELEASE_ID','ci-456-1-cccccccccc');
  const {createApp}=await import('../../apps/api/src/app.js');
  const app=await createApp();
  const response=await app.inject({method:'GET',url:'/api/version'});
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({service:'commerce-api',release:'ci-456-1-cccccccccc',sha:'c'.repeat(40),configured:true});
  const openapi=await app.inject({method:'GET',url:'/v1/openapi.json'});
  expect(openapi.statusCode).toBe(200);
  expect(openapi.json().paths['/api/version'].get.security).toEqual([]);
  await app.close();
 });

 it('fails closed instead of reflecting malformed environment values',()=>{
  expect(runtimeVersion({COMMERCE_RELEASE_SHA:'../private',COMMERCE_RELEASE_ID:'bad release\nsecret'})).toEqual({service:'commerce-api',release:'unavailable',sha:null,configured:false});
  expect(runtimeVersion({COMMERCE_RELEASE_SHA:'b'.repeat(40)})).toEqual({service:'commerce-api',release:'bbbbbbbbbbbb',sha:'b'.repeat(40),configured:true});
 });
});
