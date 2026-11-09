import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from '../constants.js';

export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
export type FinishedStatus = Exclude<TaskStatus, 'queued' | 'running'>;
/** An account runs one task per lane at a time, so a read-only task does not wait for a write task. */
export const TASK_LANES = ['write', 'read'] as const;
export type TaskLane = (typeof TASK_LANES)[number];

export interface UserRow {
  account_id: string;
  wechat_user_id: string;
  context_token: string | null;
  context_token_at: number | null;
  workspace: string | null;
  model: string | null;
  created_at: number;
}

export interface TaskRow {
  id: string;
  account_id: string;
  input: string;
  status: TaskStatus;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  session_id: string | null;
  result: string | null;
  summary: string | null;
  error: string | null;
  /** 1 once the outcome is in the outbox (pending_notices) or the user was answered directly. */
  notified: number;
  /** WeChat message the task came from; null for --simulate. */
  message_id: string | null;
  /** Registry project the message named; null runs in the account's workspace. */
  project_id: string | null;
  /** Absolute repo root of project_id when the task was created; the task's session opens there. */
  project_dir: string | null;
  /** Bot the message was addressed to: a registry id, or "all" for "@all". Null (older rows) means the default bot. */
  bot_id: string | null;
  /** read for a read-only bot's task; write for every other task, older rows included. */
  lane: TaskLane;
  /** 1-based position of the task in the account's history (computed). */
  seq: number;
}

/** The project a task runs in; dir is absolute. */
export interface TaskProject {
  id: string;
  dir: string;
}

export interface NoticeRow {
  id: number;
  account_id: string;
  text: string;
  created_at: number;
  delivered: number;
  /** Set when the notice carries a task's outcome. */
  task_id: string | null;
  /** Failed send attempts; drives the backoff in next_at. */
  attempts: number;
  /** Earliest time the next send may be attempted (epoch ms). */
  next_at: number;
}

export const STATE_DB_PATH = join(DATA_DIR, 'state.db');

