// Project routing: the registry, alias and follow-up detection, directory checks (also for /cwd),
// the prompt's <project> block, routing together with "@bot" in either order, follow-ups that stay
// with the last bot, "新话题" and "@base", aliases a bot owns, the v3 task columns, and the registry
// edits of /projects add and rm.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-projects-'));
const base = join(tmp, 'work');
for (const dir of ['miaoda', 'miaoda-ops', 'medo-discord-icafe-bot', 'rh-layers', 'dumate', '.hidden']) {
  mkdirSync(join(base, dir), { recursive: true });
}
writeFileSync(join(base, 'notes.txt'), '');
mkdirSync(join(tmp, 'outside'));
symlinkSync(join(tmp, 'outside'), join(base, 'escape'));
// Config follows HOME, state and the default registry OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
mkdirSync(join(tmp, '.wechat-opencode-bot'));
writeFileSync(join(tmp, '.wechat-opencode-bot', 'config.env'), `workingDirectory=${base}\n`);

const {
  addProject,
  detectProject,
  loadProjects,
  PROJECTS_PATH,
  removeProject,
  resolveProjectDir,
  routeMessage,
  stripProjectPrefix,
} = await import('../projects.js');
const { openStateDb } = await import('../tasks/db.js');
const { composePrompt } = await import('../orchestrator.js');
const { handlers } = await import('../commands/handlers.js');

const registry = join(tmp, 'registry', 'projects.json');
const projects = loadProjects(base, registry);
const entry = (dir: string) => ({ id: 't', dir, aliases: ['t'] });

after(() => rmSync(tmp, { recursive: true, force: true }));

test('a missing registry is generated once from the child directories, mode 0600', () => {
  assert.deepEqual(projects, [
    { id: 'dumate', dir: 'dumate', aliases: ['dumate'] },
    { id: 'medo', dir: 'medo-discord-icafe-bot', aliases: ['medo', 'icafe', 'medo-discord', 'medo-discord-icafe-bot'] },
    { id: 'miaoda', dir: 'miaoda', aliases: ['miaoda', '秒哒'] },
    { id: 'miaoda-ops', dir: 'miaoda-ops', aliases: ['miaoda-ops'] },
    { id: 'rh-layers', dir: 'rh-layers', aliases: ['rh', 'rh-layers'] },
  ]);
  assert.equal(statSync(registry).mode & 0o777, 0o600);
  // After that the file is the user's: edits apply, nothing is regenerated.
  const edited = JSON.parse(readFileSync(registry, 'utf-8'));
  writeFileSync(registry, JSON.stringify({ projects: edited.projects.slice(0, 1) }));
  assert.deepEqual(loadProjects(base, registry).map((p) => p.id), ['dumate']);
  writeFileSync(registry, JSON.stringify(edited));
});

test('a base that is itself a repo is the project "base"', () => {
  const repo = join(tmp, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'app'));
  const found = loadProjects(repo, join(tmp, 'repo.json'));
  assert.deepEqual(found.map((p) => [p.id, p.dir]), [['app', 'app'], ['base', '.']]);
  assert.equal(resolveProjectDir(repo, found[1]), repo);
});

test('"@alias" at the start picks the project in any case, and is stripped', () => {
  const medo = detectProject('@ICafe 看下日志', projects);
  assert.equal(medo?.id, 'medo');
  assert.equal(stripProjectPrefix('@ICafe 看下日志', medo!), '看下日志');
  assert.equal(stripProjectPrefix('  @medo：看下日志', medo!), '看下日志');
});

test('a mention picks the project: whole words for ASCII aliases, anywhere for Chinese ones', () => {
  assert.equal(detectProject('帮我看看rh的构建', projects)?.id, 'rh-layers');
  assert.equal(detectProject('秒哒的部署怎么样了', projects)?.id, 'miaoda');
  assert.equal(detectProject('devops 是什么', projects), null);
  assert.equal(detectProject('miaodaxyz 是什么', projects), null);
  assert.equal(detectProject('看看 rhino', projects), null);
});

