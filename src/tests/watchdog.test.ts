// runTask against a fake OpenCode server: the first-response and stall watchdogs, the one-shot fallback to
// another gateway and the breaker that skips a failing one, the progress notes of a long task, the directory
// each session opens in, and the bot a task speaks as.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { TaskProject, TaskRow } from '../tasks/db.js';

const FIRST_MS = 2000;
const STALL_MS = 2500;
/** Longer than STALL_MS plus a poll, so only the running-tool rule keeps the turn alive. */
const TOOL_MS = 5000;
/** Progress notes per task; a turn that runs past 300ms gets its first. */
const PROGRESS_MAX = 2;
const REPLY = '<<<WECHAT_REPLY>>>\nok\n<<<WECHAT_MEMORY>>>\n- 无\n<<<WECHAT_SUMMARY>>>\nok';
const FACT = '用户喜欢简短的回复';
/** The session model of the fallback for the default oneapi/DeepSeek-V4.1-Flash. */
const GPT = { providerID: 'oneapi-chat-gpt', id: 'gpt-6-astra' };

type Script =
  | 'silent'
  | 'answer'
  | 'remember'
  | 'provider-error'
  | 'quota'
  | 'gateway-502'
  | 'rejected'
  | 'child-stall'
  | 'child-tool';

interface FakeSession {
  id: string;
  parentID?: string;
  script?: Script;
  model?: unknown;
  /** The location.directory the session was created with. */
  directory?: string;
  prompt?: string;
  messages: any[];
  interrupted: boolean;
}

const sessions: FakeSession[] = [];
/** How each new root session behaves, in creation order. */
const scripts: Script[] = [];
let ids = 0;

const later = (ms: number, fn: () => void): void => void setTimeout(fn, ms).unref();
const message = (type: string, fields: object = {}): any => ({ id: `msg_${++ids}`, type, time: { created: Date.now() }, ...fields });
const assistant = (...content: unknown[]): any => message('assistant', { content });
const idle = (outcome: string, error?: unknown): any => message('idle', { outcome, error });
const tool = (name: string): any => ({ type: 'tool', name, state: { status: 'running' }, time: { created: Date.now(), ran: Date.now() } });

function addSession(fields: Partial<FakeSession> = {}): FakeSession {
  const session: FakeSession = { id: `ses_${++ids}`, messages: [], interrupted: false, ...fields };
  sessions.push(session);
  return session;
}

function answer(session: FakeSession, text = REPLY): void {
  const now = Date.now();
  const time = { created: now, streamed: now, completed: now };
  session.messages.push(message('assistant', { time, content: [{ type: 'text', text }] }), idle('succeeded'));
}

/** What a root session does once its prompt arrives. */
const play: Record<Script, (session: FakeSession) => void> = {
  silent: () => {},
  answer: (s) => later(100, () => answer(s)),
  remember: (s) => later(100, () => answer(s, REPLY.replace('- 无', `- ${FACT}`))),
  'provider-error': (s) =>
    later(100, () => s.messages.push(idle('failed', { type: 'provider.internal', message: 'control plan is unavailable' }))),
  quota: (s) => later(100, () => s.messages.push(idle('failed', { type: 'provider.quota', message: 'quota exceeded' }))),
  // A gateway error OpenCode did not map to a provider.* type.
  'gateway-502': (s) =>
    later(100, () => s.messages.push(idle('failed', { type: 'unknown', message: 'do request failed: HTTP 502 Bad Gateway' }))),
  rejected: (s) => later(100, () => s.messages.push(idle('failed', { type: 'permission.rejected', message: 'rejected' }))),
  // The orchestrator delegates, then the subagent's model goes quiet after its first thought.
  'child-stall': (s) =>
    later(100, () => {
      s.messages.push(assistant(tool('subagent')));
      const thought = { type: 'reasoning', text: '', time: { created: Date.now() } };
      addSession({ parentID: s.id }).messages.push(message('user'), assistant(thought));
    }),
  // The subagent runs one shell command for longer than STALL_MS, then the turn finishes.
  'child-tool': (s) =>
    later(100, () => {
      const call = tool('subagent');
      s.messages.push(assistant(call));
      const child = addSession({ parentID: s.id });
      child.messages.push(message('user'), assistant(tool('shell')));
      later(TOOL_MS, () => {
        child.messages.push(idle('succeeded'));
        call.state.status = 'completed';
        answer(s);
      });
    }),
};

