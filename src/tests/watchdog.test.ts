// runTask against a fake OpenCode server: the first-response and stall watchdogs, the one retry on the configured
// fallback in the same session, a session that is gone, the breaker that skips a failing gateway, the progress notes
// of a long task (diagnostics, off unless OWB_PROGRESS_ENABLED), the directory each session opens in, the bot a task
// speaks as and the model it runs on, the orchestrator agent of each lane, the memories a task reads and saves through
// a fake agentmemory engine, follow-ups that join a running task or continue a finished one's session, and the usage
// and the attachments a task records.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, beforeEach, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';
import type { TaskLane, TaskProject, TaskRow } from '../tasks/db.js';

const FIRST_MS = 2000;
const STALL_MS = 2500;
/** Longer than STALL_MS plus a poll, so only the running-tool rule keeps the turn alive. */
const TOOL_MS = 5000;
/** Progress notes per task; a turn that runs past 300ms gets its first. */
const PROGRESS_MAX = 2;
/** What the 'answer' script's wechat_report call says. */
const REPORT = { status: 'done', reply: 'ok', summary: 'ok' };
const FACT = '用户喜欢简短的回复';
/** What the fake agentmemory engine finds for any search, the queries it got and the writes, with their auth. */
const memoryHits: unknown[] = [];
const memorySearches: Array<{ q: string | null; auth?: string }> = [];
const memoryWrites: Array<{ path: string; body: unknown }> = [];
/** The session model of the fallback the tests configure. */
const GPT = { providerID: 'oneapi-chat-gpt', id: 'gpt-6-astra' };
/** The session model of oneapi/DeepSeek-V4.1-Flash, the default model. */
const DEEPSEEK = { providerID: 'oneapi', id: 'DeepSeek-V4.1-Flash' };
/** What the fake server lists on GET /api/model; the fallback is checked against it before every use. */
const MODELS = [
  { id: 'DeepSeek-V4.1-Flash', providerID: 'oneapi', variants: [] },
  { id: 'gpt-6-astra', providerID: 'oneapi-chat-gpt', variants: ['high'] },
  { id: 'claude-opus-5-5', providerID: 'oneapi-chat', variants: [] },
];
const FALLBACK = 'oneapi-chat-gpt/gpt-6-astra';
/** The paths the 'send-files' script reports. */
const attachments: string[] = [];
/** What each turn of a root session uses: 5000 tokens in with the cache reads, 250 out with the reasoning. */
const TURN_USAGE = { input: 1000, output: 200, reasoning: 50, cache: { read: 4000, write: 0 }, cost: 0.25 };
/** What each subagent session reports it used: 900 tokens in with the cache writes, 100 out. */
const CHILD_USAGE = { tokens: { input: 300, output: 100, reasoning: 0, cache: { read: 0, write: 600 } }, cost: 0.0625 };

type Script =
  | 'silent'
  | 'answer'
  | 'slow-answer'
  | 'take-in'
  | 'remember'
  | 'update'
  | 'delegate'
  | 'provider-error'
  | 'error-then-gone'
  | 'quota'
  | 'gateway-502'
  | 'rejected'
  | 'child-stall'
  | 'child-tool'
  | 'send-files'
  | 'ask'
  | 'no-report';

interface FakeSession {
  id: string;
  parentID?: string;
  /** The model it was created with, then the one each switch set. */
  model?: unknown;
  /** The agent the session was created with. */
  agent?: string;
  /** The location.directory the session was created with. */
  directory?: string;
  time: { created: number };
  messages: any[];
  interrupted: boolean;
  /** Input steered in that no turn took in. */
  inbox: Array<{ id: string; type: 'user'; payload: { text: string } }>;
  /** It goes once it is interrupted, as a session someone deletes. */
  vanish?: boolean;
  /** Gone from the server: every request about it gets OpenCode's 404. */
  gone?: boolean;
  /** What the session used over all its turns, as GET /api/session/:id and the child list report it. */
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  cost: number;
}

/** A prompt the server got: the session, the session's model at that moment, the text and how it was to be delivered. */
interface Prompt {
  session: string;
  model: unknown;
  text: string;
  delivery: string;
  resume?: boolean;
}

const sessions: FakeSession[] = [];
const prompts: Prompt[] = [];
/** How each turn behaves, in the order the turns start: each queued prompt starts one. */
const scripts: Script[] = [];
/** Runs once, at the next read of an inbox. */
let onInboxRead: (() => void) | undefined;
let ids = 0;

