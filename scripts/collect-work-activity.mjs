#!/usr/bin/env node
// Collects bounded, read-only local git evidence for one calendar day and prints it as JSON.
// It never fetches, pushes or writes inside scanned repositories; --output FILE is the only write.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const MAX_DEPTH = 4;
const MAX_CANDIDATES = 100;
const DEADLINE_MS = 20_000;
const GIT_TIMEOUT_MS = 2_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_COMMITS_PER_REPO = 200;
const MAX_SUBJECT_CHARS = 500;
const MAX_WARNINGS = 100;
const LOG_MAX_BUFFER = 4 * 1024 * 1024;
const SMALL_MAX_BUFFER = 64 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'dist', 'build']);
const TIMEZONES = {
  'Asia/Shanghai': { offsetSec: 8 * 3600, suffix: '+08:00' },
  UTC: { offsetSec: 0, suffix: '+00:00' },
};
const HASH_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Fields are split by 0x1f; -z ends each record with NUL, which git rejects inside commit messages.
const LOG_FORMAT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ct%x1f%s';
// No optional locks, no lazy fetches from partial-clone remotes, no repository inherited from the caller.
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']) {
  delete GIT_ENV[key];
}

const SCOPE_NOTE =
  'Local git evidence only. Commits, tags, branches and dirty flags do not prove tests, builds, review, release or ' +
  'deployment, so deploymentVerified is always false. No commits does not mean no work: uncommitted, non-git, ' +
  'remote-only or out-of-scope work is invisible here.';
const LIMITATIONS = [
  `Discovery reads ${MAX_DEPTH} directory levels below root (never above it), keeps at most ${MAX_CANDIDATES} .git ` +
    'candidates and skips .git internals, node_modules, .cache, dist, build and symlinks.',
  'Commits come from one git log --all per repository (local and remote-tracking refs plus worktree HEADs; no ' +
    'stash or reflog), so commits fetched from other people appear unless --author is set.',
  `Commits match by committer time in [start, end), at most ${MAX_COMMITS_PER_REPO} per repository with subjects ` +
    `cut at ${MAX_SUBJECT_CHARS} characters. git stops walking at commits dated before start, so in-range commits ` +
    'behind them (clock skew) are missed.',
  'Not collected: changed files, diffs, file contents, branch/tag/ref inventory, remote URLs, and the dirty state ' +
    'of linked worktrees outside root. dirty reflects collection time, not the requested date; null means unknown.',
];

const USAGE = `Usage: node scripts/collect-work-activity.mjs --root DIR --date YYYY-MM-DD [options]
Prints one day of bounded, read-only local git evidence under DIR as JSON.
  --timezone ZONE  ${Object.keys(TIMEZONES).join(' or ')} (default Asia/Shanghai)
  --author VALUE   keep only commits whose author name or email equals VALUE exactly
  --output FILE    write the JSON to FILE instead of stdout
`;

// Returns UTC epoch seconds [start, end) of one calendar day; only dates that survive a Date.UTC round trip are real.
function dateBounds(date, zone) {
  if (!Object.hasOwn(TIMEZONES, zone)) throw new Error(`timezone must be one of ${Object.keys(TIMEZONES).join(', ')}`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date));
  const utcMs = match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
  if (!match || match[1] < '1970' || new Date(utcMs).toISOString().slice(0, 10) !== date) {
    throw new Error(`date must be a real YYYY-MM-DD day from 1970 on, got ${JSON.stringify(date)}`);
  }
  const start = utcMs / 1000 - TIMEZONES[zone].offsetSec;
  return { start, end: start + 86_400 };
}

function isoTime(epochSec, zone) {
  const ms = (epochSec + TIMEZONES[zone].offsetSec) * 1000;
  if (!(ms >= 0 && ms < 253_402_300_800_000)) return null; // git dates are unbounded; ISO needs years 1970-9999
  return new Date(ms).toISOString().slice(0, 19) + TIMEZONES[zone].suffix;
}

// Runs git without a shell or fsmonitor (which can start a daemon or run a hook). A failure returns a warning, with
// limited set for a timeout or full buffer; only a missing git binary throws.
function git(cwd, args, remaining, maxBuffer = LOG_MAX_BUFFER) {
  const res = spawnSync('git', ['-C', cwd, '-c', 'core.fsmonitor=false', ...args], {
    env: GIT_ENV,
    encoding: 'utf8',
    timeout: Math.max(1, Math.ceil(Math.min(remaining, GIT_TIMEOUT_MS))), // 0 would disable the timeout
    maxBuffer,
  });
  const code = res.error?.code;
  if (code === 'ENOENT') throw new Error('git was not found on PATH');
  if (!res.error && res.status === 0) return { stdout: res.stdout };
  const reason = code ?? (res.stderr?.trim().split('\n')[0] || res.signal || `exit ${res.status}`);
  const warning = `git ${args[0]} failed in ${cwd}: ${reason}`;
  return { stdout: res.stdout ?? '', warning, limited: code === 'ETIMEDOUT' || code === 'ENOBUFS' };
}

