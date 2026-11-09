import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { backupStateDb } from '../backup.js';
import { openStateDb } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-backup-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('daily backup creates one consistent copy and keeps the newest seven', () => {
  const dbPath = join(tmp, 'state.db');
  const backupDir = join(tmp, 'backups');
  openStateDb(dbPath);

  const first = backupStateDb(dbPath, backupDir, new Date('2026-11-09T00:00:00Z'));
  assert.ok(first && existsSync(first));
  assert.equal(backupStateDb(dbPath, backupDir, new Date('2026-11-09T01:00:00Z')), null, 'within 24h');

  // Make room for a second backup, then add six old ones to exercise retention.
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(first, old, old);
  for (let i = 0; i < 6; i++) {
    const file = join(backupDir, `state-2020010${i + 1}-000000.db`);
    writeFileSync(file, '');
    utimesSync(file, old, old);
  }

  const second = backupStateDb(dbPath, backupDir, new Date());
  assert.ok(second && existsSync(second));
  const files = readdirSync(backupDir).filter((name) => name.startsWith('state-') && name.endsWith('.db'));
  assert.equal(files.length, 7, 'retention keeps seven backups');
});