const later = (ms: number, fn: () => void): void => void setTimeout(fn, ms).unref();
const message = (type: string, fields: object = {}): any => ({ id: `msg_${++ids}`, type, time: { created: Date.now() }, ...fields });
const assistant = (...content: unknown[]): any => message('assistant', { content });
const idle = (outcome: string, error?: unknown): any => message('idle', { outcome, error });
const tool = (name: string): any => ({ type: 'tool', name, state: { status: 'running' }, time: { created: Date.now(), ran: Date.now() } });
const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });

function addSession(fields: Partial<FakeSession> = {}): FakeSession {
  const usage = fields.parentID ? CHILD_USAGE : { tokens: zeroTokens(), cost: 0 };
  const session: FakeSession = { id: `ses_${++ids}`, time: { created: Date.now() }, messages: [], interrupted: false, inbox: [], ...usage, ...fields };
  sessions.push(session);
  return session;
}

/** A turn of the root session uses TURN_USAGE. */
function charge(session: FakeSession): void {
  const t = session.tokens;
  session.tokens = {
    input: t.input + TURN_USAGE.input,
    output: t.output + TURN_USAGE.output,
    reasoning: t.reasoning + TURN_USAGE.reasoning,
    cache: { read: t.cache.read + TURN_USAGE.cache.read, write: t.cache.write + TURN_USAGE.cache.write },
  };
  session.cost += TURN_USAGE.cost;
}

/** The turn ends with a wechat_report call of these fields. */
function answer(session: FakeSession, fields: object = {}): void {
  const now = Date.now();
  const time = { created: now, streamed: now, completed: now };
  const report = { type: 'tool', id: `call_${++ids}`, name: 'wechat_report', state: { status: 'completed', input: { ...REPORT, ...fields } } };
  session.messages.push(message('assistant', { time, content: [report] }), idle('succeeded'));
}

/** A turn that works on a shell command for 2 s, a poll's length and more, then answers. */
function slowly(session: FakeSession, beforeAnswer: () => void = () => {}): void {
  later(100, () => {
    const shell = tool('shell');
    session.messages.push(assistant(shell));
    later(2000, () => {
      shell.state.status = 'completed';
      beforeAnswer();
      answer(session);
    });
  });
}

/** What a root session does once a queued prompt arrives. */
const play: Record<Script, (session: FakeSession) => void> = {
  silent: () => {},
  answer: (s) => later(100, () => answer(s)),
  // The turn takes nothing in: what is steered meanwhile stays in the inbox.
  'slow-answer': (s) => slowly(s),
  // The turn takes in what was steered meanwhile before it answers.
  'take-in': (s) => slowly(s, () => void s.inbox.splice(0)),
  remember: (s) => later(100, () => answer(s, { memory: [FACT, '无'] })),
  // Rewrites one memory the prompt showed whole and one it showed cut, by their ids.
  update: (s) => later(100, () => answer(s, { memory: ['[mem_a 2026-11-19] 用户在 M1 上工作', '- [mem_long] 长记忆的新版本'] })),
  // One subagent runs and finishes, then the orchestrator answers.
  delegate: (s) =>
    later(100, () => {
      addSession({ parentID: s.id }).messages.push(message('user'), idle('succeeded'));
      answer(s);
    }),
  'provider-error': (s) =>
    later(100, () => s.messages.push(idle('failed', { type: 'provider.internal', message: 'control plan is unavailable' }))),
  // The same, and the session is deleted as the attempt ends.
  'error-then-gone': (s) => {
    s.vanish = true;
    play['provider-error'](s);
  },
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
  'send-files': (s) => later(100, () => answer(s, { files: [...attachments] })),
  // The reply asks the user to choose.
  ask: (s) => later(100, () => answer(s, { status: 'needs_input', reply: '你说的是哪台？\n1. M1\n2. M5' })),
  // The turn ends on text, with no report.
  'no-report': (s) =>
    later(100, () => {
      const now = Date.now();
      s.messages.push(message('assistant', { time: { created: now, streamed: now }, content: [{ type: 'text', text: 'ok' }] }), idle('succeeded'));
    }),
};

/** OpenCode's 404 for a session it does not have. */
const notFound = (id: string) => JSON.stringify({ _tag: 'SessionNotFoundError', sessionID: id, message: `Session not found: ${id}` });

