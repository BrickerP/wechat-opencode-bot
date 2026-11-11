// /session: a session's last assistant text, read straight from this OpenCode server by id or by a title the
// session list matches, so the user does not need a task to dig it out.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-session-'));
// Config and logs follow HOME, state and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
process.env.OPENCODE_SERVER_PASSWORD = '';
mkdirSync(join(tmp, '.wechat-opencode-bot'));
writeFileSync(join(tmp, '.wechat-opencode-bot', 'config.env'), `workingDirectory=${tmp}\n`);

const text = (value: string) => ({ type: 'text', text: value });
const LONG = '长'.repeat(25_000);
/** The fake OpenCode's session list, two pages of it. */
const PAGES = [
  [
    { id: 'ses_arch', title: 'medo 架构的学习', time: { created: 1, updated: 5 } },
    { id: 'ses_bot', title: '微信 #15: 查 session', time: { created: 2 } },
    { id: 'ses_untitled' },
  ],
  [
    { id: 'ses_deploy', title: 'MEDO 部署流程', time: { created: 3 } },
    { id: 'ses_empty', title: '只有提问' },
    { id: 'ses_long', title: '长回复' },
    ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `ses_todo${n}`, title: `todo ${n}` })),
  ],
];
/** Each session's messages, newest first, as order=desc gives them. */
const MESSAGES: Record<string, unknown[]> = {
  ses_arch: [
    // Still running a tool: the turn's text is in the message before it.
    { type: 'assistant', content: [{ type: 'tool', name: 'read', state: { status: 'running' } }] },
    { type: 'assistant', content: [text('medo 的架构分三层'), { type: 'tool', name: 'read' }, text('<<<WECHAT_REPLY>>>\n就这些')] },
    { type: 'user', content: [text('讲讲 medo 架构')] },
    { type: 'assistant', content: [text('更早的回复')] },
  ],
  ses_deploy: [{ type: 'assistant', content: [text('部署走流水线')] }],
  ses_empty: [{ type: 'user', content: [text('在吗')] }],
  ses_long: [{ type: 'assistant', content: [text(LONG)] }],
};
/** The requests the fake OpenCode got, in order. */
const requests: string[] = [];
const server = createServer((req, res) => {
  const send = (body: unknown) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const url = new URL(req.url ?? '', 'http://fake');
  requests.push(`${url.pathname}${url.search}`);
  if (url.pathname === '/api/session') {
    const page = url.searchParams.get('cursor') === 'page-2' ? 1 : 0;
    return send({ data: PAGES[page], cursor: page === 0 ? { next: 'page-2' } : {} });
  }
  const messages = /^\/api\/session\/([^/]+)\/message$/.exec(url.pathname);
  const session = messages && MESSAGES[decodeURIComponent(messages[1])];
  if (!session) return void res.writeHead(404).end(JSON.stringify({ name: 'SessionNotFoundError' }));
  send({ data: session });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.OPENCODE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

// provider.ts reads OPENCODE_URL at load, so the bot modules load after the fake server is up.
const { routeCommand } = await import('../commands/router.js');
const { lastAssistantText, listSessions } = await import('../opencode/provider.js');

after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => void (requests.length = 0));

const ctx = {} as CommandContext;
const LIST_1 = '/api/session?limit=100';
const LIST_2 = '/api/session?limit=100&cursor=page-2';

test('listSessions pages the list through its cursor and matches titles case-insensitively, without reading messages', async () => {
  assert.deepEqual(await listSessions('medo'), [
    { id: 'ses_arch', title: 'medo 架构的学习', time: 5 },
    { id: 'ses_deploy', title: 'MEDO 部署流程', time: 3 },
  ]);
  assert.deepEqual(requests, [LIST_1, LIST_2]);
  requests.length = 0;
  assert.deepEqual(await listSessions('nothing'), []);
  assert.deepEqual(requests, [LIST_1, LIST_2], 'no next cursor: the end of the list');
  requests.length = 0;
  assert.deepEqual((await listSessions('', 2)).map((s) => s.id), ['ses_arch', 'ses_bot'], 'at most limit sessions');
  assert.deepEqual(requests, [LIST_1]);
});

test("lastAssistantText joins the text parts of the newest assistant message that has any, and is '' without one", async () => {
  assert.equal(await lastAssistantText('ses_arch'), 'medo 的架构分三层\n<<<WECHAT_REPLY>>>\n就这些');
  assert.deepEqual(requests, ['/api/session/ses_arch/message?limit=100&order=desc']);
  assert.equal(await lastAssistantText('ses_empty'), '');
});

test('/session reads a session by id, or by the one title that matches, and returns its text as it is', async () => {
  assert.equal(await routeCommand('/session', ctx), '用法：/session <会话 id 或标题>');
  assert.equal(await routeCommand('/session ses_deploy', ctx), '部署走流水线');
  assert.deepEqual(requests, ['/api/session/ses_deploy/message?limit=100&order=desc'], 'an id needs no list');
  requests.length = 0;
  // On the second page only.
  assert.equal(await routeCommand('/session 部署', ctx), '部署走流水线');
  assert.deepEqual(requests, [LIST_1, LIST_2, '/api/session/ses_deploy/message?limit=100&order=desc']);
  assert.equal(await routeCommand('/session 架构的学习', ctx), 'medo 的架构分三层\n<<<WECHAT_REPLY>>>\n就这些', 'markers and all');
  assert.match(await routeCommand('/help', ctx), /^ {2}\/session <id\|标题> {2}直接读出/m);
});

test('/session says when no title matches, lists the ids when several do, and reads nothing then', async () => {
  assert.equal(await routeCommand('/session 不存在', ctx), '没有标题包含「不存在」的会话');
  assert.equal(
    await routeCommand('/session MeDo', ctx),
    ['有 2 个会话的标题包含「MeDo」，请用 /session <id> 指定：', 'ses_arch  medo 架构的学习', 'ses_deploy  MEDO 部署流程'].join('\n'),
  );
  assert.ok(!requests.some((r) => r.includes('/message')));
  const many = (await routeCommand('/session todo', ctx)).split('\n');
  assert.deepEqual(
    [many[0], many.length, many[5], many.at(-1)],
    ['有 6 个会话的标题包含「todo」，请用 /session <id> 指定：', 7, 'ses_todo5  todo 5', '… 还有 1 个'],
    'up to 5',
  );
});

test('/session says when there is no assistant text, cuts a long one, and names another machine for an unknown id', async () => {
  assert.equal(await routeCommand('/session ses_empty', ctx), '会话里没有可返回的助手文本');
  assert.equal(await routeCommand('/session 长回复', ctx), `${LONG.slice(0, 20_000)}\n\n（已截断，原文 25000 字）`);
  const gone = await routeCommand('/session ses_m1only', ctx);
  assert.match(gone, /^⚠️ 读不到这个会话：GET \/api\/session\/ses_m1only\/message.+HTTP 404/);
  assert.match(gone, /它可能不在这台 OpenCode 上；M1\/M3 的会话要在它们自己的机器上读$/);
});
