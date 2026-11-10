// What a task leaves the next one and what it used: the handoff the orchestrator writes after its summary, the
// <last_handoff> block the next task's prompt carries while it is fresh, the v9 columns that store both, and the
// tokens and cost /status and /tasks show.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { TaskRow, TaskUsage } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-task-meta-'));
// Config and logs follow HOME, state, memory and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { openStateDb } = await import('../tasks/db.js');
const { composePrompt, parseOrchestratorOutput } = await import('../orchestrator.js');
const { formatStatus, formatTasks } = await import('../commands/handlers.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const HANDOFF = 'files: /repo/src/parser.ts\ncommands: npm test\nopen: 两个用例还没跑\nnext: 修 parser 的边界情况';
const none = { paths: [], carried: false };

const file = join(tmp, 'state.db');
const db = openStateDb(file);
const raw = new DatabaseSync(file);

after(() => {
  raw.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A done task of the account, with the given handoff and usage, that finished at the given time. */
function finished(account: string, fields: { handoff?: string; usage?: TaskUsage } = {}, at = Date.now()): TaskRow {
  const task = db.startTaskNow(account, '改 parser')!;
  db.finishTask(task.id, 'done', { result: 'ok', summary: '改了 parser', ...fields });
  raw.prepare('UPDATE tasks SET finished_at = ? WHERE id = ?').run(at, task.id);
  return db.getTask(task.id)!;
}

/** An answer with the reply, memory and summary sections, then rest. */
const answer = (rest = '') => `<<<WECHAT_REPLY>>>\n改好了\n<<<WECHAT_MEMORY>>>\n- 无\n<<<WECHAT_SUMMARY>>>\n修了 parser${rest}`;

test('the handoff is what follows its marker, and the reply, memory and summary stop before it', () => {
  const text = `<<<WECHAT_REPLY>>>\n改好了\n<<<WECHAT_MEMORY>>>\n- 用户喜欢简短的回复\n<<<WECHAT_SUMMARY>>>\n修了 parser\n<<<WECHAT_HANDOFF>>>\n${HANDOFF}\n`;
  assert.deepEqual(parseOrchestratorOutput(text), {
    reply: '改好了',
    memory: ['用户喜欢简短的回复'],
    summary: '修了 parser',
    handoff: HANDOFF,
    files: [],
  });
});

test('an answer without a handoff marker has no handoff, and "-" or "无" after the marker means none too', () => {
  const plain = parseOrchestratorOutput(answer());
  assert.equal(plain.handoff, '');
  assert.equal(plain.summary, '修了 parser');
  for (const empty of ['-', '- 无', '无', '  -  ', '']) {
    const out = parseOrchestratorOutput(answer(`\n<<<WECHAT_HANDOFF>>>\n${empty}\n`));
    assert.equal(out.handoff, '', JSON.stringify(empty));
    assert.equal(out.summary, '修了 parser');
  }
});

test('the last handoff marker counts: a draft or a reply that quotes one does not cut the answer short', () => {
  const out = parseOrchestratorOutput(
    [
      '先打个草稿 <<<WECHAT_REPLY>>> 草稿 <<<WECHAT_HANDOFF>>> next: 草稿里的',
      '<<<WECHAT_REPLY>>>',
      '交接标记写作 <<<WECHAT_HANDOFF>>>，放在摘要后面',
      '<<<WECHAT_MEMORY>>>',
      '- 无',
      '<<<WECHAT_SUMMARY>>>',
      '解释了交接标记',
      '<<<WECHAT_HANDOFF>>>',
      'next: 等用户确认',
    ].join('\n'),
  );
  assert.equal(out.reply, '交接标记写作 <<<WECHAT_HANDOFF>>>，放在摘要后面');
  assert.equal(out.summary, '解释了交接标记');
  assert.equal(out.handoff, 'next: 等用户确认');
});

test('a long handoff is clipped to 1200 characters, its lines trimmed and its blank lines dropped', () => {
  const out = parseOrchestratorOutput(answer(`\n<<<WECHAT_HANDOFF>>>\n\n  files: a.ts  \n\n   \nnext: ${'很'.repeat(2000)}\n`));
  assert.equal(out.handoff.length, 1200);
  assert.match(out.handoff, /^files: a\.ts\nnext: 很+$/);
});

test('a v8 database gains the handoff and usage columns and keeps its rows', () => {
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
  assert.equal((old.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 10);
  old.close();
  const row = migrated.getTask(task.id)!;
  assert.deepEqual([row.input, row.handoff, row.tokens_in, row.tokens_out, row.cost_usd], ['old task', null, null, null, null]);
});

test('finishTask stores the handoff and the usage, the usage even when /stop finished the task first', () => {
  const done = finished('fin', { handoff: HANDOFF, usage: { input: 5000, output: 250, cost: 0.25 } });
  assert.deepEqual([done.handoff, done.tokens_in, done.tokens_out, done.cost_usd], [HANDOFF, 5000, 250, 0.25]);
  const bare = finished('fin', { handoff: '' });
  assert.deepEqual([bare.handoff, bare.tokens_in, bare.tokens_out, bare.cost_usd], [null, null, null, null], 'unknown, not 0');
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

test('the next task gets the handoff the task right before it left, while under 2 hours old', () => {
  const previous = finished('chat', { handoff: HANDOFF }, Date.now() - 90 * MINUTE);
  const prompt = composePrompt(db, db.createTask('chat', '继续').task, tmp, none);
  const block = `<last_handoff>\ntask: #${previous.seq}\n${HANDOFF}\n</last_handoff>`;
  assert.ok(prompt.includes(`</recent_tasks>\n\n${block}\n\n<user_message>\n继续\n</user_message>`), prompt);
});

test('no handoff block when it is stale, when the task right before left none, for a routine or for a first task', () => {
  finished('stale', { handoff: HANDOFF }, Date.now() - 2 * HOUR - MINUTE);
  finished('gap', { handoff: HANDOFF });
  finished('gap');
  finished('rt', { handoff: HANDOFF });
  const routine = db.addRoutine('rt', { name: '日报', prompt: '写日报', schedule: 'daily09:00', nextRunAt: Date.now() })!;
  const prompts = {
    stale: composePrompt(db, db.createTask('stale', '继续').task, tmp, none),
    gap: composePrompt(db, db.createTask('gap', '继续').task, tmp, none),
    routine: composePrompt(db, db.createTask('rt', '写日报', null, undefined, undefined, 'write', routine.id).task, tmp, none),
    first: composePrompt(db, db.createTask('first', '你好').task, tmp, none),
  };
  for (const [name, prompt] of Object.entries(prompts)) {
    assert.doesNotMatch(prompt, /<last_handoff>/, name);
    assert.ok(!prompt.includes(HANDOFF), name);
  }
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

test('/tasks shows what each task used and the next step its handoff names', () => {
  finished('list', { handoff: `files: a.ts\nnext: ${'修'.repeat(70)}`, usage: { input: 5_000, output: 250, cost: 0.25 } });
  finished('list', { usage: { input: 23_456, output: 2_500, cost: 0 } });
  finished('list');
  const lines = formatTasks(db, 'list', 5).split('\n');
  assert.equal(lines.length, 7, lines.join('\n'));
  assert.match(lines[0], /^#3 .+\] 改 parser$/, 'no usage, no suffix');
  assert.match(lines[2], /^#2 .+\] 改 parser {2}↑23\.5k ↓2\.5k$/);
  assert.match(lines[4], /^#1 .+\] 改 parser {2}↑5k ↓250 \$0\.25$/);
  assert.equal(lines[5], '    改了 parser');
  assert.equal(lines[6], `    ↳ next: ${'修'.repeat(60)}…`);
});
