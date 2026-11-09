// The queue ack's estimate: how long the recent done tasks ran, and the wait built from their median.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'owb-eta-'));
// Logs follow HOME, state OWB_DATA_DIR: keep both away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { openStateDb } = await import('../tasks/db.js');
const { formatQueueAck } = await import('../orchestrator.js');

const MIN = 60_000;

after(() => rmSync(tmp, { recursive: true, force: true }));

test('only done tasks with both timestamps count, newest first', () => {
  const file = join(tmp, 'state.db');
  const db = openStateDb(file);
  const raw = new DatabaseSync(file);
  const t0 = Date.now() - 60 * MIN;
  const add = (status: string, started: number | null, finished: number | null, account = 'acc') =>
    raw
      .prepare('UPDATE tasks SET status = ?, started_at = ?, finished_at = ? WHERE id = ?')
      .run(status, started, finished, db.createTask(account, 'x').task.id);
  add('done', t0, t0 + MIN);
  add('failed', t0, t0 + 9 * MIN);
  add('queued', null, null);
  add('done', null, t0 + 9 * MIN);
  add('done', t0 + 9 * MIN, t0); // finished before it started: the clock went back
  add('done', t0, t0 + 9 * MIN, 'other');
  add('done', t0, t0 + 2 * MIN);
  raw.close();
  assert.deepEqual(db.recentDurations('acc'), [2 * MIN, MIN]);
  assert.deepEqual(db.recentDurations('acc', 1), [2 * MIN]);
  assert.deepEqual(db.recentDurations('nobody'), []);
});

test('the ack estimates the wait as the median run time once per task ahead, in whole minutes', () => {
  const ack = '⏳ 已排队：任务 #7（前面还有 2 个任务）';
  assert.equal(formatQueueAck(7, 2, []), ack, 'no history, no estimate');
  assert.equal(formatQueueAck(7, 2, [10 * MIN, MIN, 3 * MIN]), `${ack}，预计约 6 分钟`);
  assert.equal(formatQueueAck(7, 2, [MIN, 10 * MIN, 2 * MIN, 3 * MIN]), `${ack}，预计约 5 分钟`, 'the mean of the middle two');
  assert.equal(formatQueueAck(7, 2, [45_000]), `${ack}，预计约 2 分钟`, '90 seconds rounds up');
  assert.equal(formatQueueAck(7, 2, [10_000, 20_000]), `${ack}，预计不到 1 分钟`);
  assert.equal(formatQueueAck(7, 2, [90 * MIN]), `${ack}，预计约 180 分钟`, 'no cap');
});