test('the longest alias wins', () => {
  const ops = detectProject('@miaoda-ops 部署', projects);
  assert.equal(ops?.id, 'miaoda-ops');
  assert.equal(stripProjectPrefix('@miaoda-ops 部署', ops!), '部署');
  assert.equal(detectProject('看下 miaoda-ops 的部署', projects)?.id, 'miaoda-ops');
  assert.equal(detectProject('@miaoda 部署', projects)?.id, 'miaoda');
  // A Chinese alias has no word edge, so "秒哒" also matches "秒哒运维": only the length decides, in either registry order.
  const short = { id: 'miaoda', dir: 'miaoda', aliases: ['秒哒'] };
  const long = { id: 'miaoda-ops', dir: 'miaoda-ops', aliases: ['秒哒运维'] };
  for (const order of [[short, long], [long, short]]) {
    assert.equal(detectProject('@秒哒运维 部署', order)?.id, 'miaoda-ops');
    assert.equal(detectProject('看下秒哒运维的部署', order)?.id, 'miaoda-ops');
    assert.equal(detectProject('@秒哒 部署', order)?.id, 'miaoda');
  }
  assert.equal(stripProjectPrefix('@秒哒运维 部署', { ...short, aliases: ['秒哒', '秒哒运维'] }), '部署');
});

test('a follow-up stays in the last project; anything else goes to the base', () => {
  assert.equal(detectProject('继续', projects, 'medo')?.id, 'medo');
  assert.equal(detectProject('', projects, 'medo')?.id, 'medo', 'an image without text');
  assert.equal(detectProject('继续看 rh', projects, 'medo')?.id, 'rh-layers', 'a named project beats the follow-up');
  assert.equal(detectProject('你好', projects, 'medo'), null);
  assert.equal(detectProject('继续', projects, null), null);
  assert.equal(detectProject('继续', projects, 'removed'), null);
  assert.equal(detectProject('@unknown 看看', projects), null);
});

test('a follow-up is a short message that opens with a cue; a cue inside other words or a long request does not count', () => {
  for (const text of ['继续', ' 再改一下 ', '刚才那个', '看一下这个报错', '它们呢']) {
    assert.equal(detectProject(text, projects, 'medo')?.id, 'medo', text);
  }
  for (const text of [
    '再见',
    '其它项目呢',
    '你好',
    '今天下午开会前帮我看一下明天北京的天气预报，再提醒我带伞，顺便把会议纪要模板也发我一份',
    '看一下这个报错是怎么回事，然后把配置里的超时改成三十秒，再重新部署一遍测试环境',
  ]) {
    assert.equal(detectProject(text, projects, 'medo'), null, text);
  }
});

test('a message that is only "@alias" keeps its text', () => {
  const miaoda = detectProject('@miaoda', projects);
  assert.equal(miaoda?.id, 'miaoda');
  assert.equal(stripProjectPrefix('@miaoda', miaoda!), '@miaoda');
  assert.equal(stripProjectPrefix(' @miaoda ：', miaoda!), ' @miaoda ：');
});

test('a project directory must resolve inside the base', () => {
  for (const dir of ['', '../outside', 'miaoda/../../outside', '/tmp', join(base, 'miaoda'), 'escape', 'missing', 'notes.txt']) {
    assert.throws(() => resolveProjectDir(base, entry(dir)), Error, `dir "${dir}"`);
  }
  assert.equal(resolveProjectDir(base, entry('miaoda')), join(base, 'miaoda'));
  const file = join(tmp, 'mixed.json');
  writeFileSync(
    file,
    JSON.stringify({
      projects: [
        { id: 'up', dir: '../outside', aliases: ['up'] },
        { id: 'abs', dir: '/tmp', aliases: ['abs'] },
        { id: 'link', dir: 'escape', aliases: ['link'] },
        { id: 'no-aliases', dir: 'miaoda' },
        { id: 'ok', dir: 'miaoda', aliases: [' ok ', ''] },
      ],
    }),
  );
  assert.deepEqual(loadProjects(base, file), [{ id: 'ok', dir: 'miaoda', aliases: ['ok'] }]);
  writeFileSync(file, '{ not json');
  assert.deepEqual(loadProjects(base, file), []);
});

