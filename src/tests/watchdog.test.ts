// runTask against a fake OpenCode server: the first-response and stall watchdogs, and the one-shot fallback.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { TaskRow } from '../tasks/db.js';

const FIRST_MS = 2000;
const STALL_MS = 2500;
/** Longer than STALL_MS plus a poll, so only the running-tool rule keeps the turn alive. */
const TOOL_MS = 5000;
const REPLY = '<<<WECHAT_REPLY>>>\nok\n<<<WECHAT_MEMORY>>>\n- 无\n<<<WECHAT_SUMMARY>>>\nok';

type Script = 'silent' | 'answer' | 'provider-error' | 'rejected' | 'child-stall' | 'child-tool';

interface FakeSession {
  id: string;
  parentID?: string;
  script?: Script;
  model?: unknown;
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

function answer(session: FakeSession): void {
  const now = Date.now();
  const time = { created: now, streamed: now, completed: now };
  session.messages.push(message('assistant', { time, content: [{ type: 'text', text: REPLY }] }), idle('succeeded'));
}

/** What a root session does once its prompt arrives. */
const play: Record<Script, (session: FakeSession) => void> = {
  silent: () => {},
  answer: (s) => later(100, () => answer(s)),
  'provider-error': (s) =>
    later(100, () => s.messages.push(idle('failed', { type: 'provider.internal', message: 'control plan is unavailable' }))),
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
      return send({ id: addSession({ model: JSON.parse(body).model, script: scripts.shift() }).id });
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
delete process.env.OPENCODE_FALLBACK_MODEL;

const server = createServer(handle);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// provider.ts reads its settings at module load, so the bot modules load after the fake server is up.
const { runTask } = await import('../orchestrator.js');
const { openStateDb } = await import('../tasks/db.js');
const db = openStateDb(join(tmp, 'state.db'));

/** Run one task through the given session scripts; stopAfterMs does what /stop does. */
async function run(plan: Script[], stopAfterMs?: number) {
  scripts.push(...plan);
  const task = db.startTaskNow('test', 'hi')!;
  const controller = new AbortController();
  if (stopAfterMs !== undefined) {
    later(stopAfterMs, () => {
      db.finishTask(task.id, 'interrupted', { error: '用户停止', notified: true });
      controller.abort();
    });
  }
  const delivered: TaskRow[] = [];
  const startedAt = Date.now();
  await runTask(db, task, { deliver: async (t) => void delivered.push(t) }, controller.signal);
  const roots = sessions.filter((s) => !s.parentID);
  return { task: db.getTask(task.id)!, delivered, roots, elapsed: Date.now() - startedAt };
}

beforeEach(() => {
  sessions.length = 0;
  scripts.length = 0;
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('a model that never answers times out, and the fallback model finishes the task', async () => {
  const { task, delivered, roots, elapsed } = await run(['silent', 'answer']);
  assert.equal(task.status, 'done');
  assert.equal(task.result, 'ok');
  assert.equal(roots.length, 2);
  assert.ok(roots[0].interrupted, 'the silent session is interrupted');
  assert.equal(roots[0].model, undefined);
  assert.deepEqual(roots[1].model, { providerID: 'oneapi', id: 'DeepSeek-V4.1-Flash' });
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

test('a tool that runs longer than the stall timeout is not a stall', async () => {
  const { task, roots, elapsed } = await run(['child-tool']);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  assert.ok(elapsed >= TOOL_MS, `took ${elapsed}ms`);
});

test('a provider error is retried once, then the task fails with a short error', async () => {
  const { task, delivered, roots } = await run(['provider-error', 'silent']);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, `备用模型重试后仍失败：上游模型 ${FIRST_MS / 1000} 秒无响应`);
  assert.equal(roots.length, 2);
  assert.equal(delivered.length, 1);
});

test('other failures are not retried', async () => {
  const { task, roots } = await run(['rejected', 'answer']);
  assert.equal(task.status, 'failed');
  assert.equal(task.error, 'OpenCode 执行失败: permission.rejected: rejected');
  assert.equal(roots.length, 1);
});

test('a stopped task is not retried', async () => {
  const { task, delivered, roots } = await run(['silent', 'answer'], 500);
  assert.equal(task.status, 'interrupted');
  assert.equal(task.error, '用户停止');
  assert.equal(roots.length, 1);
  assert.ok(roots[0].interrupted);
  assert.equal(delivered.length, 0);
});
