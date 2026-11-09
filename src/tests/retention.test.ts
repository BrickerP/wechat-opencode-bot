// Session retention: which sessions may go, the order they go in through the OpenCode API, and a cleanup that
// counts what fails and never throws.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { RetentionApi } from '../retention.js';
import type { StateDb, TaskStatus } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-retention-'));
// Logs follow HOME, state OWB_DATA_DIR: keep both away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
process.env.OPENCODE_SERVER_PASSWORD = '';
delete process.env.OWB_SESSION_TTL_DAYS;
// A handful of tasks is enough to prune; the settings test checks the default.
process.env.OWB_SESSION_KEEP = '1';

// The fake OpenCode server answers each URL as the test set it, and any other one like a route it does not have.
const answers = new Map<string, { status: number; body?: string }>();
const requests: string[] = [];
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  const answer = answers.get(req.url ?? '') ?? { status: 404, body: '{"error":"no such route"}' };
  res.writeHead(answer.status, { 'content-type': 'application/json' });
  res.end(answer.body);
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
// The provider reads it when it loads.
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const { pruneSessions } = await import('../retention.js');
const { deleteSession } = await import('../opencode/provider.js');
const { openStateDb } = await import('../tasks/db.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-09T12:00:00Z');
const T0 = NOW.getTime();
const raws: DatabaseSync[] = [];

after(() => {
  for (const raw of raws) raw.close();
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A state.db of the test's own, and a way to add a task with a given status, session and finish time. */
function fresh(name: string) {
  const file = join(tmp, `${name}.db`);
  const db = openStateDb(file);
  const raw = new DatabaseSync(file);
  raws.push(raw);
  const seed = (status: TaskStatus, sessionId: string | null, finishedAt: number | null): string => {
    const { task } = db.createTask('acc', 'hi');
    raw.prepare('UPDATE tasks SET status = ?, session_id = ?, finished_at = ? WHERE id = ?').run(status, sessionId, finishedAt, task.id);
    return task.id;
  };
  return { db, seed };
}

/** OpenCode's 404 body for a session it does not have. */
const notFound = (id: string): string =>
  JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: id, message: `Session not found: ${id}` });

/** A RetentionApi that records its calls and fails for the ids named. */
function fakeApi(children: Record<string, string[]> = {}, fail: { list?: string[]; remove?: string[] } = {}) {
  const calls: string[] = [];
  const api: RetentionApi = {
    async listChildren(sessionId) {
      calls.push(`list ${sessionId}`);
      if (fail.list?.includes(sessionId)) throw new Error('fetch failed');
      return (children[sessionId] ?? []).map((id) => ({ id }));
    },
    async deleteSession(sessionId) {
      calls.push(`delete ${sessionId}`);
      if (fail.remove?.includes(sessionId)) throw new Error(`DELETE /api/session/${sessionId} -> HTTP 500: boom`);
    },
  };
  return { api, calls };
}

const LOGS = join(tmp, '.wechat-opencode-bot', 'logs');
const logText = (): string => readdirSync(LOGS).sort().map((name) => readFileSync(join(LOGS, name), 'utf-8')).join('');
/** The fields of the last Session retention line. */
function lastSummary(): unknown {
  const line = logText().split('\n').filter((l) => l.includes(' INFO Session retention {')).at(-1)!;
  return JSON.parse(line.slice(line.indexOf('{')));
}

