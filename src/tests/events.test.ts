// The event stream: the SSE frame parser, the activity it records per session, reconnecting after a drop, and a
// turn that streams for longer than the watchdogs allow without a snapshot change, which must not time out.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const FIRST_MS = 1500;
const STALL_MS = 1500;
/** How long the fake model streams before it answers: longer than either watchdog. */
const STREAM_MS = 4000;

interface FakeSession {
  id: string;
  parentID?: string;
  messages: any[];
}

const sessions: FakeSession[] = [];
/** The open /api/event responses. */
const streams = new Set<ServerResponse>();
/** Close each stream after its first frame, as a flapping server would. */
let dropAfterFirst = false;
let connects = 0;
let ids = 0;

const frame = (event: unknown): string => `data: ${JSON.stringify(event)}\n\n`;
const emit = (event: unknown): void => {
  for (const res of streams) res.write(frame(event));
};
const delta = (sessionID: string) => ({ type: 'session.reasoning.delta', data: { sessionID, delta: '…' } });
const message = (type: string, fields: object = {}): any => ({ id: `msg_${++ids}`, type, time: { created: Date.now() }, ...fields });

/** Streams reasoning for one session for STREAM_MS, then lets done() end the turn. */
function streamFor(sessionId: string, done: () => void): void {
  const timer = setInterval(() => emit(delta(sessionId)), 200);
  setTimeout(() => {
    clearInterval(timer);
    done();
  }, STREAM_MS);
}

function handle(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const send = (data: unknown) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data }));
    if (url.pathname === '/api/event') {
      connects++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(': heartbeat\n\n' + frame({ type: 'server.connected', data: {} }));
      if (dropAfterFirst) return void res.end(frame(delta(`ses_conn${connects}`)));
      streams.add(res);
      res.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname === '/api/session') {
      if (req.method === 'GET') return send(sessions.filter((s) => s.parentID === url.searchParams.get('parentID')));
      const session: FakeSession = { id: `ses_${++ids}`, messages: [] };
      sessions.push(session);
      return send({ id: session.id });
    }
    const [, , , id, action] = url.pathname.split('/');
    const session = sessions.find((s) => s.id === id);
    if (!session) return void res.writeHead(404).end();
    if (action === undefined) return send({ id: session.id });
    if (action === 'message') return send([...session.messages].reverse());
    if (action === 'permission') return send([]);
    if (action === 'interrupt') return void res.writeHead(204).end();
    if (action === 'prompt') {
      const user = message('user');
      session.messages.push(user);
      play(session);
      return send({ time: user.time });
    }
    res.writeHead(404).end();
  });
}

/** What the next root session does after its prompt. */
let play: (session: FakeSession) => void = () => {};
const answer = (s: FakeSession): void => {
  const at = Date.now();
  s.messages.push(message('assistant', { time: { created: at, streamed: at }, content: [{ type: 'text', text: 'ok' }] }), message('idle', { outcome: 'succeeded' }));
};

const tmp = mkdtempSync(join(tmpdir(), 'owb-events-'));
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
process.env.OPENCODE_SERVER_PASSWORD = '';
process.env.OPENCODE_FIRST_RESPONSE_TIMEOUT_MS = String(FIRST_MS);
process.env.OPENCODE_STALL_TIMEOUT_MS = String(STALL_MS);

const server = createServer(handle);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.OPENCODE_URL = base;

// provider.ts reads its settings at module load, so it loads after the fake server is up.
const { createEventStream, createFrameParser, lastActivityAt, lastOutputAt, recordEvent, resetEventActivity } = await import(
  '../opencode/events.js'
);
const { openCodeQuery, startEventStream, stopEventStream } = await import('../opencode/provider.js');

beforeEach(() => {
  resetEventActivity();
  sessions.length = 0;
  dropAfterFirst = false;
});

after(() => {
  stopEventStream();
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('the parser reads frames split at any point, with CRLF, comments, several data lines and bad JSON', () => {
  const text = ': heartbeat\r\n\r\ndata: {"a":1}\r\n\r\nevent: x\ndata: {"b":\ndata: 2}\n\ndata: not json\n\ndata: {"c":3}\n\n';
  for (let cut = 0; cut <= text.length; cut++) {
    const seen: unknown[] = [];
    const parse = createFrameParser((data) => seen.push(data));
    parse(text.slice(0, cut));
    parse(text.slice(cut));
    assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }], `cut at ${cut}`);
  }
});

test('activity is kept per session; output only for the model producing something; other events are ignored', () => {
  recordEvent({ type: 'session.step.started', data: { sessionID: 'ses_a' } }, 1000);
  recordEvent({ type: 'session.text.delta', data: { sessionID: 'ses_b' } }, 2000);
  recordEvent({ type: 'session.retry.scheduled', data: { sessionID: 'ses_a' } }, 3000);
  recordEvent({ type: 'mcp.status.changed', data: { server: 'x' } }, 4000);
  recordEvent({ type: 'session.text.delta', data: {} }, 5000);
  assert.equal(lastActivityAt(['ses_a', 'ses_b', 'ses_c']), 2000);
  assert.equal(lastActivityAt(['ses_a']), 1000, 'a retry the provider schedules is not progress');
  assert.equal(lastOutputAt(['ses_a']), undefined, 'a step that started produced nothing yet');
  assert.equal(lastOutputAt(['ses_b']), 2000);
  recordEvent({ type: 'session.text.delta', data: { sessionID: 'ses_c' } }, 2000 + 2 * 60 * 60 * 1000);
  assert.equal(lastActivityAt(['ses_a', 'ses_b']), undefined, 'sessions quiet for an hour are forgotten');
});

test('a dropped stream reconnects and goes on recording', async () => {
  dropAfterFirst = true;
  const stream = createEventStream(`${base}/api/event`, {});
  try {
    const deadline = Date.now() + 5000;
    while (lastActivityAt(['ses_conn2']) === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(lastActivityAt(['ses_conn1']), 'the first connection was read');
    assert.ok(lastActivityAt(['ses_conn2']), 'the stream came back after the drop');
  } finally {
    stream.stop();
  }
});

test('a model that streams reasoning for longer than both watchdogs, with no snapshot change, is not timed out', async () => {
  startEventStream();
  play = (s) => streamFor(s.id, () => answer(s));
  const started = Date.now();
  const result = await openCodeQuery({ prompt: 'hi', cwd: tmp });
  assert.equal(result.error, undefined);
  assert.equal(result.text, 'ok');
  assert.ok(Date.now() - started >= STREAM_MS, 'it waited for the answer');
});

test("a subagent's streaming keeps the turn alive while the root only waits on it", async () => {
  startEventStream();
  play = (s) => {
    s.messages.push(message('assistant', { content: [{ type: 'tool', name: 'subagent', state: { status: 'running' } }] }));
    const child: FakeSession = { id: `ses_${++ids}`, parentID: s.id, messages: [message('user')] };
    sessions.push(child);
    streamFor(child.id, () => answer(s));
  };
  const result = await openCodeQuery({ prompt: 'hi', cwd: tmp });
  assert.equal(result.error, undefined);
  assert.equal(result.text, 'ok');
});
