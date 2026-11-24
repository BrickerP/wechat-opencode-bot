// Independent SQLite connections share the account limit, the reserved slot, and the session lock.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';
import type { StateDb, TaskRow } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-slots-'));
process.env.OWB_MAX_TASKS = '2';
// Config and logs follow HOME, state and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { openStateDb } = await import('../tasks/db.js');
const { createTaskQueue } = await import('../tasks/queue.js');
const { createPermissionBroker } = await import('../permission.js');
const { routeCommand } = await import('../commands/router.js');
const { prepareWorkspace } = await import('../tasks/worktree.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

test('worktree only for a contended single repository; reuse it for the next turn', async () => {
  for (const kind of ['single', 'nested', 'nonrepo', 'base', 'unregistered', 'failure']) {
    const dir = mkdtempSync(join(tmp, 'checkout-'));
    if (kind !== 'nonrepo') execFileSync('git', ['init', '-q', dir]);
    if (kind === 'nested') {
      const nested = join(dir, 'one/two/three/four');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, '.git'), 'gitdir: elsewhere');
    }
    const project = kind === 'unregistered' ? undefined : { id: kind, dir };
    const db = openStateDb(join(tmp, `${kind}.db`));
    const owner = db.startTaskNow('a', 'first', project)!;
    let calls = 0;
    const create = async (root: string, name: string) => {
      calls++;
      assert.deepEqual([root, name], [dir, 'wechat-2']);
      if (kind === 'failure') throw new Error('disk full');
      return `${dir}-isolated`;
    };
    assert.ok(await prepareWorkspace(db, owner, create));
    assert.equal(calls, 0);
    const second = db.startTaskNow('a', 'second', project)!;
    assert.equal(await prepareWorkspace(db, second, create), kind !== 'failure');
    assert.equal(calls, Number(kind === 'single' || kind === 'failure'));
    if (kind === 'single') {
      db.setTaskSession(second.id, 'session');
      db.finishTask(second.id, 'done');
      const next = db.startTaskNow('a', 'continue', project, undefined, 'session')!;
      assert.equal(next.worktree_dir, `${dir}-isolated`);
      assert.ok(await prepareWorkspace(db, next, create));
      assert.equal(calls, 1);
    } else if (kind === 'failure') {
      db.createTask('a', 'unrelated');
      assert.equal(db.getTask(second.id)?.status, 'queued');
      assert.equal(db.claimNextTask('a')?.input, 'unrelated');
      db.finishTask(owner.id, 'done');
      const retry = db.claimNextTask('a')!;
      assert.equal(retry.id, second.id);
      assert.ok(await prepareWorkspace(db, retry, create));
      assert.equal(calls, 1);
    }
  }
});

