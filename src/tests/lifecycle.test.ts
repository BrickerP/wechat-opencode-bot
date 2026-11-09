// The daemon lock: a second bot exits while the first one holds it, a stale lock is taken over,
// and release removes only this process's lock, also when the bot exits on an error.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const tmp = mkdtempSync(join(tmpdir(), 'owb-lifecycle-'));
// Config, accounts and logs follow HOME, the lock OWB_DATA_DIR: keep all of them away from the real bot.
// The bots spawned below inherit both.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = tmp;
after(() => rmSync(tmp, { recursive: true, force: true }));

const { LOCK_FILE, acquireDaemonLock, lockHolder, releaseDaemonLock } = await import('../lifecycle.js');
const MAIN = fileURLToPath(new URL('../main.js', import.meta.url));

const startBot = () => spawnSync(process.execPath, [MAIN, '--daemon'], { encoding: 'utf-8', timeout: 20_000 });
const lockedPid = (): number => Number(/^pid=(\d+)$/m.exec(readFileSync(LOCK_FILE, 'utf-8'))?.[1]);
const lockText = (pid: number, startedAt = new Date()): string =>
  `pid=${pid}\nstartedAt=${startedAt.toISOString()}\nentry=${MAIN}\n`;

test('a second bot exits 0 while the first one holds the lock, and leaves the lock alone', () => {
  assert.equal(acquireDaemonLock(MAIN), null);
  const second = startBot();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, `wechat-opencode-bot already running (pid ${process.pid})\n`);
  assert.equal(lockedPid(), process.pid);
  releaseDaemonLock();
});

test('a stale lock is taken over', () => {
  const stale = {
    'its process is gone': lockText(spawnSync(process.execPath, ['-e', '']).pid),
    'it is not a lock': 'garbage\n',
    // The parent is alive, but a lock from before the last boot names a pid that someone else got since.
    'it predates the last boot': lockText(process.ppid, new Date(0)),
  };
  for (const [why, text] of Object.entries(stale)) {
    writeFileSync(LOCK_FILE, text);
    assert.equal(lockHolder(), null, why);
    assert.equal(acquireDaemonLock(MAIN), null, why);
    assert.equal(lockedPid(), process.pid, why);
    releaseDaemonLock();
  }
});

test('release removes only this process\'s lock, and a bot that fails to start releases its own', () => {
  assert.equal(acquireDaemonLock(MAIN), null);
  releaseDaemonLock();
  assert.equal(existsSync(LOCK_FILE), false);

  const other = lockText(process.ppid);
  writeFileSync(LOCK_FILE, other);
  assert.equal(lockHolder()?.pid, process.ppid);
  releaseDaemonLock();
  assert.equal(readFileSync(LOCK_FILE, 'utf-8'), other);
  rmSync(LOCK_FILE);

  // Without an account the bot exits 1 right after it took the lock; its exit handler releases it.
  const bot = startBot();
  assert.equal(bot.status, 1);
  assert.match(bot.stderr, /未找到账号/);
  assert.equal(existsSync(LOCK_FILE), false);
});
