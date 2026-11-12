// runTask against a fake OpenCode server whose sessions change from one poll to the next (a poll every 1.5s): what
// the orchestrator writes on a root step that calls a tool reaches the user once, in its bot's voice and ahead of
// the answer; only a step that calls no tool can be the answer; reasoning, subagents, tool payloads, steps still
// streaming, answer text and tool-call markup are never commentary; a stop, a failed send or a finished task drops
// a note without touching the outcome; a retry does not say again what was said; and OWB_PROGRESS_MAX=0 sends no
// progress note though the notes are on.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const REPLY = '<<<WECHAT_REPLY>>>\nok\n<<<WECHAT_MEMORY>>>\n- 无\n<<<WECHAT_SUMMARY>>>\nok';
const NO_ANSWER = 'OpenCode 执行结束，但模型没有给出最终回复';

/** What a session does as the provider reads its messages: one read per poll. */
type Read = (session: FakeSession) => void;

interface FakeSession {
  id: string;
  parentID?: string;
  messages: any[];
  /** One runs before each read of the messages; out of reads, the session stays as it is. */
  reads: Read[];
  interrupted: boolean;
}

const sessions: FakeSession[] = [];
/** The reads of each new root session, in creation order. */
const turns: Read[][] = [];
let ids = 0;
let clock = 0;

/** Creation times strictly increase, so the steps of a turn sort in the order they were written. */
const created = (): number => (clock = Math.max(Date.now(), clock + 1));
const message = (type: string, fields: object = {}): any => ({ id: `msg_${++ids}`, type, time: { created: created() }, ...fields });
/** A step whose response has streamed in full; a tool it calls may still run. */
const step = (...content: unknown[]): any => {
  const at = created();
  return { id: `msg_${++ids}`, type: 'assistant', time: { created: at, streamed: at }, content };
};
const text = (value: string) => ({ type: 'text', text: value });
const tool = (name: string, status = 'running', state: object = {}): any => ({ type: 'tool', name, state: { status, ...state } });
const idle = (outcome: string, error?: unknown): any => message('idle', { outcome, error });
/** The answer comes and the turn ends. */
const answer: Read = (s) => void s.messages.push(step(text(REPLY)), idle('succeeded'));

function addSession(fields: Partial<FakeSession> = {}): FakeSession {
  const session: FakeSession = { id: `ses_${++ids}`, messages: [], reads: [], interrupted: false, ...fields };
  sessions.push(session);
  return session;
}

/** The few OpenCode routes a turn uses. A new root session takes its reads from turns. */
function handle(req: IncomingMessage, res: ServerResponse): void {
  req.resume().on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const send = (data: unknown) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    if (url.pathname === '/api/session') {
      if (req.method === 'GET') return send(sessions.filter((s) => s.parentID === url.searchParams.get('parentID')));
      return send({ id: addSession({ reads: turns.shift() ?? [] }).id });
    }
    const [, , , id, action] = url.pathname.split('/');
    const session = sessions.find((s) => s.id === id);
    if (!session) return void res.writeHead(404).end();
    if (action === undefined) return send({ id: session.id });
    if (action === 'message') {
      session.reads.shift()?.(session);
      return send([...session.messages].reverse());
    }
    if (action === 'permission') return send([]);
    if (action === 'interrupt') {
      session.interrupted = true;
      return void res.writeHead(204).end();
    }
    if (action === 'prompt') {
      const user = message('user');
      session.messages.push(user);
      return send({ time: user.time });
    }
    res.writeHead(404).end();
  });
}

const tmp = mkdtempSync(join(tmpdir(), 'owb-conversation-'));
// Logs and config follow HOME, state and memory OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
process.env.OPENCODE_SERVER_PASSWORD = '';
// Every turn here ends within three polls; the watchdogs only stop a test that would hang.
process.env.OPENCODE_FIRST_RESPONSE_TIMEOUT_MS = '5000';
process.env.OPENCODE_STALL_TIMEOUT_MS = '5000';
// The progress notes are on and one is due at every poll, but OWB_PROGRESS_MAX=0 allows none.
process.env.OWB_PROGRESS_ENABLED = 'true';
process.env.OWB_PROGRESS_FIRST_MS = '1';
process.env.OWB_PROGRESS_MIN_GAP_MS = '1';
process.env.OWB_PROGRESS_EVERY_MS = '1';
process.env.OWB_PROGRESS_MAX = '0';
delete process.env.OPENCODE_FALLBACK_MODEL;
delete process.env.OPENCODE_DEFAULT_MODEL;
delete process.env.OWB_BREAKER_THRESHOLD;
delete process.env.OWB_BREAKER_COOLDOWN_MS;

