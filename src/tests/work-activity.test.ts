// The work-activity collector, run as the CLI it is on git fixtures in temp directories: a repository and its linked
// worktrees are one entry, the day is [start, end) in committer time, --author matches exactly, dirty worktrees are
// reported apart from commits, what cannot be read leaves a warning, and nothing local makes deploymentVerified true.
// Every task's prompt gives the orchestrator the collector's path, as collector: in <context>.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The collector's JSON, as far as these tests read it. */
interface Commit {
  hash: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredEpoch: number;
  authoredAt: string | null;
  committedEpoch: number;
  committedAt: string | null;
}
interface Repository {
  commonDir: string;
  worktrees: { path: string; dirty: boolean | null }[];
  commits: Commit[];
  duplicateCommits: number;
}
interface Activity {
  root: string;
  date: string;
  timezone: string;
  timeRange: { start: string; end: string; startEpoch: number; endEpoch: number };
  authorFilter: string | null;
  repositories: Repository[];
  warnings: string[];
  truncated: boolean;
  deploymentVerified: boolean;
}

const SCRIPT = fileURLToPath(new URL('../../scripts/collect-work-activity.mjs', import.meta.url));
// The real path: the collector reports real paths, and on macOS the temp dir is behind a symlink.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'owb-work-activity-')));
after(() => rmSync(tmp, { recursive: true, force: true }));

// Fixtures and collector run without the caller's git config, ignore files, locale or repository (a git hook that runs
// the tests sets GIT_DIR), so signing, hooks or a global ignore cannot change a result. The machine zone is neither of
// the collector's zones, so a result that leaned on local time would be off.
const ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  HOME: tmp,
  XDG_CONFIG_HOME: join(tmp, '.config'),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  LC_ALL: 'C',
  TZ: 'America/Los_Angeles',
};

// The prompt test's config and logs follow HOME, its state, memory and registries OWB_DATA_DIR: keep them away from the
// real bot. ENV above is already built, so the collector's environment stays as it is.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
const { composePrompt, WORK_ACTIVITY_COLLECTOR } = await import('../orchestrator.js');
const { openStateDb } = await import('../tasks/db.js');

const DATE = '2026-11-12';
/** Unix seconds of an ISO time. */
const at = (iso: string): number => Date.parse(iso) / 1000;
// DATE in the default zone, Asia/Shanghai, is [START, END).
const START = at('2026-11-12T00:00:00+08:00');
const END = START + 86_400;
const HOUR = 3600;
const DAY = 86_400;
// The collector keeps at most this many commits per repository; docs/WORK-ACTIVITY.md lists its limits.
const COMMIT_LIMIT = 200;

