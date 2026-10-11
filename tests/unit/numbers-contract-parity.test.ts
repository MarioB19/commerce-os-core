import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {documentNumbersApi} from '../../apps/api/src/openapi-numbers.js';
import {numberTools} from '../../apps/commerce-mcp/src/numbers.js';
import {numberFlowTestResetSchema,numberFlowTestStartSchema,programCreateSchema,programDraftSchema} from '../../packages/contracts/src/numbers.js';
import {serviceScopes} from '../../packages/contracts/src/index.js';

const program=(policy_version:string,mode:'standard'|'inbound-light'='standard')=>({
 name:'Programa contractual',topology:'direct' as const,account_ids:[randomUUID(),randomUUID()],content_ids:[],
 profile:{name:'Perfil contractual',policy_version,mode,timezone:'UTC'},expires_at:'2035-01-31T00:00:00.000Z',
});

describe('number API, MCP and OpenAPI parity',()=>{
 it('accepts only standard-15d/v2 when creating while retaining historical edit parsing',()=>{
  const current=program('standard-15d/v2'),historical=program('standard-15d/v1'),legacy=program('legacy-30d/v1','inbound-light');
  expect(programCreateSchema.safeParse(current).success).toBe(true);
  expect(programCreateSchema.safeParse(historical).success).toBe(false);
  expect(programCreateSchema.safeParse(legacy).success).toBe(false);
  expect(programDraftSchema.safeParse(historical).success).toBe(true);
  expect(programDraftSchema.safeParse(legacy).success).toBe(true);
 expect(numberTools.number_program_create.schema.body.safeParse(historical).success).toBe(false);
 });

 it('shares the complete refined EMPTY and reset bodies across MCP and OpenAPI',()=>{
  expect(numberTools.number_flow_test_start.schema.body).toBe(numberFlowTestStartSchema);
  expect(numberTools.number_flow_test_reset.schema.body).toBe(numberFlowTestResetSchema);
  for(const schema of [numberTools.number_flow_test_start.schema.body,numberTools.number_flow_test_reset.schema.body]){
   expect(schema.safeParse({initial_message:'No debe sembrarse implícitamente'}).success).toBe(false);
   expect(schema.safeParse({start_mode:'SEEDED',initial_message:'Inicio explícito'}).success).toBe(true);
  }
  const spec:any={components:{schemas:{}},paths:{
   '/v1/channel-accounts/{id}/flow-tests':{post:{parameters:[],responses:{}}},
   '/v1/number-flow-tests/{id}/reset':{post:{parameters:[],responses:{}}},
  }};
  documentNumbersApi(spec);
  for(const path of ['/v1/channel-accounts/{id}/flow-tests','/v1/number-flow-tests/{id}/reset']){
   const operation=spec.paths[path].post,schema=operation.requestBody.content['application/json'].schema;
   expect(operation['x-mcp-tool']).toMatch(/^number_flow_test_(start|reset)$/);
   expect(schema.properties.start_mode).toMatchObject({enum:['EMPTY','SEEDED'],default:'EMPTY'});
   expect(schema.properties.initial_message).toMatchObject({type:'string',minLength:1,maxLength:4096});
   expect(schema.properties).not.toHaveProperty('account_id');
   expect(schema.properties).not.toHaveProperty('test_id');
  }
 });

 it('publishes only real service scopes and maps every action to the API permission',()=>{
  const spec:any={components:{schemas:{}},paths:{
   '/v1/number-programs':{post:{parameters:[],responses:{}}},
   '/v1/number-programs/{id}/commands':{post:{parameters:[],responses:{}}},
   '/v1/number-capacity':{post:{parameters:[],responses:{}}},
  }};
  documentNumbersApi(spec);
  const create=spec.paths['/v1/number-programs'].post;
  const profile=create.requestBody.content['application/json'].schema.properties.profile;
  expect(profile.properties.policy_version.enum).toEqual(['standard-15d/v2']);
  expect(profile.properties.mode.enum).toEqual(['standard']);

  const programCommand=spec.paths['/v1/number-programs/{id}/commands'].post;
  expect(programCommand['x-required-service-scopes']).toEqual([]);
  expect(programCommand['x-required-service-scopes-by-action']).toEqual({
   review:['warmup:manage'],authorize:['warmup:activate'],activate:['warmup:activate'],pause:['warmup:manage'],resume:['warmup:activate'],cancel:['warmup:manage'],archive:['warmup:manage'],restore:['warmup:manage'],revoke:['warmup:manage'],
  });
  const capacityCommand=spec.paths['/v1/number-capacity'].post;
  expect(capacityCommand['x-required-service-scopes']).toEqual([]);
  expect(capacityCommand['x-required-service-scopes-by-action']).toEqual({preview:['channels:read'],prepare:['channels:capacity'],expand:['channels:capacity'],drain:['channels:capacity'],provision_existing:['channels:capacity'],release:['channels:capacity']});
  const serialized=JSON.stringify(spec);
  expect(serialized).not.toContain('warmup:manage or warmup:activate');
  expect(serialized).not.toContain('channels:read (preview) or channels:capacity');
  for(const operation of [programCommand,capacityCommand])for(const scopes of Object.values(operation['x-required-service-scopes-by-action']) as string[][])for(const scope of scopes)expect(serviceScopes).toContain(scope);
 });
});