/** The OpenCode routes runTask uses, and the agentmemory ones under /agentmemory/. */
function handle(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const json = (status: number, data: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const send = (data: unknown) => json(200, { data });
    if (url.pathname.startsWith('/agentmemory/')) {
      if (url.pathname === '/agentmemory/memories') {
        memorySearches.push({ q: url.searchParams.get('q'), auth: req.headers.authorization });
        return json(200, { memories: memoryHits });
      }
      memoryWrites.push({ path: url.pathname, body: JSON.parse(body) });
      return url.pathname === '/agentmemory/evolve' ? json(200, { success: true }) : json(201, { success: true });
    }
    if (url.pathname === '/api/model') return send(MODELS);
    if (url.pathname === '/api/session') {
      if (req.method === 'GET') return send(sessions.filter((s) => s.parentID === url.searchParams.get('parentID') && !s.gone));
      const { model, agent, location } = JSON.parse(body);
      return send({ id: addSession({ model, agent, directory: location?.directory }).id });
    }
    const [, , , id, action, item] = url.pathname.split('/');
    const session = sessions.find((s) => s.id === id && !s.gone);
    if (!session) return void res.writeHead(404, { 'Content-Type': 'application/json' }).end(notFound(id));
    if (action === undefined) return send({ id: session.id, tokens: session.tokens, cost: session.cost });
    if (action === 'message') return send([...session.messages].reverse());
    if (action === 'permission') return send([]);
    if (action === 'model') {
      session.model = JSON.parse(body).model;
      return void res.writeHead(204).end();
    }
    if (action === 'inbox') {
      if (req.method === 'DELETE') {
        session.inbox = session.inbox.filter((entry) => entry.id !== item);
        return void res.writeHead(204).end();
      }
      const hook = onInboxRead;
      onInboxRead = undefined;
      hook?.();
      return send(session.inbox);
    }
    if (action === 'interrupt') {
      session.interrupted = true;
      if (session.vanish) session.gone = true;
      return void res.writeHead(204).end();
    }
    if (action === 'prompt') {
      const { text, delivery, resume } = JSON.parse(body);
      prompts.push({ session: session.id, model: session.model, text, delivery, resume });
      const user = message('user');
      // A steer waits in the inbox until a turn takes it in; resume: false never starts one.
      if (delivery === 'steer') {
        session.inbox.push({ id: user.id, type: 'user', payload: { text } });
        return send({ id: user.id, time: user.time });
      }
      session.messages.push(user);
      charge(session);
      play[scripts.shift() ?? 'silent'](session);
      return send({ id: user.id, time: user.time });
    }
    res.writeHead(404).end();
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'owb-watchdog-'));
// Logs and config follow HOME, state OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
process.env.OPENCODE_SERVER_PASSWORD = '';
process.env.OPENCODE_FIRST_RESPONSE_TIMEOUT_MS = String(FIRST_MS);
process.env.OPENCODE_STALL_TIMEOUT_MS = String(STALL_MS);
// The progress notes are off by default; the tests here check them, so they turn them on.
process.env.OWB_PROGRESS_ENABLED = 'true';
process.env.OWB_PROGRESS_FIRST_MS = '300';
process.env.OWB_PROGRESS_MIN_GAP_MS = '200';
process.env.OWB_PROGRESS_EVERY_MS = '1000';
process.env.OWB_PROGRESS_MAX = String(PROGRESS_MAX);
// Most tests here retry on this fallback; the ones about a missing or unset fallback change it and put it back.
process.env.OPENCODE_FALLBACK_MODEL = FALLBACK;
delete process.env.OPENCODE_DEFAULT_MODEL;
delete process.env.OWB_BREAKER_THRESHOLD;
delete process.env.OWB_BREAKER_COOLDOWN_MS;

const server = createServer(handle);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
// The fake server is the agentmemory engine too, so no test reads or writes the owner's.
process.env.AGENTMEMORY_URL = process.env.OPENCODE_URL;
process.env.AGENTMEMORY_SECRET = 'test-secret';

// provider.ts reads its settings at module load, so the bot modules load after the fake server is up.
const { joinRunningTask, resultText, runTask } = await import('../orchestrator.js');
const { BOTS_PATH, loadBots } = await import('../bots.js');
const { routeCommand } = await import('../commands/router.js');
const { resetModelRouting } = await import('../model-routing.js');
const { openStateDb } = await import('../tasks/db.js');
const db = openStateDb(join(tmp, 'state.db'));

interface RunOptions {
  /** Does what /stop does after this long. */
  stopAfterMs?: number;
  project?: TaskProject;
  botId?: string;
  lane?: TaskLane;
  /** Every progress note fails to send, as a reply does while WeChat is unreachable. */
  progressFails?: boolean;
  /** As --simulate runs a task: it reads memories but saves none. */
  readOnlyMemory?: boolean;
  /** The session the task continues, as a follow-up of a finished task is created. */
  continues?: string;
  /** Runs once the task has started, while it runs. */
  whileRunning?: (task: TaskRow) => void;
}

