import type {Body, Environment} from '@commerce/contracts';
import {appendEvent, getRecord, type QueryExecutor} from '@commerce/db';
import {recordProfileExecutor} from '../../../packages/db/src/profile-record-context.js';

type ProviderObservation = {
  id: string;
  workspace_id: string;
  environment: Environment;
  aggregate_id: string;
  recorded_at: string | Date;
  event_type: string;
  payload: Body;
};

const statusRank: Record<string, number> = {SENT: 1, DELIVERED: 2, READ: 3, PLAYED: 4};

/** Apply a durable ingress event in the same transaction as its consumer receipt. */
export async function applyProviderAcknowledgement(client: QueryExecutor, event: ProviderObservation) {
  if (event.event_type !== 'provider.ack.observed') throw new Error('PROVIDER_ACK_EVENT_REQUIRED');
  const {workspace_id, environment, aggregate_id, payload} = event;
  const effect = (await client.query(
    `SELECT * FROM outbox WHERE workspace_id=$1 AND environment=$2 AND account_id=$3
      AND ((provider_message_id=$4 AND ($5='' OR id::text=$5))
        OR (id::text=$5 AND (provider_message_id IS NULL OR $4::text IS NULL OR provider_message_id=$4))) FOR UPDATE`,
    [workspace_id, environment, aggregate_id, payload.provider_message_id, payload.effect_id_hint ?? ''],
  )).rows[0];
  if (!effect && Date.now() - new Date(event.recorded_at).getTime() < 300000) return;
  const receipt = await client.query(
    "INSERT INTO consumer_receipts(consumer,event_id) VALUES('channel-v1',$1) ON CONFLICT DO NOTHING RETURNING event_id",
    [event.id],
  );
  if (!receipt.rowCount) return;
  const account = await getRecord(client, workspace_id, 'channel_account', aggregate_id);
  if (!account || account.environment !== environment) return;
  if (!effect) {
    await appendEvent(client, {workspace_id, environment, event_type: 'provider.ack.unmatched',
      aggregate_id, causation_id: event.id, payload: {provider_message_id: payload.provider_message_id,
        status: payload.status, evidence_ref: payload.envelope_id}});
    return;
  }
  const applied: string[] = effect.result?.ack_keys ?? [];
  if (applied.includes(payload.canonical_key)) return;
  await recordProfileExecutor(client, effect.workspace_id, effect.environment);
  let next = effect.status;
  if (effect.status !== 'UNKNOWN' && (statusRank[payload.status] ?? 0) > (statusRank[effect.status] ?? 0)) {
    next = payload.status === 'PLAYED' ? 'READ' : payload.status;
  }
  if (payload.status === 'FAILED' && effect.status === 'SENT') next = 'FAILED';
  await client.query('UPDATE outbox SET status=$2,result=result||$3::jsonb,updated_at=now() WHERE id=$1', [
    effect.id, next, JSON.stringify({ack_keys: [...applied, payload.canonical_key],
      last_ack: {status: payload.status, provider_at: payload.provider_at, evidence_ref: payload.envelope_id}}),
  ]);
  await appendEvent(client, {workspace_id, environment, event_type: 'message.acknowledged',
    aggregate_id: effect.conversation_id, causation_id: event.id,
    payload: {effect_id: effect.id, status: payload.status, provider_at: payload.provider_at}});
}