test('/cwd only switches to a directory that is inside the base once symlinks are resolved', async () => {
  const db = openStateDb(join(tmp, 'cwd.db'));
  db.ensureUser('acc', 'wx');
  const ctx = { accountId: 'acc', db } as CommandContext;
  assert.match(await handlers.cwd('escape', ctx), /超出允许范围/, 'a symlink inside the base that points outside');
  assert.match(await handlers.cwd('../outside', ctx), /超出允许范围/);
  assert.match(await handlers.cwd('missing', ctx), /目录不存在/);
  assert.equal(db.getUser('acc')?.workspace, null);
  assert.match(await handlers.cwd('miaoda', ctx), /已切换/);
  assert.equal(db.getUser('acc')?.workspace, join(base, 'miaoda'));
});

test('a project task tells the orchestrator its repo, and that the repo rules come first', () => {
  const db = openStateDb(join(tmp, 'prompt.db'));
  const medo = { id: 'medo', dir: join(base, 'medo-discord-icafe-bot') };
  const none = { paths: [], carried: false };
  const prompt = composePrompt(db, db.createTask('acc', '看下日志', null, medo).task, medo.dir, none);
  const [id, dir, precedence] = /<project>\n([\s\S]*?)\n<\/project>/.exec(prompt)?.[1].split('\n') ?? [];
  assert.equal(id, 'id: medo');
  assert.equal(dir, `dir: ${medo.dir}`);
  assert.match(precedence ?? '', /AGENTS\.md .*take precedence over <memory> and <recent_tasks>/);
  assert.doesNotMatch(composePrompt(db, db.createTask('acc', '你好').task, base, none), /<project>/);
});

test('routeMessage stores the stripped input and the repo dir; follow-ups expire after 2 hours', () => {
  const file = join(tmp, 'state.db');
  const db = openStateDb(file);
  const medo = { id: 'medo', dir: join(base, 'medo-discord-icafe-bot') };
  const first = routeMessage(db, 'acc', '@medo 看下 AGENTS.md');
  assert.deepEqual(first, { input: '看下 AGENTS.md', project: medo, botId: 'chief' });
  const { task } = db.createTask('acc', first.input, 'm1', first.project);
  assert.deepEqual([task.input, task.project_id, task.project_dir], ['看下 AGENTS.md', medo.id, medo.dir]);
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', project: medo, botId: 'chief' });
  assert.deepEqual(routeMessage(db, 'acc', '你好'), { input: '你好', botId: 'chief' });
  assert.equal(db.startTaskNow('sim', '继续', medo)?.project_dir, medo.dir);

  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60 * 1000 - 1000, task.id);
  raw.close();
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', botId: 'chief' });
});

test('"@bot" comes off first, then the project is routed from the rest', () => {
  const db = openStateDb(join(tmp, 'bots.db'));
  const at = (id: string, dir: string) => ({ id, dir: join(base, dir) });
  assert.deepEqual(routeMessage(db, 'acc', '@research 在 miaoda 里看下发布流程'), {
    input: '在 miaoda 里看下发布流程',
    project: at('miaoda', 'miaoda'),
    botId: 'research',
  });
  assert.deepEqual(routeMessage(db, 'acc', '@eng @medo 看下日志'), {
    input: '看下日志',
    project: at('medo', 'medo-discord-icafe-bot'),
    botId: 'eng',
  });
  // "ops" is the Ops bot's alias, at the start and in the rest of the message; the project goes by "miaoda-ops".
  assert.deepEqual(routeMessage(db, 'acc', '@ops 看下日志'), { input: '看下日志', botId: 'ops' });
  assert.deepEqual(routeMessage(db, 'acc', '@miaoda-ops 看下部署'), {
    input: '看下部署',
    project: at('miaoda-ops', 'miaoda-ops'),
    botId: 'chief',
  });
  assert.deepEqual(routeMessage(db, 'acc', '@all 让 ops 和 research 分头看下这个报错'), {
    input: '让 ops 和 research 分头看下这个报错',
    botId: 'all',
  });
  assert.deepEqual(routeMessage(db, 'acc', '@all 看看 rh'), { input: '看看 rh', project: at('rh-layers', 'rh-layers'), botId: 'all' });
});