/** The few OpenCode routes runTask uses. */
function handle(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const send = (data: unknown) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    if (url.pathname === '/api/session') {
      if (req.method === 'GET') return send(sessions.filter((s) => s.parentID === url.searchParams.get('parentID')));
      const { model, location } = JSON.parse(body);
      return send({ id: addSession({ model, directory: location?.directory, script: scripts.shift() }).id });
    }
    const [, , , id, action] = url.pathname.split('/');
    const session = sessions.find((s) => s.id === id);
    if (!session) return void res.writeHead(404).end();
    if (action === 'message') return send([...session.messages].reverse());
    if (action === 'permission') return send([]);
    if (action === 'interrupt') {
      session.interrupted = true;
      return void res.writeHead(204).end();
    }
    if (action === 'prompt') {
      session.prompt = JSON.parse(body).text;
      const user = message('user');
      session.messages.push(user);
      play[session.script ?? 'silent'](session);
      return send({ time: user.time });
    }
    res.writeHead(404).end();
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'owb-watchdog-'));
// Logs and config follow HOME, state and memory OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
process.env.OPENCODE_SERVER_PASSWORD = '';
process.env.OPENCODE_FIRST_RESPONSE_TIMEOUT_MS = String(FIRST_MS);
process.env.OPENCODE_STALL_TIMEOUT_MS = String(STALL_MS);
process.env.OWB_PROGRESS_FIRST_MS = '300';
process.env.OWB_PROGRESS_MIN_GAP_MS = '200';
process.env.OWB_PROGRESS_EVERY_MS = '1000';
process.env.OWB_PROGRESS_MAX = String(PROGRESS_MAX);
delete process.env.OPENCODE_FALLBACK_MODEL;
delete process.env.OPENCODE_DEFAULT_MODEL;
delete process.env.OWB_BREAKER_THRESHOLD;
delete process.env.OWB_BREAKER_COOLDOWN_MS;

const server = createServer(handle);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// provider.ts reads its settings at module load, so the bot modules load after the fake server is up.
const { resultText, runTask } = await import('../orchestrator.js');
const { resetModelRouting } = await import('../model-routing.js');
const { openStateDb } = await import('../tasks/db.js');
const db = openStateDb(join(tmp, 'state.db'));

interface RunOptions {
  /** Does what /stop does after this long. */
  stopAfterMs?: number;
  project?: TaskProject;
  botId?: string;
  /** Every progress note fails to send, as a reply does while WeChat is unreachable. */
  progressFails?: boolean;
}

/** Run one task through the given session scripts. */
async function run(plan: Script[], { stopAfterMs, project, botId, progressFails }: RunOptions = {}) {
  scripts.push(...plan);
  const task = db.startTaskNow('test', 'hi', project, botId)!;
  const controller = new AbortController();
  if (stopAfterMs !== undefined) {
    later(stopAfterMs, () => {
      db.finishTask(task.id, 'interrupted', { error: '用户停止', notified: true });
      controller.abort();
    });
  }
  const delivered: TaskRow[] = [];
  const progress: string[] = [];
  const startedAt = Date.now();
  await runTask(
    db,
    task,
    {
      deliver: async (t) => void delivered.push(t),
      progress: async (text) => {
        progress.push(text);
        if (progressFails) throw new Error('send failed');
      },
    },
    controller.signal,
  );
  const roots = sessions.filter((s) => !s.parentID);
  return { task: db.getTask(task.id)!, delivered, progress, roots, elapsed: Date.now() - startedAt };
}

beforeEach(() => {
  sessions.length = 0;
  scripts.length = 0;
  // Gateway state lives in memory for the whole process; each test starts with every breaker closed.
  resetModelRouting();
  delete process.env.OWB_BREAKER_THRESHOLD;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.OWB_BREAKER_THRESHOLD;
});

test('a model that never answers times out, and the fallback model finishes the task', async () => {
  const { task, delivered, roots, elapsed } = await run(['silent', 'answer']);
  assert.equal(task.status, 'done');
  assert.equal(task.result, 'ok');
  assert.equal(roots.length, 2);
  assert.ok(roots[0].interrupted, 'the silent session is interrupted');
  assert.equal(roots[0].model, undefined);
  assert.deepEqual(roots[1].model, GPT);
  assert.doesNotMatch(roots[0].prompt ?? '', /^retry: /m);
  assert.match(roots[1].prompt ?? '', /^retry: /m);
  assert.equal(task.session_id, roots[1].id);
  assert.equal(delivered.length, 1);
  assert.ok(elapsed >= FIRST_MS && elapsed < FIRST_MS + 5000, `took ${elapsed}ms`);
});

test('a subagent that stops making progress times out the turn', async () => {
  const { task, roots } = await run(['child-stall', 'answer']);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 2);
  const child = sessions.find((s) => s.parentID === roots[0].id);
  assert.ok(child?.interrupted, 'the stalled subagent session is interrupted');
});

test('a tool that runs longer than the stall timeout is not a stall, and the user hears that the task is running', async () => {
  const { task, roots, elapsed, progress } = await run(['child-tool']);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  assert.ok(elapsed >= TOOL_MS, `took ${elapsed}ms`);
  assert.ok(progress.length >= 1 && progress.length <= PROGRESS_MAX, `${progress.length} notes`);
  assert.match(progress[0], new RegExp(`^⏳ 任务 #${task.seq} 运行中（\\d+秒），已派出 1 个子任务$`));
});

test('a task that finishes quickly sends no progress note', async () => {
  const { task, progress } = await run(['answer']);
  assert.equal(task.status, 'done');
  assert.deepEqual(progress, []);
});

