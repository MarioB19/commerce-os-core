import {expect,it} from 'vitest';
import {workflowSchema} from '../../packages/contracts/src/index.js';
import {miCicloListoWorkflow,preschoolWorkflow} from '../../packages/domain/src/sales/preschool.js';
import {validateWorkflow} from '../../packages/domain/src/sales/workflow.js';
import {classifyEducation,collectionStopReason} from '../../packages/domain/src/sales/education.js';
const id='00000000-0000-4000-8000-000000000001';const assets={pitch:id,agreement:id,collection:id,followup1:id,followup2:id,mockup:id};
it('validates new recipe through API and domain while preserving legacy without followups',()=>{
 const flow=miCicloListoWorkflow(assets);expect(workflowSchema.safeParse(flow).success).toBe(true);expect(validateWorkflow(flow)).toEqual({valid:true,errors:[]});expect(preschoolWorkflow(assets).nodes.some(n=>n.id==='collection_wait')).toBe(false);
 const receipt=flow.nodes.find(n=>n.id==='receipt')!;receipt.config.followups.touches.push({...receipt.config.followups.touches[1],id:'extra'});expect(validateWorkflow(flow).valid).toBe(false);
});
it('does not invent a level for ambiguous first grade and accepts actual education roles',()=>{
 expect(classifyEducation('primero')).toMatchObject({valid:false,grado:'1'});expect(classifyEducation('primaria',{grado:'1'})).toEqual({valid:true,nivel:'primaria',grado:'1'});expect(classifyEducation('sexto de preescolar').valid).toBe(false);expect(classifyEducation('soy directora').education_role).toBe('directivo');expect(classifyEducation('multigrado de primaria').education_role).toBe('multigrado');expect(classifyEducation('aún no tengo grupo').education_role).toBe('sin_grupo');
});
it('stops refusal/optout/payment-date automation without treating questions as commitment',()=>{
 expect(collectionStopReason('No, gracias.')).toBe('CUSTOMER_DECLINED');expect(collectionStopReason('baja')).toBe('CONTACT_OPT_OUT');expect(collectionStopReason('pago el lunes')).toBe('PAYMENT_DATE_REQUIRES_REVIEW');expect(collectionStopReason('¿Sirve para sexto?')).toBeUndefined();
});
