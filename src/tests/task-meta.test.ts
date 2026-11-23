// What a task records and what its prompts carry: the v9 usage columns and the tokens and cost /status and /tasks
// show, the v11 outcome and how /tasks and <recent_tasks> name it, a follow-up's text joined to the task it follows,
// a follow-up task created with the session it continues, and the prompts of a continued session.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { TaskRow, TaskUsage } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-task-meta-'));
// Config and logs follow HOME, state and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { openStateDb } = await import('../tasks/db.js');
const { composeContinuation, composePrompt, composeRetry, composeSteer, SESSION_READER } = await import('../orchestrator.js');
const { formatStatus, formatTasks } = await import('../commands/handlers.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const none = { paths: [], carried: false };

const file = join(tmp, 'state.db');
const db = openStateDb(file);
const raw = new DatabaseSync(file);

after(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A done task of the account, with the given usage, that finished at the given time. */
function finished(account: string, fields: { usage?: TaskUsage } = {}, at = Date.now()): TaskRow {
  const task = db.startTaskNow(account, '改 parser')!;
  db.finishTask(task.id, 'done', { result: 'ok', summary: '改了 parser', ...fields });
  raw.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run(at, task.id);
  return db.getTask(task.id)!;
}

test('a v8 database gains the usage columns, and the handoff column older binaries read, and keeps its rows', () => {
  const v8 = join(tmp, 'v8.db');
  const { task } = openStateDb(v8).createTask('acc', 'old task');
  const old = new DatabaseSync(v8);
  old.exec(
    'ALTER TABLE tasks DROP COLUMN handoff; ALTER TABLE tasks DROP COLUMN tokens_in; ' +
      'ALTER TABLE tasks DROP COLUMN tokens_out; ALTER TABLE tasks DROP COLUMN cost_usd; PRAGMA user_version = 8;',
  );
  const migrated = openStateDb(v8);
  const columns = old.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
  for (const column of ['handoff', 'tokens_in', 'tokens_out', 'cost_usd']) assert.ok(columns.includes(column), column);
  assert.equal((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 11);
  old.close();
  const row = migrated.getTask(task.id)!;
  assert.deepEqual([row.input, row.tokens_in, row.tokens_out, row.cost_usd], ['old task', null, null, null]);
});

test('finishTask stores the usage, even when /stop finished the task first', () => {
  const done = finished('fin', { usage: { input: 5000, output: 250, cost: 0.25 } });
  assert.deepEqual([done.tokens_in, done.tokens_out, done.cost_usd], [5000, 250, 0.25]);
  const bare = finished('fin');
  assert.deepEqual([bare.tokens_in, bare.tokens_out, bare.cost_usd], [null, null, null], 'unknown, not 0');
  const stopped = db.startTaskNow('fin', '跑测试')!;
  assert.ok(db.finishTask(stopped.id, 'interrupted', { error: '用户停止', notified: true }));
  assert.equal(db.finishTask(stopped.id, 'interrupted', { error: 'aborted', usage: { input: 10, output: 2, cost: 0 } }), false);
  const row = db.getTask(stopped.id)!;
  assert.deepEqual([row.error, row.tokens_in, row.tokens_out, row.cost_usd], ['用户停止', 10, 2, 0]);
});

test('usageSince sums what the tasks that finished since then used, and is 0 when none did', () => {
  const now = Date.now();
  finished('sum', { usage: { input: 1000, output: 100, cost: 0.5 } }, now - HOUR);
  finished('sum', { usage: { input: 200, output: 20, cost: 0 } }, now - 2 * HOUR);
  finished('sum', {}, now - 3 * HOUR);
  finished('sum', { usage: { input: 9999, output: 999, cost: 9 } }, now - 25 * HOUR);
  assert.deepEqual({ ...db.usageSince('sum', now - 24 * HOUR) }, { input: 1200, output: 120, cost: 0.5 });
  assert.deepEqual({ ...db.usageSince('sum', now - HOUR) }, { input: 1000, output: 100, cost: 0.5 }, 'finishing at since counts');
  assert.deepEqual({ ...db.usageSince('nobody', 0) }, { input: 0, output: 0, cost: 0 });
});

test("<recent_tasks> shows each task's session id, and <context> names this build's session reader", () => {
  const recalled = finished('ids');
  db.setTaskSession(recalled.id, 'ses_recall');
  finished('ids');
  const prompt = composePrompt(db, db.createTask('ids', '它做了什么').task, tmp, none);
  assert.match(prompt, new RegExp(`^#${recalled.seq} .+ \\[完成\\]（会话 ses_recall） 用户: 改 parser$`, 'm'));
  const tasks = prompt.split('\n').filter((line) => /^#\d+ /.test(line));
  assert.equal(tasks.filter((line) => line.includes('（会话 ')).length, 1, 'a task without a session shows none');
  assert.ok(prompt.split('\n').includes(`session-reader: node ${SESSION_READER} --session`), prompt);
  assert.doesNotMatch(prompt, /<last_handoff>/, 'a follow-up continues the session instead');
});

test('/status shows the tokens of the last 24 hours, and their cost when there is one', () => {
  const now = Date.now();
  finished('stat', { usage: { input: 1_200_000, output: 3_000, cost: 0.4 } }, now - HOUR);
  finished('stat', { usage: { input: 34_567, output: 400, cost: 0.02 } }, now - 2 * HOUR);
  finished('stat', { usage: { input: 9_000_000, output: 9_000, cost: 9 } }, now - 25 * HOUR);
  assert.match(formatStatus(db, 'stat'), /^📊 24h tokens: ↑1\.2M ↓3\.4k（\$0\.42）$/m);
  finished('free', { usage: { input: 5_000, output: 250, cost: 0 } });
  assert.match(formatStatus(db, 'free'), /^📊 24h tokens: ↑5k ↓250$/m, 'a model OpenCode has no price for costs 0');
  assert.match(formatStatus(db, 'quiet'), /^📊 24h tokens: ↑0 ↓0$/m);
});

test('/tasks shows what each task used, and its summary', () => {
  finished('list', { usage: { input: 5_000, output: 250, cost: 0.25 } });
  finished('list', { usage: { input: 23_456, output: 2_500, cost: 0 } });
  finished('list');
  const lines = formatTasks(db, 'list', 5).split('\n');
  assert.equal(lines.length, 6, lines.join('\n'));
  assert.match(lines[0], /^#3 .+\] 改 parser$/, 'no usage, no suffix');
  assert.match(lines[2], /^#2 .+\] 改 parser {2}↑23\.5k ↓2\.5k$/);
  assert.match(lines[4], /^#1 .+\] 改 parser {2}↑5k ↓250 \$0\.25$/);
  assert.equal(lines[5], '    改了 parser');
});

test('/tasks flags a task whose prompt tokens reach OWB_TASK_WARN_TOKENS, keeping its counts', () => {
  finished('warn', { usage: { input: 499_999, output: 100, cost: 0 } });
  finished('warn', { usage: { input: 500_000, output: 3_000, cost: 0.4 } });
  const lines = formatTasks(db, 'warn', 5).split('\n');
  assert.match(lines[0], /^#2 .+\] 改 parser {2}↑500k ↓3k \$0\.40 {2}⚠️$/);
  assert.match(lines[2], /^#1 .+\] 改 parser {2}↑500k ↓100$/, 'under the threshold: no mark');
  process.env.OWB_TASK_WARN_TOKENS = '1000';
  try {
    assert.match(formatTasks(db, 'warn', 5).split('\n')[2], /↓100 {2}⚠️$/, 'read on use');
  } finally {
    delete process.env.OWB_TASK_WARN_TOKENS;
  }
});

test('/tasks and <recent_tasks> name a done task that asked the user, was blocked or failed by its own report', () => {
  for (const outcome of ['needs_input', 'blocked', 'failed', 'done']) {
    const task = db.startTaskNow('outcome', '看下')!;
    db.finishTask(task.id, 'done', { result: 'ok', outcome });
  }
  const labels = formatTasks(db, 'outcome', 5)
    .split('\n')
    .filter((line) => line.startsWith('#'))
    .map((line) => /\[([^\]]+)\]/.exec(line)?.[1]);
  assert.deepEqual(labels, ['完成', '完成·没做成', '完成·受阻', '完成·等你回复']);
  const prompt = composePrompt(db, db.createTask('outcome', '那就 M1').task, tmp, none);
  assert.match(prompt, /^#1 .+ \[完成·等你回复\] 用户: 看下$/m);
});

test('a follow-up joins a task only while the task has one of the statuses given, on a line of its own', () => {
  const { task } = db.createTask('join', '看下日志');
  assert.equal(db.appendTaskInput(task.id, '还有 nginx 的', ['queued']), true);
  assert.equal(db.getTask(task.id)!.input, '看下日志\n还有 nginx 的');
  assert.equal(db.appendTaskInput(task.id, '晚了', ['running']), false, 'still queued');
  db.claimNextTask('join', 'write');
  assert.equal(db.appendTaskInput(task.id, '再看下 redis', ['queued']), false, 'started meanwhile');
  assert.equal(db.appendTaskInput(task.id, '再看下 redis', ['running']), true);
  db.finishTask(task.id, 'done', { result: 'ok' });
  assert.equal(db.appendTaskInput(task.id, '太晚了', ['queued', 'running']), false);
  assert.equal(db.getTask(task.id)!.input, '看下日志\n还有 nginx 的\n再看下 redis');
});

test('a follow-up task names the session it continues from the start; task_sessions keeps the task that ran there first', () => {
  const first = finished('cont');
  db.setTaskSession(first.id, 'ses_work');
  const { task } = db.createTask('cont', '继续', 'msg-1', undefined, undefined, 'write', undefined, 'ses_work');
  assert.equal(task.session_id, 'ses_work');
  assert.equal(task.status, 'queued');
  const owners = raw.prepare("SELECT task_id FROM task_sessions WHERE session_id = 'ses_work'").all().map((row) => row.task_id);
  assert.deepEqual(owners, [first.id]);
  assert.equal(db.createTask('cont', '新的').task.session_id, null, 'any other task starts without one');
});

test('a continued session gets what is new only: the time, the task number, the attachments, the memories, the message', () => {
  const task = db.createTask('next', '[图片]').task;
  const memories = [{ id: 'mem_a', text: '用户在 M5 上工作', full: true, date: '2026-11-18' }];
  const prompt = composeContinuation(task, { paths: ['/data/attachments/x/image-1.png'], carried: false }, memories);
  assert.match(
    prompt,
    new RegExp(
      `^<context>\\ntime: .+ \\(Asia/Shanghai\\)\\ntask: #${task.seq}\\nattachments:\\n- /data/attachments/x/image-1\\.png\\n</context>\\n\\n` +
        '<memory>\\n- \\[mem_a 2026-11-18\\] 用户在 M5 上工作\\n</memory>\\n\\n<user_message>\\n\\[图片\\] 请分析这张图片\\n</user_message>\\n\\n' +
        'This message follows up on the work in this session\\.',
    ),
  );
  assert.doesNotMatch(prompt, /<persona>|<recent_tasks>|<project>|workspace:/, 'the session has those already');
  assert.match(composeContinuation(db.createTask('next', '那第二个呢').task, none), /\n<memory>\n\(暂无\)\n<\/memory>\n/);
});

test('a retry names what stopped the attempt; a steer says that only the last answer reaches the user', () => {
  const retry = composeRetry(`上游模型 120 秒无响应${'。'.repeat(300)}`);
  assert.match(retry, /^<retry>\nYour previous attempt stopped: 上游模型 120 秒无响应。+…\n<\/retry>\n\n/);
  assert.match(retry, /Check the current state, then continue from where it stopped instead of starting over/);
  const steer = composeSteer('先别改测试，\n只看 src');
  assert.match(steer, /^<user_correction>\n先别改测试，\n只看 src\n<\/user_correction>\n\n/, 'line breaks kept');
  assert.match(steer, /Only your last wechat_report reaches the user, so if you have already reported, call wechat_report again/);
});
