import {z} from 'zod';
import {labHash} from './number-lab.js';
const uuid=z.uuid(),sha=z.string().regex(/^[a-f0-9]{64}$/);
export const labVirtualMaterialSchema=z.strictObject({
 schema_version:z.literal(1),delivery:z.literal('LAB_ONLY'),run_id:uuid,snapshot_sha256:sha,variant_id:uuid,
 id:uuid,kind:z.enum(['link','access']),source:z.strictObject({id:uuid,revision:z.number().int().positive(),sha256:sha}),
});
export type LabVirtualMaterial=z.infer<typeof labVirtualMaterialSchema>;
/** This pure descriptor confers no authority. The protected source broker must
 * authenticate its complete binding before the seed role may persist it. */
export function numberLabVirtualMaterial(input:Omit<LabVirtualMaterial,'schema_version'|'delivery'>):LabVirtualMaterial{
 const descriptor=labVirtualMaterialSchema.parse({...input,schema_version:1,delivery:'LAB_ONLY'});
 Object.freeze(descriptor.source);return Object.freeze(descriptor);
}
export function numberLabVirtualMaterialHash(value:LabVirtualMaterial){return labHash(labVirtualMaterialSchema.parse(value));}
/** Internal presentation reference only. Never a source URL, portal credential,
 * remote grant or a selectable provider. The mounted UI must authorize the run. */
export function numberLabVirtualMaterialPath(value:LabVirtualMaterial){const d=labVirtualMaterialSchema.parse(value);return '/number-laboratory/'+d.run_id+'/materials/'+d.id;}
