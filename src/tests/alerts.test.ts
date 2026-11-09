// The failure alert: enough failed tasks within the window queue one notice, then the account stays quiet for
// the cooldown.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import type { StateDb } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-alerts-'));
// Logs follow HOME, state OWB_DATA_DIR: keep both away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
delete process.env.OWB_FAILURE_ALERT_COUNT;
delete process.env.OWB_FAILURE_ALERT_WINDOW_MS;
delete process.env.OWB_FAILURE_ALERT_COOLDOWN_MS;

const { maybeAlertFailures, resetAlerts } = await import('../alerts.js');
const { openStateDb } = await import('../tasks/db.js');

const MINUTE = 60 * 1000;
const file = join(tmp, 'state.db');
const db = openStateDb(file);
const raw = new DatabaseSync(file);
const alert = (failed: number, minutes = 30): string =>
  `🚨 最近 ${minutes} 分钟有 ${failed} 个任务失败，发送 /status 查看；网关故障会自动切换备用模型。`;

beforeEach(() => resetAlerts());

after(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A task of the account that failed at the given time. */
function fail(at: number, account = 'acc'): void {
  const { task } = db.createTask(account, 'hi');
  raw.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = 'boom' WHERE id = ?").run(at, task.id);
}

const notices = (account = 'acc'): string[] => db.pendingNotices(account).map((n) => n.text);

test('3 failures within 30 minutes queue one alert; a 4th in the cooldown does not; after it another goes out', () => {
  const t0 = Date.now();
  fail(t0 - 40 * MINUTE);
  fail(t0 - 2 * MINUTE);
  fail(t0 - MINUTE);
  assert.equal(maybeAlertFailures(db, 'acc', t0), false, 'the failure 40 minutes ago is outside the window');
  assert.deepEqual(notices(), []);

  fail(t0);
  assert.equal(maybeAlertFailures(db, 'acc', t0), true);
  assert.deepEqual(notices(), [alert(3)]);

  fail(t0 + 10 * MINUTE);
  assert.equal(maybeAlertFailures(db, 'acc', t0 + 10 * MINUTE), false, 'within the cooldown');
  assert.deepEqual(notices(), [alert(3)]);

  // 31 minutes on, the window holds the failure at t0 + 10 minutes and two new ones.
  const t1 = t0 + 31 * MINUTE;
  fail(t1);
  fail(t1);
  assert.equal(maybeAlertFailures(db, 'acc', t1), true);
  assert.deepEqual(notices(), [alert(3), alert(3)]);

  assert.equal(maybeAlertFailures(db, 'acc', t1), false);
  resetAlerts();
  assert.equal(maybeAlertFailures(db, 'acc', t1), true, 'resetAlerts forgets when the account was alerted');
  assert.equal(notices().length, 3);
});

test('the settings apply on every call, and the alert names the actual count and window', () => {
  const now = Date.now();
  for (let i = 0; i < 4; i++) fail(now - i * MINUTE, 'big');
  fail(now - 15 * MINUTE, 'big');
  process.env.OWB_FAILURE_ALERT_WINDOW_MS = String(10 * MINUTE);
  process.env.OWB_FAILURE_ALERT_COUNT = '5';
  try {
    assert.equal(maybeAlertFailures(db, 'big', now), false, 'only 4 failed within 10 minutes');
    process.env.OWB_FAILURE_ALERT_COUNT = '4';
    assert.equal(maybeAlertFailures(db, 'big', now), true);
    assert.deepEqual(notices('big'), [alert(4, 10)]);
    process.env.OWB_FAILURE_ALERT_COOLDOWN_MS = String(MINUTE);
    assert.equal(maybeAlertFailures(db, 'big', now + 2 * MINUTE), true, 'a 1-minute cooldown is over');
    assert.deepEqual(notices('big'), [alert(4, 10), alert(4, 10)]);
  } finally {
    delete process.env.OWB_FAILURE_ALERT_WINDOW_MS;
    delete process.env.OWB_FAILURE_ALERT_COUNT;
    delete process.env.OWB_FAILURE_ALERT_COOLDOWN_MS;
  }
});

test('each account has its own cooldown', () => {
  const now = Date.now();
  for (const account of ['a', 'b']) {
    for (let i = 0; i < 3; i++) fail(now, account);
    assert.equal(maybeAlertFailures(db, account, now), true, account);
  }
  assert.deepEqual([notices('a'), notices('b')], [[alert(3)], [alert(3)]]);
});

test('an alert that cannot be queued is logged, never thrown into the task path', () => {
  const broken = {
    statusCountsSince: () => {
      throw new Error('database is locked');
    },
  } as unknown as StateDb;
  assert.equal(maybeAlertFailures(broken, 'acc'), false);
});
