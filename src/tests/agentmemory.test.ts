// The agentmemory client against a fake engine: memory off without a secret or a URL, where the secret comes from, the
// search and how it shows each memory, the writes (new memories, updates by id and when an update becomes a new
// memory), the deadlines, and the check /doctor shows.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'owb-agentmemory-'));
// Logs follow HOME, and so does ~/.agentmemory/secret: keep both away from the real ones.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
delete process.env.AGENTMEMORY_URL;
delete process.env.AGENTMEMORY_SECRET;

interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  auth?: string;
  body?: any;
}
/** Every request the fake engine got. */
const seen: Seen[] = [];
/** What a search finds. */
let hits: unknown[] = [];
/** Requests to this path get no answer. */
let hang = '';

/** The engine's answer to an evolve of each memory id, as 0.9.33 gives it. */
const EVOLVE: Record<string, [number, unknown]> = {
  mem_ok: [200, { success: true, memory: { id: 'mem_ok2' }, previousId: 'mem_ok' }],
  mem_gone: [404, { success: false, error: 'memory not found', code: 'not_found' }],
  mem_old: [409, { success: false, error: 'memory is not the latest version; edit the latest version instead', code: 'not_latest' }],
  mem_same: [400, { success: false, error: 'nothing changed', code: 'unchanged' }],
  mem_bad: [500, { error: 'boom' }],
};
const NOT_FOUND: [number, unknown] = [404, { success: false, error: 'memory not found', code: 'not_found' }];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const sent = body ? JSON.parse(body) : undefined;
    seen.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, auth: req.headers.authorization, body: sent });
    if (url.pathname === hang) return;
    const json = (status: number, data: unknown) => void res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.headers.authorization === 'Bearer wrong') return json(401, { error: 'unauthorized' });
    if (url.pathname === '/agentmemory/memories') {
      if (url.searchParams.get('count') === 'true') return json(200, { total: 42, latestCount: 42 });
      return json(200, { memories: hits, total: hits.length });
    }
    if (url.pathname === '/agentmemory/evolve') return json(...(EVOLVE[sent.memoryId] ?? NOT_FOUND));
    // The engine answers 201 even when it refuses a memory.
    if (url.pathname === '/agentmemory/remember') {
      return json(201, sent.content === '拒绝' ? { success: false, error: 'content is required' } : { success: true, memory: { id: 'mem_new' } });
    }
    json(404, { error: 'no route' });
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const ENGINE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
/** A port nothing listens on: fetch refuses low ports such as 1 itself, so take a free one and close it. */
const closed = createServer();
await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
const DOWN = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
await new Promise((resolve) => closed.close(resolve));

const { checkMemory, memoryConnection, saveMemories, searchMemories } = await import('../agentmemory.js');

/** A new memory as the bot saves it. */
const created = (content: string) => ({ path: '/agentmemory/remember', body: { content, concepts: ['wechat-opencode-bot'] } });
const evolved = (memoryId: string, newContent: string) => ({ path: '/agentmemory/evolve', body: { memoryId, newContent } });
const writes = () => seen.map(({ path, body }) => ({ path, body }));

beforeEach(() => {
  seen.length = 0;
  hits = [];
  hang = '';
  process.env.AGENTMEMORY_URL = ENGINE;
  process.env.AGENTMEMORY_SECRET = 'test-secret';
});

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('memory is off without a secret or a URL: nothing is asked and nothing is saved', async () => {
  delete process.env.AGENTMEMORY_URL;
  delete process.env.AGENTMEMORY_SECRET;
  assert.equal(memoryConnection(), undefined);
  assert.deepEqual(await searchMemories('部署'), []);
  assert.deepEqual(await saveMemories(['用户在 M5 上工作'], new Set()), { saved: 0, updated: 0, failed: 0 });
  assert.deepEqual(await checkMemory(), { state: 'off' });
  assert.deepEqual(seen, []);
});

test('the secret is AGENTMEMORY_SECRET, else ~/.agentmemory/secret; an explicit URL alone sends no auth', async () => {
  delete process.env.AGENTMEMORY_URL;
  delete process.env.AGENTMEMORY_SECRET;
  mkdirSync(join(tmp, '.agentmemory'));
  writeFileSync(join(tmp, '.agentmemory', 'secret'), ' file-secret\n');
  try {
    assert.deepEqual(memoryConnection(), { url: 'http://127.0.0.1:3111', secret: 'file-secret' }, "the engine's default URL");
    process.env.AGENTMEMORY_SECRET = 'env-secret';
    process.env.AGENTMEMORY_URL = `${ENGINE}/`;
    assert.deepEqual(memoryConnection(), { url: ENGINE, secret: 'env-secret' });
  } finally {
    rmSync(join(tmp, '.agentmemory'), { recursive: true, force: true });
  }
  delete process.env.AGENTMEMORY_SECRET;
  assert.deepEqual(memoryConnection(), { url: ENGINE, secret: undefined });
  await searchMemories('部署');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, undefined);
});

