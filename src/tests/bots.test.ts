// The bot roster: the generated registry and its checks, "@bot" routing, the v4 bot_id column,
// per-bot memory, the <persona> block, reply prefixes, /bots and /status.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';
import type { TaskRow } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-bots-'));
// Config and logs follow HOME, state, memory and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
mkdirSync(join(tmp, '.wechat-opencode-bot'));
writeFileSync(join(tmp, '.wechat-opencode-bot', 'config.env'), `workingDirectory=${tmp}\n`);

const { BOTS_PATH, detectBot, isReadOnlyBot, loadBots, resolveBot } = await import('../bots.js');
const { appendMemory, memoryPath, readMemory } = await import('../memory.js');
const { composePrompt, resultText } = await import('../orchestrator.js');
const { openStateDb } = await import('../tasks/db.js');
const { formatStatus, formatTasks } = await import('../commands/handlers.js');
const { routeCommand } = await import('../commands/router.js');

const bots = loadBots();
const [chief, research] = bots;
const none = { paths: [], carried: false };
const DAY = /\[\d{4}-\d{2}-\d{2}\]/.source;

after(() => rmSync(tmp, { recursive: true, force: true }));

test('a missing registry is generated once with the four bots, mode 0600, and edits apply', () => {
  assert.equal(BOTS_PATH, join(tmp, 'data', 'bots.json'));
  assert.equal(statSync(BOTS_PATH).mode & 0o777, 0o600);
  assert.deepEqual(
    bots.map((b) => [b.id, b.name, b.aliases, b.prefix, b.default, b.subagent]),
    [
      ['chief', 'Chief', ['chief', '总管'], '', true, undefined],
      ['research', '研究', ['research', '研究'], '研究：', false, 'wechat-explore'],
      ['eng', '工程', ['eng', '工程', 'code'], '工程：', false, 'wechat-general'],
      ['ops', 'Ops', ['ops', '运维'], 'Ops：', false, 'wechat-general'],
    ],
  );
  // After that the file is the user's: edits apply, nothing is regenerated.
  const generated = readFileSync(BOTS_PATH, 'utf-8');
  writeFileSync(BOTS_PATH, JSON.stringify({ bots: JSON.parse(generated).bots.slice(0, 2) }));
  assert.deepEqual(loadBots().map((b) => b.id), ['chief', 'research']);
  writeFileSync(BOTS_PATH, generated);
});
test('invalid entries are skipped, and the first "default": true, else the first bot, is the default', () => {
  const file = join(tmp, 'mixed.json');
  const entry = (fields: object) => ({ id: 'x', name: 'X', aliases: ['x'], role: 'r', ...fields });
  const invalid = [
    { id: 'Upper' },
    { id: '../up' },
    { id: 'all' },
    { id: 'everyone' },
    { id: 'noname', name: ' ' },
    { id: 'norole', role: '' },
    { id: 'noaliases', aliases: 'x' },
    { id: 'space', aliases: ['two words'] },
    { id: 'at', aliases: ['@at'] },
    { id: 'slash', aliases: ['a/b'] },
    { id: 'reserved', aliases: ['Everyone'] },
    { id: 'prefix', prefix: 1 },
    { id: 'flag', default: 'yes' },
    { id: 'agent', subagent: 'build' },
  ];
  const valid = [
    entry({ id: 'ok', aliases: [' ok ', ''] }),
    entry({ id: 'ok', name: 'Again' }),
    entry({ id: 'second', default: true }),
    entry({ id: 'third', default: true }),
  ];
  writeFileSync(file, JSON.stringify({ bots: [...invalid.map(entry), ...valid] }));
  const [ok, ...rest] = loadBots(file);
  assert.deepEqual(ok, { id: 'ok', name: 'X', aliases: ['ok'], prefix: '', default: false, role: 'r' });
  assert.deepEqual(rest.map((b) => [b.id, b.default]), [['second', true], ['third', false]]);
  writeFileSync(file, JSON.stringify({ bots: [entry({ id: 'a' }), entry({ id: 'b' })] }));
  assert.deepEqual(loadBots(file).map((b) => b.default), [true, false]);
});

test('a registry without a valid bot falls back to the built-in default bot', () => {
  const file = join(tmp, 'broken.json');
  for (const content of ['{ not json', '{}', '{"bots": []}', '{"bots": [{"id": "BAD"}]}']) {
    writeFileSync(file, content);
    assert.deepEqual(loadBots(file).map((b) => [b.id, b.default]), [['chief', true]], content);
  }
});