const server = createServer(handle);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// provider.ts reads its settings at module load, so the bot modules load after the fake server is up.
const { resultText, runTask } = await import('../orchestrator.js');
const { openCodeQuery } = await import('../opencode/provider.js');
const { createNotifier } = await import('../notify.js');
const { resetModelRouting } = await import('../model-routing.js');
const { openStateDb } = await import('../tasks/db.js');
const db = openStateDb(join(tmp, 'state.db'));

beforeEach(() => {
  sessions.length = 0;
  turns.length = 0;
  // Gateway state lives in memory for the whole process; each test starts with every breaker closed.
  resetModelRouting();
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface RunOptions {
  botId?: string;
  /** Runs as each commentary note goes out, given what /stop does; a throw is a note that fails to send. */
  onCommentary?: (stop: () => void) => void;
}

/** Run one task through the reads of its root sessions. heard is what the user gets: each note, then the outcome. */
async function run(plays: Read[][], { botId, onCommentary }: RunOptions = {}) {
  turns.push(...plays);
  const task = db.startTaskNow('test', 'hi', undefined, botId)!;
  const controller = new AbortController();
  const stop = () => {
    db.finishTask(task.id, 'interrupted', { error: '用户停止', notified: true });
    controller.abort();
  };
  const heard: string[] = [];
  const progress: string[] = [];
  await runTask(
    db,
    task,
    {
      deliver: async (finished) => void heard.push(`→ ${resultText(finished)}`),
      commentary: async (note) => {
        heard.push(note);
        onCommentary?.(stop);
      },
      progress: async (note) => void progress.push(note),
    },
    controller.signal,
  );
  return { task: db.getTask(task.id)!, heard, progress, roots: sessions.filter((s) => !s.parentID) };
}

test("a tool step's words reach the user once over the polls, in its bot's voice and ahead of the answer", async () => {
  const shell = tool('shell');
  const { task, heard, progress, roots } = await run(
    [
      [
        (s) => void s.messages.push(step(text('我先看一下日志。'), shell)),
        // The command is still running: the next poll reads the same step again.
        () => {},
        (s) => {
          shell.state.status = 'completed';
          answer(s);
        },
      ],
    ],
    { botId: 'research' },
  );
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 1);
  assert.deepEqual(heard, ['研究：我先看一下日志。', '→ 研究：ok']);
  assert.deepEqual(progress, [], 'OWB_PROGRESS_MAX=0 sends none, though a note is due at every poll');
});

test('a turn that ends on a tool step fails rather than pass what was said on the way off as the answer', async () => {
  const lookup = () => step(text('我先查一下。'), tool('read', 'completed'));
  const endings: Record<string, Read> = {
    'a last step that only reasoned': (s) =>
      void s.messages.push(lookup(), step({ type: 'reasoning', text: '查完了' }), idle('succeeded')),
    'no step after the tool': (s) => void s.messages.push(lookup(), idle('succeeded')),
  };
  for (const [name, ending] of Object.entries(endings)) {
    sessions.length = 0;
    const { task, heard, roots } = await run([[ending]]);
    assert.equal(task.status, 'failed', name);
    assert.equal(task.error, NO_ANSWER, name);
    assert.equal(roots.length, 1, `${name}: not an upstream failure, so no retry`);
    assert.deepEqual(heard, ['我先查一下。', `→ ⚠️ 任务 #${task.seq} 失败：${NO_ANSWER}`], name);
  }
});

test('the answer is the newest step that says something and calls no tool, its text before an empty reply section too', async () => {
  const answerFirst = '那个 medo 架构的学习 session 讲了三层：\n1. 网关\n2. 服务\n3. 存储\n';
  const recovered = await run([
    [
      (s) =>
        void s.messages.push(
          step(text('我先翻一下笔记。'), tool('read', 'completed')),
          step(text(`${answerFirst}<<<WECHAT_REPLY>>>\n\n<<<WECHAT_MEMORY>>>\n- 无\n<<<WECHAT_SUMMARY>>>\n讲了三层`)),
          idle('succeeded'),
        ),
    ],
  ]);
  assert.equal(recovered.task.status, 'done');
  assert.deepEqual(recovered.heard, ['我先翻一下笔记。', `→ ${answerFirst.trim()}`]);
  sessions.length = 0;
  const trailing = await run([
    [(s) => void s.messages.push(step(text(REPLY)), step({ type: 'reasoning', text: '答完了' }), idle('succeeded'))],
  ]);
  assert.deepEqual(trailing.heard, ['→ ok'], 'a step after the answer that wrote nothing is passed over');
});

test('no commentary from a subagent, reasoning, a tool payload, a step still streaming, answer text or tool-call markup', async () => {
  let draft: any;
  const { task, heard } = await run([
    [
      (s) => {
        addSession({ parentID: s.id }).messages.push(message('user'), step(text('子任务：我来跑测试。'), tool('shell')));
        draft = message('assistant', { content: [text('我在检'), tool('grep')] });
        s.messages.push(
          step({ type: 'reasoning', text: '先派一个子任务去跑测试' }, tool('subagent')),
          step(tool('read', 'completed', { input: { path: '/repo/a.ts' }, output: 'export const a = 1;' })),
          draft,
        );
      },
      (s) => {
        // Streamed in full now: only now is it told, and whole.
        draft.content[0].text = '我在检查配置文件。';
        draft.time.streamed = Date.now();
        s.messages.push(
          step(text('<<<WECHAT_REPLY>>>\n草稿回复'), tool('read')),
          step(text('我看下文件\n<｜｜DSML｜｜invoke name="read"'), tool('read')),
        );
        answer(s);
      },
    ],
  ]);
  assert.equal(task.status, 'done');
  assert.deepEqual(heard, ['我在检查配置文件。', '→ ok']);
});

test('a stop after a step is chosen but before it is told drops it, in the provider and in runTask', async () => {
  const controller = new AbortController();
  const told: string[] = [];
  turns.push([(s) => void s.messages.push(step(text('第一步'), tool('read')), step(text('第二步'), tool('read')))]);
  const result = await openCodeQuery({
    prompt: 'hi',
    cwd: tmp,
    signal: controller.signal,
    // Both steps come in one poll and are queued together; the stop comes as the first is told.
    onAssistantText: (update) => {
      told.push(update.text);
      controller.abort();
    },
  });
  assert.equal(result.interrupted, true);
  assert.deepEqual(told, ['第一步']);

  // runTask chooses both notes before the first goes out, so the second is dropped as it is handed over.
  sessions.length = 0;
  const { task, heard, roots } = await run(
    [[(s) => void s.messages.push(step(text('先看日志。'), tool('shell')), step(text('再看配置。'), tool('shell')))]],
    { onCommentary: (stop) => stop() },
  );
  assert.equal(task.status, 'interrupted');
  assert.equal(task.error, '用户停止');
  assert.ok(roots[0].interrupted, 'the session is stopped too');
  assert.deepEqual(heard, ['先看日志。'], 'and no outcome: /stop has answered for the task');
});

test('a note that fails to send is dropped, and the outcome still goes out', async () => {
  const { task, heard } = await run(
    [
      [
        (s) => {
          s.messages.push(step(text('我先看一下。'), tool('read', 'completed')));
          answer(s);
        },
      ],
    ],
    {
      onCommentary: () => {
        throw new Error('send failed');
      },
    },
  );
  assert.equal(task.status, 'done');
  assert.deepEqual(heard, ['我先看一下。', '→ ok']);
});

test('the notifier drops a note whose send fails or whose turn comes after its task finished, and sends the outcome', async () => {
  db.saveContextToken('acct', 'wx', 'token');
  const sent: string[] = [];
  const sender = {
    async sendText(_user: string, _token: string, note: string) {
      if (note === '网关挂了') throw new Error('send failed');
      sent.push(note);
    },
  };
  const task = db.startTaskNow('acct', 'hi')!;
  const io = createNotifier(db, {} as any, sender as any).taskIO(task, {} as any);
  await io.commentary!('网关挂了');
  // Handed over while the task runs; by its turn on the account's send chain the task is done.
  const late = io.commentary!('还在查');
  db.finishTask(task.id, 'done', { result: 'ok', summary: 'ok' });
  await late;
  await io.deliver(db.getTask(task.id)!);
  assert.deepEqual(sent, ['ok']);
  assert.deepEqual(db.pendingNotices('acct'), [], 'a note is never kept for a retry');
});

test('a retry does not say again what was said; notes are cut at 800 characters, 3 at most, and a plain answer has none', async () => {
  const said = (note: string) => step(text(note), tool('shell', 'completed'));
  const { task, heard, roots } = await run([
    [
      (s) =>
        void s.messages.push(
          said('我先查一下网关日志。'),
          idle('failed', { type: 'provider.internal', message: 'control plan is unavailable' }),
        ),
    ],
    [
      (s) => {
        s.messages.push(said('我先查一下网关日志。'), said('长'.repeat(900)), said('第三条'), said('第四条'));
        answer(s);
      },
    ],
  ]);
  assert.equal(task.status, 'done');
  assert.equal(roots.length, 2, 'the provider error is retried on the fallback');
  assert.deepEqual(heard, ['我先查一下网关日志。', `${'长'.repeat(800)}…`, '第三条', '→ ok']);
  sessions.length = 0;
  assert.deepEqual((await run([[answer]])).heard, ['→ ok'], 'a plain answer is not told ahead of itself');
});
