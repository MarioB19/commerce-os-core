import {describe,expect,it} from 'vitest';
import {currentSpec,renderReference,referenceDrift,operations} from '../../scripts/api-reference.js';
import {mcpRegistry} from '../../packages/contracts/src/mcp-registry.js';

// V7 RF-16.b (DOC-SYNC): the committed reference equals what the code serves.
describe('generated API/MCP reference',()=>{
 it('matches the committed docs/reference files exactly',async()=>{
  const spec=await currentSpec();
  expect(await referenceDrift(renderReference(spec))).toEqual([]);
  expect(operations(spec)).toHaveLength(180);
 },60_000);
 it('fails on an intentionally broken contract in a fixture (route, schema or MCP action)',async()=>{
  const spec=await currentSpec();
  const extraRoute=structuredClone(spec);extraRoute.paths['/v2/fixture-drift']={get:{responses:{200:{description:'fixture'}}}};
  expect(await referenceDrift(renderReference(extraRoute))).toEqual(['docs/reference/openapi-v7.json','docs/reference/api-mcp-v7.md']);
  const schema=structuredClone(spec);const first=Object.values(schema.paths as Record<string,Record<string,any>>)[0]!;Object.values(first)[0].deprecated=true;
  expect(await referenceDrift(renderReference(schema))).toContain('docs/reference/openapi-v7.json');
  const registry=mcpRegistry.map((t,i)=>i===0?{...t,actions:[...t.actions,'fixture_drift']}:t);
  expect(await referenceDrift(renderReference(spec,registry))).toEqual(['docs/reference/mcp-v7.json','docs/reference/api-mcp-v7.md']);
 },60_000);
});