/** Run one task through the given turn scripts; prompts are the ones the server got during it. */
async function run(
  plan: Script[],
  { stopAfterMs, project, botId, lane, progressFails, readOnlyMemory, continues, whileRunning }: RunOptions = {},
) {
  scripts.push(...plan);
  let task = db.startTaskNow('test', 'hi', project, botId, lane)!;
  if (continues) {
    db.setTaskSession(task.id, continues);
    task = db.getTask(task.id)!;
  }
  const controller = new AbortController();
  if (stopAfterMs !== undefined) {
    later(stopAfterMs, () => {
      db.finishTask(task.id, 'interrupted', { error: '用户停止', notified: true });
      controller.abort();
    });
  }
  const delivered: TaskRow[] = [];
  const progress: string[] = [];
  const from = prompts.length;
  const startedAt = Date.now();
  const running = runTask(
    db,
    task,
    {
      deliver: async (t) => void delivered.push(t),
      progress: async (text) => {
        progress.push(text);
        if (progressFails) throw new Error('send failed');
      },
      readOnlyMemory,
    },
    controller.signal,
  );
  whileRunning?.(task);
  await running;
  const roots = sessions.filter((s) => !s.parentID);
  return { task: db.getTask(task.id)!, delivered, progress, roots, prompts: prompts.slice(from), elapsed: Date.now() - startedAt };
}

beforeEach(() => {
  sessions.length = 0;
  prompts.length = 0;
  scripts.length = 0;
  onInboxRead = undefined;
  memoryHits.length = 0;
  memorySearches.length = 0;
  memoryWrites.length = 0;
  // Gateway state lives in memory for the whole process; each test starts with every breaker closed.
  resetModelRouting();
  delete process.env.OWB_BREAKER_THRESHOLD;
  process.env.OPENCODE_FALLBACK_MODEL = FALLBACK;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.OWB_BREAKER_THRESHOLD;
});

test('a model that never answers times out, and the same session goes on with the fallback model', async () => {
  const { task, delivered, roots, prompts: sent, elapsed } = await run(['silent', 'answer']);
  assert.equal(task.status, 'done');
  assert.equal(task.result, 'ok');
  assert.equal(roots.length, 1, 'one session for both attempts');
  assert.ok(roots[0].interrupted, 'the silent turn is interrupted');
  assert.deepEqual(sent.map((p) => [p.session, p.model]), [[roots[0].id, undefined], [roots[0].id, GPT]]);
  assert.doesNotMatch(sent[0].text, /<retry>/);
  assert.match(sent[1].text, new RegExp(`^<retry>\\nYour previous attempt stopped: 上游模型 ${FIRST_MS / 1000} 秒无响应\\n</retry>\\n\\n`));
  assert.doesNotMatch(sent[1].text, /<recent_tasks>/, 'the session has the task already');
  assert.equal(task.session_id, roots[0].id);
  const raw = new DatabaseSync(join(tmp, 'state.db'));
  const recorded = raw.prepare('SELECT session_id FROM task_sessions WHERE task_id = ? ORDER BY rowid').all(task.id);
  raw.close();
  assert.deepEqual(recorded.map((row) => row.session_id), [roots[0].id]);
  assert.equal(delivered.length, 1);
  assert.ok(elapsed >= FIRST_MS && elapsed < FIRST_MS + 5000, `took ${elapsed}ms`);
});

test('a session that is gone before the retry is replaced by a new one, with the whole prompt', async () => {
  const { task, roots, prompts: sent } = await run(['error-then-gone', 'answer']);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 2);
  assert.deepEqual(sent.map((p) => [p.session, p.model]), [[roots[0].id, undefined], [roots[1].id, GPT]]);
  assert.match(sent[1].text, /^<context>\nworkspace: [\s\S]*^retry: an earlier attempt/m);
  assert.equal(task.session_id, roots[1].id);
});

test('a subagent that stops making progress times out the turn', async () => {
  const { task, roots } = await run(['child-stall', 'answer']);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  const child = sessions.find((s) => s.parentID === roots[0].id);
  assert.ok(child?.interrupted, 'the stalled subagent session is interrupted');
});

