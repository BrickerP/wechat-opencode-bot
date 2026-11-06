import type { StateDb, TaskRow } from './db.js';
import { logger } from '../logger.js';

export type TaskRunner = (task: TaskRow, signal: AbortSignal) => Promise<void>;

const TICK_MS = 3000;

/**
 * Per-account serial worker. The DB is the source of truth: tasks are claimed
 * atomically, so an account never runs two tasks at once, even across processes.
 * onFinished runs when the queue itself ends a task (expired while queued, or the
 * runner crashed), so the outbox can report it without waiting for the next message.
 */
export function createTaskQueue(db: StateDb, runTask: TaskRunner, onFinished: (accountId: string) => void) {
  const active = new Map<string, { task: TaskRow; controller: AbortController }>();
  const draining = new Set<string>();

  function claim(accountId: string): TaskRow | null {
    const expired = db.expireStaleQueued(accountId);
    for (const task of expired) logger.warn('Queued task expired', { taskId: task.id, seq: task.seq });
    if (expired.length) onFinished(accountId);
    return db.claimNextTask(accountId);
  }

  async function drain(accountId: string): Promise<void> {
    for (let task = claim(accountId); task; task = claim(accountId)) {
      const controller = new AbortController();
      active.set(accountId, { task, controller });
      logger.info('Task started', { taskId: task.id, seq: task.seq });
      try {
        await runTask(task, controller.signal);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Task runner crashed', { taskId: task.id, error });
        if (db.finishTask(task.id, 'failed', { error })) onFinished(accountId);
      } finally {
        active.delete(accountId);
      }
    }
  }

  function kick(accountId: string): void {
    if (draining.has(accountId)) return;
    draining.add(accountId);
    drain(accountId)
      .catch((err) => logger.error('Task queue drain failed', { error: String(err) }))
      .finally(() => draining.delete(accountId));
  }

  /** Abort the task this process is running for the account; returns it, or undefined if none. */
  function stop(accountId: string): TaskRow | undefined {
    const current = active.get(accountId);
    current?.controller.abort();
    return current?.task;
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
