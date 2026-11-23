// The task router: which open tasks a message may belong to and how the prompt shows them, the model's answer and
// every way it can fail, and what placeMessage does with each route: merge into a queued task, follow a finished
// or running one, a task of its own for an image, and stop one task alone.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';
import type { StateDb, TaskRow, TaskStatus } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-task-router-'));
// Config and logs follow HOME, state and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
mkdirSync(join(tmp, 'work', 'medo'), { recursive: true });
mkdirSync(join(tmp, '.wechat-opencode-bot'));
writeFileSync(join(tmp, '.wechat-opencode-bot', 'config.env'), `workingDirectory=${join(tmp, 'work')}\n`);
process.env.OPENCODE_SERVER_PASSWORD = '';
delete process.env.OPENCODE_DEFAULT_MODEL;

/** What the fake generate endpoint answers, one per call: the text, an HTTP error, or no answer at all. */
type Answer = string | { status: number } | 'hang';
const answers: Answer[] = [];
const calls: Array<{ prompt: string; model: unknown }> = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (req.url !== '/api/experimental/generate/text') return void res.writeHead(404).end();
    calls.push(JSON.parse(body));
    const answer = answers.shift() ?? '{"action":"new"}';
    if (answer === 'hang') return;
    if (typeof answer !== 'string') return void res.writeHead(answer.status).end('{"_tag":"ProviderRequestError"}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: { text: answer } }));
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// provider.ts reads OPENCODE_URL at module load, so the bot modules load after the fake server is up.
const { composeRouterPrompt, followUpOf, openTasks, parseRoute, placeMessage, routeToTask } = await import('../task-router.js');
const { routeMessage } = await import('../projects.js');
const { openStateDb } = await import('../tasks/db.js');
const { createTaskQueue } = await import('../tasks/queue.js');
const { createPermissionBroker } = await import('../permission.js');
const { stopOneTask } = await import('../commands/handlers.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
let dbs = 0;

beforeEach(() => {
  answers.length = 0;
  calls.length = 0;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A state.db of the test's own, and a way to add a task of account "acc" in a given state. */
function fresh() {
  const file = join(tmp, `state-${++dbs}.db`);
  const db = openStateDb(file);
  const raw = new DatabaseSync(file);
  const add = (
    input: string,
    fields: { status?: TaskStatus; ago?: number; session?: string; botId?: string; lane?: 'read' | 'write'; summary?: string; result?: string } = {},
  ): TaskRow => {
    const { task } = db.createTask('acc', input, null, undefined, fields.botId, fields.lane);
    const status = fields.status ?? 'queued';
    const at = Date.now() - (fields.ago ?? 0);
    raw
      .prepare('UPDATE tasks SET status = ?, started_at = ?, finished_at = ?, session_id = ?, summary = ?, result = ? WHERE id = ?')
      .run(
        status,
        status === 'queued' ? null : at,
        status === 'queued' || status === 'running' ? null : at,
        fields.session ?? null,
        fields.summary ?? null,
        fields.result ?? null,
        task.id,
      );
    return db.getTask(task.id)!;
  };
  return { db, add };
}

/** A message as the daemon reads it, routed by its text. */
const inbound = (text: string, image = false) => ({ input: text, image, routed: routeMessage(text) });

/** A context whose queue runs every task until it is stopped, recording the ones it stopped. */
function context(db: StateDb) {
  const aborted: string[] = [];
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
  return { ctx, queue, aborted };
}

/** Lets every pending promise callback run, so a lane can claim its next task. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('open tasks: running, queued, and finished within 24 hours with a session; one per session, newest first, at most 6', () => {
  const { db, add } = fresh();
  add('太旧', { status: 'done', ago: 25 * HOUR, session: 'ses_old' });
  add('没会话', { status: 'failed', ago: HOUR });
  add('被挤掉', { status: 'done', ago: 3 * HOUR, session: 'ses_x' });
  add('第四', { status: 'done', ago: 2 * HOUR, session: 'ses_a' });
  add('第五', { status: 'failed', ago: 50 * MINUTE, session: 'ses_b' });
  add('第六', { status: 'interrupted', ago: 40 * MINUTE, session: 'ses_c' });
  add('第七', { status: 'done', ago: 30 * MINUTE, session: 'ses_d' });
  add('第八接着第七', { status: 'done', ago: 20 * MINUTE, session: 'ses_d' });
  add('第九', { status: 'running', ago: 5 * MINUTE, session: 'ses_e' });
  add('第十');
  assert.deepEqual(openTasks(db, 'acc').map((t) => t.seq), [10, 9, 8, 6, 5, 4]);
  assert.deepEqual(openTasks(db, 'nobody'), []);
});

test('the prompt gives the time, each open task on one line, the #32 example and the message last', () => {
  const { db, add } = fresh();
  add('看下日志', { status: 'done', ago: 90 * MINUTE, session: 'ses_a', botId: 'research', summary: '查了日志', result: '你说的是 M1 还是 M5？' });
  add('去帮我完成最新一期周报'.repeat(20), { status: 'running', ago: 2 * MINUTE, session: 'ses_b' });
  add('改测试');
  const now = Date.now();
  const prompt = composeRouterPrompt('M1', openTasks(db, 'acc', now), now);
  const lines = prompt.split('\n').filter((line) => /^#\d+ /.test(line));
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '#3 [排队中] 刚刚 bot:chief 项目:无 输入：改测试 摘要：无');
  assert.match(lines[1], /^#2 \[运行中\] 2 分钟前 bot:chief 项目:无 输入：去帮我完成\S+… 摘要：无$/);
  assert.equal(/输入：(\S+) 摘要/.exec(lines[1])?.[1].length, 151, 'the input is cut at 150 characters');
  assert.equal(lines[2], '#1 [完成] 1 小时前 bot:research 项目:无 输入：看下日志 摘要：查了日志 （回复最后在问用户）');
  assert.match(prompt, /^现在：\d{4}-\d\d-\d\d \d\d:\d\d（北京时间）$/m);
  assert.match(prompt, /输出 \{"action":"attach","task":32\}/);
  assert.ok(prompt.endsWith('新消息：\n<message>\nM1\n</message>'), prompt.slice(-80));
});

test('the answer: its first JSON object; bad JSON, an unknown action or a task that is not open is new work, with why', () => {
  const { add } = fresh();
  const open = [add('a', { status: 'running', session: 'ses_a' }), add('b')];
  assert.deepEqual(parseRoute('{"action":"new"}', open), { action: 'new' });
  assert.deepEqual(parseRoute('好的：\n```json\n{"action": "attach", "task": 2}\n```', open), { action: 'attach', task: open[1] });
  assert.deepEqual(parseRoute('{"action":"stop","task":"1"}', open), { action: 'stop', task: open[0] });
  assert.deepEqual(parseRoute('{"action":"attach","task":7}', open), { action: 'new', reason: 'the task is not open' });
  assert.deepEqual(parseRoute('{"action":"stop"}', open), { action: 'new', reason: 'the task is not open' });
  assert.deepEqual(parseRoute('{"action":"merge","task":1}', open), { action: 'new', reason: 'unknown action' });
  assert.deepEqual(parseRoute('{action: attach}', open), { action: 'new', reason: 'unparseable JSON' });
  assert.deepEqual(parseRoute('attach #1', open), { action: 'new', reason: 'no JSON in the answer' });
});

test('without open tasks nothing is called; with them DEFAULT_MODEL is asked once, and the decision is logged without the message', async () => {
  const { db, add } = fresh();
  assert.deepEqual(await routeToTask(db, 'acc', '继续'), { action: 'new' });
  assert.equal(calls.length, 0);
  const task = add('看下日志', { status: 'running', session: 'ses_a' });
  answers.push('{"action":"attach","task":1}');
  assert.deepEqual(await routeToTask(db, 'acc', '不是 M5，是 M1'), { action: 'attach', task });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].model, { providerID: 'oneapi', id: 'DeepSeek-V4.1-Flash' });
  assert.match(calls[0].prompt, /<message>\n不是 M5，是 M1\n<\/message>$/);
  const logs = join(tmp, '.wechat-opencode-bot', 'logs');
  const log = readdirSync(logs).map((name) => readFileSync(join(logs, name), 'utf-8')).join('');
  assert.match(log, /INFO Message routed \{"action":"attach","task":1,"open":1,"latencyMs":\d+\}/);
  assert.ok(!log.includes('不是 M5'), 'the message is the user’s');
});

test('a failed call, an empty answer or no answer in time is new work', async () => {
  const { db, add } = fresh();
  add('看下日志', { status: 'running', session: 'ses_a' });
  answers.push({ status: 502 });
  const failed = await routeToTask(db, 'acc', '继续');
  assert.equal(failed.action, 'new');
  assert.match(failed.action === 'new' ? (failed.reason ?? '') : '', /HTTP 502/);
  answers.push('  ');
  assert.deepEqual(await routeToTask(db, 'acc', '继续'), { action: 'new', reason: 'Error: 模型没有给出回答' });
  answers.push('hang');
  const startedAt = Date.now();
  assert.deepEqual(await routeToTask(db, 'acc', '继续', 300), { action: 'new', reason: 'no answer in 300 ms' });
  assert.ok(Date.now() - startedAt < 3000, 'it does not wait for the answer');
});

test('a prefixed message never reaches the router; new work runs where routeMessage said, in the lane of its bot', async () => {
  const { db, add } = fresh();
  add('看下日志', { status: 'running', session: 'ses_a' });
  const { ctx } = context(db);
  const medo = { id: 'medo', dir: join(tmp, 'work', 'medo') };
  assert.deepEqual(await placeMessage(ctx, inbound('@research 继续')), { task: { project: undefined, botId: 'research', lane: 'read' } });
  assert.deepEqual(await placeMessage(ctx, inbound('@medo 看下')), { task: { project: medo, botId: 'chief', lane: 'write' } });
  assert.equal(calls.length, 0);
  answers.push('{"action":"new"}');
  assert.deepEqual(await placeMessage(ctx, inbound('看下 medo 的部署')), { task: { project: medo, botId: 'chief', lane: 'write' } });
  assert.equal(calls.length, 1);
});

test('attach merges words into a queued task; a finished or running task, or an image, gets a task that follows it', async () => {
  const { db, add } = fresh();
  const queued = add('看下日志');
  const finished = add('查下发布', { status: 'done', ago: HOUR, session: 'ses_done', botId: 'research', lane: 'read' });
  const running = add('跑测试', { status: 'running', session: 'ses_run' });
  const { ctx } = context(db);
  answers.push(`{"action":"attach","task":${queued.seq}}`);
  assert.deepEqual(await placeMessage(ctx, inbound('还有 nginx 的')), { reply: `↪️ 已合并到排队中的任务 #${queued.seq}` });
  assert.equal(db.getTask(queued.id)!.input, '看下日志\n还有 nginx 的');
  answers.push(`{"action":"attach","task":${finished.seq}}`);
  assert.deepEqual(await placeMessage(ctx, inbound('那第二个呢')), {
    task: { project: undefined, botId: 'research', lane: 'read', continues: 'ses_done' },
  });
  // Running, but in no runner of this process, as right after a restart: it cannot take the words in.
  answers.push(`{"action":"attach","task":${running.seq}}`);
  assert.deepEqual(await placeMessage(ctx, inbound('先别改测试')), { task: followUpOf(running) });
  assert.equal(followUpOf(running).continues, 'ses_run');
  assert.equal(db.getTask(running.id)!.input, '跑测试', 'nothing joined it');
  answers.push(`{"action":"attach","task":${queued.seq}}`);
  assert.deepEqual(await placeMessage(ctx, inbound('[图片]', true)), {
    task: { project: undefined, botId: undefined, lane: 'write', continues: undefined },
  });
  assert.equal(db.getTask(queued.id)!.input, '看下日志\n还有 nginx 的', 'an image is not merged');
});

test('stop cancels a queued task, or stops one running task alone and denies its asks; an ended task says so', async () => {
  const { db, add } = fresh();
  const w1 = add('w1');
  const r1 = add('r1', { botId: 'research', lane: 'read' });
  const w2 = add('w2');
  const { ctx, queue, aborted } = context(db);
  queue.kick('acc');
  await settle();
  assert.deepEqual([w1, r1, w2].map((t) => db.getTask(t.id)!.status), ['running', 'running', 'queued']);
  const own = ctx.broker.createPending('acc', 'bash', 'rm -rf dist', `任务 #${w1.seq}（chief）`, w1.id);
  const other = ctx.broker.createPending('acc', 'bash', 'ls', `任务 #${r1.seq}（research）`, r1.id);
  try {
    answers.push(`{"action":"stop","task":${w1.seq}}`);
    assert.deepEqual(await placeMessage(ctx, inbound('别做了')), { reply: `⏹ 已停止任务 #${w1.seq}` });
    assert.equal(await own, false, 'its ask is denied');
    await settle();
    assert.deepEqual(aborted, ['w1']);
    const row = db.getTask(w1.id)!;
    assert.deepEqual([row.status, row.error, row.notified], ['interrupted', '用户停止', 1]);
    assert.equal(db.getTask(r1.id)!.status, 'running', 'the read lane runs on');
    assert.equal(ctx.broker.getPending('acc')?.answer, other, 'and its ask still waits');
    assert.equal(db.getTask(w2.id)!.status, 'running', 'the write lane moved on');

    const w3 = add('w3');
    answers.push(`{"action":"stop","task":${w3.seq}}`);
    assert.deepEqual(await placeMessage(ctx, inbound('w3 不用做了')), { reply: `🗑 已取消任务 #${w3.seq}` });
    assert.deepEqual([db.getTask(w3.id)!.status, db.getTask(w3.id)!.error], ['interrupted', '用户取消']);
    assert.equal(stopOneTask(ctx, w1.seq), `任务 #${w1.seq} 已经结束（已中断）`);
    assert.equal(stopOneTask(ctx, 99), '⚠️ 没有任务 #99，发送 /tasks 查看');
  } finally {
    ctx.broker.rejectPending('acc');
    queue.stop('acc');
    await settle();
  }
});