test('"@alias" at the start picks the bot in any case and is stripped; "@all" and "@everyone" address everyone', () => {
  assert.deepEqual(detectBot('@Research 看下日志', bots), { botId: 'research', input: '看下日志' });
  assert.deepEqual(detectBot('  @研究：看下日志', bots), { botId: 'research', input: '看下日志' });
  assert.deepEqual(detectBot('@CODE, 跑下测试', bots), { botId: 'eng', input: '跑下测试' });
  assert.deepEqual(detectBot('@运维 看下日志', bots), { botId: 'ops', input: '看下日志' });
  assert.deepEqual(detectBot('@all 看看', bots), { botId: 'all', input: '看看' });
  assert.deepEqual(detectBot('@Everyone：看看', bots), { botId: 'all', input: '看看' });
  // A message that is only "@alias" keeps its text, as with projects.
  assert.deepEqual(detectBot('@research', bots), { botId: 'research', input: '@research' });
});
test('anything else goes to the default bot: a bot is never guessed from the message body', () => {
  for (const text of ['你好', '让 research 看下', '研究一下 @ops', '@researcher 看下', 'a@ops 看下', '@ all 看看']) {
    assert.deepEqual(detectBot(text, bots), { botId: 'chief', input: text }, text);
  }
});

test('the longest alias wins, in either registry order', () => {
  const short = { ...chief, id: 'research', aliases: ['研究'] };
  const long = { ...chief, id: 'staff', aliases: ['研究员'], default: false };
  for (const order of [[short, long], [long, short]]) {
    assert.deepEqual(detectBot('@研究员 看下', order), { botId: 'staff', input: '看下' });
    assert.deepEqual(detectBot('@研究 看下', order), { botId: 'research', input: '看下' });
  }
});

test('"@all" tasks, rows from before bots and removed bots speak as the default bot', () => {
  assert.deepEqual(resolveBot('research', bots), { bot: research, all: false });
  assert.deepEqual(resolveBot('all', bots), { bot: chief, all: true });
  assert.deepEqual(resolveBot(null, bots), { bot: chief, all: false });
  assert.deepEqual(resolveBot('removed', bots), { bot: chief, all: false });
});

test('only a specialist that prefers wechat-explore is read-only; everyone else writes', () => {
  assert.equal(isReadOnlyBot('research', bots), true);
  for (const botId of ['chief', 'eng', 'ops', 'all', null, 'removed']) assert.equal(isReadOnlyBot(botId, bots), false, String(botId));
  assert.equal(isReadOnlyBot('research', [{ ...research, default: true }]), false, 'the default bot writes even if it prefers explore');
});

test('a v3 database gains bot_id and keeps its rows; new tasks store their bot', () => {
  const file = join(tmp, 'v3.db');
  const { task } = openStateDb(file).createTask('acc', 'old task');
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE tasks DROP COLUMN bot_id; PRAGMA user_version = 3;');
  const db = openStateDb(file);
  assert.ok(raw.prepare("SELECT name FROM pragma_table_info('tasks')").all().some((c) => c.name === 'bot_id'));
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 7);
  raw.close();
  assert.deepEqual([db.getTask(task.id)?.input, db.getTask(task.id)?.bot_id], ['old task', null]);
  assert.equal(openStateDb(file).getTask(task.id)?.input, 'old task', 'opening again changes nothing');
  assert.equal(db.createTask('acc', 'hi', 'm1', undefined, 'research').task.bot_id, 'research');
  assert.equal(db.startTaskNow('sim', 'hi', undefined, 'all')?.bot_id, 'all');
});