test("a search asks for the 8 best of every agent's latest memories, and shows each on one line with its date, cut at 600", async () => {
  hits = [
    // 17:00 UTC is the next day in Shanghai; the latest version's date counts.
    { id: 'mem_a', content: '用户  在 M5\n上工作', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-18T17:00:00Z' },
    { id: 'mem_b', content: '长'.repeat(700), createdAt: '2026-11-02T00:00:00Z' },
    { id: 'mem_c', content: ' \n ' },
    { id: 7, content: '没有可用的 id' },
    { id: 'mem_d', content: '没有日期' },
    ...Array.from({ length: 6 }, (_, i) => ({ id: `mem_${i}`, content: `第 ${i} 条` })),
  ];
  const found = await searchMemories(`  看下\n部署 ${'字'.repeat(400)}`);
  assert.equal(seen.length, 1);
  const { method, path, query, auth } = seen[0];
  assert.deepEqual([method, path, auth], ['GET', '/agentmemory/memories', 'Bearer test-secret']);
  assert.deepEqual(Object.fromEntries(query), { q: `看下 部署 ${'字'.repeat(294)}`, limit: '8', agentId: '*', latest: 'true' });
  assert.deepEqual(found.slice(0, 3), [
    { id: 'mem_a', text: '用户 在 M5 上工作', full: true, date: '2026-11-19' },
    { id: 'mem_b', text: `${'长'.repeat(600)}…`, full: false, date: '2026-11-02' },
    { id: 'mem_d', text: '没有日期', full: true, date: '' },
  ]);
  assert.deepEqual(found.slice(3).map((m) => m.id), ['mem_0', 'mem_1', 'mem_2', 'mem_3', 'mem_4'], 'at most 8');
  assert.deepEqual(await searchMemories(' \n '), [], 'no words, no search');
  assert.equal(seen.length, 1);
});

test('a search that is refused, fails or passes its deadline gives no memories', async () => {
  process.env.AGENTMEMORY_SECRET = 'wrong';
  assert.deepEqual(await searchMemories('部署'), []);
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  hang = '/agentmemory/memories';
  const started = Date.now();
  assert.deepEqual(await searchMemories('部署', AbortSignal.timeout(200)), []);
  assert.ok(Date.now() - started < 2000, 'the deadline holds');
  process.env.AGENTMEMORY_URL = DOWN;
  assert.deepEqual(await searchMemories('部署'), [], 'nothing listening');
});

test('a plain fact is saved with the concept; "无" is nothing; at most 5 facts, each on one line and cut at 600', async () => {
  const facts = ['无', '（无）', 'none', '用户\n喜欢  简短的回复', '长'.repeat(700), 'b', 'c', 'd', 'e'];
  assert.deepEqual(await saveMemories(facts, new Set()), { saved: 5, updated: 0, failed: 0 });
  assert.deepEqual(writes(), [created('用户 喜欢 简短的回复'), created('长'.repeat(600)), created('b'), created('c'), created('d')]);
  assert.ok(seen.every((s) => s.method === 'POST' && s.auth === 'Bearer test-secret'));
});

test('"[id] text" updates a memory shown whole; one gone, superseded or not shown whole becomes a new memory', async () => {
  const shown = new Set(['mem_ok', 'mem_gone', 'mem_old', 'mem_same']);
  const facts = ['[mem_ok 2026-11-18] 新文本', '[mem_gone] 消失的', '[mem_old] 旧版本的', '[mem_same] 没变', '[mem_cut] 截断的'];
  assert.deepEqual(await saveMemories(facts, shown), { saved: 3, updated: 1, failed: 0 });
  assert.deepEqual(writes(), [
    evolved('mem_ok', '新文本'),
    evolved('mem_gone', '消失的'),
    created('消失的'),
    evolved('mem_old', '旧版本的'),
    created('旧版本的'),
    evolved('mem_same', '没变'),
    created('截断的'),
  ]);
});

test('a refused or failed write is counted and the others still go through; one deadline covers all the writes', async () => {
  assert.deepEqual(await saveMemories(['[mem_bad] 出错的', '拒绝', '[mem_x]', '好的'], new Set(['mem_bad'])), { saved: 1, updated: 0, failed: 2 });
  assert.deepEqual(writes(), [evolved('mem_bad', '出错的'), created('拒绝'), created('好的')], 'an id with no text is no fact');
  hang = '/agentmemory/remember';
  const started = Date.now();
  assert.deepEqual(await saveMemories(['a', 'b'], new Set(), AbortSignal.timeout(200)), { saved: 0, updated: 0, failed: 2 });
  assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
});

test("/doctor's check: the count of latest memories, a refused secret, or an engine that does not answer", async () => {
  assert.deepEqual(await checkMemory(), { state: 'ok', url: ENGINE, count: 42 });
  assert.deepEqual(Object.fromEntries(seen[0].query), { count: 'true', latest: 'true', agentId: '*' });
  assert.equal(seen[0].auth, 'Bearer test-secret');
  process.env.AGENTMEMORY_SECRET = 'wrong';
  assert.deepEqual(await checkMemory(), { state: 'unreachable', url: ENGINE, reason: '鉴权失败（HTTP 401），检查 AGENTMEMORY_SECRET' });
  process.env.AGENTMEMORY_SECRET = 'test-secret';
  hang = '/agentmemory/memories';
  assert.deepEqual(await checkMemory(AbortSignal.timeout(200)), { state: 'unreachable', url: ENGINE, reason: '超时无响应' });
  process.env.AGENTMEMORY_URL = DOWN;
  assert.deepEqual(await checkMemory(), { state: 'unreachable', url: DOWN, reason: 'fetch failed (ECONNREFUSED)' });
});
