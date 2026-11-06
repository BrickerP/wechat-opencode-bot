import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Bot } from './bots.js';
import { DATA_DIR } from './constants.js';

const MEMORY_ROOT = join(DATA_DIR, 'memory');
const READ_LIMIT_BYTES = 8 * 1024;
const FILE_LIMIT_BYTES = 16 * 1024;
const MAX_FACTS_PER_TASK = 5;
const MAX_FACT_CHARS = 300;
const HEADER = '# WeChat bot memory\n\n由 bot 在每个任务结束后自动维护：只保存长期有效的事实和偏好。\n\n';
const EMPTY_MARKERS = new Set(['无', '无。', '(无)', '（无）', 'none', 'n/a']);
// Bullet dates follow the user's clock, not the host timezone.
const DAY_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.@=-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

/**
 * The default bot keeps the account's shared memory, which every bot reads; any other bot keeps its
 * own file under bots/ as well. Bot ids are plain file names (see bots.ts).
 */
export function memoryPath(accountId: string, bot?: Bot): string {
  validateAccountId(accountId);
  const dir = join(MEMORY_ROOT, accountId);
  return !bot || bot.default ? join(dir, 'MEMORY.md') : join(dir, 'bots', `${bot.id}.md`);
}

function readBullets(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((line) => line.startsWith('- '));
}

/** Bullet text without the "- [date] " prefix, used for exact-duplicate detection. */
function bulletContent(bullet: string): string {
  return bullet.replace(/^- (\[\d{4}-\d{2}-\d{2}\] )?/, '').trim();
}

/** Newest memory bullets that fit in 8 KB, oldest first. Empty string if there are none. */
export function readMemory(file: string): string {
  const kept: string[] = [];
  let size = 0;
  const bullets = readBullets(file);
  for (let i = bullets.length - 1; i >= 0; i--) {
    size += Buffer.byteLength(bullets[i]) + 1;
    if (size > READ_LIMIT_BYTES) break;
    kept.unshift(bullets[i]);
  }
  return kept.join('\n');
}

export function memoryStats(file: string): { bullets: number; bytes: number } {
  const bullets = readBullets(file);
  return { bullets: bullets.length, bytes: Buffer.byteLength(bullets.join('\n')) };
}

/** Append durable facts as dated bullets. Skips exact duplicates and drops the oldest past 16 KB. */
export function appendMemory(file: string, facts: string[], date: Date = new Date()): number {
  const bullets = readBullets(file);
  const seen = new Set(bullets.map(bulletContent));
  const day = DAY_FORMAT.format(date);

  let added = 0;
  for (const raw of facts.slice(0, MAX_FACTS_PER_TASK)) {
    const fact = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
    if (!fact || EMPTY_MARKERS.has(fact.toLowerCase()) || seen.has(fact)) continue;
    seen.add(fact);
    bullets.push(`- [${day}] ${fact}`);
    added++;
  }
  if (added === 0) return 0;

  while (bullets.length > 1 && Buffer.byteLength(HEADER + bullets.join('\n') + '\n') > FILE_LIMIT_BYTES) {
    bullets.shift();
  }

  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, HEADER + bullets.join('\n') + '\n', { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, file);
  return added;
}
