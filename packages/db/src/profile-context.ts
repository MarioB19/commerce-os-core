import {currentProfileExecutor,joinProfileQueryWork} from './profile-query-routing.js';
import {currentWorkerProfile} from './profile-worker-scope.js';
import {requestProfileScope} from './profile-request-scope.js';
import type pg from 'pg';

// Keep pg's legacy default row type while preserving explicitly typed callers.
export type ProfileQuery = <Row extends pg.QueryResultRow = any>(
  sql: string, values?: unknown[],
) => Promise<pg.QueryResult<Row>>;
export interface ProfileExecutor {
  readonly workspaceId: string;
  readonly query: ProfileQuery;
}
export interface ProfileConnection {
  query: ProfileQuery;
  release(error?: Error | boolean): void;
}
export interface ProfilePool { connect(): Promise<ProfileConnection> }

export class ProfileContextError extends Error {
  constructor(code: string) { super(code); this.name = 'ProfileContextError'; }
}
export function requireProfileId(value: unknown): string {
  // Existing workspace IDs are text, including non-UUID IDs. Never rewrite them.
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new ProfileContextError('PROFILE_CONTEXT_REQUIRED');
  }
  return value;
}

/** Open exactly one transaction for an already-authorized profile.
 * This boundary establishes SQL context, not membership or action permission.
 * The callback never receives the pool, raw connection, release, or set-profile API.
 */
export async function withProfileTransaction<T>(
  pool: ProfilePool, workspaceId: string, work: (db: ProfileExecutor) => Promise<T>,
): Promise<T> {
  requireProfileId(workspaceId);
  currentWorkerProfile(workspaceId);
  // An authenticated request scope fixes the only profile this request may use.
  const request=requestProfileScope();
  if(request&&request.workspaceId!==workspaceId)throw new ProfileContextError('PROFILE_REQUEST_SCOPE_MISMATCH');
  const existing=currentProfileExecutor(workspaceId);
  if(existing)return joinProfileQueryWork(existing,()=>work(existing));
  const connection = await pool.connect();
  let usable = false;
  let begun = false;
  let discard: Error | undefined;
  let queryFailed = false;
  const pending = new Set<Promise<unknown>>();
  const query: ProfileQuery = <Row extends pg.QueryResultRow = any>(sql: string, values?: unknown[]) => {
    if (!usable) return Promise.reject(new ProfileContextError('PROFILE_TRANSACTION_CLOSED'));
    if (typeof sql !== 'string' || !sql.trim()) return Promise.reject(new ProfileContextError('PROFILE_QUERY_REQUIRED'));
    let operation: Promise<pg.QueryResult<Row>>;
    try { operation = connection.query<Row>(sql, values); }
    catch (error) { operation = Promise.reject(error); }
    pending.add(operation);
    // Observe the same promise returned to callers. A forgotten await must not
    // produce an unhandled rejection while the boundary drains and rolls back.
    void operation.then(() => { pending.delete(operation); }, () => { queryFailed = true; pending.delete(operation); });
    return operation;
  };
  const executor = Object.freeze({workspaceId, query});
  try {
    await connection.query('BEGIN');
    begun = true;
    await connection.query("SELECT pg_catalog.set_config('app.workspace_id', $1, true)", [workspaceId]);
    // The request's parsed environment also scopes environment-bound tables.
    if (request?.environment) await connection.query("SELECT pg_catalog.set_config('app.environment', $1, true)", [request.environment]);
    await connection.query('SET LOCAL row_security = on');
    usable = true;
    const result = await work(executor);
    usable = false;
    // A forgotten await cannot enqueue work after COMMIT or leak into another tenant.
    if (pending.size) throw new ProfileContextError('PROFILE_QUERY_NOT_AWAITED');
    if (queryFailed) throw new ProfileContextError('PROFILE_TRANSACTION_QUERY_FAILED');
    const committed = await connection.query('COMMIT');
    if (committed.command !== 'COMMIT') throw new ProfileContextError('PROFILE_COMMIT_UNCONFIRMED');
    begun = false;
    return result;
  } catch (error) {
    usable = false;
    await Promise.allSettled(pending);
    if (begun) {
      try { await connection.query('ROLLBACK'); }
      catch { discard = new ProfileContextError('PROFILE_ROLLBACK_FAILED'); }
    } else {
      // A failed BEGIN leaves transport state uncertain; do not reuse the socket.
      discard = new ProfileContextError('PROFILE_BEGIN_FAILED');
    }
    throw error;
  } finally {
    usable = false;
    connection.release(discard);
  }
}
