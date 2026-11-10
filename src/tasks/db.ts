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
  /** OpenCode session of the task's last attempt; null before it has one and once retention deleted it. */
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
  /** Routine that queued the task; null for a message's task, older rows included. */
  routine_id: string | null;
  /** Notes a done task left for the next one (files, commands, open questions, next step); never shown to the user. */
  handoff: string | null;
  /** Tokens the task's sessions read over all its attempts, subagents and cache reads included; null when unknown. */
  tokens_in: number | null;
  /** Tokens they wrote, reasoning included; null when unknown. */
  tokens_out: number | null;
  /** What they cost in USD as OpenCode prices them, 0 for a model it has no price for; null when unknown. */
  cost_usd: number | null;
  /** 1-based position of the task in the account's history (computed). */
  seq: number;
}

/** What a task's sessions used over all its attempts. */
export interface TaskUsage {
  input: number;
  output: number;
  /** USD. */
  cost: number;
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

/** A recurring task: when next_run_at comes, the daemon queues prompt as a task of the account (see routines.ts). */
export interface RoutineRow {
  id: string;
  account_id: string;
  /** What the user calls it in /routine; unique per account. */
  name: string;
  /** The task input, its "@bot" and "@alias" already stripped. */
  prompt: string;
  /** Bot its tasks speak as, routed when the routine was added. */
  bot_id: string | null;
  /** Registry project its tasks run in; null runs them in the account's workspace. */
  project_id: string | null;
  /** Absolute repo root of project_id when the routine was added. */
  project_dir: string | null;
  /** Canonical schedule, such as daily09:00 or every30m. */
  schedule: string;
  /** 1 while the scheduler runs it; /routine off sets 0. */
  enabled: number;
  /** When the routine is next due (epoch ms). */
  next_run_at: number;
  /** When it last queued a task; null before its first run. */
  last_run_at: number | null;
  created_at: number;
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
    if (version < 7) {
      // Routines queue a task on a schedule; the task points back at its routine. Older tasks came from messages.
      db.exec(`CREATE TABLE IF NOT EXISTS routines (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        bot_id TEXT,
        project_id TEXT,
        project_dir TEXT,
        schedule TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at INTEGER NOT NULL,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE(account_id, name)
      )`);
      if (!hasColumn('tasks', 'routine_id')) db.exec('ALTER TABLE tasks ADD COLUMN routine_id TEXT');
      db.exec('PRAGMA user_version = 7');
    }
    if (version < 8) {
      // Retention deletes every attempt's session; tasks.session_id names only the last. Older tasks bring that one.
      db.exec(`CREATE TABLE IF NOT EXISTS task_sessions (
        session_id TEXT NOT NULL PRIMARY KEY,
        task_id TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_sessions_task ON task_sessions(task_id);
      INSERT OR IGNORE INTO task_sessions (session_id, task_id, created_at)
        SELECT session_id, id, COALESCE(finished_at, started_at, created_at) FROM tasks WHERE session_id IS NOT NULL;
      PRAGMA user_version = 8;`);
    }
    if (version < 9) {
      // A done task leaves notes for the next one, and every task records what its sessions used. Older tasks have neither.
      if (!hasColumn('tasks', 'handoff')) db.exec('ALTER TABLE tasks ADD COLUMN handoff TEXT');
      if (!hasColumn('tasks', 'tokens_in')) db.exec('ALTER TABLE tasks ADD COLUMN tokens_in INTEGER');
      if (!hasColumn('tasks', 'tokens_out')) db.exec('ALTER TABLE tasks ADD COLUMN tokens_out INTEGER');
      if (!hasColumn('tasks', 'cost_usd')) db.exec('ALTER TABLE tasks ADD COLUMN cost_usd REAL');
      db.exec('PRAGMA user_version = 9');
    }
  });

  const getTask = (id: string) => one<TaskRow>(`${TASK_SELECT} WHERE t.id = ?`, id);
  /** The account's task numbered seq, the number replies and /tasks show; undefined if it has none by that number. */
  function taskBySeq(accountId: string, seq: number): TaskRow | undefined {
    if (!Number.isSafeInteger(seq) || seq < 1) return undefined;
    // seq counts the account's rows by rowid, as TASK_SELECT does.
    const row = one<{ id: string }>('SELECT id FROM tasks WHERE account_id = ? ORDER BY rowid LIMIT 1 OFFSET ?', accountId, seq - 1);
    return row && getTask(row.id);
  }
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
    routineId: string | null = null,
  ): TaskRow {
    const id = randomUUID();
    const now = Date.now();
    run(
      `INSERT INTO tasks (id, account_id, input, status, created_at, started_at, message_id, project_id, project_dir, bot_id, lane, routine_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, accountId, input, status, now, status === 'running' ? now : null, messageId, project?.id ?? null, project?.dir ?? null, botId, lane,
      routineId,
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
    taskBySeq,

    /**
     * Queue a task for an inbound message, or for a routine (routineId, no message). iLink can deliver a message
     * again, and the monitor forgets what it saw on restart: the same message id returns the existing task with
     * created: false.
     */
    createTask(
      accountId: string,
      input: string,
      messageId: string | null = null,
      project?: TaskProject,
      botId?: string,
      lane?: TaskLane,
      routineId?: string,
    ): { task: TaskRow; created: boolean } {
      return immediate(() => {
        const existing =
          messageId === null
            ? undefined
            : one<TaskRow>(`${TASK_SELECT} WHERE t.account_id = ? AND t.message_id = ?`, accountId, messageId);
        if (existing) return { task: existing, created: false };
        return { task: insertTask(accountId, input, 'queued', messageId, project, botId, lane, routineId), created: true };
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

    /** How long the newest done tasks (of the lane, if given) ran (ms), newest first; the queue ack's ETA comes from them. */
    recentDurations(accountId: string, lane?: TaskLane, limit = 10): number[] {
      return all<{ ms: number }>(
        `SELECT finished_at - started_at AS ms FROM tasks WHERE account_id = ? AND lane = COALESCE(?, lane) AND status = 'done'
           AND started_at IS NOT NULL AND finished_at IS NOT NULL AND finished_at >= started_at ORDER BY rowid DESC LIMIT ?`,
        accountId, lane ?? null, limit,
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

    /** Token and cost totals of the tasks that finished at or after since (epoch ms); 0 when none recorded any. */
    usageSince: (accountId: string, since: number): TaskUsage =>
      one<TaskUsage>(
        `SELECT COALESCE(SUM(tokens_in), 0) AS input, COALESCE(SUM(tokens_out), 0) AS output, COALESCE(SUM(cost_usd), 0) AS cost
           FROM tasks WHERE account_id = ? AND finished_at >= ?`,
        accountId, since,
      )!,

    /** Every attempt's session is recorded for retention; the task names the last. */
    setTaskSession(id: string, sessionId: string): void {
      immediate(() => {
        run('UPDATE tasks SET session_id = ? WHERE id = ?', sessionId, id);
        run('INSERT OR IGNORE INTO task_sessions (session_id, task_id, created_at) VALUES (?, ?, ?)', sessionId, id, Date.now());
      });
    },

    /**
     * Sessions retention may delete: every attempt's of the tasks that finished before cutoff (epoch ms), oldest
     * first. The newest keep finished tasks keep all theirs however old they are. A binary before v8 records a
     * session only in tasks.session_id, so that counts too; a session no task records never qualifies.
     */
    staleSessionIds: (cutoff: number, keep: number) =>
      all<{ session_id: string }>(
        `WITH recorded AS (
           SELECT session_id, task_id, rowid AS pos FROM task_sessions
           UNION ALL
           SELECT session_id, id, NULL FROM tasks t
             WHERE session_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task_sessions s WHERE s.session_id = t.session_id)
         ), finished AS (
           SELECT id, finished_at, rowid AS pos FROM tasks WHERE status IN ('done', 'failed', 'interrupted')
             AND finished_at IS NOT NULL AND id IN (SELECT task_id FROM recorded)
         )
         SELECT r.session_id FROM recorded r JOIN finished f ON f.id = r.task_id
         WHERE f.finished_at < ? AND f.id NOT IN (SELECT id FROM finished ORDER BY finished_at DESC, pos DESC LIMIT ?)
         ORDER BY f.finished_at, f.pos, r.pos NULLS LAST`,
        cutoff, keep,
      ).map((row) => row.session_id),

    /** The session is gone from OpenCode: task_sessions drops it and no task names it, so retention does not ask again. */
    forgetSession(sessionId: string): void {
      immediate(() => {
        run('DELETE FROM task_sessions WHERE session_id = ?', sessionId);
        run('UPDATE tasks SET session_id = NULL WHERE session_id = ?', sessionId);
      });
    },

    /**
     * Finish a running task. Returns false if it was no longer running (stopped or interrupted meanwhile).
     * notified: the caller already told the user, so the outbox skips the task. An empty handoff stores none.
     * usage is stored either way: a task /stop finished first still used what its sessions used.
     */
    finishTask(
      id: string,
      status: FinishedStatus,
      fields: { result?: string; summary?: string; error?: string; notified?: boolean; handoff?: string; usage?: TaskUsage } = {},
    ): boolean {
      return immediate(() => {
        const out = run(
          `UPDATE tasks SET status = ?, finished_at = ?, result = ?, summary = ?, error = ?, notified = ?, handoff = ?
           WHERE id = ? AND status = 'running'`,
          status, Date.now(), fields.result ?? null, fields.summary ?? null, fields.error ?? null, fields.notified ? 1 : 0,
          fields.handoff || null, id,
        );
        const { usage } = fields;
        if (usage) run('UPDATE tasks SET tokens_in = ?, tokens_out = ?, cost_usd = ? WHERE id = ?', usage.input, usage.output, usage.cost, id);
        return Number(out.changes) === 1;
      });
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

    /** /cancel: one queued task never starts; the reply tells the user. null unless the task was still queued. */
    cancelQueuedTask(accountId: string, seq: number, error: string): TaskRow | null {
      return immediate(() => {
        const task = taskBySeq(accountId, seq);
        if (task?.status !== 'queued') return null;
        run(
          "UPDATE tasks SET status = 'interrupted', finished_at = ?, error = ?, notified = 1 WHERE id = ? AND status = 'queued'",
          Date.now(), error, task.id,
        );
        return getTask(task.id)!;
      });
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

    // ── routines ─────────────────────────────────────────────────────────
    /** Returns the new routine, or null when the account already has one of that name. */
    addRoutine(
      accountId: string,
      routine: { name: string; prompt: string; schedule: string; nextRunAt: number; botId?: string; project?: TaskProject },
    ): RoutineRow | null {
      const id = randomUUID();
      const out = run(
        `INSERT INTO routines (id, account_id, name, prompt, bot_id, project_id, project_dir, schedule, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, name) DO NOTHING`,
        id, accountId, routine.name, routine.prompt, routine.botId ?? null, routine.project?.id ?? null,
        routine.project?.dir ?? null, routine.schedule, routine.nextRunAt, Date.now(),
      );
      return Number(out.changes) === 1 ? one<RoutineRow>('SELECT * FROM routines WHERE id = ?', id)! : null;
    },

    /** The account's routines, on or off, by name. */
    routines: (accountId: string) => all<RoutineRow>('SELECT * FROM routines WHERE account_id = ? ORDER BY name', accountId),

    routine: (accountId: string, name: string) =>
      one<RoutineRow>('SELECT * FROM routines WHERE account_id = ? AND name = ?', accountId, name),

    /** Its tasks stay, a queued one included. Returns false if it was gone already. */
    removeRoutine: (id: string): boolean => Number(run('DELETE FROM routines WHERE id = ?', id).changes) === 1,

    /** Enabling passes nextRunAt, so the routine counts from then; disabling keeps the stale one. */
    setRoutineEnabled(id: string, enabled: boolean, nextRunAt?: number): void {
      run(
        'UPDATE routines SET enabled = ?, next_run_at = COALESCE(?, next_run_at) WHERE id = ?',
        enabled ? 1 : 0, nextRunAt ?? null, id,
      );
    },

    /** /panic: every routine of the account goes off; /routine on brings one back. Returns how many were on. */
    disableAllRoutines: (accountId: string): number =>
      Number(run('UPDATE routines SET enabled = 0 WHERE account_id = ? AND enabled = 1', accountId).changes),

    /** Enabled routines of every account whose time has come, the longest due first. */
    dueRoutines: (now: number) =>
      all<RoutineRow>('SELECT * FROM routines WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, rowid', now),

    /** lastRunAt stays as it was when the scheduler skipped the run. */
    markRoutineRun(id: string, nextRunAt: number, lastRunAt: number | null): void {
      run('UPDATE routines SET next_run_at = ?, last_run_at = ? WHERE id = ?', nextRunAt, lastRunAt, id);
    },

    /** A routine runs one task at a time: true while one of its tasks is queued or running. */
    hasOpenRoutineTask: (routineId: string): boolean =>
      one("SELECT 1 FROM tasks WHERE routine_id = ? AND status IN ('queued', 'running')", routineId) !== undefined,
  };
}

export type StateDb = ReturnType<typeof openStateDb>;