test('a tool that runs longer than the stall timeout is not a stall, and the user hears that the task is running it', async () => {
  const { task, roots, elapsed, progress } = await run(['child-tool']);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  assert.ok(elapsed >= TOOL_MS, `took ${elapsed}ms`);
  assert.ok(progress.length >= 1 && progress.length <= PROGRESS_MAX, `${progress.length} notes`);
  // The subagent's shell command, not the orchestrator's subagent call that waits on it.
  assert.match(progress[0], new RegExp(`^⏳ 任务 #${task.seq} 运行中（\\d+秒），正在 shell，已派出 1 个子任务$`));
});

test('a task that finishes quickly sends no progress note', async () => {
  const { task, progress } = await run(['answer']);
  assert.equal(task.status, 'done');
  assert.deepEqual(progress, []);
});

test('without OWB_PROGRESS_ENABLED a long task sends no progress note', async (t) => {
  delete process.env.OWB_PROGRESS_ENABLED;
  t.after(() => {
    process.env.OWB_PROGRESS_ENABLED = 'true';
  });
  // With the notes on, the silent primary alone brings one, as the cap test below shows.
  const { task, delivered, progress } = await run(['silent', 'answer']);
  assert.equal(task.status, 'done');
  assert.deepEqual(progress, []);
  assert.equal(delivered.length, 1);
});

test('progress notes stop at the cap over both attempts, and a note that fails to send is dropped', async () => {
  const notices = db.pendingNotices('test').length;
  // Uncapped, the silent primary and the fallback's long tool would bring 4 notes.
  const { task, prompts: sent, progress } = await run(['silent', 'child-tool'], { progressFails: true });
  assert.equal(task.status, 'done');
  assert.equal(sent.length, 2);
  assert.equal(progress.length, PROGRESS_MAX);
  assert.match(progress[0], new RegExp(`^⏳ 任务 #${task.seq} 运行中（\\d+秒）$`), 'the silent primary has no subagent');
  assert.match(progress[1], /，正在 shell，已派出 1 个子任务$/);
  assert.equal(db.pendingNotices('test').length, notices, 'progress never goes to the outbox');
});

test('a provider error is retried once, then the task fails with a short error', async () => {
  const { task, delivered, prompts: sent } = await run(['provider-error', 'silent']);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, `备用模型重试后仍失败：上游模型 ${FIRST_MS / 1000} 秒无响应`);
  assert.equal(sent.length, 2);
  assert.equal(delivered.length, 1);
});

test('a gateway error OpenCode did not map to provider.* is retried on the fallback too', async () => {
  const { task, prompts: sent } = await run(['gateway-502', 'answer']);
  assert.equal(task.status, 'done');
  assert.deepEqual(sent.map((p) => p.model), [undefined, GPT]);
});

test('other failures are not retried', async () => {
  const { task, prompts: sent } = await run(['rejected', 'answer']);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'OpenCode 执行失败: permission.rejected: rejected');
  assert.equal(sent.length, 1);
});

test('a stopped task is not retried', async () => {
  const { task, delivered, roots, prompts: sent } = await run(['silent', 'answer'], { stopAfterMs: 500 });
  assert.equal(task.status, 'interrupted');
  assert.equal(task.error, '用户停止');
  assert.equal(sent.length, 1);
  assert.ok(roots[0].interrupted);
  assert.equal(delivered.length, 0);
});

test('a gateway that keeps failing is skipped by later tasks, and the user hears it once', async () => {
  process.env.OWB_BREAKER_THRESHOLD = '1';
  const notices = db.pendingNotices('test').length;
  const first = await run(['quota', 'answer']);
  assert.equal(first.task.status, 'done');
  assert.deepEqual(first.prompts.map((p) => p.model), [undefined, GPT]);
  sessions.length = 0;
  const second = await run(['answer']);
  assert.equal(second.task.status, 'done');
  assert.deepEqual(second.roots.map((s) => s.model), [GPT], 'a new session, already on the fallback');
  assert.doesNotMatch(second.prompts[0].text, /^retry: /m);
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
  for (const plan of plans) models.push((await run(plan)).prompts.map((p) => p.model));
  assert.deepEqual(models, [[undefined, GPT], [undefined], [undefined, GPT], [undefined]]);
  assert.equal(db.pendingNotices('test').length, notices);
});

test('a project task opens its session at the repo root, any other task in the account workspace', async () => {
  const workspace = join(tmp, 'workspace');
  db.ensureUser('test', 'wx');
  db.setWorkspace('test', workspace);
  const project = { id: 'medo', dir: join(tmp, 'medo') };
  const { roots, prompts: sent } = await run(['provider-error', 'answer'], { project });
  assert.deepEqual(roots.map((s) => s.directory), [project.dir]);
  assert.equal(sent.length, 2, 'the retry stays in that session');
  sessions.length = 0;
  assert.deepEqual((await run(['answer'])).roots.map((s) => s.directory), [workspace]);
});