test('staleSessionIds: sessions of tasks finished before the cutoff, oldest first, except the newest keep', () => {
  const { db, seed } = fresh('stale');
  seed('done', 'ses_c', T0 - 8 * DAY);
  const a = seed('failed', 'ses_a', T0 - 10 * DAY);
  seed('interrupted', 'ses_b', T0 - 9 * DAY);
  seed('done', 'ses_recent', T0 - DAY);
  // Nothing to delete: one failed before it had a session, one is still queued, one still runs.
  seed('failed', null, T0 - 20 * DAY);
  seed('queued', null, null);
  seed('running', 'ses_running', null);

  const cutoff = T0 - 7 * DAY;
  assert.deepEqual(db.staleSessionIds(cutoff, 1), ['ses_a', 'ses_b', 'ses_c']);
  assert.deepEqual(db.staleSessionIds(cutoff, 2), ['ses_a', 'ses_b'], 'ses_c is among the newest 2');
  assert.deepEqual(db.staleSessionIds(cutoff, 4), [], 'every finished session is among the newest 4');
  assert.deepEqual(db.staleSessionIds(T0 - 9.5 * DAY, 1), ['ses_a'], 'ses_b finished after that cutoff');

  db.forgetSession('ses_a');
  assert.deepEqual(db.staleSessionIds(cutoff, 1), ['ses_b', 'ses_c']);
  assert.equal(db.getTask(a)?.status, 'failed', 'the task stays');
  assert.equal(db.getTask(a)?.session_id, null);
});

test('deleteSession: deleted or already gone resolves; any other failure rejects, a 404 from a missing route too', async () => {
  answers.clear();
  requests.length = 0;
  answers.set('/api/session/ses_ok', { status: 204 });
  answers.set('/api/session/ses_gone', { status: 404, body: notFound('ses_gone') });
  answers.set('/api/session/ses_boom', { status: 500, body: '{"error":"boom"}' });

  await deleteSession('ses_ok');
  await deleteSession('ses_gone');
  await assert.rejects(deleteSession('ses_boom'), /HTTP 500/);
  // No proof the session is gone, so retention keeps it and tries again.
  await assert.rejects(deleteSession('ses_unrouted'), /HTTP 404/);
  // An id stays one path segment and never reaches another route.
  await assert.rejects(deleteSession('../info'), /HTTP 404/);
  assert.deepEqual(requests, [
    'DELETE /api/session/ses_ok',
    'DELETE /api/session/ses_gone',
    'DELETE /api/session/ses_boom',
    'DELETE /api/session/ses_unrouted',
    'DELETE /api/session/..%2Finfo',
  ]);
});

test('pruneSessions goes through the OpenCode API, subagent sessions before their parent, and forgets what went', async () => {
  answers.clear();
  requests.length = 0;
  const { db, seed } = fresh('api');
  const tree = seed('done', 'ses_tree', T0 - 12 * DAY);
  const gone = seed('failed', 'ses_gone', T0 - 10 * DAY);
  // Past the TTL as well, but the newest: KEEP=1 spares it.
  const kept = seed('done', 'ses_kept', T0 - 8 * DAY);
  answers.set('/api/session?parentID=ses_tree&limit=50', {
    status: 200,
    body: JSON.stringify({ data: [{ id: 'ses_tree_1', title: 'Fix the login bug' }, { id: 'ses_tree_2', title: 'Run the tests' }] }),
  });
  for (const id of ['ses_tree_1', 'ses_tree_2', 'ses_tree']) answers.set(`/api/session/${id}`, { status: 204 });
  // Someone deleted this one already.
  answers.set('/api/session?parentID=ses_gone&limit=50', { status: 200, body: '{"data":[]}' });
  answers.set('/api/session/ses_gone', { status: 404, body: notFound('ses_gone') });

  assert.deepEqual(await pruneSessions(db, undefined, NOW), { deleted: 4, failed: 0 });
  assert.deepEqual(requests, [
    'GET /api/session?parentID=ses_tree&limit=50',
    'DELETE /api/session/ses_tree_1',
    'DELETE /api/session/ses_tree_2',
    'DELETE /api/session/ses_tree',
    'GET /api/session?parentID=ses_gone&limit=50',
    'DELETE /api/session/ses_gone',
  ]);
  assert.equal(db.getTask(tree)?.session_id, null);
  assert.equal(db.getTask(gone)?.session_id, null);
  assert.equal(db.getTask(kept)?.session_id, 'ses_kept');
  assert.deepEqual(lastSummary(), { deleted: 4, failed: 0, cutoff: '2026-11-02T12:00:00.000Z', keep: 1 });
  assert.ok(!logText().includes('Fix the login bug'), 'no session titles in the log');

  // The next run has nothing to ask OpenCode.
  requests.length = 0;
  assert.deepEqual(await pruneSessions(db, undefined, NOW), { deleted: 0, failed: 0 });
  assert.deepEqual(requests, []);
});

