import { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./constants.js";

const BACKUP_PREFIX = "state-";
const BACKUP_SUFFIX = ".db";
const MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const KEEP = 7;

function stamp(now: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function backups(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_SUFFIX))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Daily consistent copy of state.db using SQLite's VACUUM INTO (WAL-safe, no
 * external sqlite3 binary). Returns the new path, or null when the newest copy
 * is younger than a day or the database does not exist yet.
 */
export function backupStateDb(
  dbPath: string = join(DATA_DIR, "state.db"),
  backupDir: string = join(DATA_DIR, "backups"),
  now: Date = new Date(),
): string | null {
  if (!existsSync(dbPath)) return null;
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const existing = backups(backupDir);
  const newest = existing[existing.length - 1];
  if (newest) {
    try {
      if (now.getTime() - statSync(join(backupDir, newest)).mtimeMs < MIN_INTERVAL_MS) return null;
    } catch {
      // unreadable oldest file: continue with a new backup
    }
  }

  const dest = join(backupDir, `${BACKUP_PREFIX}${stamp(now)}${BACKUP_SUFFIX}`);
  if (existsSync(dest)) return dest;
  const db = new DatabaseSync(dbPath);
  try {
    // VACUUM INTO needs the destination to be quoted; the path is ours, not user input.
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  chmodSync(dest, 0o600);

  for (const old of backups(backupDir).slice(0, -KEEP)) {
    try {
      unlinkSync(join(backupDir, old));
    } catch {
      // best effort
    }
  }
  return dest;
}