// Keeps MAX_WARNINGS warnings plus one note that more were dropped; truncated marks that a bound cut something off.
function pushWarning(state, message, truncated = false) {
  const { warnings } = state;
  state.truncated ||= truncated || warnings.length >= MAX_WARNINGS;
  if (warnings.length < MAX_WARNINGS) warnings.push(message);
  else if (warnings.length === MAX_WARNINGS) warnings.push(`more than ${MAX_WARNINGS} warnings; the rest were dropped`);
}

// Milliseconds left before the shared deadline. The first call past it records one warning; later steps just skip.
function timeLeft(state, step) {
  const left = state.deadline - Date.now();
  if (left > 0) return left;
  if (!state.timedOut) pushWarning(state, `stopped at the ${DEADLINE_MS} ms time limit during ${step}`, true);
  state.timedOut = true;
  return 0;
}

// Breadth-first, so shallow repositories are kept when the candidate cap or the time limit cuts discovery short.
// Dirents report symlinks as symlinks, so linked directories are never entered.
function walk(root, state) {
  const candidates = [];
  const queue = [[root, 0]];
  for (let i = 0; i < queue.length && timeLeft(state, 'discovery'); i += 1) {
    const [dir, depth] = queue[i];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch (err) {
      pushWarning(state, `cannot read ${dir}: ${err.code ?? err.message}`);
    }
    if (entries.some((entry) => entry.name === '.git' && (entry.isDirectory() || entry.isFile()))) {
      if (candidates.length === MAX_CANDIDATES) {
        pushWarning(state, `discovery stopped after ${MAX_CANDIDATES} .git candidates`, true);
        break;
      }
      candidates.push(dir);
    }
    if (depth === MAX_DEPTH) continue;
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name)) queue.push([path.join(dir, entry.name), depth + 1]);
    }
  }
  return candidates;
}

// Linked worktrees share a common dir, so grouping by it first means one git log per repository.
function groupByCommonDir(candidates, state) {
  const groups = new Map();
  for (const worktree of candidates) {
    const left = timeLeft(state, 'repository grouping');
    if (!left) break;
    const res = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir'], left, SMALL_MAX_BUFFER);
    const commonDir = res.stdout.replace(/\n$/, '');
    if (res.warning || !path.isAbsolute(commonDir) || commonDir.includes('\n')) {
      pushWarning(state, res.warning ?? `git rev-parse printed no absolute common dir in ${worktree}`, res.limited);
      continue;
    }
    if (!groups.has(commonDir)) groups.set(commonDir, []);
    groups.get(commonDir).push(worktree);
  }
  return groups;
}

// Returns null unless the record holds a hash, valid parents, author name and email, two epochs and a subject.
function parseCommit(record, zone) {
  const [hash, parentList, authorName, authorEmail, authored, committed, ...subjectParts] = record.split('\x1f');
  const parents = parentList ? parentList.split(' ') : [];
  const hashesOk = HASH_RE.test(hash) && parents.every((parent) => HASH_RE.test(parent));
  if (!hashesOk || !/^\d+$/.test(authored) || !/^\d+$/.test(committed) || !subjectParts.length) return null;
  const subject = subjectParts.join('\x1f'); // %s is last, so a stray 0x1f inside it cannot shift the other fields
  const [authoredEpoch, committedEpoch] = [Number(authored), Number(committed)];
  return {
    hash,
    parents,
    subject: subject.length > MAX_SUBJECT_CHARS ? [...subject].slice(0, MAX_SUBJECT_CHARS).join('') : subject,
    authorName,
    authorEmail,
    authoredEpoch,
    authoredAt: isoTime(authoredEpoch, zone),
    committedEpoch,
    committedAt: isoTime(committedEpoch, zone),
  };
}

