import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';

/** V7 RF-10.c: the follow-up cycles of one variant, as the web and the MCP read
 * them. A cycle opens when the customer stops answering and closes on reply,
 * payment, opt-out, decline, review or its maximum. The policy captured when it
 * opened stays with it: publishing a new policy applies to new cycles only (V7
 * retired the V5 reprogramming of open cycles). Pausing the conversation stops
 * its pending follow-ups. No contact data leaves this read. */
export const remarketingCyclesQuerySchema=z.object({status:z.enum(['OPEN','CLOSED','ALL']).default('OPEN'),limit:z.coerce.number().int().min(1).max(100).default(50)}).strict();
const statusLabels:Record<string,string>={OPEN:'En curso',PAID:'Pagó',REPLIED:'Respondió',DECLINED:'Rechazó',OPTED_OUT:'Pidió la baja',HUMAN_REVIEW:'Pasó a una persona',CLOSED:'Cerrado'};
const stageLabels:Record<string,string>={AGREEMENT:'Esperando que acepte',COLLECTION:'Esperando el pago'};
export async function variantRemarketingCycles(db:ProfileExecutor,environment:'REAL'|'SIMULATION',variantId:string,input:unknown){
 const q=remarketingCyclesQuerySchema.parse(input??{}),id=z.uuid().parse(variantId);
 const rows=(await db.query(`SELECT c.id,c.revision,c.status,c.stage,c.opened_at,c.closed_at,c.close_reason,c.consumed_attempts,c.max_attempts,c.source_conversation_id,
   (SELECT min(t.due_at) FROM timers t WHERE t.workspace_id=c.workspace_id AND t.environment=c.environment AND t.status='PENDING' AND t.kind='followup' AND t.payload->>'cycle_id'=c.id::text) AS next_due_at,
   (SELECT COALESCE(jsonb_object_agg(s.status,s.n),'{}'::jsonb) FROM (SELECT a.status,count(*)::int n FROM commercial_remarketing_attempts a WHERE a.cycle_id=c.id GROUP BY a.status) s) AS attempts,
   EXISTS(SELECT 1 FROM manual_controls m WHERE m.workspace_id=c.workspace_id AND m.scope_type='conversation' AND m.scope_id=c.source_conversation_id::text AND (m.paused OR m.takeover)) AS conversation_paused
  FROM commercial_remarketing_cycles c
  JOIN records r ON r.id=c.source_conversation_id AND r.workspace_id=c.workspace_id AND r.environment=c.environment AND r.kind='conversation'
  WHERE c.workspace_id=$1 AND c.environment=$2 AND r.body->>'variant_id'=$3
   AND ($4='ALL' OR ($4='OPEN')=(c.status='OPEN'))
  ORDER BY c.updated_at DESC,c.id LIMIT $5`,[db.workspaceId,environment,id,q.status,q.limit])).rows;
 const iso=(v:unknown)=>v?new Date(v as string).toISOString():null;
 return{variant_id:id,status:q.status,
  cycles:rows.map(r=>({id:String(r.id),revision:Number(r.revision),status:String(r.status),status_label:statusLabels[r.status]??String(r.status),
   stage:String(r.stage),stage_label:stageLabels[r.stage]??String(r.stage),opened_at:iso(r.opened_at),closed_at:iso(r.closed_at),close_reason:r.close_reason?String(r.close_reason).slice(0,80):null,
   consumed_attempts:Number(r.consumed_attempts),max_attempts:Number(r.max_attempts),next_due_at:iso(r.next_due_at),attempts:r.attempts as Record<string,number>,
   conversation_id:String(r.source_conversation_id),conversation_paused:r.conversation_paused===true})),
  note:'Cada ciclo conserva la política con la que abrió. Publicar otra aplica a los ciclos nuevos; para detener uno, pausa o cierra su conversación.'};
}
