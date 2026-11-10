import { logger } from './logger.js';
import { deleteSession, listChildSessions } from './opencode/provider.js';
import type { StateDb } from './tasks/db.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The daemon prunes at startup and then this often. */
export const PRUNE_INTERVAL_MS = DAY_MS;

// Read on every call, like the alert settings, so tests can change them. LIMIT takes integers only.
const ttlDays = (): number => Number(process.env.OWB_SESSION_TTL_DAYS) || 7;
const keepCount = (): number => Math.trunc(Number(process.env.OWB_SESSION_KEEP)) || 300;

/** What pruning needs from OpenCode. */
export interface RetentionApi {
  listChildren(sessionId: string): Promise<Array<{ id: string }>>;
  deleteSession(sessionId: string): Promise<void>;
}

const openCode: RetentionApi = { listChildren: listChildSessions, deleteSession };

/** True once OpenCode deleted the session; a failure is logged. */
async function tryDelete(api: RetentionApi, sessionId: string): Promise<boolean> {
  try {
    await api.deleteSession(sessionId);
    return true;
  } catch (err) {
    logger.warn('Session delete failed', { sessionId, error: String(err) });
    return false;
  }
}

/**
 * Delete, through the OpenCode API, the sessions of tasks that finished more than ttlDays() ago, a retried task's
 * earlier attempts included, oldest first. The newest keepCount() finished tasks keep theirs, a session state.db
 * does not record is never touched, and opencode.db is never opened. A session's subagent sessions go before it,
 * and a deleted session is forgotten, so no later run asks for it again. Returns how many sessions went and how
 * many could not. Never throws: a failure is logged and counted, and the next run tries again.
 */
export async function pruneSessions(
  db: StateDb,
  api: RetentionApi = openCode,
  now: Date = new Date(),
): Promise<{ deleted: number; failed: number }> {
  const cutoff = now.getTime() - ttlDays() * DAY_MS;
  const keep = keepCount();
  let deleted = 0;
  let failed = 0;
  try {
    for (const sessionId of db.staleSessionIds(cutoff, keep)) {
      let children: Array<{ id: string }>;
      try {
        children = await api.listChildren(sessionId);
      } catch (err) {
        // Children go first, so without the list the parent waits for the next run.
        logger.warn('Session children unavailable', { sessionId, error: String(err) });
        failed++;
        continue;
      }
      for (const child of children) {
        if (await tryDelete(api, child.id)) deleted++;
        else failed++;
      }
      if (!(await tryDelete(api, sessionId))) {
        failed++;
        continue;
      }
      deleted++;
      // OpenCode deletes a session's children with it, so a child that failed above went too.
      db.forgetSession(sessionId);
    }
  } catch (err) {
    logger.warn('Session retention failed', { error: String(err) });
  }
  logger.info('Session retention', { deleted, failed, cutoff: new Date(cutoff).toISOString(), keep });
  return { deleted, failed };
}
