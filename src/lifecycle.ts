import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR } from './constants.js';

/** Held by the running bot, so that a second one exits instead of polling WeChat as well. */
export const LOCK_FILE = join(DATA_DIR, 'daemon.lock');

export interface DaemonLock {
  pid: number;
  startedAt: string;
  /** The bot's main module as Node loaded it, symlinks resolved: releases/<tag>/dist/main.js rather than current/. */
  entry: string;
}

function parseLock(text: string): DaemonLock | null {
  const field = (key: string): string => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '';
  const pid = Number(field('pid'));
  const startedAt = field('startedAt');
  if (!Number.isInteger(pid) || pid <= 0 || Number.isNaN(Date.parse(startedAt))) return null;
  return { pid, startedAt, entry: field('entry') };
}

function readLock(): DaemonLock | null {
  try {
    return parseLock(readFileSync(LOCK_FILE, 'utf-8'));
  } catch {
    return null; // no lock
  }
}

/**
 * The live process that holds the lock, or null. A lock is stale when it is not a valid lock, when its
 * process is gone, when it names this process, or when it was written before the last boot: in the last
 * two cases a bot died without releasing it and its pid has been handed to another process since.
 */
export function lockHolder(): DaemonLock | null {
  const lock = readLock();
  const bootedAt = Date.now() - uptime() * 1000;
  if (!lock || lock.pid === process.pid || Date.parse(lock.startedAt) < bootedAt) return null;
  try {
    process.kill(lock.pid, 0);
    return lock;
  } catch {
    return null; // ESRCH: gone. EPERM: another user's process, so not this bot.
  }
}

/** Takes the lock for the bot that runs entry and returns null, or returns the live process that holds it. A stale lock is replaced. */
export function acquireDaemonLock(entry: string): DaemonLock | null {
  mkdirSync(DATA_DIR, { recursive: true });
  const content = `pid=${process.pid}\nstartedAt=${new Date().toISOString()}\nentry=${entry}\n`;
  try {
    writeFileSync(LOCK_FILE, content, { flag: 'wx' });
    return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const holder = lockHolder();
  if (holder) return holder;
  rmSync(LOCK_FILE, { force: true });
  // launchd starts one bot at a time, so nothing else replaces the stale lock now; 'wx' still refuses to
  // overwrite a lock that appeared in the meantime.
  writeFileSync(LOCK_FILE, content, { flag: 'wx' });
  return null;
}

/** Removes the lock if this process holds it; a bot that was refused the lock leaves it alone. */
export function releaseDaemonLock(): void {
  if (readLock()?.pid === process.pid) rmSync(LOCK_FILE, { force: true });
}