test('a task speaks as its bot: the persona in the prompt and the reply prefix', async () => {
  const research = await run(['answer'], { botId: 'research' });
  assert.match(research.prompts[0].text, /<persona>\nid: research\n/);
  assert.equal(resultText(research.task), '研究：ok');
  const chief = await run(['answer']);
  assert.match(chief.prompts[0].text, /<persona>\nid: chief\n/);
  assert.equal(resultText(chief.task), 'ok');
});

test("the memories that match the message are in the task's prompt, and a done task's fact is saved", async () => {
  // 17:00 UTC is the next day in Shanghai.
  memoryHits.push({ id: 'mem_a', content: '用户  在 M5\n上工作', updatedAt: '2026-11-18T17:00:00Z' });
  const { task, prompts: sent } = await run(['provider-error', 'remember']);
  assert.equal(task.status, 'done');
  assert.deepEqual(memorySearches, [{ q: 'hi', auth: 'Bearer test-secret' }], 'one search, with the message, for both attempts');
  assert.match(sent[0].text, /\n<memory>\n- \[mem_a 2026-11-19\] 用户 在 M5 上工作\n<\/memory>\n/);
  assert.match(sent[1].text, /^<retry>/, 'the retry continues the session that has them');
  assert.deepEqual(memoryWrites, [{ path: '/agentmemory/remember', body: { content: FACT, concepts: ['wechat-opencode-bot'] } }]);

  memoryHits.length = 0;
  assert.match((await run(['answer'])).prompts[0].text, /\n<memory>\n\(暂无\)\n<\/memory>\n/, 'nothing matched');
});

test('a fact naming a memory shown whole updates it; one shown cut is saved as a new memory', async () => {
  memoryHits.push({ id: 'mem_a', content: '用户在 M5 上工作', updatedAt: '2026-11-18T17:00:00Z' }, { id: 'mem_long', content: '长'.repeat(700) });
  await run(['update']);
  assert.deepEqual(memoryWrites, [
    { path: '/agentmemory/evolve', body: { memoryId: 'mem_a', newContent: '用户在 M1 上工作' } },
    { path: '/agentmemory/remember', body: { content: '长记忆的新版本', concepts: ['wechat-opencode-bot'] } },
  ]);
});

test('a read-only run, as --simulate is, reads memories and saves none; a failed task saves none either', async () => {
  const simulated = await run(['remember'], { readOnlyMemory: true });
  assert.equal(simulated.task.status, 'done');
  assert.equal(memorySearches.length, 1);
  assert.deepEqual(memoryWrites, []);
  delete process.env.OPENCODE_FALLBACK_MODEL;
  assert.equal((await run(['provider-error'])).task.status, 'failed');
  assert.deepEqual(memoryWrites, []);
});

test('a read-lane task runs on the read-only orchestrator, its retry too; a write task on the full one', async () => {
  const read = await run(['provider-error', 'answer'], { botId: 'research', lane: 'read' });
  assert.equal(read.task.status, 'done');
  assert.deepEqual(read.roots.map((s) => s.agent), ['wechat-orchestrator-read']);
  assert.equal(read.prompts.length, 2);
  sessions.length = 0;
  assert.deepEqual((await run(['answer'])).roots.map((s) => s.agent), ['wechat-orchestrator']);
});

test("a task runs on its bot's model unless /model picks one, and a failing bot model retries on the fallback", async (t) => {
  // eng runs Claude; ops runs a variant of the fallback's model, and its retry runs on the fallback as configured.
  const models: Record<string, string> = { eng: 'oneapi-chat/claude-opus-5-5', ops: 'oneapi-chat-gpt/gpt-6-astra#high' };
  const bots = loadBots();
  const registry = readFileSync(BOTS_PATH, 'utf-8');
  writeFileSync(BOTS_PATH, JSON.stringify({ bots: bots.map((b) => (models[b.id] ? { ...b, model: models[b.id] } : b)) }));
  db.ensureUser('test', 'wx');
  t.after(() => {
    writeFileSync(BOTS_PATH, registry);
    db.setModel('test', null);
  });
  const promptModels = async (plan: Script[], botId?: string) => (await run(plan, { botId })).prompts.map((p) => p.model);
  assert.deepEqual(await promptModels(['answer'], 'eng'), [{ providerID: 'oneapi-chat', id: 'claude-opus-5-5' }]);
  assert.deepEqual(await promptModels(['answer']), [undefined], "a bot without a model runs the agent's own");
  assert.deepEqual(await promptModels(['provider-error', 'answer'], 'ops'), [{ ...GPT, variant: 'high' }, GPT]);
  db.setModel('test', 'oneapi/DeepSeek-V4.1-Flash');
  assert.deepEqual(await promptModels(['answer'], 'eng'), [DEEPSEEK], '/model wins over the bot model');
});