// One log per repository. git's --until is inclusive, so [start, end) is enforced again on the committer epoch.
// --exclude keeps stash snapshots out of --all; --no-show-signature keeps log.showSignature gpg lines out of stdout.
function collectCommits(repo, filter, seen, state) {
  const left = timeLeft(state, 'git log');
  if (!left) return;
  const { start, end, timezone, author } = filter;
  const day = [`--since=${isoTime(start, timezone)}`, `--until=${isoTime(end, timezone)}`];
  const args = ['log', '--no-show-signature', '--exclude=refs/stash', '--all', ...day, '-z', `--format=${LOG_FORMAT}`];
  const res = git(repo.worktrees[0].path, args, left);
  if (res.warning) pushWarning(state, res.warning, res.limited);
  let malformed = 0;
  let matched = 0;
  // The piece after the last NUL is empty, or a record cut off by a timeout or a full buffer.
  for (const record of res.stdout.split('\0').slice(0, -1)) {
    const commit = parseCommit(record, timezone);
    if (!commit) malformed += 1;
    if (!commit || commit.committedEpoch < start || commit.committedEpoch >= end) continue;
    if (author && commit.authorName !== author && commit.authorEmail !== author) continue;
    if (seen.has(commit.hash)) {
      repo.duplicateCommits += 1; // already listed under an earlier repository, such as another clone
    } else if (++matched <= MAX_COMMITS_PER_REPO) {
      seen.add(commit.hash);
      repo.commits.push(commit);
    }
  }
  if (malformed) pushWarning(state, `skipped ${malformed} unparseable git log records in ${repo.commonDir}`);
  if (matched > MAX_COMMITS_PER_REPO) {
    pushWarning(state, `kept ${MAX_COMMITS_PER_REPO} of ${matched} matching commits in ${repo.commonDir}`, true);
  }
}

export function collectWorkActivity({ root, date, timezone = 'Asia/Shanghai', author } = {}) {
  const startedAt = Date.now();
  const { start, end } = dateBounds(date, timezone);
  const rootDir = fs.existsSync(root) ? fs.realpathSync(root) : '';
  if (!rootDir || !fs.statSync(rootDir).isDirectory()) throw new Error(`root is not a directory: ${root}`);

  const state = { deadline: startedAt + DEADLINE_MS, warnings: [], truncated: false, timedOut: false };
  const filter = { start, end, timezone, author: author || null };
  const seen = new Set();
  const repositories = [];
  for (const [commonDir, worktrees] of groupByCommonDir(walk(rootDir, state), state)) {
    const repo = {
      commonDir,
      worktrees: worktrees.map((dir) => ({ path: dir, dirty: null })),
      commits: [],
      duplicateCommits: 0,
    };
    collectCommits(repo, filter, seen, state);
    repositories.push(repo);
  }
  // Statuses run after every log, so a tight time limit is spent on commits first. Any porcelain output means dirty;
  // an empty answer means clean only when git succeeded, otherwise dirty stays null.
  for (const worktree of repositories.flatMap((repo) => repo.worktrees)) {
    const left = timeLeft(state, 'git status');
    if (!left) break;
    const res = git(worktree.path, ['status', '--porcelain'], left, SMALL_MAX_BUFFER);
    if (res.stdout) worktree.dirty = true;
    else if (res.warning) pushWarning(state, res.warning, res.limited);
    else worktree.dirty = false;
  }
  return {
    root: rootDir,
    date,
    timezone,
    timeRange: { start: isoTime(start, timezone), end: isoTime(end, timezone), startEpoch: start, endEpoch: end },
    authorFilter: filter.author,
    repositories,
    warnings: state.warnings,
    truncated: state.truncated,
    elapsedMs: Date.now() - startedAt,
    deploymentVerified: false,
    scope: SCOPE_NOTE,
    limitations: LIMITATIONS,
  };
}

// Drops trailing commits until the JSON fits. A commit's compact JSON is never longer than its share of the indented
// output, so one pass frees enough; the loop only re-measures.
function serialize(result) {
  let json = JSON.stringify(result, null, 2);
  if (Buffer.byteLength(json) <= MAX_OUTPUT_BYTES) return json;
  result.truncated = true;
  result.warnings.push(`output exceeded ${MAX_OUTPUT_BYTES} bytes, so trailing commit records were dropped`);
  const repos = result.repositories.filter((repo) => repo.commits.length > 0);
  for (;;) {
    json = JSON.stringify(result, null, 2);
    let excess = Buffer.byteLength(json) - MAX_OUTPUT_BYTES;
    if (excess <= 0 || repos.length === 0) return json; // with nothing left to drop it is still valid, just oversized
    while (excess > 0 && repos.length > 0) {
      const { commits } = repos.at(-1);
      excess -= Buffer.byteLength(JSON.stringify(commits.pop()));
      if (commits.length === 0) repos.pop();
    }
  }
}

export function main(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        date: { type: 'string' },
        timezone: { type: 'string' },
        author: { type: 'string' },
        output: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (!values.root || !values.date) throw new Error('--root and --date are required (see --help)');
    const json = `${serialize(collectWorkActivity(values))}\n`;
    if (values.output) fs.writeFileSync(values.output, json);
    else process.stdout.write(json);
    return 0;
  } catch (err) {
    process.stderr.write(`collect-work-activity: ${err.message}\n`);
    return 1;
  }
}

// Importing the module (as tests will) only defines the exports; running the file as a script runs main.
const scriptPath = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : null;
if (scriptPath === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
