import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { createNotifier } from '../notify.js';
import { openStateDb } from '../tasks/db.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-outbox-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

test('a failed notice backs off and blocks later notices; clearing it sends in order', async () => {
  const db = openStateDb(join(tmp, 'state.db'));
  db.saveContextToken('acct', 'user', 'token');

  const sent: string[] = [];
  let fail = true;
  const sender = {
    async sendText(_user: string, _token: string, text: string) {
      if (fail) throw new Error('send failed');
      sent.push(text);
    },
  } as any;
  const notifier = createNotifier(db, {} as any, sender);

  db.addNotice('acct', 'first');
  db.addNotice('acct', 'second');

  assert.equal(await notifier.flush('acct'), false);
  const head = db.pendingHead('acct')!;
  assert.equal(head.text, 'first');
  assert.equal(head.attempts, 1);
  assert.ok(head.next_at > Date.now());
  assert.deepEqual(sent, [], 'the second notice must not overtake the backed-off first');

  // Pretend the backoff elapsed.
  db.markNoticeFailed(head.id, 1, 0);
  fail = false;
  assert.equal(await notifier.flush('acct'), true);
  assert.deepEqual(sent, ['first', 'second']);
});
