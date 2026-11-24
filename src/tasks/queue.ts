import type { StateDb, TaskRow } from './db.js';
import { logger } from '../logger.js';

export type TaskRunner = (task: TaskRow, signal: AbortSignal) => Promise<void>;

export function createTaskQueue(db: StateDb, runTask: TaskRunner, onFinished: (accountId: string) => void) {
  const active = new Map<string, { task: TaskRow; controller: AbortController }>();

  async function run(task: TaskRow) {
    const controller = new AbortController();
    active.set(task.id, { task, controller });
    try {
      logger.info('Task claimed', { taskId: task.id, seq: task.seq });
      await runTask(task, controller.signal);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('Task runner crashed', { taskId: task.id, error });
      if (db.finishTask(task.id, 'failed', { error })) onFinished(task.account_id);
    } finally {
      active.delete(task.id);
      queueMicrotask(() => kick(task.account_id));
    }
  }

  function kick(accountId: string): void {
    try {
      if (db.expireStaleQueued(accountId).length) onFinished(accountId);
      for (let task = db.claimNextTask(accountId); task; task = db.claimNextTask(accountId)) void run(task);
    } catch (err) {
      logger.error('Task queue drain failed', { accountId, error: String(err) });
    }
  }

  function stop(accountId: string): TaskRow[] {
    const running = [...active.values()].filter(({ task }) => task.account_id === accountId);
    for (const { controller } of running) controller.abort();
    return running.map(({ task }) => task);
  }

  function stopTask(accountId: string, taskId: string): boolean {
    const entry = active.get(taskId);
    if (!entry || entry.task.account_id !== accountId) return false;
    entry.controller.abort();
    return true;
  }

  function start(accountId: string): () => void {
    kick(accountId);
    const timer = setInterval(() => kick(accountId), 3000);
    return () => clearInterval(timer);
  }

  return { kick, stop, stopTask, start };
}

export type TaskQueue = ReturnType<typeof createTaskQueue>;