test('a fallback the server no longer lists is not tried, and the error says why', async () => {
  process.env.OPENCODE_FALLBACK_MODEL = 'oneapi-chat-gpt/gone';
  const { task, prompts: sent, delivered } = await run(['provider-error', 'answer']);
  assert.equal(task.status, 'failed');
  assert.equal(sent.length, 1, 'no second attempt');
  assert.match(
    task.error ?? '',
    /^未重试：备用模型 oneapi-chat-gpt\/gone 不在 OpenCode 的模型列表里，请更新 OPENCODE_FALLBACK_MODEL。OpenCode 执行失败: provider\.internal/,
  );
  assert.equal(delivered.length, 1);
});

test('without a fallback an upstream failure is not retried, and the error is the primary model’s', async () => {
  delete process.env.OPENCODE_FALLBACK_MODEL;
  const { task, prompts: sent } = await run(['provider-error', 'answer']);
  assert.equal(task.status, 'failed');
  assert.equal(sent.length, 1);
  assert.equal(task.error, 'OpenCode 执行失败: provider.internal: control plan is unavailable');
});

test('an open breaker without a usable fallback leaves tasks on the primary, and promises no switch', async () => {
  process.env.OWB_BREAKER_THRESHOLD = '1';
  process.env.OPENCODE_FALLBACK_MODEL = 'oneapi-chat-gpt/gone';
  const notices = db.pendingNotices('test').length;
  const first = await run(['quota']);
  assert.equal(first.task.status, 'failed');
  sessions.length = 0;
  const second = await run(['answer']);
  assert.equal(second.task.status, 'done');
  assert.deepEqual(second.roots.map((s) => s.model), [undefined], 'the primary, though its breaker is open');
  const said = db.pendingNotices('test').slice(notices).map((n) => n.text);
  assert.ok(!said.some((text) => text.includes('已切到备用模型')), `no notice about a switch that did not happen: ${said.join(' | ')}`);
});

/** The tokens in, the tokens out and the cost a task recorded. */
const used = (task: TaskRow) => [task.tokens_in, task.tokens_out, task.cost_usd];

test('a done task records what its session and its subagents used', async () => {
  const { task } = await run(['delegate']);
  assert.equal(task.status, 'done');
  assert.equal(task.result, 'ok');
  assert.equal(task.summary, 'ok');
  // The root's 5000 in and 250 out, plus the subagent's 900 and 100.
  assert.deepEqual(used(task), [5900, 350, 0.3125]);
});

test('a retried task records what both turns of its session used', async () => {
  const { task, roots } = await run(['provider-error', 'answer']);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  assert.deepEqual(used(task), [10000, 500, 0.5]);
});

test('a failed task and a stopped one still record what they used', async () => {
  const failed = await run(['rejected']);
  assert.equal(failed.task.status, 'failed');
  assert.deepEqual(used(failed.task), [5000, 250, 0.25]);
  // The stop finishes the task before runTask does, as /stop does, so runTask only adds the usage.
  const stopped = await run(['silent'], { stopAfterMs: 500 });
  assert.equal(stopped.task.status, 'interrupted');
  assert.equal(stopped.task.error, '用户停止');
  assert.deepEqual(used(stopped.task), [5000, 250, 0.25]);
});

test('a done task keeps the files it may send, and its reply says how many of the others did not go', async () => {
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  const inside = join(repo, 'chart.png');
  const outside = join(tmp, 'secret.txt');
  writeFileSync(inside, 'png');
  writeFileSync(outside, 'secret');
  attachments.push(inside, outside);
  const { task, delivered } = await run(['send-files'], { project: { id: 'repo', dir: repo } });
  assert.equal(task.status, 'done');
  assert.equal(task.result, 'ok\n（有 1 个附件未发送：路径不在工作区、类型/大小不支持或超过 3 个）');
  assert.equal(task.files, JSON.stringify([inside]));
  assert.equal(delivered[0].files, task.files, 'deliver gets the row with the files');
});