test('the default bot keeps the shared memory; every other bot also keeps its own file', () => {
  const dir = join(tmp, 'data', 'memory', 'mem');
  assert.equal(memoryPath('mem'), join(dir, 'MEMORY.md'));
  assert.equal(memoryPath('mem', chief), join(dir, 'MEMORY.md'));
  const own = memoryPath('mem', research);
  assert.equal(own, join(dir, 'bots', 'research.md'));
  assert.equal(appendMemory(own, ['偏好只读调研', '偏好只读调研', '无'], new Date('2026-11-06T04:00:00Z')), 1);
  assert.equal(readMemory(own), '- [2026-11-06] 偏好只读调研');
  assert.equal(statSync(own).mode & 0o777, 0o600);
  assert.equal(readMemory(memoryPath('mem')), '', 'a bot fact stays out of the shared memory');
});
test('the prompt names the persona and its memory; the default bot also lists the specialists', () => {
  const db = openStateDb(join(tmp, 'prompt.db'));
  appendMemory(memoryPath('p'), ['回复用中文']);
  appendMemory(memoryPath('p', research), ['偏好只读调研']);
  const prompt = (botId?: string) => composePrompt(db, db.createTask('p', '你好', null, undefined, botId).task, tmp, none);
  const block = (text: string, tag: string) => new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? '';

  const asResearch = prompt('research');
  const persona = block(asResearch, 'persona');
  assert.match(persona, /^id: research\nname: 研究\nrole: read-only research/);
  assert.match(persona, /^subagent: prefer wechat-explore/m);
  assert.match(
    persona,
    /^You are speaking as 研究\. Match this role\. The repository's AGENTS\.md and opencode\.json take precedence over this persona role, <memory> and <recent_tasks>\.$/m,
  );
  assert.doesNotMatch(persona, /specialists/);
  assert.match(block(asResearch, 'memory'), new RegExp(`^- ${DAY} 回复用中文\\n\\n研究 的记忆:\\n- ${DAY} 偏好只读调研$`));

  const asChief = prompt();
  assert.match(block(asChief, 'persona'), /^id: chief\n[\s\S]*^specialists .*:\n- research \(研究\): .*\n- eng \(工程\): .*\n- ops \(Ops\): /m);
  assert.match(block(asChief, 'memory'), new RegExp(`^- ${DAY} 回复用中文$`), "the default bot does not read another bot's memory");
  assert.doesNotMatch(asChief, /@all/);
  assert.match(asChief, /用户（对 research）: 你好/, 'recent tasks say which bot each message went to');
  assert.match(block(prompt('all'), 'persona'), /^id: chief\n[\s\S]*\(@all\): .*at most 3 subagents/);
});

test('the bridge puts the bot prefix before a reply; the default bot and notices get none', () => {
  const task = (fields: Partial<TaskRow>) =>
    ({ seq: 7, status: 'done', result: 'ok', error: null, bot_id: 'research', ...fields }) as TaskRow;
  assert.equal(resultText(task({})), '研究：ok');
  assert.equal(resultText(task({ bot_id: 'ops' })), 'Ops：ok');
  for (const bot_id of [null, 'chief', 'all', 'removed']) assert.equal(resultText(task({ bot_id })), 'ok', String(bot_id));
  assert.equal(resultText(task({ result: '' })), 'ℹ️ 没有可回复的内容');
  assert.equal(resultText(task({ status: 'failed', error: '超时' })), '⚠️ 任务 #7 失败：超时');
  assert.equal(resultText(task({ status: 'interrupted', error: '用户停止' })), '⏹ 任务 #7 已中断：用户停止，需要的话请重新发送');
});

test('/bots lists the roster with the default bot and "@all"', async () => {
  const text = await routeCommand('/bots', {} as CommandContext);
  assert.match(text, /^- chief: Chief（chief, 总管）默认，无回复前缀$/m);
  assert.match(text, /^- research: 研究（research, 研究）回复前缀「研究：」$/m);
  assert.match(text, /^- all: @all 或 @everyone 交给 Chief，/m);
  assert.ok(text.includes(BOTS_PATH));
});

test('/status shows the default bot, the last bot and each memory; /tasks shows the "@bot"', () => {
  const db = openStateDb(join(tmp, 'status.db'));
  assert.match(formatStatus(db, 'st'), /^💬 最近 bot: 无$/m);
  db.createTask('st', 'hi', null, undefined, 'research');
  appendMemory(memoryPath('st'), ['回复用中文']);
  appendMemory(memoryPath('st', research), ['偏好只读调研']);
  const status = formatStatus(db, 'st');
  assert.match(status, /^🎭 默认 bot: chief（Chief）$/m);
  assert.match(status, /^💬 最近 bot: research（#1）$/m);
  assert.match(status, /^🧠 记忆: 共享 1 条，research 1 条$/m);
  assert.match(formatTasks(db, 'st', 5), /\] @research hi$/m);
});
