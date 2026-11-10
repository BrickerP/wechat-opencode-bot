// /doctor: one line per thing the daemon depends on, from OpenCode and its agents to the bot's own state, then how
// many need attention; /panic: every task stopped or cancelled, every ask denied, plan mode, every routine off.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CommandContext, DoctorProbe } from '../commands/handlers.js';
import type { TaskLane } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-control-'));
// Config and logs follow HOME, state and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
process.env.OPENCODE_SERVER_PASSWORD = '';
mkdirSync(join(tmp, '.wechat-opencode-bot'));
writeFileSync(join(tmp, '.wechat-opencode-bot', 'config.env'), `workingDirectory=${tmp}\npermissionMode=auto\n`);

/** The fake OpenCode's agents: a built-in and config/agents without wechat-explore. */
const AGENTS = ['build', 'wechat-orchestrator', 'wechat-orchestrator-read', 'wechat-general'];
const server = createServer((req, res) => {
  const send = (body: unknown) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  if (req.url === '/api/info') return send({ version: '2.2.1', pid: 1 });
  if (req.url === '/api/agent') return send({ location: { directory: tmp }, data: AGENTS.map((id) => ({ id, name: id })) });
  res.writeHead(404).end();
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// provider.ts reads OPENCODE_URL at load, so the bot modules load after the fake server is up.
const { formatDoctor, tickRoutines } = await import('../commands/handlers.js');
const { routeCommand } = await import('../commands/router.js');
const { loadConfig } = await import('../config.js');
const { createPermissionBroker } = await import('../permission.js');
const { openStateDb, STATE_DB_PATH } = await import('../tasks/db.js');
const { createTaskQueue } = await import('../tasks/queue.js');

// /doctor reports the size of the daemon's state.db, so the tests use that file.
const db = openStateDb(STATE_DB_PATH);
const raw = new DatabaseSync(STATE_DB_PATH);

after(() => {
  raw.close();
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 20:00 in Shanghai. */
const NOW = Date.parse('2026-11-09T12:00:00Z');
const TOKEN = 'secret-context-token';
/** Where /doctor looks for OpenCode's database, under HOME. */
const OPENCODE_DB = join(tmp, '.local', 'share', 'opencode', 'opencode.db');
const REQUIRED_AGENTS = ['wechat-orchestrator', 'wechat-orchestrator-read', 'wechat-general', 'wechat-explore'];

const fulfilled = <T>(value: T): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value });
const rejected = (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason });
/** A report with its state.db size masked: SQLite decides when the file grows. */
const sized = (text: string): string => text.replace(/^✅ state\.db: [\d.]+ (B|KB|MB)$/m, '✅ state.db: <size>');

/** Lets every pending promise callback run, so a lane can claim its next task. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('/doctor asks the running OpenCode for its version and agents, and names the agent it lacks with the fix', async () => {
  db.saveContextToken('doc', 'wx-doc', TOKEN);
  const doctor = await routeCommand('/doctor', { accountId: 'doc', db } as CommandContext);
  assert.ok(!doctor.includes(TOKEN), 'the token itself is a credential');
  assert.equal(
    sized(doctor).replace(/^✅ 消息令牌: \d+秒前$/m, '✅ 消息令牌: <age>前').replace(/^✅ 运行时长: .+$/m, '✅ 运行时长: <uptime>'),
    [
      '🩺 自检：',
      '✅ OpenCode: 已连接（v2.2.1）',
      '❌ Agent: 缺少 wechat-explore',
      '   修复: scripts/install-agents.sh --apply，再 reload：',
      `   (set -a; . ${join(tmp, 'data', 'env')}; set +a; opencode reload --server "\${OPENCODE_URL:-http://127.0.0.1:4096}")`,
      '✅ 消息令牌: <age>前',
      '✅ 待补发: 无',
      '✅ state.db: <size>',
      '✅ 熔断: 无',
      '✅ 24小时: 完成 0，失败 0，中断 0',
      '✅ 定时任务: 无',
      '✅ 运行时长: <uptime>',
      '总体: 有 1 项需要注意',
    ].join('\n'),
    'no opencode.db line without the file',
  );
});

test('/doctor flags each thing that needs attention and counts them; a healthy daemon is "正常"', () => {
  mkdirSync(dirname(OPENCODE_DB), { recursive: true });
  writeFileSync(OPENCODE_DB, Buffer.alloc(1.5 * 1024 * 1024));
  db.ensureUser('sick', 'wx-sick');
  const first = db.addNotice('sick', 'first');
  db.addNotice('sick', 'second');
  raw.prepare('UPDATE pending_notices SET created_at = ? WHERE id = ?').run(NOW - 90 * MINUTE, first);
  db.markNoticeFailed(first, 2, 0);
  const { task } = db.createTask('sick', 'hi');
  raw.prepare("UPDATE tasks SET status = 'failed', finished_at = ?, error = 'boom' WHERE id = ?").run(NOW - 30 * MINUTE, task.id);
  db.addRoutine('sick', { name: 'daily', prompt: 'p', schedule: 'daily09:00', nextRunAt: Date.parse('2026-11-10T01:00:00Z') });
  // Off, so not the next run, though it would be due first.
  db.setRoutineEnabled(db.addRoutine('sick', { name: 'poll', prompt: 'p', schedule: 'every30m', nextRunAt: NOW })!.id, false);
  const sick: DoctorProbe = {
    // As fetch fails in Node: refused, or the signal's timeout.
    server: rejected(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })),
    agents: rejected(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })),
    // Its cooldown is over: not listed.
    gateways: [{ provider: 'oneapi', openUntil: NOW + 10 * MINUTE }, { provider: 'oneapi-gemini', openUntil: NOW - MINUTE }],
    uptimeMs: 3 * HOUR + 12 * MINUTE,
  };
  assert.equal(
    sized(formatDoctor(db, 'sick', sick, NOW)),
    [
      '🩺 自检：',
      '❌ OpenCode: 无法连接（fetch failed (ECONNREFUSED)）',
      '❌ Agent: 无法获取（8 秒无响应）',
      '❌ 消息令牌: 无（结果会等你的下一条消息再发）',
      '⚠️ 待补发: 2 条（最久 1小时30分，重试 2 次）',
      '✅ state.db: <size>',
      '✅ opencode.db: 1.5 MB（OpenCode 的会话库）',
      '⚠️ 熔断: oneapi（剩 10 分钟）',
      '⚠️ 24小时: 完成 0，失败 1，中断 0（最近失败 19:30 任务 #1：boom）',
      '✅ 定时任务: 2 个，启用 1 个，下次 11-10 09:00（daily）',
      '✅ 运行时长: 3小时12分',
      '总体: 有 6 项需要注意',
    ].join('\n'),
  );

  db.saveContextToken('sick', 'wx-sick', TOKEN);
  raw.prepare('UPDATE users SET context_token_at = ? WHERE account_id = ?').run(NOW - 13 * HOUR, 'sick');
  const stale = formatDoctor(db, 'sick', sick, NOW);
  assert.match(stale, /^⚠️ 消息令牌: 13小时0分前（超过 12 小时，可能已失效）$/m);
  assert.match(stale, /^总体: 有 6 项需要注意$/m);

  db.saveContextToken('well', 'wx-well', TOKEN);
  raw.prepare('UPDATE users SET context_token_at = ? WHERE account_id = ?').run(NOW - 5 * MINUTE, 'well');
  const well: DoctorProbe = {
    server: fulfilled({}),
    agents: fulfilled(['build', ...REQUIRED_AGENTS].map((id) => ({ id }))),
    gateways: [{ provider: 'oneapi-gemini', openUntil: NOW - MINUTE }],
    uptimeMs: 90_000,
  };
  assert.equal(
    sized(formatDoctor(db, 'well', well, NOW)),
    [
      '🩺 自检：',
      '✅ OpenCode: 已连接',
      '✅ Agent: 4 个已就绪',
      '✅ 消息令牌: 5分钟前',
      '✅ 待补发: 无',
      '✅ state.db: <size>',
      '✅ opencode.db: 1.5 MB（OpenCode 的会话库）',
      '✅ 熔断: 无',
      '✅ 24小时: 完成 0，失败 0，中断 0',
      '✅ 定时任务: 无',
      '✅ 运行时长: 1分钟',
      '总体: 正常',
    ].join('\n'),
  );
});

test('/panic stops and cancels every task, denies every ask, switches to plan and turns every routine off', async (t) => {
  const pdb = openStateDb(join(tmp, 'panic.db'));
  const add = (accountId: string, input: string, lane: TaskLane = 'write') =>
    pdb.createTask(accountId, input, null, undefined, undefined, lane).task;
  // Each lane of "acc" runs a task with another queued behind it; "other" is another account of the same database.
  const tasks = [add('acc', 'w1'), add('acc', 'r1', 'read'), add('acc', 'w2'), add('acc', 'r2', 'read')];
  const theirs = [add('other', 'o1'), add('other', 'o2')];
  pdb.claimNextTask('other', 'write');
  for (const name of ['daily', 'poll', 'old']) pdb.addRoutine('acc', { name, prompt: 'p', schedule: 'every30m', nextRunAt: Date.now() });
  pdb.setRoutineEnabled(pdb.routine('acc', 'old')!.id, false);
  pdb.addRoutine('other', { name: 'theirs', prompt: 'p', schedule: 'every30m', nextRunAt: Date.now() });
  const started: string[] = [];
  const aborted: string[] = [];
  // Every task runs until it is stopped.
  const queue = createTaskQueue(
    pdb,
    (task, signal) => {
      started.push(task.input);
      return new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => {
          aborted.push(task.input);
          resolve();
        }),
      );
    },
    () => {},
  );
  queue.kick('acc');
  const broker = createPermissionBroker();
  const ask = broker.createPending('acc', 'bash', 'rm -rf dist', '任务 #1');
  const theirAsk = broker.createPending('other', 'bash', 'ls');
  // Its 2-minute timeout would keep the test running.
  t.after(() => broker.rejectPending('other'));
  const ctx: CommandContext = { accountId: 'acc', db: pdb, queue, broker };

  assert.equal(
    await routeCommand('/panic', ctx),
    '🛑 已 panic：停止 2 个任务、取消 2 个排队、权限切到 plan、停用 2 个定时任务。恢复：/permission default；/routine on <名称>',
  );
  assert.equal(await ask, false, 'the waiting ask is denied');
  await settle();
  assert.deepEqual([started, aborted], [['w1', 'r1'], ['w1', 'r1']], 'both runners stopped; the queued tasks never started');
  assert.deepEqual(
    tasks.map((task) => pdb.getTask(task.id)).map((task) => [task?.input, task?.status, task?.error, task?.notified]),
    ['w1', 'r1', 'w2', 'r2'].map((input) => [input, 'interrupted', '用户 panic', 1]),
    'the reply is their notice: the outbox skips them',
  );
  assert.deepEqual([loadConfig().permissionMode, loadConfig().workingDirectory], ['plan', tmp]);
  assert.deepEqual(pdb.routines('acc').map((r) => [r.name, r.enabled]), [['daily', 0], ['old', 0], ['poll', 0]]);
  assert.deepEqual(tickRoutines(pdb, 'acc', () => {}, Date.now() + HOUR), [], 'none comes due');
  // Another account's tasks, routine and ask are left alone.
  assert.deepEqual(theirs.map((task) => pdb.getTask(task.id)?.status), ['running', 'queued']);
  assert.equal(pdb.routine('other', 'theirs')?.enabled, 1);
  assert.equal(broker.getPending('other')?.answer, theirAsk);

  assert.equal(
    await routeCommand('/panic', ctx),
    '🛑 已 panic：停止 0 个任务、取消 0 个排队、权限切到 plan、停用 0 个定时任务。恢复：/permission default；/routine on <名称>',
    'nothing left to stop',
  );
  // The way back the reply names.
  await routeCommand('/permission default', ctx);
  await routeCommand('/routine on daily', ctx);
  assert.deepEqual([loadConfig().permissionMode, pdb.routine('acc', 'daily')?.enabled], ['default', 1]);
});
