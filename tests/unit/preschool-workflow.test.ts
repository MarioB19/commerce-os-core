import {expect,it} from 'vitest';
import {workflowSchema} from '../../packages/contracts/src/index.js';
import {preschoolWorkflow} from '../../packages/domain/src/sales/preschool.js';
import {validateWorkflow} from '../../packages/domain/src/sales/workflow.js';

it('accepts the actual preschool recipe at the API contract and domain validation boundaries',()=>{
  const asset='00000000-0000-4000-8000-000000000001';
  const recipe=preschoolWorkflow({pitch:asset,agreement:asset,collection:asset});
  expect(workflowSchema.safeParse(recipe).success).toBe(true);
  expect(validateWorkflow(recipe)).toEqual({valid:true,errors:[]});
  expect(recipe.nodes.filter(node=>node.type==='reply').map(node=>node.config.variable)).toEqual(['grado','interes']);
});