test('a follow-up task continues the session it was created with: a short prompt, on the model of its attempt', async () => {
  const first = await run(['answer']);
  const session = first.roots[0].id;
  const next = await run(['answer'], { continues: session });
  assert.equal(next.task.status, 'done');
  assert.equal(sessions.filter((s) => !s.parentID).length, 1, 'no new session');
  assert.deepEqual(next.prompts.map((p) => [p.session, p.model]), [[session, DEEPSEEK]], "switched to the agent's own model");
  assert.match(
    next.prompts[0].text,
    new RegExp(`^<context>\\ntime: .+\\ntask: #${next.task.seq}\\n</context>\\n\\n<memory>\\n\\(暂无\\)\\n</memory>\\n\\n<user_message>\\nhi\\n</user_message>`),
  );
  assert.equal(next.task.session_id, session);
  // One turn's worth, though the session's totals hold the first task's too.
  assert.deepEqual(used(next.task), [5000, 250, 0.25]);
});

test('a follow-up task whose session is gone runs in a new session with the whole prompt', async () => {
  const { task, roots, prompts: sent } = await run(['answer'], { continues: 'ses_missing' });
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  assert.match(sent[0].text, /^<context>\nworkspace: /);
  assert.equal(task.session_id, roots[0].id);
});

test('a follow-up steers into the running turn; one the turn did not take in gets a turn of its own', async () => {
  let joined: boolean | undefined;
  const { task, roots, prompts: sent } = await run(['slow-answer', 'answer'], {
    whileRunning: (t) => later(400, () => (joined = joinRunningTask(t.id, '先别改测试'))),
  });
  assert.equal(joined, true);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  assert.deepEqual(sent.map((p) => [p.session, p.delivery]), [[roots[0].id, 'queue'], [roots[0].id, 'steer'], [roots[0].id, 'queue']]);
  assert.equal(sent[1].resume, false, 'a steer never starts a turn of its own');
  assert.match(sent[1].text, /^<user_correction>\n先别改测试\n<\/user_correction>\n\n/);
  assert.equal(sent[2].text, sent[1].text, 'taken out of the inbox, it is the next turn');
  assert.deepEqual(roots[0].inbox, []);
  assert.equal(joinRunningTask(task.id, '太晚了'), false, 'a finished task takes no more');
});

test('a steer the turn takes in needs no turn of its own; /steer hands its text over the same way', async () => {
  let reply: string | undefined;
  const ctx = { accountId: 'test', db } as CommandContext;
  const { task, prompts: sent } = await run(['take-in'], {
    whileRunning: () => later(400, () => void routeCommand('/steer 只看 src', ctx).then((text) => (reply = text))),
  });
  assert.equal(task.status, 'done');
  assert.equal(reply, `🎯 已把修正交给任务 #${task.seq}，运行中会在下一个步骤采纳`);
  assert.deepEqual(sent.map((p) => p.delivery), ['queue', 'steer']);
  assert.equal(task.input, 'hi\n只看 src', '/tasks and later prompts see it');
});

test('a follow-up that comes as the turn answers gets a turn of its own before the task closes', async () => {
  const { task, prompts: sent } = await run(['answer', 'answer'], {
    whileRunning: (t) => (onInboxRead = () => assert.ok(joinRunningTask(t.id, '还有 redis'))),
  });
  assert.equal(task.status, 'done');
  assert.deepEqual(sent.map((p) => p.delivery), ['queue', 'queue']);
  assert.match(sent[1].text, /^<user_correction>\n还有 redis\n<\/user_correction>/);
});

test('a turn that ends without wechat_report gets one prompt to give it, in the same session; still none, and the task fails', async () => {
  const nudged = await run(['no-report', 'answer']);
  assert.equal(nudged.task.status, 'done');
  assert.equal(nudged.task.result, 'ok');
  assert.deepEqual(nudged.prompts.map((p) => [p.session, p.delivery]), [[nudged.roots[0].id, 'queue'], [nudged.roots[0].id, 'queue']]);
  assert.match(nudged.prompts[1].text, /^Your turn ended without calling wechat_report/);
  sessions.length = 0;
  const { task, prompts: sent, delivered } = await run(['no-report', 'no-report']);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'OpenCode 执行结束，但模型没有给出最终回复');
  assert.equal(sent.length, 2, 'one nudge, and no retry: the model answered, just not as asked');
  assert.equal(delivered.length, 1);
});

test('a done task records the status its report gave, and its reply as the result', async () => {
  const { task } = await run(['ask']);
  assert.deepEqual([task.status, task.outcome, task.result, task.summary], ['done', 'needs_input', '你说的是哪台？\n1. M1\n2. M5', 'ok']);
  const plain = await run(['answer']);
  assert.equal(plain.task.outcome, 'done');
});
