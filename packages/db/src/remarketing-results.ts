import {z} from 'zod';
import type {ProfileExecutor} from './profile-context.js';
import {resultsDaySchema} from '../../contracts/src/results.js';

/** V7 F7 (RF-10.e): what a variant's follow-ups did in a period.
 * - «Entraron»: remarketing cycles opened (the customer stopped answering).
 * - Messages, people reached, replies and opt-outs come from follow-ups the
 *   provider accepted; a reply counts within 7 days after the first one, so a
 *   reply before any follow-up is not the follow-up's merit.
 * - Recovered sales and revenue are the same payment facts as Resultados
 *   (paid within 7 days after an accepted follow-up), per currency, never mixed. */
export const remarketingResultsQuerySchema=z.object({from:resultsDaySchema,to:resultsDaySchema}).strict()
 .refine(v=>v.from<=v.to&&Date.parse(v.to)-Date.parse(v.from)<=365*86400000,'El periodo admite hasta 366 días.');
const n=(v:unknown)=>Number(v??0);
export async function variantRemarketingResults(db:ProfileExecutor,environment:'REAL'|'SIMULATION',variantId:string,input:unknown){
 const q=remarketingResultsQuerySchema.parse(input),id=z.uuid().parse(variantId);
 // People who entered follow-up (the customer stopped answering), per stage.
 const cycles=(await db.query(`SELECT c.stage,count(*) cycles FROM commercial_remarketing_cycles c
  JOIN records r ON r.id=c.source_conversation_id AND r.workspace_id=c.workspace_id AND r.environment=c.environment AND r.kind='conversation'
  WHERE c.workspace_id=$1 AND c.environment=$2 AND r.body->>'variant_id'=$3 AND c.opened_at>=$4::date AND c.opened_at<$5::date+1 GROUP BY c.stage`,[db.workspaceId,environment,id,q.from,q.to])).rows;
 // Follow-ups the provider accepted, and what each reached person did next.
 const reach=(await db.query(`WITH sent AS(SELECT o.conversation_id,min(o.created_at) first_at,count(*) messages FROM outbox o
   JOIN records r ON r.id::text=o.conversation_id AND r.workspace_id=o.workspace_id AND r.environment=o.environment AND r.kind='conversation'
   WHERE o.workspace_id=$1 AND o.environment=$2 AND r.body->>'variant_id'=$3 AND o.payload->>'purpose'='remarketing' AND o.status IN('SENT','DELIVERED','READ') AND o.provider_message_id IS NOT NULL
    AND o.created_at>=$4::date AND o.created_at<$5::date+1 GROUP BY o.conversation_id)
  SELECT count(*)::int reached,COALESCE(sum(messages),0)::int sent,
   count(*) FILTER(WHERE EXISTS(SELECT 1 FROM records m WHERE m.workspace_id=$1 AND m.environment=$2 AND m.kind='message' AND m.body->>'conversation_id'=s.conversation_id AND m.body->>'direction'='INBOUND' AND m.created_at>s.first_at AND m.created_at<=s.first_at+interval '7 days'))::int replied,
   count(*) FILTER(WHERE EXISTS(SELECT 1 FROM records c WHERE c.workspace_id=$1 AND c.environment=$2 AND c.kind='conversation' AND c.id::text=s.conversation_id AND 'CONTACT_OPT_OUT' IN(c.body->>'followup_stop_reason',c.body->>'collection_stop_reason')))::int opted_out
  FROM sent s`,[db.workspaceId,environment,id,q.from,q.to])).rows[0];
 const uncertain=(await db.query(`SELECT count(*)::int n FROM outbox o JOIN records r ON r.id::text=o.conversation_id AND r.workspace_id=o.workspace_id AND r.environment=o.environment AND r.kind='conversation'
  WHERE o.workspace_id=$1 AND o.environment=$2 AND r.body->>'variant_id'=$3 AND o.payload->>'purpose'='remarketing' AND o.status='UNKNOWN' AND o.created_at>=$4::date AND o.created_at<$5::date+1`,[db.workspaceId,environment,id,q.from,q.to])).rows[0];
 const revenue=environment==='REAL'?(await db.query(`SELECT currency,COALESCE(sum(amount_minor),0)::text revenue_minor,count(DISTINCT order_id) FILTER(WHERE effective_at=first_order_payment_at)::int sales
  FROM result_payment_facts WHERE workspace_id=$1 AND environment='REAL' AND variant_id::text=$2 AND touch='REMARKETING' AND effective_at>=$3::date AND effective_at<$4::date+1
  GROUP BY currency ORDER BY currency`,[db.workspaceId,id,q.from,q.to])).rows:[];
 const revenueSales=revenue.reduce((t,r)=>t+n(r.sales),0);
 return{variant_id:id,from:q.from,to:q.to,basis:{entered:'cycle_opened_at',messages:'accepted_follow_up_created_at',replies:'inbound_within_7_days_after_first_follow_up',sales:'payment_within_7_days_after_follow_up'} as const,
  entered:cycles.reduce((t,r)=>t+n(r.cycles),0),entered_by_stage:{AGREEMENT:n(cycles.find(r=>r.stage==='AGREEMENT')?.cycles),COLLECTION:n(cycles.find(r=>r.stage==='COLLECTION')?.cycles)},
  reached:n(reach?.reached),messages:{sent:n(reach?.sent),uncertain:n(uncertain?.n)},replied:n(reach?.replied),opted_out:n(reach?.opted_out),recovered_sales:revenueSales,
  recovered_revenue:revenue.map(r=>({currency:String(r.currency),revenue_minor:String(r.revenue_minor),sales:n(r.sales)}))};
}