test('a failed delete is counted and the rest go on; a session whose children cannot be listed waits', async () => {
  const { db, seed } = fresh('failures');
  seed('done', 'ses_a', T0 - 12 * DAY);
  seed('done', 'ses_b', T0 - 11 * DAY);
  seed('done', 'ses_c', T0 - 10 * DAY);
  seed('done', 'ses_recent', T0 - DAY);
  const { api, calls } = fakeApi({ ses_a: ['ses_a_1', 'ses_a_2'] }, { list: ['ses_b'], remove: ['ses_a_1', 'ses_c'] });

  assert.deepEqual(await pruneSessions(db, api, NOW), { deleted: 2, failed: 3 });
  assert.deepEqual(calls, ['list ses_a', 'delete ses_a_1', 'delete ses_a_2', 'delete ses_a', 'list ses_b', 'list ses_c', 'delete ses_c']);
  // ses_a took ses_a_1 with it; the next run tries ses_b and ses_c again.
  assert.deepEqual(db.staleSessionIds(T0 - 7 * DAY, 1), ['ses_b', 'ses_c']);
});

test('TTL and KEEP are read on every run, 7 days and 300 tasks by default; now moves the cutoff', async () => {
  const { db, seed } = fresh('settings');
  seed('done', 'ses_3d', T0 - 3 * DAY);
  seed('done', 'ses_2d', T0 - 2 * DAY);
  seed('done', 'ses_1d', T0 - DAY);
  const { api, calls } = fakeApi();
  const later = new Date(T0 + 30 * DAY);
  try {
    delete process.env.OWB_SESSION_KEEP;
    assert.deepEqual(await pruneSessions(db, api, later), { deleted: 0, failed: 0 }, 'all 3 are among the newest 300');
    assert.deepEqual(lastSummary(), { deleted: 0, failed: 0, cutoff: '2026-12-02T12:00:00.000Z', keep: 300 });
    assert.deepEqual(calls, []);

    process.env.OWB_SESSION_KEEP = '1';
    assert.deepEqual(await pruneSessions(db, api, NOW), { deleted: 0, failed: 0 }, 'none finished 7 days ago');
    process.env.OWB_SESSION_TTL_DAYS = '2.5';
    assert.deepEqual(await pruneSessions(db, api, NOW), { deleted: 1, failed: 0 });
    assert.deepEqual(await pruneSessions(db, api, later), { deleted: 1, failed: 0 }, 'ses_1d is the newest');
    assert.deepEqual(calls, ['list ses_3d', 'delete ses_3d', 'list ses_2d', 'delete ses_2d']);
  } finally {
    process.env.OWB_SESSION_KEEP = '1';
    delete process.env.OWB_SESSION_TTL_DAYS;
  }
});

test('pruneSessions never throws: with OpenCode down or state.db broken it logs, counts and returns', async () => {
  const { db, seed } = fresh('down');
  seed('done', 'ses_x', T0 - 9 * DAY);
  seed('done', 'ses_y', T0 - 8 * DAY);
  seed('done', 'ses_recent', T0 - DAY);
  const down = fakeApi({}, { list: ['ses_x', 'ses_y'] });
  assert.deepEqual(await pruneSessions(db, down.api, NOW), { deleted: 0, failed: 2 });
  assert.deepEqual(down.calls, ['list ses_x', 'list ses_y'], 'no delete without the children');
  assert.deepEqual(db.staleSessionIds(T0 - 7 * DAY, 1), ['ses_x', 'ses_y'], 'the next run tries again');

  const broken = { staleSessionIds: () => { throw new Error('database is locked'); } } as unknown as StateDb;
  assert.deepEqual(await pruneSessions(broken, fakeApi().api, NOW), { deleted: 0, failed: 0 });
});