interface Person {
  name: string;
  email: string;
}
const ALICE: Person = { name: 'Alice', email: 'alice@example.com' };

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): string {
  return execFileSync('git', args, { cwd, env: { ...ENV, ...env }, input, encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A new repository without commits at dir. */
function init(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  return dir;
}

/** Commits what is staged in dir, or nothing, at the given committer time, and returns the full hash. */
function commit(dir: string, subject: string, committed: number, { authored = committed, by = ALICE } = {}): string {
  const date = (epoch: number) => `@${epoch} +0800`;
  git(dir, ['commit', '-q', '--allow-empty', '-m', subject], {
    GIT_AUTHOR_NAME: by.name,
    GIT_AUTHOR_EMAIL: by.email,
    GIT_AUTHOR_DATE: date(authored),
    GIT_COMMITTER_NAME: by.name,
    GIT_COMMITTER_EMAIL: by.email,
    GIT_COMMITTER_DATE: date(committed),
  });
  return git(dir, ['rev-parse', 'HEAD']);
}

const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: ENV, encoding: 'utf8', timeout: 30_000 });

/** Collects DATE under root; the run must succeed without a word on stderr. */
function collect(root: string, ...args: string[]): Activity {
  const res = run('--root', root, '--date', DATE, ...args);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  return JSON.parse(res.stdout) as Activity;
}

const subjects = (activity: Activity): string[] =>
  activity.repositories.flatMap((repo) => repo.commits.map((c) => c.subject)).sort();

const readable = (dir: string): boolean => {
  try {
    readdirSync(dir);
    return true;
  } catch {
    return false;
  }
};

/** Every path under dir with its size and modification time, so a run that writes there shows. */
const snapshot = (dir: string): string[] =>
  readdirSync(dir, { encoding: 'utf8', recursive: true })
    .sort()
    .map((name) => {
      const stat = lstatSync(join(dir, name));
      return `${name} ${stat.size} ${stat.mtimeMs}`;
    });

test('a repository and its linked worktree are one repository, with each commit listed once', () => {
  const root = mkdtempSync(join(tmp, 'worktree-'));
  const app = init(join(root, 'app'));
  const feature = join(root, 'app-feature');
  const first = commit(app, 'Add login page', START + 9 * HOUR);
  git(app, ['worktree', 'add', '-q', '-b', 'feature', feature]);
  const second = commit(feature, 'Validate login form', START + 10 * HOUR);

  const activity = collect(root);
  assert.equal(activity.timezone, 'Asia/Shanghai', 'the default zone');
  assert.deepEqual(activity.timeRange, {
    start: '2026-11-12T00:00:00+08:00',
    end: '2026-11-13T00:00:00+08:00',
    startEpoch: START,
    endEpoch: END,
  });
  assert.equal(activity.repositories.length, 1);
  const [repo] = activity.repositories;
  assert.equal(repo.commonDir, join(app, '.git'));
  assert.deepEqual(repo.worktrees, [{ path: app, dirty: false }, { path: feature, dirty: false }]);
  // main and feature both reach the first commit; the one log per repository lists it once.
  assert.deepEqual(repo.commits.map((c) => c.hash).sort(), [first, second].sort());
  assert.equal(repo.duplicateCommits, 0);
  assert.deepEqual(repo.commits.find((c) => c.hash === first), {
    hash: first,
    parents: [],
    subject: 'Add login page',
    authorName: 'Alice',
    authorEmail: 'alice@example.com',
    authoredEpoch: START + 9 * HOUR,
    authoredAt: '2026-11-12T09:00:00+08:00',
    committedEpoch: START + 9 * HOUR,
    committedAt: '2026-11-12T09:00:00+08:00',
  });
  assert.deepEqual(repo.commits.find((c) => c.hash === second)?.parents, [first]);
  assert.deepEqual(activity.warnings, []);
  assert.equal(activity.truncated, false);
});

test('separate repositories stay apart, a clone lists no commit twice, and paths may hold spaces and Chinese', () => {
  const root = mkdtempSync(join(tmp, 'many repos '));
  const alpha = init(join(root, 'alpha'));
  const copy = join(root, 'alpha-copy');
  const beta = init(join(root, '客户 项目'));
  const shared = commit(alpha, 'Alpha change', START + HOUR);
  git(root, ['clone', '-q', alpha, copy]);
  const copyOnly = commit(copy, 'Copy change', START + 2 * HOUR);
  const betaOnly = commit(beta, '修复 登录', START + 3 * HOUR);

  const activity = collect(root);
  const repos = new Map(activity.repositories.map((repo) => [repo.commonDir, repo]));
  assert.deepEqual([...repos.keys()].sort(), [alpha, copy, beta].map((dir) => join(dir, '.git')).sort());
  for (const [commonDir, repo] of repos) assert.deepEqual(repo.worktrees, [{ path: dirname(commonDir), dirty: false }]);
  assert.deepEqual(repos.get(join(beta, '.git'))?.commits.map((c) => [c.hash, c.subject]), [[betaOnly, '修复 登录']]);
  assert.ok(repos.get(join(copy, '.git'))?.commits.some((c) => c.hash === copyOnly));
  // Both clones hold the shared commit: one lists it, the other counts it as a duplicate.
  const listed = activity.repositories.flatMap((repo) => repo.commits.map((c) => c.hash));
  assert.deepEqual(listed.sort(), [shared, copyOnly, betaOnly].sort());
  assert.equal(activity.repositories.reduce((sum, repo) => sum + repo.duplicateCommits, 0), 1);
});

test('the day is [start, end) in committer time, and --author keeps exact name or email matches only', () => {
  const root = mkdtempSync(join(tmp, 'window-'));
  const app = init(join(root, 'app'));
  commit(app, 'just before the day', START - 1);
  commit(app, 'first second', START);
  const smith = { name: 'Alice Smith', email: 'alice.smith@example.com' };
  commit(app, 'rebased today', START + HOUR, { authored: START - 3 * DAY, by: smith });
  commit(app, 'last second', END - 1, { by: { name: 'Bob', email: 'bob@example.com' } });
  commit(app, 'written today, committed at the end', END, { authored: START + HOUR });

  const day = collect(root);
  assert.equal(day.authorFilter, null);
  assert.deepEqual(subjects(day), ['first second', 'last second', 'rebased today']);
  const rebased = day.repositories[0].commits.find((c) => c.subject === 'rebased today');
  assert.deepEqual(
    [rebased?.authoredEpoch, rebased?.authoredAt, rebased?.committedEpoch, rebased?.committedAt],
    [START - 3 * DAY, '2026-11-09T00:00:00+08:00', START + HOUR, '2026-11-12T01:00:00+08:00'],
  );

  // Unlike git's --author regex, Alice is not Alice Smith; the day still applies to Alice's other commits.
  const alice = collect(root, '--author', 'Alice');
  assert.equal(alice.authorFilter, 'Alice');
  assert.deepEqual(subjects(alice), ['first second']);
  assert.deepEqual(subjects(collect(root, '--author', 'bob@example.com')), ['last second']);

  // The same date in UTC starts eight hours later, which takes in the commit at the Shanghai end.
  const utc = collect(root, '--timezone', 'UTC');
  assert.deepEqual([utc.timeRange.start, utc.timeRange.end], ['2026-11-12T00:00:00+00:00', '2026-11-13T00:00:00+00:00']);
  assert.deepEqual(subjects(utc), ['last second', 'written today, committed at the end']);
  const last = utc.repositories[0].commits.find((c) => c.subject === 'last second');
  assert.equal(last?.committedAt, '2026-11-12T15:59:59+00:00');
});

test('dirty worktrees are reported apart from commits, and no local ref or subject makes deploymentVerified true', () => {
  const root = mkdtempSync(join(tmp, 'dirty-'));
  const svc = init(join(root, 'svc'));
  const hotfix = join(root, 'svc-hotfix');
  writeFileSync(join(svc, 'README.md'), 'v1\n');
  git(svc, ['add', 'README.md']);
  const deploy = commit(svc, 'Deploy v1.2.0 to production, verified', START + HOUR);
  // Refs that look like a release or a push are still only local refs.
  git(svc, ['tag', 'v1.2.0']);
  git(svc, ['tag', 'deployed-production']);
  git(svc, ['branch', 'release/production']);
  git(svc, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  git(svc, ['worktree', 'add', '-q', '-b', 'hotfix', hotfix]);
  writeFileSync(join(svc, 'README.md'), 'v2, not committed\n');
  // Nothing committed on the day, but an untracked file now.
  const notes = init(join(root, 'notes'));
  commit(notes, 'Old notes', START - 2 * DAY);
  writeFileSync(join(notes, 'todo.txt'), 'draft\n');

  const before = snapshot(root);
  const activity = collect(root);
  assert.deepEqual(snapshot(root), before, 'the run wrote nothing under root');
  assert.equal(activity.deploymentVerified, false);
  const repos = new Map(activity.repositories.map((repo) => [repo.commonDir, repo]));
  assert.deepEqual([...repos.keys()].sort(), [join(notes, '.git'), join(svc, '.git')]);
  const service = repos.get(join(svc, '.git'));
  assert.deepEqual(service?.worktrees, [{ path: svc, dirty: true }, { path: hotfix, dirty: false }]);
  assert.deepEqual(service?.commits.map((c) => c.hash), [deploy], 'the uncommitted edit is no commit');
  assert.deepEqual(repos.get(join(notes, '.git')), {
    commonDir: join(notes, '.git'),
    worktrees: [{ path: notes, dirty: true }],
    commits: [],
    duplicateCommits: 0,
  });
});

test('the CLI rejects bad input with exit 1, prints help, writes --output, and runs nothing when imported', () => {
  const dir = mkdtempSync(join(tmp, 'cli-'));
  const file = join(dir, 'file.txt');
  writeFileSync(file, '');
  const bad: [string[], RegExp][] = [
    [['--root', join(dir, 'missing'), '--date', DATE], /root is not a directory/],
    [['--root', file, '--date', DATE], /root is not a directory/],
    [['--root', dir, '--date', '2026-02-30'], /date must be a real YYYY-MM-DD day/],
    [['--root', dir, '--date', DATE, '--timezone', 'Asia/Tokyo'], /timezone must be one of Asia\/Shanghai, UTC/],
    [['--date', DATE], /--root and --date are required/],
    [['--root', dir, '--date', DATE, '--since', 'yesterday'], /--since/],
  ];
  for (const [args, error] of bad) {
    const res = run(...args);
    assert.equal(res.status, 1, args.join(' '));
    assert.match(res.stderr, error);
    assert.equal(res.stdout, '', args.join(' '));
  }

  for (const flag of ['--help', '-h']) {
    const help = run(flag);
    assert.equal(help.status, 0, help.stderr);
    for (const option of ['--root', '--date', '--timezone', '--author', '--output']) {
      assert.ok(help.stdout.includes(option), `${flag} names ${option}`);
    }
  }

  const empty = join(dir, 'empty');
  mkdirSync(empty);
  const out = join(dir, 'activity.json');
  const written = run('--root', empty, '--date', DATE, '--output', out);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(written.stdout, '', 'the JSON goes to the file only');
  const activity = JSON.parse(readFileSync(out, 'utf8')) as Activity;
  assert.deepEqual(
    [activity.root, activity.date, activity.repositories, activity.deploymentVerified],
    [empty, DATE, [], false],
  );

  // The importer is argv[1], as it would be for any program that imports the module. Run as the CLI, the module
  // would complain about the missing options and exit 1.
  const importer = join(dir, 'import.mjs');
  const url = JSON.stringify(pathToFileURL(SCRIPT).href);
  writeFileSync(importer, `const m = await import(${url});\nconsole.log(Object.keys(m).sort().join(' '));\n`);
  const imported = spawnSync(process.execPath, [importer], { env: ENV, encoding: 'utf8', timeout: 30_000 });
  assert.equal(imported.stderr, '');
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout, 'collectWorkActivity main\n');
});

test('an unreadable directory or a broken .git leaves a warning, and readable repositories are still collected', (t) => {
  const root = mkdtempSync(join(tmp, 'gaps-'));
  const ok = init(join(root, 'ok'));
  const kept = commit(ok, 'Readable work', START + HOUR);
  const broken = join(root, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, '.git'), `gitdir: ${join(root, 'gone')}\n`);
  const locked = join(root, 'locked');
  mkdirSync(locked);
  chmodSync(locked, 0);
  t.after(() => chmodSync(locked, 0o755));

  const activity = collect(root);
  assert.deepEqual(activity.repositories.map((repo) => repo.commonDir), [join(ok, '.git')]);
  assert.deepEqual(activity.repositories[0].commits.map((c) => c.hash), [kept]);
  // The warnings, not truncated (which is for the fixed limits), say that the run saw less than root holds.
  const warnings = activity.warnings.join('\n');
  assert.ok(activity.warnings.some((w) => w.startsWith(`git rev-parse failed in ${broken}: `)), warnings);
  if (readable(locked)) t.diagnostic('this user reads mode-0 directories, so the unreadable one was not checked');
  else assert.ok(activity.warnings.includes(`cannot read ${locked}: EACCES`), warnings);
});