const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const EXPIRED_ERROR = '排队超过24小时，已过期';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS users (
  account_id TEXT PRIMARY KEY,
  wechat_user_id TEXT NOT NULL,
  context_token TEXT,
  context_token_at INTEGER,
  workspace TEXT,
  model TEXT,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  input TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  session_id TEXT,
  result TEXT,
  summary TEXT,
  error TEXT,
  notified INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tasks_account_status ON tasks(account_id, status);
CREATE TABLE IF NOT EXISTS pending_notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT,
  text TEXT,
  created_at INTEGER,
  delivered INTEGER DEFAULT 0
);
`;

// rowid gives insertion order; seq numbers tasks per account in that order.
const TASK_SELECT = `SELECT t.*, (SELECT COUNT(*) FROM tasks x WHERE x.account_id = t.account_id AND x.rowid <= t.rowid) AS seq FROM tasks t`;

type Param = string | number | null;

/** The daemon, --simulate and --notify each open their own connection; WAL + busy_timeout lets them share it. */
export function openStateDb(file: string = STATE_DB_PATH) {
  mkdirSync(DATA_DIR, { recursive: true });
  // Create the file 0600 before SQLite does: the -wal/-shm files inherit its mode.
  closeSync(openSync(file, 'a', 0o600));
  if (process.platform !== 'win32') chmodSync(file, 0o600);

  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');

  const one = <T>(sql: string, ...params: Param[]) => db.prepare(sql).get(...params) as unknown as T | undefined;
  const all = <T>(sql: string, ...params: Param[]) => db.prepare(sql).all(...params) as unknown as T[];
  const run = (sql: string, ...params: Param[]) => db.prepare(sql).run(...params);

  function immediate<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const hasColumn = (table: string, column: string) =>
    one('SELECT 1 FROM pragma_table_info(?) WHERE name = ?', table, column) !== undefined;

  // Each step runs once, in order, and user_version records how far a database got. Steps also
  // check what they add, so a hand-edited database still opens.
  immediate(() => {
    const version = one<{ user_version: number }>('PRAGMA user_version')!.user_version;
    if (version < 1) db.exec(SCHEMA_V1);
    if (version < 2) {
      // Inbound messages are matched by WeChat message id; outcome notices point back at their task.
      if (!hasColumn('tasks', 'message_id')) db.exec('ALTER TABLE tasks ADD COLUMN message_id TEXT');
      if (!hasColumn('pending_notices', 'task_id')) db.exec('ALTER TABLE pending_notices ADD COLUMN task_id TEXT');
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_account_message ON tasks(account_id, message_id) WHERE message_id IS NOT NULL;
        PRAGMA user_version = 2;`);
    }
    if (version < 3) {
      // Each task runs in the project its message named, or in the account's workspace.
      if (!hasColumn('tasks', 'project_id')) db.exec('ALTER TABLE tasks ADD COLUMN project_id TEXT');
      if (!hasColumn('tasks', 'project_dir')) db.exec('ALTER TABLE tasks ADD COLUMN project_dir TEXT');
      db.exec('PRAGMA user_version = 3');
    }
    if (version < 4) {
      // Each task speaks as the bot its message named.
      if (!hasColumn('tasks', 'bot_id')) db.exec('ALTER TABLE tasks ADD COLUMN bot_id TEXT');
      db.exec('PRAGMA user_version = 4');
    }
    if (version < 5) {
      // Outbox retry: a failed notice waits for its next_at instead of blocking every later flush.
      if (!hasColumn('pending_notices', 'attempts')) db.exec('ALTER TABLE pending_notices ADD COLUMN attempts INTEGER DEFAULT 0');
      if (!hasColumn('pending_notices', 'next_at')) db.exec('ALTER TABLE pending_notices ADD COLUMN next_at INTEGER DEFAULT 0');
      db.exec('PRAGMA user_version = 5');
    }
    if (version < 6) {
      // Lanes: a read-only task runs beside a write task. Every older task was a write.
      if (!hasColumn('tasks', 'lane')) db.exec("ALTER TABLE tasks ADD COLUMN lane TEXT NOT NULL DEFAULT 'write'");
      db.exec('PRAGMA user_version = 6');
    }
  });

  const getTask = (id: string) => one<TaskRow>(`${TASK_SELECT} WHERE t.id = ?`, id);
  const hasRunning = (accountId: string, lane: TaskLane) =>
    one(`SELECT 1 FROM tasks WHERE account_id = ? AND lane = ? AND status = 'running'`, accountId, lane) !== undefined;

  function insertTask(
    accountId: string,
    input: string,
    status: 'queued' | 'running',
    messageId: string | null = null,
    project: TaskProject | null = null,
    botId: string | null = null,
    lane: TaskLane = 'write',
  ): TaskRow {
    const id = randomUUID();
    const now = Date.now();
    run(
      `INSERT INTO tasks (id, account_id, input, status, created_at, started_at, message_id, project_id, project_dir, bot_id, lane)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, accountId, input, status, now, status === 'running' ? now : null, messageId, project?.id ?? null, project?.dir ?? null, botId, lane,
    );
    return getTask(id)!;
  }

  return {
    // ── users ────────────────────────────────────────────────────────────
    getUser: (accountId: string) => one<UserRow>('SELECT * FROM users WHERE account_id = ?', accountId),

    ensureUser(accountId: string, wechatUserId: string): void {
      run(
        'INSERT INTO users (account_id, wechat_user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO NOTHING',
        accountId, wechatUserId, Date.now(),
      );
    },

    /** Every inbound message refreshes the token; proactive sends (results, --notify) reuse the latest one. */
    saveContextToken(accountId: string, wechatUserId: string, token: string): void {
      const now = Date.now();
      run(
        `INSERT INTO users (account_id, wechat_user_id, context_token, context_token_at, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET wechat_user_id = excluded.wechat_user_id,
           context_token = excluded.context_token, context_token_at = excluded.context_token_at`,
        accountId, wechatUserId, token, now, now,
      );
    },

    setWorkspace(accountId: string, workspace: string): void {
      run('UPDATE users SET workspace = ? WHERE account_id = ?', workspace, accountId);
    },

    /** null restores the orchestrator agent's own model. */
    setModel(accountId: string, model: string | null): void {
      run('UPDATE users SET model = ? WHERE account_id = ?', model, accountId);
    },

    // ── tasks ────────────────────────────────────────────────────────────
    getTask,

    /**
     * Queue a task for an inbound message. iLink can deliver a message again, and the monitor forgets
     * what it saw on restart: the same message id returns the existing task with created: false.
     */
    createTask(
      accountId: string,
      input: string,
      messageId: string | null = null,
      project?: TaskProject,
      botId?: string,
      lane?: TaskLane,
    ): { task: TaskRow; created: boolean } {
      return immediate(() => {
        const existing =
          messageId === null
            ? undefined
            : one<TaskRow>(`${TASK_SELECT} WHERE t.account_id = ? AND t.message_id = ?`, accountId, messageId);
        if (existing) return { task: existing, created: false };
        return { task: insertTask(accountId, input, 'queued', messageId, project, botId, lane), created: true };
      });
    },

    /** Insert a task directly as running (--simulate), unless its lane already has a running task. */
    startTaskNow(accountId: string, input: string, project?: TaskProject, botId?: string, lane: TaskLane = 'write'): TaskRow | null {
      return immediate(() =>
        hasRunning(accountId, lane) ? null : insertTask(accountId, input, 'running', null, project, botId, lane),
      );
    },

    /** Atomically move the lane's oldest queued task to running; null if the lane is busy or has nothing queued. */
    claimNextTask(accountId: string, lane: TaskLane): TaskRow | null {
      return immediate(() => {
        if (hasRunning(accountId, lane)) return null;
        const next = one<{ id: string }>(
          "SELECT id FROM tasks WHERE account_id = ? AND lane = ? AND status = 'queued' ORDER BY rowid LIMIT 1",
          accountId, lane,
        );
        if (!next) return null;
        run("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?", Date.now(), next.id);
        return getTask(next.id)!;
      });
    },

    /** The running tasks, at most one per lane, oldest first. */
    runningTasks: (accountId: string) =>
      all<TaskRow>(`${TASK_SELECT} WHERE t.account_id = ? AND t.status = 'running' ORDER BY t.rowid`, accountId),

    /** Tasks that will run before the given one: its lane's running task plus the lane's older queued tasks. */
    countAhead(accountId: string, taskId: string): number {
      return one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM tasks WHERE account_id = ? AND id != ? AND lane = (SELECT lane FROM tasks WHERE id = ?)
           AND (status = 'running' OR (status = 'queued' AND rowid < (SELECT rowid FROM tasks WHERE id = ?)))`,
        accountId, taskId, taskId, taskId,
      )!.n;
    },

    /** Most recent tasks, newest first. With beforeTaskId, only tasks inserted before it. */
    recentTasks(accountId: string, limit: number, beforeTaskId?: string): TaskRow[] {
      return beforeTaskId
        ? all<TaskRow>(
            `${TASK_SELECT} WHERE t.account_id = ? AND t.rowid < (SELECT rowid FROM tasks WHERE id = ?) ORDER BY t.rowid DESC LIMIT ?`,
            accountId, beforeTaskId, limit,
          )
        : all<TaskRow>(`${TASK_SELECT} WHERE t.account_id = ? ORDER BY t.rowid DESC LIMIT ?`, accountId, limit);
    },

    /** How long the newest done tasks ran (ms), newest first; the queue ack's ETA comes from them. */
    recentDurations(accountId: string, limit = 10): number[] {
      return all<{ ms: number }>(
        `SELECT finished_at - started_at AS ms FROM tasks WHERE account_id = ? AND status = 'done'
           AND started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at ORDER BY rowid DESC LIMIT ?`,
        accountId, limit,
      ).map((row) => row.ms);
    },

    statusCounts(accountId: string): Record<TaskStatus, number> {
      const counts: Record<TaskStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, interrupted: 0 };
      for (const row of all<{ status: TaskStatus; n: number }>(
        'SELECT status, COUNT(*) AS n FROM tasks WHERE account_id = ? GROUP BY status',
        accountId,
      )) {
        counts[row.status] = row.n;
      }
      return counts;
    },

    /** Finished tasks by outcome, counting those that finished at or after since (epoch ms). */
    statusCountsSince(accountId: string, since: number): Record<FinishedStatus, number> {
      const counts: Record<FinishedStatus, number> = { done: 0, failed: 0, interrupted: 0 };
      for (const row of all<{ status: FinishedStatus; n: number }>(
        `SELECT status, COUNT(*) AS n FROM tasks WHERE account_id = ? AND status IN ('done', 'failed', 'interrupted')
           AND finished_at >= ? GROUP BY status`,
        accountId, since,
      )) {
        counts[row.status] = row.n;
      }
      return counts;
    },

    /** The task that failed last, at or after since (epoch ms); undefined if none did. */
    lastFailure: (accountId: string, since: number) =>
      one<TaskRow>(
        `${TASK_SELECT} WHERE t.account_id = ? AND t.status = 'failed' AND t.finished_at >= ?
           ORDER BY t.finished_at DESC, t.rowid DESC LIMIT 1`,
        accountId, since,
      ),

    setTaskSession(id: string, sessionId: string): void {
      run('UPDATE tasks SET session_id = ? WHERE id = ?', sessionId, id);
    },

    /**
     * Finish a running task. Returns false if it was no longer running (stopped or interrupted meanwhile).
     * notified: the caller already told the user, so the outbox skips the task.
     */
    finishTask(
      id: string,
      status: FinishedStatus,
      fields: { result?: string; summary?: string; error?: string; notified?: boolean } = {},
    ): boolean {
      const out = run(
        "UPDATE tasks SET status = ?, finished_at = ?, result = ?, summary = ?, error = ?, notified = ? WHERE id = ? AND status = 'running'",
        status, Date.now(), fields.result ?? null, fields.summary ?? null, fields.error ?? null, fields.notified ? 1 : 0, id,
      );
      return Number(out.changes) === 1;
    },

    markNotified(id: string): void {
      run('UPDATE tasks SET notified = 1 WHERE id = ?', id);
    },

    /** /stop all: queued tasks never start; the reply tells the user. Returns how many were cancelled. */
    cancelQueued(accountId: string, error: string): number {
      const out = run(
        "UPDATE tasks SET status = 'interrupted', finished_at = ?, error = ?, notified = 1 WHERE account_id = ? AND status = 'queued'",
        Date.now(), error, accountId,
      );
      return Number(out.changes);
    },

    /** Queued tasks older than the TTL never start; they end as interrupted and the outbox tells the user. */
    expireStaleQueued(accountId: string, olderThanMs: number = QUEUE_TTL_MS): TaskRow[] {
      return immediate(() => {
        const stale = all<{ id: string }>(
          "SELECT id FROM tasks WHERE account_id = ? AND status = 'queued' AND created_at < ? ORDER BY rowid",
          accountId, Date.now() - olderThanMs,
        );
        for (const { id } of stale) {
          run("UPDATE tasks SET status = 'interrupted', finished_at = ?, error = ? WHERE id = ?", Date.now(), EXPIRED_ERROR, id);
        }
        return stale.map(({ id }) => getTask(id)!);
      });
    },

    /** Startup recovery: no task survives a bot restart. Returns the tasks that were interrupted. */
    interruptRunningTasks(error: string): TaskRow[] {
      return immediate(() => {
        const rows = all<TaskRow>(`${TASK_SELECT} WHERE t.status = 'running' ORDER BY t.rowid`);
        run("UPDATE tasks SET status = 'interrupted', finished_at = ?, error = ? WHERE status = 'running'", Date.now(), error);
        return rows;
      });
    },

    // ── pending notices ──────────────────────────────────────────────────
    /**
     * Outbox hand-off: queue the outcome of every finished task the user has not been told about,
     * oldest first. The chunks and notified = 1 commit together, so an outcome is queued exactly once
     * even across crashes and processes; the task_id check holds that even if notified were reset.
     */
    queueUnnotified(accountId: string, toChunks: (task: TaskRow) => string[]): void {
      immediate(() => {
        const tasks = all<TaskRow>(
          `${TASK_SELECT} WHERE t.account_id = ? AND t.notified = 0 AND t.status IN ('done', 'failed', 'interrupted')
             AND NOT EXISTS (SELECT 1 FROM pending_notices n WHERE n.task_id = t.id) ORDER BY t.rowid`,
          accountId,
        );
        for (const task of tasks) {
          for (const text of toChunks(task)) {
            run(
              'INSERT INTO pending_notices (account_id, text, created_at, task_id) VALUES (?, ?, ?, ?)',
              accountId, text, Date.now(), task.id,
            );
          }
          run('UPDATE tasks SET notified = 1 WHERE id = ?', task.id);
        }
      });
    },

    addNotice(accountId: string, text: string): number {
      return Number(
        run('INSERT INTO pending_notices (account_id, text, created_at) VALUES (?, ?, ?)', accountId, text, Date.now())
          .lastInsertRowid,
      );
    },

    pendingNotices: (accountId: string) =>
      all<NoticeRow>('SELECT * FROM pending_notices WHERE account_id = ? AND delivered = 0 ORDER BY id', accountId),

    /** The oldest undelivered notice; later notices never overtake it. */
    pendingHead: (accountId: string) =>
      one<NoticeRow>('SELECT * FROM pending_notices WHERE account_id = ? AND delivered = 0 ORDER BY id LIMIT 1', accountId),

    /** Undelivered notices whose backoff has elapsed, oldest first. */
    dueNotices: (accountId: string, now: number = Date.now()) =>
      all<NoticeRow>(
        'SELECT * FROM pending_notices WHERE account_id = ? AND delivered = 0 AND COALESCE(next_at, 0) <= ? ORDER BY id',
        accountId, now,
      ),

    markNoticeDelivered(id: number): void {
      run('UPDATE pending_notices SET delivered = 1 WHERE id = ?', id);
    },

    markNoticeFailed(id: number, attempts: number, nextAt: number): void {
      run('UPDATE pending_notices SET attempts = ?, next_at = ? WHERE id = ?', attempts, nextAt, id);
    },
  };
}

export type StateDb = ReturnType<typeof openStateDb>;