test('progress notes stop at the cap over both attempts, and a note that fails to send is dropped', async () => {
  const notices = db.pendingNotices('test').length;
  // Uncapped, the silent primary and the fallback's long tool would bring 4 notes.
  const { task, roots, progress } = await run(['silent', 'child-tool'], { progressFails: true });
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 2);
  assert.equal(progress.length, PROGRESS_MAX);
  assert.match(progress[0], new RegExp(`^⏳ 任务 #${task.seq} 运行中（\\d+秒）$`), 'the silent primary has no subagent');
  assert.match(progress[1], /，已派出 1 个子任务$/);
  assert.equal(db.pendingNotices('test').length, notices, 'progress never goes to the outbox');
});

test('a provider error is retried once, then the task fails with a short error', async () => {
  const { task, delivered, roots } = await run(['provider-error', 'silent']);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, `备用模型重试后仍失败：上游模型 ${FIRST_MS / 1000} 秒无响应`);
  assert.equal(roots.length, 2);
  assert.equal(delivered.length, 1);
});

test('a gateway error OpenCode did not map to provider.* is retried on the fallback too', async () => {
  const { task, roots } = await run(['gateway-502', 'answer']);
  assert.equal(task.status, 'done');
  assert.deepEqual(roots.map((s) => s.model), [undefined, GPT]);
});

test('other failures are not retried', async () => {
  const { task, roots } = await run(['rejected', 'answer']);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'OpenCode 执行失败: permission.rejected: rejected');
  assert.equal(roots.length, 1);
});

test('a stopped task is not retried', async () => {
  const { task, delivered, roots } = await run(['silent', 'answer'], { stopAfterMs: 500 });
  assert.equal(task.status, 'interrupted');
  assert.equal(task.error, '用户停止');
  assert.equal(roots.length, 1);
  assert.ok(roots[0].interrupted);
  assert.equal(delivered.length, 0);
});

test('a gateway that keeps failing is skipped by later tasks, and the user hears it once', async () => {
  process.env.OWB_BREAKER_THRESHOLD = '1';
  const notices = db.pendingNotices('test').length;
  const first = await run(['quota', 'answer']);
  assert.equal(first.task.status, 'done');
  assert.deepEqual(first.roots.map((s) => s.model), [undefined, GPT]);
  sessions.length = 0;
  const second = await run(['answer']);
  assert.equal(second.task.status, 'done');
  assert.deepEqual(second.roots.map((s) => s.model), [GPT], 'one session, already on the fallback');
  assert.doesNotMatch(second.roots[0].prompt ?? '', /^retry: /m);
  assert.deepEqual(
    db.pendingNotices('test').slice(notices).map((n) => n.text),
    ['⚠️ oneapi 连续 1 次失败，已切到备用模型 oneapi-chat-gpt/gpt-6-astra（后续任务自动跳过该网关，稍后自动恢复）'],
  );
});

test('a success in between starts the count over, so the gateway is not skipped', async () => {
  process.env.OWB_BREAKER_THRESHOLD = '2';
  const notices = db.pendingNotices('test').length;
  const plans: Script[][] = [['quota', 'answer'], ['answer'], ['quota', 'answer'], ['answer']];
  const models: unknown[][] = [];
  for (const plan of plans) {
    sessions.length = 0;
    models.push((await run(plan)).roots.map((s) => s.model));
  }
  assert.deepEqual(models, [[undefined, GPT], [undefined], [undefined, GPT], [undefined]]);
  assert.equal(db.pendingNotices('test').length, notices);
});

test('a project task opens its sessions at the repo root, any other task in the account workspace', async () => {
  const workspace = join(tmp, 'workspace');
  db.ensureUser('test', 'wx');
  db.setWorkspace('test', workspace);
  const project = { id: 'medo', dir: join(tmp, 'medo') };
  const { roots } = await run(['provider-error', 'answer'], { project });
  assert.deepEqual(roots.map((s) => s.directory), [project.dir, project.dir], 'the retry stays in the repo');
  sessions.length = 0;
  assert.deepEqual((await run(['answer'])).roots.map((s) => s.directory), [workspace]);
});

test('a task speaks as its bot: the persona in the prompt, the reply prefix, and where its memory goes', async () => {
  const memory = join(tmp, 'data', 'memory', 'test');
  const research = await run(['remember'], { botId: 'research' });
  assert.match(research.roots[0].prompt ?? '', /<persona>\nid: research\n/);
  assert.equal(resultText(research.task), '研究：ok');
  assert.match(readFileSync(join(memory, 'bots', 'research.md'), 'utf-8'), new RegExp(`^- \\[\\d{4}-\\d{2}-\\d{2}\\] ${FACT}$`, 'm'));
  sessions.length = 0;
  const chief = await run(['remember']);
  assert.match(chief.roots[0].prompt ?? '', /<persona>\nid: chief\n/);
  assert.doesNotMatch(chief.roots[0].prompt ?? '', new RegExp(FACT), "the default bot does not read another bot's memory");
  assert.equal(resultText(chief.task), 'ok');
  assert.match(readFileSync(join(memory, 'MEMORY.md'), 'utf-8'), new RegExp(FACT));
});