test('"@project @bot" works too; an unknown "@name" stays in the text for the default bot', () => {
  const db = openStateDb(join(tmp, 'order.db'));
  const miaoda = { id: 'miaoda', dir: join(base, 'miaoda') };
  assert.deepEqual(routeMessage(db, 'acc', '@miaoda @eng 看下日志'), { input: '看下日志', project: miaoda, botId: 'eng' });
  assert.deepEqual(routeMessage(db, 'acc', '@秒哒：@研究，看下发布流程'), { input: '看下发布流程', project: miaoda, botId: 'research' });
  assert.deepEqual(routeMessage(db, 'acc', '@miaoda @foo 看下日志'), { input: '@foo 看下日志', project: miaoda, botId: 'chief' });
  assert.deepEqual(routeMessage(db, 'acc', '@foo 看下日志'), { input: '@foo 看下日志', botId: 'chief' });
  // A message names one bot: the one that opens it.
  assert.deepEqual(routeMessage(db, 'acc', '@eng @miaoda @research 看下'), { input: '@research 看下', project: miaoda, botId: 'eng' });
});

test('a follow-up that names no bot stays with the last bot; a new request goes to the default bot', () => {
  const file = join(tmp, 'last-bot.db');
  const db = openStateDb(file);
  const medo = { id: 'medo', dir: join(base, 'medo-discord-icafe-bot') };
  db.createTask('acc', '看下日志', null, undefined, 'eng');
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', botId: 'eng' });
  assert.deepEqual(routeMessage(db, 'acc', ''), { input: '', botId: 'eng' }, 'an image without text');
  assert.deepEqual(routeMessage(db, 'acc', '你好'), { input: '你好', botId: 'chief' });
  db.createTask('acc', '看下日志', null, medo, 'research');
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', project: medo, botId: 'research' });
  db.createTask('acc', '分头看下', null, undefined, 'all');
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', botId: 'all' });
  // A bot that left the registry is not followed, and neither is a task from over 2 hours ago.
  db.createTask('acc', '看下', null, undefined, 'removed');
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', botId: 'chief' });
  const { task } = db.createTask('acc', '看下', null, undefined, 'eng');
  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60 * 1000 - 1000, task.id);
  raw.close();
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', botId: 'chief' });
});

test('an explicit "@bot" beats the last bot, and so does an "@project" that names none', () => {
  const db = openStateDb(join(tmp, 'explicit-bot.db'));
  const miaoda = { id: 'miaoda', dir: join(base, 'miaoda') };
  db.createTask('acc', '看下日志', null, undefined, 'research');
  assert.deepEqual(routeMessage(db, 'acc', '@ops 继续'), { input: '继续', botId: 'ops' });
  assert.deepEqual(routeMessage(db, 'acc', '@chief 继续'), { input: '继续', botId: 'chief' });
  assert.deepEqual(routeMessage(db, 'acc', '@all 继续'), { input: '继续', botId: 'all' });
  assert.deepEqual(routeMessage(db, 'acc', '@eng 看下这个报错'), { input: '看下这个报错', botId: 'eng' });
  assert.deepEqual(routeMessage(db, 'acc', '@miaoda 继续'), { input: '继续', project: miaoda, botId: 'chief' });
  assert.deepEqual(routeMessage(db, 'acc', '@miaoda @eng 继续'), { input: '继续', project: miaoda, botId: 'eng' });
});

