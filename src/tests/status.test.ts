// /status: the running task of each lane, and its health: the last 24 hours' outcomes and latest failure, the
// open breakers, the outbox backlog and the message token's age, never the token itself.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';
import type { FinishedStatus, TaskRow } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-status-'));
// Config and logs follow HOME, state, memory and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
delete process.env.OWB_BREAKER_THRESHOLD;
delete process.env.OWB_BREAKER_COOLDOWN_MS;

const { openStateDb } = await import('../tasks/db.js');
const { formatStatus } = await import('../commands/handlers.js');
const { routeCommand } = await import('../commands/router.js');
const { breaker, resetModelRouting } = await import('../model-routing.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const TOKEN = 'secret-context-token';
const LONG_ERROR = 'x'.repeat(80);

const file = join(tmp, 'state.db');
const db = openStateDb(file);
const raw = new DatabaseSync(file);
const now = Date.now();

after(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A task of the account that finished with the given status at the given time. */
function finished(status: FinishedStatus, at: number, error: string | null = null, account = 'acc'): TaskRow {
  const { task } = db.createTask(account, 'hi');
  raw.prepare('UPDATE tasks SET status = ?, finished_at = ?, error = ? WHERE id = ?').run(status, at, error, task.id);
  return db.getTask(task.id)!;
}

finished('done', now - HOUR);
finished('failed', now - 25 * HOUR, 'too old to count');
finished('failed', now - 2 * HOUR, 'an earlier failure');
const latest = finished('failed', now - 30 * MINUTE, LONG_ERROR);
finished('interrupted', now - 3 * HOUR, '用户停止');
finished('failed', now - MINUTE, 'another account', 'other');
db.createTask('acc', 'still queued');

test('statusCountsSince counts finished tasks by outcome from a time on, and lastFailure finds the latest failure', () => {
  assert.deepEqual(db.statusCountsSince('acc', now - 24 * HOUR), { done: 1, failed: 2, interrupted: 1 });
  assert.deepEqual(db.statusCountsSince('acc', now - HOUR), { done: 1, failed: 1, interrupted: 0 }, 'finishing at since counts');
  assert.deepEqual(db.statusCountsSince('nobody', 0), { done: 0, failed: 0, interrupted: 0 });
  const last = db.lastFailure('acc', now - 24 * HOUR);
  assert.equal(last?.id, latest.id);
  assert.equal(last?.seq, 4);
  assert.equal(last?.error, LONG_ERROR);
  assert.equal(db.lastFailure('acc', now - 10 * MINUTE), undefined);
});

test('/status adds the 24-hour outcomes, the open breakers, the outbox backlog and the token age, but not the token', async () => {
  const first = db.addNotice('acc', 'first');
  db.addNotice('acc', 'second');
  raw.prepare('UPDATE pending_notices SET created_at = ? WHERE id = ?').run(now - 90 * MINUTE, first);
  db.markNoticeFailed(first, 2, 0);
  db.saveContextToken('acc', 'wx', TOKEN);
  raw.prepare('UPDATE users SET context_token_at = ? WHERE account_id = ?').run(now - 5 * MINUTE, 'acc');
  for (let i = 0; i < breaker.threshold; i++) {
    breaker.recordFailure('oneapi', now);
    breaker.recordFailure('oneapi-chat-gpt', now - 3 * MINUTE);
    // Opened 20 minutes ago for 10 minutes: past its cooldown, so not listed.
    breaker.recordFailure('oneapi-gemini', now - 20 * MINUTE);
  }

  const status = await routeCommand('/status', { accountId: 'acc', db } as CommandContext);
  assert.match(status, new RegExp(`^🩺 24小时: 完成 1，失败 2，中断 1（最近失败 \\d{2}:\\d{2} 任务 #4：${'x'.repeat(60)}…）$`, 'm'));
  assert.match(status, /^🧯 熔断: oneapi（剩 10 分钟），oneapi-chat-gpt（剩 7 分钟）$/m);
  assert.match(status, /^📮 待补发: 2 条（最久 1小时30分，重试 2 次）$/m);
  assert.match(status, /^🔑 消息令牌: 5分钟前$/m);
  assert.ok(!status.includes(TOKEN), 'the token itself is a credential');
  // The lines before the health lines are as they were.
  assert.match(status, /^⏳ 排队: 1 个$/m);
  assert.match(status, /^📊 累计: 6 个任务（完成 1，失败 3，中断 1）$/m);
});

test('/status of a quiet account: nothing failed, no breaker open, no outbox line, no token yet', async () => {
  resetModelRouting();
  db.ensureUser('quiet', 'wx-quiet');
  const status = await routeCommand('/status', { accountId: 'quiet', db } as CommandContext);
  assert.match(status, /^▶️ 运行中: 无$/m);
  assert.match(status, /^🩺 24小时: 完成 0，失败 0，中断 0$/m);
  assert.match(status, /^🧯 熔断: 无$/m);
  assert.doesNotMatch(status, /📮/);
  assert.match(status, /^🔑 消息令牌: 无$/m);
});

test('/status shows the running task of each lane, oldest first, with its lane', () => {
  const { task: write } = db.createTask('busy', '跑下测试', null, undefined, 'eng');
  const { task: read } = db.createTask('busy', '看下日志', null, undefined, 'research', 'read');
  assert.match(formatStatus(db, 'busy'), /^▶️ 运行中: 无$/m, 'queued tasks are not running');
  db.claimNextTask('busy', 'read');
  db.claimNextTask('busy', 'write');
  raw.prepare('UPDATE tasks SET started_at = ? WHERE id = ?').run(Date.now() - 3 * MINUTE, write.id);
  raw.prepare('UPDATE tasks SET started_at = ? WHERE id = ?').run(Date.now() - 40_000, read.id);
  assert.match(
    formatStatus(db, 'busy'),
    /^▶️ 运行中: #1 @eng 跑下测试（write，已运行 3分钟）；#2 @research 看下日志（read，已运行 40秒）$/m,
  );
});

test('--status has no breaker state to show, so it says where to look instead of "无"', () => {
  assert.match(formatStatus(db, 'acc'), /^🧯 熔断: 仅 bot 进程内可见，在微信发送 \/status 查看$/m);
});
