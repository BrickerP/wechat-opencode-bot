import { TASK_LANES, type StateDb, type TaskLane, type TaskRow } from './db.js';
import { logger } from '../logger.js';

export type TaskRunner = (task: TaskRow, signal: AbortSignal) => Promise<void>;

const TICK_MS = 3000;

interface Running {
  task: TaskRow;
  controller: AbortController;
}

/**
 * Per-account workers, one per lane: an account runs at most one write and one read task at a time,
 * and each lane runs its tasks in order. The DB is the source of truth: tasks are claimed atomically,
 * so that holds even across processes.
 * onFinished runs when the queue itself ends a task (expired while queued, or the
 * runner crashed), so the outbox can report it without waiting for the next message.
 */
export function createTaskQueue(db: StateDb, runTask: TaskRunner, onFinished: (accountId: string) => void) {
  const active = new Map<string, Map<TaskLane, Running>>();
  /** `${accountId}:${lane}` of every lane with a drain in progress. */
  const draining = new Set<string>();

  function claim(accountId: string, lane: TaskLane): TaskRow | null {
    const expired = db.expireStaleQueued(accountId);
    for (const task of expired) logger.warn('Queued task expired', { taskId: task.id, seq: task.seq });
    if (expired.length) onFinished(accountId);
    return db.claimNextTask(accountId, lane);
  }

  async function drain(accountId: string, lane: TaskLane): Promise<void> {
    const running = active.get(accountId) ?? new Map<TaskLane, Running>();
    active.set(accountId, running);
    for (let task = claim(accountId, lane); task; task = claim(accountId, lane)) {
      const controller = new AbortController();
      running.set(lane, { task, controller });
      logger.info('Task started', { taskId: task.id, seq: task.seq, lane });
      try {
        await runTask(task, controller.signal);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Task runner crashed', { taskId: task.id, error });
        if (db.finishTask(task.id, 'failed', { error })) onFinished(accountId);
      } finally {
        running.delete(lane);
      }
    }
  }

  /** Start draining both lanes now; a lane that is already draining keeps going. */
  function kick(accountId: string): void {
    for (const lane of TASK_LANES) {
      const key = `${accountId}:${lane}`;
      if (draining.has(key)) continue;
      draining.add(key);
      drain(accountId, lane)
        .catch((err) => logger.error('Task queue drain failed', { lane, error: String(err) }))
        .finally(() => draining.delete(key));
    }
  }

  /** Abort every task this process is running for the account, in both lanes; returns them. */
  function stop(accountId: string): TaskRow[] {
    const running = [...(active.get(accountId)?.values() ?? [])];
    for (const { controller } of running) controller.abort();
    return running.map(({ task }) => task);
  }

  /** Start draining now and keep polling for tasks queued while busy. */
  function start(accountId: string): () => void {
    kick(accountId);
    const timer = setInterval(() => kick(accountId), TICK_MS);
    return () => clearInterval(timer);
  }

  return { kick, stop, start };
}

export type TaskQueue = ReturnType<typeof createTaskQueue>;
