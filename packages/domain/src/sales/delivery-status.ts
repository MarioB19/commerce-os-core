export type DeliverySummary = 'PENDING' | 'PARTIAL' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'UNKNOWN';

/** Summarizes only material notifications already proposed, never portal access. */
export function summarizeDelivery(statuses: readonly string[]): DeliverySummary {
  if (!statuses.length) return 'PENDING';
  if (statuses.includes('UNKNOWN')) return 'UNKNOWN';
  if (statuses.every(s => s === 'READ')) return 'READ';
  if (statuses.every(s => ['DELIVERED', 'READ'].includes(s))) return 'DELIVERED';
  if (statuses.every(s => ['SENT', 'DELIVERED', 'READ'].includes(s))) return 'SENT';
  if (statuses.every(s => ['FAILED', 'CANCELLED'].includes(s))) return 'FAILED';
  if (statuses.every(s => ['PROPOSED', 'READY', 'BLOCKED', 'PENDING', 'SENDING'].includes(s))) return 'PENDING';
  return 'PARTIAL';
}
