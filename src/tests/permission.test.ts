// Permission asks: a queue per account that y/n answers oldest first, a timeout per ask, /stop rejecting
// every ask, a cap of three; and the ask a task sends, which names the task.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'owb-permission-'));
// Logs follow HOME, state and the bot registry OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');

const { createPermissionBroker } = await import('../permission.js');
const { createNotifier } = await import('../notify.js');
const { openStateDb } = await import('../tasks/db.js');

const db = openStateDb(join(tmp, 'state.db'));
db.saveContextToken('acc', 'wx', 'token');
const sent: string[] = [];
let sendFails = false;
const sender = {
  async sendText(_user: string, _token: string, text: string) {
    if (sendFails) throw new Error('send failed');
    sent.push(text);
  },
} as any;
const notifier = createNotifier(db, {} as any, sender);
const eng = db.createTask('acc', '跑下测试', null, undefined, 'eng').task;
const research = db.createTask('acc', '看下日志', null, undefined, 'research', 'read').task;
const plain = db.createTask('acc', 'hi').task;
const request = (action: string) => ({ id: `per_${action}`, sessionId: 'ses_1', action, resources: ['/tmp/x'] });

// Every ask arms a 2-minute timer: fake timers keep the tests fast and leave nothing running after them.
beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
afterEach(() => mock.timers.reset());
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Lets every pending promise callback run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** What each answer has settled to so far; undefined while it still waits. */
function watch(...answers: Promise<boolean>[]): (boolean | undefined)[] {
  const settled: (boolean | undefined)[] = answers.map(() => undefined);
  answers.forEach((answer, i) => void answer.then((allowed) => (settled[i] = allowed)));
  return settled;
}

test('a second ask leaves the first waiting, and each answer goes to the oldest ask', async () => {
  const broker = createPermissionBroker();
  const first = broker.createPending('acc', 'bash', 'rm a', 'A');
  const second = broker.createPending('acc', 'bash', 'rm b', 'B');
  const settled = watch(first, second);
  await settle();
  assert.deepEqual(settled, [undefined, undefined]);
  assert.equal(broker.getPending('acc')?.label, 'A');
  assert.deepEqual([broker.asksAhead('acc', first), broker.asksAhead('acc', second)], [0, 1]);
  assert.equal(broker.resolvePermission('acc', true), true);
  await settle();
  assert.deepEqual(settled, [true, undefined]);
  assert.equal(broker.resolvePermission('acc', false), true);
  await settle();
  assert.deepEqual(settled, [true, false]);
  assert.equal(broker.resolvePermission('acc', true), false, 'nothing left to answer');
});

test('each ask times out on its own; a y/n just after a timeout gets the grace period', async () => {
  const timedOut: (string | undefined)[] = [];
  const broker = createPermissionBroker((ask) => timedOut.push(ask.label));
  const first = broker.createPending('acc', 'bash', 'rm a', 'A');
  mock.timers.tick(60_000);
  const second = broker.createPending('acc', 'bash', 'rm b', 'B');
  const settled = watch(first, second);
  mock.timers.tick(60_000);
  await settle();
  assert.deepEqual([settled, timedOut], [[false, undefined], ['A']]);
  assert.equal(broker.getPending('acc')?.label, 'B', 'the second ask still waits');
  assert.equal(broker.isTimedOut('acc'), true);
  mock.timers.tick(15_000);
  assert.equal(broker.isTimedOut('acc'), false);
  mock.timers.tick(45_000);
  await settle();
  assert.deepEqual([settled, timedOut], [[false, false], ['A', 'B']]);
  assert.equal(broker.getPending('acc'), undefined);
});

test('rejecting without an answer rejects every ask (/stop); with one, only that ask', async () => {
  const broker = createPermissionBroker();
  const [a, b, c] = ['A', 'B', 'C'].map((label) => broker.createPending('acc', 'bash', label, label));
  const settled = watch(a, b, c);
  assert.equal(broker.rejectPending('acc', b), true);
  await settle();
  assert.deepEqual(settled, [undefined, false, undefined]);
  assert.equal(broker.rejectPending('acc', b), false, 'already answered');
  assert.equal(broker.rejectPending('acc'), true);
  await settle();
  assert.deepEqual(settled, [false, false, false]);
  assert.equal(broker.rejectPending('acc'), false);
});

test('with three asks waiting a fourth is denied at once; another account has a queue of its own', async () => {
  const broker = createPermissionBroker();
  const asks = ['A', 'B', 'C', 'D'].map((label) => broker.createPending('acc', 'bash', label, label));
  const other = broker.createPending('other', 'bash', 'x');
  const settled = watch(...asks, other);
  await settle();
  assert.deepEqual(settled, [undefined, undefined, undefined, false, undefined]);
  assert.equal(broker.asksAhead('acc', asks[3]), -1);
  broker.rejectPending('acc');
  broker.rejectPending('other');
});

test('a task asks by its number and bot, keeps the y/n hint, and an ask behind another says so', async () => {
  const broker = createPermissionBroker();
  sent.length = 0;
  const first = notifier.taskIO(eng, broker).onPermission!(request('bash'));
  const second = notifier.taskIO(research, broker).onPermission!(request('read'));
  await settle();
  assert.equal(sent.length, 2);
  assert.ok(sent[0].startsWith(`🔐 任务 #${eng.seq}（eng）请求权限：\n操作: bash\n资源: /tmp/x\n`), sent[0]);
  assert.match(sent[0], /^回复 y 允许，n 拒绝\n\(120秒未回复自动拒绝\)$/m);
  assert.doesNotMatch(sent[0], /前面还有/);
  assert.ok(sent[1].startsWith(`🔐 任务 #${research.seq}（research）请求权限：`), sent[1]);
  assert.match(sent[1], /^⚠️ 前面还有 1 个权限请求未回复，y\/n 先回复最早的那个$/m);
  broker.resolvePermission('acc', true);
  assert.equal(await first, 'once');
  broker.resolvePermission('acc', false);
  assert.equal(await second, 'reject');
});

test('an ask that cannot be sent is rejected, and the ask already shown still waits', async () => {
  const broker = createPermissionBroker();
  sent.length = 0;
  const shown = notifier.taskIO(plain, broker).onPermission!(request('bash'));
  await settle();
  assert.ok(sent[0].startsWith(`🔐 任务 #${plain.seq}（chief）请求权限：`), 'a task without a bot asks as the default bot');
  sendFails = true;
  try {
    assert.equal(await notifier.taskIO(eng, broker).onPermission!(request('edit')), 'reject');
  } finally {
    sendFails = false;
  }
  assert.equal(broker.getPending('acc')?.label, `任务 #${plain.seq}（chief）`);
  broker.resolvePermission('acc', true);
  assert.equal(await shown, 'once');
  assert.equal(broker.getPending('acc'), undefined, 'the unsent ask is gone too');
});

test('an ask the full queue denied is reported, not shown for answering', async () => {
  const broker = createPermissionBroker();
  for (const label of ['A', 'B', 'C']) broker.createPending('acc', 'bash', label, label);
  sent.length = 0;
  assert.equal(await notifier.taskIO(eng, broker).onPermission!(request('bash')), 'reject');
  assert.equal(sent.length, 1, 'the user hears why it was denied without a y/n prompt');
  assert.match(sent[0], /过多/);
  assert.match(sent[0], new RegExp(`任务 #${eng.seq}`));
  broker.rejectPending('acc');
});
