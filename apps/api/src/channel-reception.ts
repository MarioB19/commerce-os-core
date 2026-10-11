import type {DomainRecord} from '../../../packages/contracts/src/index.js';
import type {QueryExecutor} from '../../../packages/db/src/index.js';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {assertPermission} from '../../../packages/domain/src/core/permissions.js';
import {principal,scopedRecord,parseBody,mutate,command,fail} from './context.js';

export async function channelHistoryRoutes(app:FastifyInstance){
  app.post('/v1/channel-accounts/:id/sync-inbox',async(req,reply)=>{
    assertPermission(principal(req),'channels:manage');
    const input=z.object({expected_version:z.number().int().positive(),since:z.string().datetime({offset:true}),until:z.string().datetime({offset:true}).optional(),limit:z.number().int().min(1).max(100).default(100),reason:z.string().min(3).max(1000),confirmation:z.literal('IMPORT_RECENT_INBOUND')}).strict().parse(parseBody(req));
    const result=await mutate(req,'channel.history:'+(req.params as {id:string}).id,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['channel-command:'+(req.params as {id:string}).id]);
      const a=await scopedRecord(req,'channel_account',(req.params as {id:string}).id,c);
      if(a.version!==input.expected_version)throw fail(409,'VERSION_CONFLICT');
      if(a.environment!=='REAL'||a.body.provider!=='waha'||a.body.status!=='WORKING'||!a.body.identity_verified)throw fail(409,'CONNECTED_WAHA_REQUIRED');
      const since=Date.parse(input.since),until=Date.parse(input.until??new Date().toISOString());
      if(since<new Date(a.created_at).getTime()||since<Date.now()-86400000||until> Date.now()+1000||until<since||until-since>86400000)throw fail(400,'HISTORY_WINDOW_INVALID');
      return{data:await command(c,req,'channel_command',a.id,{type:'sync_inbox',since:input.since,until:new Date(until).toISOString(),limit:input.limit,reason:input.reason,identity_fingerprint:a.body.identity_fingerprint},a.environment),status:202};
    });reply.code(result.status??202);return{data:result.data};
  });
}

/** Aggregate metadata only. Messages, provider configuration and secrets never enter this report. */
export async function channelReception(c:QueryExecutor,a:DomainRecord){
  const args=[a.workspace_id,a.environment,a.id];
  const envelopes=(await c.query(`SELECT count(*)::int AS received,
    count(*) FILTER(WHERE status='PENDING')::int AS pending,
    count(*) FILTER(WHERE status='FAILED')::int AS failed,
    count(*) FILTER(WHERE status='PROCESSED')::int AS processed,
    max(received_at) AS last_received_at,max(processed_at) AS last_processed_at
    FROM inbound_envelopes WHERE workspace_id=$1 AND environment=$2 AND account_id=$3`,args)).rows[0];
  const messages=(await c.query(`SELECT count(*)::int AS received,count(*) FILTER(WHERE body->>'source'='provider_history')::int AS recovered,max(created_at) AS last_received_at
    FROM records WHERE workspace_id=$1 AND environment=$2 AND kind='message'
    AND body->>'account_id'=$3 AND body->>'direction'='INBOUND'`,args)).rows[0];
  const observation=(await c.query(`SELECT body FROM records WHERE workspace_id=$1 AND environment=$2
    AND kind='health_signal' AND body->>'account_id'=$3 AND body->'value'->>'kind'='webhook'
    ORDER BY created_at DESC,id DESC LIMIT 1`,args)).rows[0]?.body;
  const fresh=!!observation&&Date.parse(observation.expires_at)>Date.now();
  const webhook=a.body.provider!=='waha'?{state:'NOT_APPLICABLE'}:{state:!fresh?'UNKNOWN':observation.value.matches?'CONFIGURED':'MISMATCH',observed_at:observation?.observed_at??null};
  const state=webhook.state==='MISMATCH'?'CONFIGURATION_BLOCKED':envelopes.failed?'PROCESSING_FAILED':envelopes.pending?'PROCESSING_PENDING':messages.received?(messages.recovered===messages.received?'RECOVERED':'RECEIVED'):'AWAITING_MESSAGE';
  return{state,webhook,envelopes,messages,sending_enabled:a.body.sending_enabled===true,computed_at:new Date().toISOString()};
}