test('"新话题" at the start follows neither the last project nor the last bot, and comes off the text', () => {
  const db = openStateDb(join(tmp, 'new-topic.db'));
  const medo = { id: 'medo', dir: join(base, 'medo-discord-icafe-bot') };
  db.createTask('acc', '看下日志', null, medo, 'eng');
  assert.deepEqual(routeMessage(db, 'acc', '新话题：继续'), { input: '继续', botId: 'chief' });
  assert.deepEqual(routeMessage(db, 'acc', ' New Topic, @research 继续'), { input: '继续', botId: 'research' });
  assert.deepEqual(routeMessage(db, 'acc', '换个话题 看下 rh'), {
    input: '看下 rh',
    project: { id: 'rh-layers', dir: join(base, 'rh-layers') },
    botId: 'chief',
  });
  assert.deepEqual(routeMessage(db, 'acc', '新话题'), { input: '新话题', botId: 'chief' }, 'nothing would be left');
  // Later in the message it is just words.
  assert.deepEqual(routeMessage(db, 'acc', '继续，别当新话题'), { input: '继续，别当新话题', project: medo, botId: 'eng' });
  // The cue needs a separator or the end, so a word that merely starts with it is left alone.
  assert.deepEqual(routeMessage(db, 'acc', '新话题来了'), { input: '新话题来了', botId: 'chief' });
});

test('"@base" at the start runs the task in the base workspace, with the default bot unless one is named', () => {
  const db = openStateDb(join(tmp, 'at-base.db'));
  assert.ok(!loadProjects(base).some((p) => p.id === 'base'), 'the base is no repo, so no project is called "base"');
  db.createTask('acc', '看下日志', null, { id: 'medo', dir: join(base, 'medo-discord-icafe-bot') }, 'eng');
  assert.deepEqual(routeMessage(db, 'acc', '@base 看下日志'), { input: '看下日志', botId: 'chief' });
  assert.deepEqual(routeMessage(db, 'acc', '@base 继续'), { input: '继续', botId: 'chief' }, 'no follow-up of the medo task');
  assert.deepEqual(routeMessage(db, 'acc', '@BASE：@eng 看下'), { input: '看下', botId: 'eng' });
  assert.deepEqual(routeMessage(db, 'acc', '@eng @base 看下'), { input: '看下', botId: 'eng' });
  assert.deepEqual(routeMessage(db, 'acc', '@base'), { input: '@base', botId: 'chief' });
  assert.deepEqual(routeMessage(db, 'acc', '@baseline 看下'), { input: '@baseline 看下', botId: 'chief' });
});

test('an alias a bot uses names only the bot: a project that lists it loses it, with a warning', () => {
  // As in a registry generated before the bots, miaoda-ops also goes by the Ops bot's "ops".
  const generated = readFileSync(PROJECTS_PATH, 'utf-8');
  const stale = JSON.parse(generated);
  stale.projects.find((p: { id: string }) => p.id === 'miaoda-ops').aliases.unshift('OPS', 'all');
  writeFileSync(PROJECTS_PATH, JSON.stringify(stale));
  assert.deepEqual(loadProjects(base).find((p) => p.id === 'miaoda-ops')?.aliases, ['miaoda-ops']);
  const logs = join(tmp, '.wechat-opencode-bot', 'logs');
  const log = readdirSync(logs).map((name) => readFileSync(join(logs, name), 'utf-8')).join('');
  assert.match(log, /WARN Ignoring project aliases that name a bot \{"id":"miaoda-ops","aliases":\["OPS","all"\]\}/);
  const db = openStateDb(join(tmp, 'stale.db'));
  assert.deepEqual(routeMessage(db, 'acc', '@ops 看下日志'), { input: '看下日志', botId: 'ops' });
  assert.deepEqual(routeMessage(db, 'acc', '@all 让 ops 和 research 分头看下这个报错'), {
    input: '让 ops 和 research 分头看下这个报错',
    botId: 'all',
  });
  assert.equal(routeMessage(db, 'acc', '@miaoda-ops 看下部署').project?.id, 'miaoda-ops');
  writeFileSync(PROJECTS_PATH, generated);
});

test('a v2 database gains the project columns and keeps its rows', () => {
  const file = join(tmp, 'v2.db');
  const { task } = openStateDb(file).createTask('acc', 'old task');
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE tasks DROP COLUMN project_id; ALTER TABLE tasks DROP COLUMN project_dir; PRAGMA user_version = 2;');
  const migrated = openStateDb(file);
  const columns = raw.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
  assert.ok(columns.includes('project_id') && columns.includes('project_dir'));
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 9);
  assert.deepEqual([migrated.getTask(task.id)?.input, migrated.getTask(task.id)?.project_id], ['old task', null]);
  raw.close();
});