test('a repository over the commit limit is cut, warned about and marked truncated', () => {
  const root = mkdtempSync(join(tmp, 'busy-'));
  const busy = init(join(root, 'busy'));
  // One more commit than the limit, a minute apart within the day, in one fast-import call. Commit i is mark :i+1
  // (marks start at 1) and its parent is mark :i, the commit before it, so main reaches all of them.
  const stream = Array.from({ length: COMMIT_LIMIT + 1 }, (_, i) => {
    const message = `commit ${i}\n`;
    const committer = `committer Alice <alice@example.com> ${START + HOUR + 60 * i} +0800`;
    const data = `data ${Buffer.byteLength(message)}\n${message}`;
    const parent = i === 0 ? '' : `from :${i}\n`;
    return `commit refs/heads/main\nmark :${i + 1}\n${committer}\n${data}${parent}\n`;
  }).join('');
  git(busy, ['fast-import', '--quiet'], {}, stream);

  const activity = collect(root);
  const [repo] = activity.repositories;
  assert.equal(repo.commits.length, COMMIT_LIMIT);
  assert.equal(new Set(repo.commits.map((c) => c.hash)).size, COMMIT_LIMIT);
  assert.equal(activity.truncated, true);
  const warning = `kept ${COMMIT_LIMIT} of ${COMMIT_LIMIT + 1} matching commits in ${join(busy, '.git')}`;
  assert.ok(activity.warnings.includes(warning), activity.warnings.join('\n'));
});

test("every task prompt gives this collector's absolute path in <context>, as collector:", () => {
  // dist/orchestrator.js resolves ../scripts/ as this test resolves ../../scripts/: the repository's copy here, and
  // the copy that release.sh puts beside dist/ in an installed release.
  assert.equal(WORK_ACTIVITY_COLLECTOR, SCRIPT);
  assert.ok(lstatSync(WORK_ACTIVITY_COLLECTOR).isFile());
  const db = openStateDb(join(tmp, 'state.db'));
  const prompt = composePrompt(db, db.createTask('acc', '总结今天的工作').task, tmp, { paths: [], carried: false });
  const context = /<context>\n([\s\S]*?)\n<\/context>/.exec(prompt)?.[1] ?? '';
  assert.ok(context.split('\n').includes(`collector: ${SCRIPT}`), prompt);
});
