// Project routing: the registry, alias detection, directory checks, and the v3 task columns.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

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

const { detectProject, loadProjects, resolveProjectDir, routeMessage, stripProjectPrefix } = await import('../projects.js');
const { openStateDb } = await import('../tasks/db.js');

const registry = join(tmp, 'registry', 'projects.json');
const projects = loadProjects(base, registry);
const entry = (dir: string) => ({ id: 't', dir, aliases: ['t'] });

after(() => rmSync(tmp, { recursive: true, force: true }));

test('a missing registry is generated once from the child directories, mode 0600', () => {
  assert.deepEqual(projects, [
    { id: 'dumate', dir: 'dumate', aliases: ['dumate'] },
    { id: 'medo', dir: 'medo-discord-icafe-bot', aliases: ['medo', 'icafe', 'medo-discord', 'medo-discord-icafe-bot'] },
    { id: 'miaoda', dir: 'miaoda', aliases: ['miaoda', '秒哒'] },
    { id: 'miaoda-ops', dir: 'miaoda-ops', aliases: ['ops', 'miaoda-ops'] },
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

test('routeMessage stores the stripped input and the repo dir; follow-ups expire after 2 hours', () => {
  const file = join(tmp, 'state.db');
  const db = openStateDb(file);
  const medo = { id: 'medo', dir: join(base, 'medo-discord-icafe-bot') };
  const first = routeMessage(db, 'acc', '@medo 看下 AGENTS.md');
  assert.deepEqual(first, { input: '看下 AGENTS.md', project: medo });
  const { task } = db.createTask('acc', first.input, 'm1', first.project);
  assert.deepEqual([task.input, task.project_id, task.project_dir], ['看下 AGENTS.md', medo.id, medo.dir]);
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续', project: medo });
  assert.deepEqual(routeMessage(db, 'acc', '你好'), { input: '你好' });
  assert.equal(db.startTaskNow('sim', '继续', medo)?.project_dir, medo.dir);

  const raw = new DatabaseSync(file);
  raw.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(Date.now() - 2 * 60 * 60 * 1000 - 1000, task.id);
  raw.close();
  assert.deepEqual(routeMessage(db, 'acc', '继续'), { input: '继续' });
});

test('a v2 database gains the project columns and keeps its rows', () => {
  const file = join(tmp, 'v2.db');
  const { task } = openStateDb(file).createTask('acc', 'old task');
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE tasks DROP COLUMN project_id; ALTER TABLE tasks DROP COLUMN project_dir; PRAGMA user_version = 2;');
  const migrated = openStateDb(file);
  const columns = raw.prepare("SELECT name FROM pragma_table_info('tasks')").all().map((c) => c.name);
  assert.ok(columns.includes('project_id') && columns.includes('project_dir'));
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
  assert.deepEqual([migrated.getTask(task.id)?.input, migrated.getTask(task.id)?.project_id], ['old task', null]);
  raw.close();
});