test('addProject appends a project for a directory inside the base, and removeProject takes it out again', (t) => {
  const file = join(tmp, 'manage', 'projects.json');
  // The first change generates the missing registry, then appends to it: the id lowercased, the dir as typed.
  assert.deepEqual(addProject(base, file, ' Hidden ', ' .hidden '), { id: 'hidden', dir: '.hidden', aliases: ['hidden'] });
  assert.deepEqual(loadProjects(base, file).map((p) => p.id), ['dumate', 'medo', 'miaoda', 'miaoda-ops', 'rh-layers', 'hidden']);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(tmp, 'manage')), ['projects.json'], 'written to a temp file renamed over the registry');

  // A checkout made later; without a dir, the id names it.
  mkdirSync(join(base, 'NewRepo'));
  t.after(() => rmSync(join(base, 'NewRepo'), { recursive: true }));
  const before = readFileSync(file, 'utf-8');
  const added = addProject(base, file, 'NewRepo');
  assert.deepEqual(added, { id: 'newrepo', dir: 'NewRepo', aliases: ['newrepo'] });
  assert.deepEqual(loadProjects(base, file).at(-1), added, 'read back as added');
  assert.deepEqual(removeProject(base, file, 'NEWREPO'), added, 'by id, in any case');
  assert.equal(readFileSync(file, 'utf-8'), before, 'the registry is back as it was');
  assert.ok(statSync(join(base, 'NewRepo')).isDirectory(), 'its directory stays');
  assert.deepEqual(
    removeProject(base, file, 'icafe'),
    { id: 'medo', dir: 'medo-discord-icafe-bot', aliases: ['medo', 'icafe', 'medo-discord', 'medo-discord-icafe-bot'] },
    'by alias',
  );
  assert.deepEqual(loadProjects(base, file).map((p) => p.id), ['dumate', 'miaoda', 'miaoda-ops', 'rh-layers', 'hidden']);
});

test('addProject refuses a taken name, a bad id or a directory outside the base, and writes nothing', () => {
  const file = join(tmp, 'refused', 'projects.json');
  loadProjects(base, file);
  const saved = readFileSync(file, 'utf-8');
  const idRule = '项目 id 需以字母或数字开头，只含字母、数字、- 和 _，最多 32 个字符；base 留给基础目录';
  const pathRule = (id: string) => `project ${id}: dir must be a path inside the base, without ..`;
  const refused: Array<[string, string | undefined, string]> = [
    ['miaoda', 'dumate', 'miaoda 已被项目 miaoda 使用，发送 /projects 查看'],
    ['RH', 'dumate', 'rh 已被项目 rh-layers 使用，发送 /projects 查看'],
    ['icafe', 'dumate', 'icafe 已被项目 medo 使用，发送 /projects 查看'],
    ['ops', 'dumate', 'ops 是 bot 的别名，换一个 id'],
    ['all', 'dumate', 'all 是 bot 的别名，换一个 id'],
    ['base', '.', idRule],
    ['-x', 'dumate', idRule],
    ['a'.repeat(33), 'dumate', idRule],
    ['秒哒', 'miaoda', idRule],
    ['up', '../outside', pathRule('up')],
    ['up', 'miaoda/../../outside', pathRule('up')],
    ['abs', join(base, 'dumate'), pathRule('abs')],
    ['out', 'escape', 'project out: escape resolves outside the base'],
    ['notes', 'notes.txt', 'project notes: notes.txt is not a directory'],
    ['missing', undefined, `目录不存在: ${join(base, 'missing')}`],
  ];
  for (const [id, dir, message] of refused) {
    assert.throws(() => addProject(base, file, id, dir), { message }, `${id} ${dir}`);
  }
  assert.equal(readFileSync(file, 'utf-8'), saved);
});