/** Let a finished runner release its slot. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const addTasks = (db: StateDb, ...inputs: string[]): TaskRow[] =>
  inputs.map((input) => db.createTask('acc', input).task);

test('migration keeps old rows and the lane default for rollback', () => {
  const file = join(tmp, 'v5.db');
  const { task } = openStateDb(file).createTask('acc', 'old task');
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE tasks DROP COLUMN lane; PRAGMA user_version = 5;');
  const db = openStateDb(file);
  assert.ok(raw.prepare("SELECT name FROM pragma_table_info('tasks')").all().some((c) => c.name === 'lane'));
  assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 12);
  assert.equal(raw.prepare('SELECT lane FROM tasks').get()?.lane, 'write');
  raw.close();
  assert.deepEqual([db.getTask(task.id)?.input, db.getTask(task.id)?.worktree_dir], ['old task', null]);
});

test('new work cannot consume the last slot; oldest eligible continuation starts, never two turns in one session', () => {
  const file = join(tmp, 'claim.db');
  const db = openStateDb(file), other = openStateDb(file);
  const [a, b, c] = addTasks(db, 'a', 'b', 'c');
  assert.equal(db.claimNextTask('acc')?.id, a.id);
  assert.equal(other.claimNextTask('acc')?.id, b.id);
  db.setTaskSession(a.id, 'busy');
  for (const session of ['busy', 'free']) db.createTask('acc', session, null, undefined, undefined, undefined, session);
  assert.equal(other.claimNextTask('acc')?.input, 'free');
  assert.equal(db.claimNextTask('acc'), null);
  db.finishTask(a.id, 'done');
  assert.equal(db.claimNextTask('acc')?.input, 'busy');
  for (const task of db.runningTasks('acc')) db.finishTask(task.id, 'done');
  assert.equal(db.claimNextTask('acc')?.id, c.id);
});

test('the queue fills ordinary slots and refills each as soon as its runner finishes', async () => {
  const db = openStateDb(join(tmp, 'queue.db'));
  addTasks(db, 'w1', 'r1', 'r2', 'w2');
  const started: string[] = [];
  const finished: string[] = [];
  const release = new Map<string, () => void>();
  const queue = createTaskQueue(
    db,
    async (task) => {
      started.push(task.input);
      await new Promise<void>((resolve) => release.set(task.input, resolve));
      db.finishTask(task.id, 'done');
      finished.push(task.input);
    },
    () => {},
  );
  const stopPolling = queue.start('acc');
  try {
    assert.deepEqual([started, finished], [['w1', 'r1'], []]);
    release.get('r1')!();
    await settle();
    assert.deepEqual(started, ['w1', 'r1', 'r2'], 'the second read follows the first read, not the write');
    release.get('w1')!();
    await settle();
    assert.deepEqual(started, ['w1', 'r1', 'r2', 'w2'], 'the second write waited for the first write');
    release.get('r2')!();
    release.get('w2')!();
    await settle();
    assert.deepEqual(finished, ['r1', 'w1', 'r2', 'w2']);
    assert.equal(db.statusCounts('acc').done, 4);
  } finally {
    stopPolling();
  }
});

test('a runner crash fails only its task and the outbox hears of it', async () => {
  const db = openStateDb(join(tmp, 'crash.db'));
  const [r1, r2] = addTasks(db, 'r1', 'r2');
  const flushed: string[] = [];
  const queue = createTaskQueue(
    db,
    async (task) => {
      if (task.input === 'r1') throw new Error('boom');
      db.finishTask(task.id, 'done');
    },
    (accountId) => flushed.push(accountId),
  );
  queue.kick('acc');
  await settle();
  assert.deepEqual([db.getTask(r1.id)?.status, db.getTask(r1.id)?.error, db.getTask(r2.id)?.status], ['failed', 'boom', 'done']);
  assert.deepEqual(flushed, ['acc']);
});

test('/stop names and stops all running tasks; /stop all also empties the queue', async () => {
  const db = openStateDb(join(tmp, 'stop.db'));
  addTasks(db, 'w1', 'r1', 'w2', 'r2');
  const aborted: string[] = [];
  // Every task runs until it is stopped.
  const queue = createTaskQueue(
    db,
    (task, signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => {
          aborted.push(task.input);
          resolve();
        }),
      ),
    () => {},
  );
  const ctx: CommandContext = { accountId: 'acc', db, queue, broker: createPermissionBroker() };
  queue.kick('acc');
  assert.equal(await routeCommand('/stop', ctx), '⏹ 已停止：任务 #1、#2');
  assert.deepEqual([...aborted].sort(), ['r1', 'w1']);
  // Both free slots take new tasks.
  await settle();
  addTasks(db, 'w3', 'r3');
  assert.equal(await routeCommand('/stop all', ctx), '⏹ 已停止：任务 #3、#4\n🗑 已取消 2 个排队任务');
  await settle();
  assert.deepEqual([...aborted].sort(), ['r1', 'r2', 'w1', 'w2']);
  assert.deepEqual(
    db.recentTasks('acc', 6).reverse().map((t) => [t.input, t.status, t.error, t.notified]),
    [
      ['w1', 'interrupted', '用户停止', 1],
      ['r1', 'interrupted', '用户停止', 1],
      ['w2', 'interrupted', '用户停止', 1],
      ['r2', 'interrupted', '用户停止', 1],
      ['w3', 'interrupted', '用户取消', 1],
      ['r3', 'interrupted', '用户取消', 1],
    ],
  );
  assert.equal(await routeCommand('/stop', ctx), '没有运行中的任务');
});
