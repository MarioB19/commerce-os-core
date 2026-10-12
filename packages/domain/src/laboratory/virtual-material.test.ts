import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {numberLabVirtualMaterial as make,numberLabVirtualMaterialHash as hash,numberLabVirtualMaterialPath as path,labVirtualMaterialSchema} from './virtual-material.js';
const fixture=()=>({run_id:randomUUID(),snapshot_sha256:'a'.repeat(64),variant_id:randomUUID(),id:randomUUID(),kind:'link' as const,source:{id:randomUUID(),revision:1,sha256:'b'.repeat(64)}});
describe('closed virtual material descriptor without external authority',()=>{
 it.each(['link','access'] as const)('preserves %s identity with no REAL URL or credential',kind=>{const f=fixture(),d=make({...f,kind});expect(d).toEqual({...f,kind,schema_version:1,delivery:'LAB_ONLY'});expect(Object.isFrozen(d)&&Object.isFrozen(d.source)).toBe(true);expect(path(d)).toBe('/number-laboratory/'+f.run_id+'/materials/'+f.id);expect(JSON.stringify(d)).not.toContain('https:');});
 it('pins every identity and source field in the digest',()=>{const f=fixture(),d=make(f);for(const patch of [{run_id:randomUUID()},{variant_id:randomUUID()},{id:randomUUID()},{kind:'access' as const},{snapshot_sha256:'c'.repeat(64)},{source:{...f.source,revision:2}},{source:{...f.source,sha256:'d'.repeat(64)}}])expect(hash(make({...f,...patch}))).not.toBe(hash(d));});
 it.each(['url','code','token','provider','root','delivery_reference'])('rejects external %s rather than stripping it',field=>{expect(()=>make({...fixture(),[field]:'forbidden'} as any)).toThrow();});
 it('rejects invented delivery authority, paths and unsupported kinds',()=>{const d=make(fixture());for(const patch of [{delivery:'REAL'},{run_id:'../source'},{kind:'file'},{source:{...d.source,credential:'forbidden'}},{schema_version:2}])expect(()=>labVirtualMaterialSchema.parse({...d,...patch})).toThrow();});
});