test('removeProject refuses "base"; both changes keep the entries they do not touch, and never write over a broken registry', () => {
  const file = join(tmp, 'kept', 'projects.json');
  loadProjects(base, file);
  assert.throws(() => removeProject(base, file, 'nope'), { message: '没有名为 nope 的项目，发送 /projects 查看' });
  // As in the registry of a base that is a repo, plus an entry loadProjects skips.
  const registry = JSON.parse(readFileSync(file, 'utf-8'));
  registry.projects.push({ id: 'base', dir: '.', aliases: ['base', 'root'] }, { id: 'up', dir: '../outside', aliases: ['up'] });
  writeFileSync(file, JSON.stringify(registry));
  for (const key of ['base', 'root']) {
    assert.throws(() => removeProject(base, file, key), { message: 'base 是基础目录本身，不能移除' }, key);
  }
  const hidden = addProject(base, file, 'hidden', '.hidden');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')).projects, [...registry.projects, hidden], 'the others as written');
  assert.ok(!loadProjects(base, file).some((p) => p.id === 'up'));
  assert.deepEqual(removeProject(base, file, 'up'), { id: 'up', dir: '../outside', aliases: ['up'] }, 'a skipped entry can go');

  for (const broken of ['{ not json', '{"projects":{}}']) {
    writeFileSync(file, broken);
    for (const change of [() => addProject(base, file, 'other', 'dumate'), () => removeProject(base, file, 'dumate')]) {
      assert.throws(change, { message: /^项目配置无法读取，先修好 / }, broken);
    }
    assert.equal(readFileSync(file, 'utf-8'), broken);
  }
});

test('/projects add and rm edit the registry from WeChat, and reply with what to fix when they cannot', async (t) => {
  const generated = readFileSync(PROJECTS_PATH, 'utf-8');
  t.after(() => writeFileSync(PROJECTS_PATH, generated));
  const db = openStateDb(join(tmp, 'manage.db'));
  const ctx = { accountId: 'acc', db } as CommandContext;
  const send = (args: string) => handlers.projects(args, ctx);
  const hidden = { id: 'hidden', dir: join(base, '.hidden') };

  assert.equal(await send('add hidden .hidden'), '✅ 已添加项目 hidden: .hidden，以 @hidden 开头的消息就在该目录运行');
  assert.deepEqual(routeMessage(db, 'acc', '@hidden 看下'), { input: '看下', project: hidden, botId: 'chief' });
  assert.match(await send(''), /^- hidden: \.hidden（hidden）$/m);
  const usage = '用法：/projects 查看；/projects add <id> [目录]；/projects rm <id|别名>';
  for (const [args, reply] of [
    ['add up ../outside', '⚠️ project up: dir must be a path inside the base, without ..'],
    ['add out escape', '⚠️ project out: escape resolves outside the base'],
    ['add rh .hidden', '⚠️ rh 已被项目 rh-layers 使用，发送 /projects 查看'],
    ['add', usage],
    ['rename hidden x', usage],
  ]) {
    assert.equal(await send(args), reply, args);
  }

  // A routine in the project keeps its schedule; from then on its tasks run in the workspace.
  db.addRoutine('acc', { name: 'daily', prompt: '看下', schedule: 'daily09:00', nextRunAt: Date.now(), project: hidden });
  assert.equal(await send('rm hidden'), '🗑 已移除项目 hidden（目录本身不受影响）；定时任务 daily 之后在工作目录运行');
  assert.equal(readFileSync(PROJECTS_PATH, 'utf-8'), generated, 'the registry is back as it was');
  assert.equal(await send('RM ICAFE'), '🗑 已移除项目 medo（目录本身不受影响）');
  for (const key of ['hidden', 'base']) {
    assert.equal(await send(`rm ${key}`), `⚠️ 没有名为 ${key} 的项目，发送 /projects 查看`, key);
  }
  const help = await handlers.help('', ctx);
  assert.match(help, /^ {2}\/projects add <id> \[目录\] {2}添加项目（目录相对基础目录，默认与 id 同名）$/m);
  assert.match(help, /^ {2}\/projects rm <id\|别名> {2}移除项目（目录本身不受影响）$/m);
});
