// Lanes: a read-only bot's task runs beside a write task. The v6 lane column, each lane's claim and queue
// position, the queue's worker per lane, and /stop for both lanes.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';
import type { StateDb, TaskRow } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-lanes-'));
// Config and logs follow HOME, state and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { openStateDb } = await import('../tasks/db.js');
const { createTaskQueue } = await import('../tasks/queue.js');
const { createPermissionBroker } = await import('../permission.js');
const { routeCommand } = await import('../commands/router.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

/** Lets every pending promise callback run, so a lane can claim its next task. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Queue tasks of account "acc" in order; an input that starts with "r" goes to the read lane. */
const addTasks = (db: StateDb, ...inputs: string[]): TaskRow[] =>
  inputs.map((input) => db.createTask('acc', input, null, undefined, undefined, input.startsWith('r') ? 'read' : 'write').task);

test('a v5 database gains the lane column and its tasks are writes; new tasks store their lane', () => {
  const file = join(tmp, 'v5.db');
  const { task } = openStateDb(file).createTask('acc', 'old task');
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE tasks DROP COLUMN lane; PRAGMA user_version = 5;');
  const db = openStateDb(file);
  assert.ok(raw.prepare("SELECT name FROM pragma_table_info('tasks')").all().some((c) => c.name === 'lane'));
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
  raw.close();
  assert.deepEqual([db.getTask(task.id)?.input, db.getTask(task.id)?.lane], ['old task', 'write']);
  assert.equal(openStateDb(file).getTask(task.id)?.lane, 'write', 'opening again changes nothing');
  assert.equal(db.createTask('acc', 'hi').task.lane, 'write');
  assert.equal(db.createTask('acc', 'hi', 'm1', undefined, 'research', 'read').task.lane, 'read');
});

test('each lane claims its own oldest task, and only tasks of the same lane count as ahead', () => {
  const db = openStateDb(join(tmp, 'claim.db'));
  const [w1, r1, w2, r2, r3] = addTasks(db, 'w1', 'r1', 'w2', 'r2', 'r3');
  assert.deepEqual([w1, r1, w2, r2, r3].map((t) => db.countAhead('acc', t.id)), [0, 0, 1, 1, 2]);
  assert.equal(db.claimNextTask('acc', 'read')?.id, r1.id, 'the read lane does not wait for the older write');
  assert.equal(db.claimNextTask('acc', 'read'), null, 'one read at a time');
  assert.equal(db.claimNextTask('acc', 'write')?.id, w1.id);
  assert.equal(db.claimNextTask('acc', 'write'), null, 'one write at a time');
  assert.deepEqual(db.runningTasks('acc').map((t) => t.input), ['w1', 'r1'], 'oldest first');
  // The lane's running task plus its older queued tasks.
  assert.deepEqual([w2, r2, r3].map((t) => db.countAhead('acc', t.id)), [1, 1, 2]);
  db.finishTask(r1.id, 'done');
  assert.equal(db.claimNextTask('acc', 'read')?.id, r2.id, 'the next read starts while the write still runs');
  assert.equal(db.countAhead('acc', r3.id), 1);
  // --simulate starts a task only while its lane is free.
  assert.ok(db.startTaskNow('sim', 'w'));
  assert.equal(db.startTaskNow('sim', 'w'), null);
  assert.equal(db.startTaskNow('sim', 'r', undefined, 'research', 'read')?.lane, 'read');
});

test('the queue runs a read task beside a write task, and each lane waits only for itself', async () => {
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
    assert.deepEqual([started, finished], [['w1', 'r1'], []], 'both lanes start before either finishes');
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

test('a runner crash fails only its task, the lane goes on, and the outbox hears of it', async () => {
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

test('/stop stops the running task of both lanes and names them; /stop all also empties both queues', async () => {
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
  // Each lane moves on to its next task.
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
