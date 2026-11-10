// Routines: the schedule syntax and the next run (no drift, no catch-up), the v7 routines table and the tasks'
// routine_id, the scheduler tick that queues a due routine once, in its project as the registry has it now, and
// /routine with its routing.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import type { CommandContext } from '../commands/handlers.js';
import type { StateDb } from '../tasks/db.js';
import type { TaskQueue } from '../tasks/queue.js';

const tmp = mkdtempSync(join(tmpdir(), 'owb-routines-'));
const base = join(tmp, 'work');
for (const dir of ['miaoda', 'notes']) mkdirSync(join(base, dir), { recursive: true });
// Config and logs follow HOME, state and the registries OWB_DATA_DIR: keep all of them away from the real bot.
process.env.HOME = tmp;
process.env.OWB_DATA_DIR = join(tmp, 'data');
mkdirSync(join(tmp, '.wechat-opencode-bot'));
writeFileSync(join(tmp, '.wechat-opencode-bot', 'config.env'), `workingDirectory=${base}\n`);

const { formatSchedule, nextRunText, parseSchedule } = await import('../routines.js');
const { openStateDb } = await import('../tasks/db.js');
const { tickRoutines } = await import('../commands/handlers.js');
const { routeCommand } = await import('../commands/router.js');
const { createPermissionBroker } = await import('../permission.js');
const { loadProjects, PROJECTS_PATH } = await import('../projects.js');

after(() => rmSync(tmp, { recursive: true, force: true }));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 20:00 in Shanghai. */
const NOW = Date.parse('2026-11-09T12:00:00Z');
const at = (iso: string): number => Date.parse(iso);
const miaoda = join(base, 'miaoda');

/** The next run of a schedule that must parse. */
const next = (spec: string, now: number, slot?: number): number => parseSchedule(spec)!.nextRunAt(now, slot);

/** /routine as account "acc" sends it; the queue only counts its kicks. */
function commands(db: StateDb) {
  const kicks = { n: 0 };
  const queue = { kick: () => void kicks.n++, stop: () => [], start: () => () => {} } as unknown as TaskQueue;
  const ctx: CommandContext = { accountId: 'acc', db, queue, broker: createPermissionBroker() };
  return { send: (text: string) => routeCommand(text, ctx), kicks };
}

/** A reply with its next runs masked: they depend on the clock. */
const masked = (text: string): string => text.replace(/\d\d-\d\d \d\d:\d\d/g, '<time>');

test('dailyHH:MM is next due at that time in Shanghai, strictly after now', () => {
  assert.equal(next('daily21:00', NOW), at('2026-11-09T13:00:00Z'), 'later today');
  assert.equal(next('daily09:00', NOW), at('2026-11-10T01:00:00Z'), 'tomorrow');
  assert.equal(next('daily21:00', at('2026-11-09T13:00:00Z')), at('2026-11-10T13:00:00Z'), 'not at now itself');
  assert.equal(next('daily00:30', NOW), at('2026-11-09T16:30:00Z'), "after Shanghai's midnight, still the 9th in UTC");
  assert.equal(next('daily07:00', at('2026-11-09T22:30:00Z')), at('2026-11-09T23:00:00Z'), 'Shanghai is already on the 10th');
  // Any case, one-digit hours and the "：" of a Chinese keyboard; stored in one form.
  assert.deepEqual(['DAILY9:05', ' daily23:59 ', 'daily09：00'].map((text) => parseSchedule(text)?.spec), [
    'daily09:05',
    'daily23:59',
    'daily09:00',
  ]);
});

test('everyNm and everyNh run every N minutes or hours, from 5 minutes to 24 hours', () => {
  assert.deepEqual([parseSchedule('every30m')?.spec, next('every30m', NOW)], ['every30m', NOW + 30 * MINUTE]);
  assert.deepEqual([parseSchedule('EVERY2H')?.spec, next('EVERY2H', NOW)], ['every2h', NOW + 2 * HOUR]);
  assert.equal(parseSchedule('every05m')?.spec, 'every5m');
  for (const text of ['every5m', 'every24h', 'every1440m', 'every1h']) assert.ok(parseSchedule(text), text);
  for (const text of ['every4m', 'every25h', 'every0h', 'every0m', 'every1441m']) assert.equal(parseSchedule(text), null, text);
});

test('anything else is no schedule', () => {
  for (const text of [
    ...['', 'daily', 'daily24:00', 'daily9:60', 'daily09:0', 'daily123:00'],
    ...['every', 'every30', 'every30s', 'every-5m', 'every1.5h'],
    ...['hourly', 'daily 09:00', 'every 30m', 'daily09:00x', 'cron(0 9 * * *)'],
  ]) {
    assert.equal(parseSchedule(text), null, text);
  }
});

test('an interval keeps its rhythm when the tick runs late, and does not make up the runs it missed', () => {
  const every5m = parseSchedule('every5m')!;
  assert.equal(every5m.nextRunAt(NOW + 20_000, NOW), NOW + 5 * MINUTE, 'a tick 20 s late does not push the next run back');
  assert.equal(every5m.nextRunAt(NOW + 5 * MINUTE - 1000, NOW), NOW + 5 * MINUTE);
  assert.equal(every5m.nextRunAt(NOW + 5 * MINUTE, NOW), NOW + 10 * MINUTE, 'a whole interval late counts from now');
  assert.equal(every5m.nextRunAt(NOW + 12 * MINUTE, NOW), NOW + 17 * MINUTE, 'two missed runs are not made up');
  assert.equal(every5m.nextRunAt(NOW, NOW + 3 * MINUTE), NOW + 5 * MINUTE, 'run before its slot, as by /routine run: counts from now');
  assert.equal(next('daily21:00', NOW, NOW - 24 * HOUR), at('2026-11-09T13:00:00Z'), 'a day late, a daily routine keeps its time');
});

test('/routine shows a schedule in words, and the next run without the year', () => {
  assert.deepEqual(['daily09:00', 'every30m', 'every2h', 'weird'].map((spec) => formatSchedule(spec)), [
    '每天 09:00',
    '每 30 分钟',
    '每 2 小时',
    'weird',
  ]);
  assert.equal(nextRunText(at('2026-11-10T01:00:00Z')), '11-10 09:00');
});

test('routines are kept per account by name, and a task can point at its routine', () => {
  const db = openStateDb(join(tmp, 'crud.db'));
  const b = db.addRoutine('acc', { name: 'b', prompt: 'pb', schedule: 'every30m', nextRunAt: NOW + MINUTE })!;
  const project = { id: 'miaoda', dir: miaoda };
  const a = db.addRoutine('acc', { name: 'a', prompt: 'pa', schedule: 'daily09:00', nextRunAt: NOW - MINUTE, botId: 'research', project })!;
  const theirs = db.addRoutine('other', { name: 'a', prompt: 'po', schedule: 'every1h', nextRunAt: NOW })!;
  assert.deepEqual([b.enabled, b.bot_id, b.project_id, b.project_dir, b.last_run_at], [1, null, null, null, null]);
  assert.deepEqual([a.bot_id, a.project_id, a.project_dir], ['research', 'miaoda', miaoda]);
  assert.equal(db.addRoutine('acc', { name: 'a', prompt: 'again', schedule: 'every5m', nextRunAt: NOW }), null, 'one name per account');
  assert.equal(db.routine('acc', 'a')?.prompt, 'pa');
  assert.deepEqual(db.routines('acc').map((r) => r.name), ['a', 'b']);
  assert.equal(db.routine('other', 'a')?.id, theirs.id);
  assert.equal(db.routine('acc', 'c'), undefined);
  assert.deepEqual(db.dueRoutines(NOW).map((r) => r.id), [a.id, theirs.id], 'of every account, the longest due first');

  db.setRoutineEnabled(a.id, false);
  assert.deepEqual(db.dueRoutines(NOW).map((r) => r.id), [theirs.id]);
  assert.deepEqual([db.routine('acc', 'a')?.enabled, db.routine('acc', 'a')?.next_run_at], [0, NOW - MINUTE]);
  db.setRoutineEnabled(a.id, true, NOW + HOUR);
  assert.deepEqual([db.routine('acc', 'a')?.enabled, db.routine('acc', 'a')?.next_run_at], [1, NOW + HOUR]);
  db.markRoutineRun(b.id, NOW + 2 * HOUR, NOW);
  assert.deepEqual([db.routine('acc', 'b')?.next_run_at, db.routine('acc', 'b')?.last_run_at], [NOW + 2 * HOUR, NOW]);

  const { task } = db.createTask('acc', 'pb', null, undefined, undefined, 'write', b.id);
  assert.equal(task.routine_id, b.id);
  assert.equal(db.createTask('acc', 'a message', 'm1').task.routine_id, null);
  assert.equal(db.hasOpenRoutineTask(b.id), true, 'queued');
  assert.equal(db.claimNextTask('acc', 'write')?.id, task.id);
  assert.equal(db.hasOpenRoutineTask(b.id), true, 'running');
  db.finishTask(task.id, 'done');
  assert.deepEqual([db.hasOpenRoutineTask(b.id), db.hasOpenRoutineTask(a.id)], [false, false]);
  assert.deepEqual([db.removeRoutine(b.id), db.removeRoutine(b.id)], [true, false]);
  assert.equal(db.getTask(task.id)?.routine_id, b.id, 'its tasks stay');
});

test('a v6 database gains the routines table and routine_id, and keeps its rows', () => {
  const file = join(tmp, 'v6.db');
  const { task } = openStateDb(file).createTask('acc', 'old task');
  const raw = new DatabaseSync(file);
  raw.exec('DROP TABLE routines; ALTER TABLE tasks DROP COLUMN routine_id; PRAGMA user_version = 6;');
  const db = openStateDb(file);
  assert.ok(raw.prepare("SELECT name FROM pragma_table_info('tasks')").all().some((c) => c.name === 'routine_id'));
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routines'").get());
  assert.equal((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 8);
  raw.close();
  assert.deepEqual([db.getTask(task.id)?.input, db.getTask(task.id)?.routine_id], ['old task', null]);
  assert.equal(openStateDb(file).getTask(task.id)?.input, 'old task', 'opening again changes nothing');
  assert.ok(db.addRoutine('acc', { name: 'daily', prompt: 'p', schedule: 'daily09:00', nextRunAt: NOW }));
});

test('the tick queues a due routine as its message would have been, once, and skips a run while that task is open', () => {
  const db = openStateDb(join(tmp, 'tick.db'));
  const project = { id: 'miaoda', dir: miaoda };
  const watch = db.addRoutine('acc', { name: 'watch', prompt: '看下发布流程', schedule: 'every30m', nextRunAt: NOW, botId: 'research', project })!;
  const routine = () => db.routine('acc', 'watch')!;
  let kicks = 0;
  const kick = () => void kicks++;
  const queued = tickRoutines(db, 'acc', kick, NOW + 20_000);
  assert.deepEqual(
    queued.map((t) => [t.input, t.bot_id, t.project_id, t.project_dir, t.lane, t.routine_id, t.status, t.message_id]),
    [['看下发布流程', 'research', 'miaoda', miaoda, 'read', watch.id, 'queued', null]],
    "the research bot's task goes to the read lane",
  );
  assert.equal(kicks, 1);
  assert.deepEqual([routine().next_run_at, routine().last_run_at], [NOW + 30 * MINUTE, NOW + 20_000], 'the tick ran late; the rhythm holds');
  assert.deepEqual(tickRoutines(db, 'acc', kick, NOW + 20_000), [], 'not due again');
  // Due again while its task still waits: no second task, and the routine moves on to its next slot.
  assert.deepEqual(tickRoutines(db, 'acc', kick, NOW + 30 * MINUTE + 5000), []);
  assert.deepEqual([routine().next_run_at, routine().last_run_at], [NOW + 60 * MINUTE, NOW + 20_000]);
  assert.deepEqual([db.statusCounts('acc').queued, kicks], [1, 1]);
  db.finishTask(db.claimNextTask('acc', 'read')!.id, 'done');
  assert.equal(tickRoutines(db, 'acc', kick, NOW + 60 * MINUTE).length, 1);
  assert.equal(kicks, 2);
});

test('the tick leaves routines that are off, not due or of another account, disables one it cannot read, and never throws', () => {
  const db = openStateDb(join(tmp, 'tick-skip.db'));
  const off = db.addRoutine('acc', { name: 'off', prompt: 'p', schedule: 'every5m', nextRunAt: NOW })!;
  db.setRoutineEnabled(off.id, false);
  db.addRoutine('other', { name: 'theirs', prompt: 'p', schedule: 'every5m', nextRunAt: NOW });
  db.addRoutine('acc', { name: 'later', prompt: 'p', schedule: 'every5m', nextRunAt: NOW + MINUTE });
  // Only a hand edit of state.db stores a schedule /routine add rejects.
  db.addRoutine('acc', { name: 'broken', prompt: 'p', schedule: 'cron', nextRunAt: NOW });
  let kicks = 0;
  assert.deepEqual(tickRoutines(db, 'acc', () => void kicks++, NOW), []);
  assert.equal(kicks, 0);
  assert.equal(db.routine('acc', 'broken')?.enabled, 0, 'due on every tick, it would never run');
  assert.equal(db.routine('other', 'theirs')?.next_run_at, NOW, "the queue runs the daemon's account only");
  assert.equal(db.routine('acc', 'later')?.next_run_at, NOW + MINUTE);
  assert.equal(db.statusCounts('acc').queued + db.statusCounts('other').queued, 0);
  const locked = {
    dueRoutines: () => {
      throw new Error('database is locked');
    },
  } as unknown as StateDb;
  assert.deepEqual(tickRoutines(locked, 'acc', () => void kicks++, NOW), [], 'a failed tick waits for the next one');
});

test('the tick runs a routine in its project as the registry has it now, and where a message would once it is gone', () => {
  const db = openStateDb(join(tmp, 'moved.db'));
  loadProjects(base);
  const registry = readFileSync(PROJECTS_PATH, 'utf-8');
  /** The registry with a "scratch" project at dir, or without it. */
  const register = (dir?: string) => {
    const { projects } = JSON.parse(registry);
    if (dir) projects.push({ id: 'scratch', dir, aliases: ['scratch'] });
    writeFileSync(PROJECTS_PATH, JSON.stringify({ projects }));
  };
  const scratch = join(base, 'scratch');
  const moved = join(base, 'scratch2');
  mkdirSync(scratch);
  register('scratch');
  const project = { id: 'scratch', dir: scratch };
  const tidy = db.addRoutine('acc', { name: 'tidy', prompt: '整理一下', schedule: 'every5m', nextRunAt: NOW, project })!;
  let now = NOW;
  /** One due run: the project of the task it queued, which then finishes so the next run is not skipped. */
  const tick = () => {
    const [task] = tickRoutines(db, 'acc', () => {}, now);
    now += 5 * MINUTE;
    db.finishTask(db.claimNextTask('acc', 'write')!.id, 'done');
    return [task.project_id, task.project_dir];
  };
  try {
    assert.deepEqual(tick(), ['scratch', scratch]);
    renameSync(scratch, moved);
    register('scratch2');
    assert.deepEqual(tick(), ['scratch', moved], 'moved: the new path');
    assert.equal(db.routine('acc', 'tidy')?.project_dir, scratch, 'the row stays as it was');
    rmSync(moved, { recursive: true });
    assert.deepEqual(tick(), [null, null], 'its directory is gone: the workspace, as for a message without a project');
    mkdirSync(moved);
    register();
    assert.deepEqual(tick(), [null, null], 'no longer registered');
    const logs = join(tmp, '.wechat-opencode-bot', 'logs');
    const misses = readdirSync(logs)
      .flatMap((name) => readFileSync(join(logs, name), 'utf-8').split('\n'))
      .filter((line) => line.includes(' WARN Routine project missing '));
    assert.deepEqual(
      misses.map((line) => line.slice(line.indexOf(' WARN '))),
      Array(2).fill(` WARN Routine project missing {"routineId":"${tidy.id}","name":"tidy","projectId":"scratch"}`),
    );
  } finally {
    writeFileSync(PROJECTS_PATH, registry);
    for (const dir of [scratch, moved]) rmSync(dir, { recursive: true, force: true });
  }
});

test('/routine add routes the prompt like a message that follows no earlier task; /routine lists the routines', async () => {
  const db = openStateDb(join(tmp, 'add.db'));
  const { send } = commands(db);
  const row = (name: string) => db.routine('acc', name)!;
  assert.equal(await send('/routine'), '还没有定时任务。用法：/routine add <名称> <dailyHH:MM|everyNm> <内容>');
  // A last task that a short "继续…" message would stay with.
  db.createTask('acc', '继续', null, { id: 'miaoda', dir: miaoda }, 'eng');
  const t0 = Date.now();
  const reply = await send('/routine add Watch every30m @research @miaoda 看下发布流程');
  const t1 = Date.now();
  assert.equal(
    masked(reply),
    '✅ 已添加定时任务 watch [启用] 每 30 分钟（下次 <time>） @research @miaoda 看下发布流程\n💡 结果发不出去时会进入待发队列，在你下一条消息后补发',
  );
  const watch = row('watch');
  assert.deepEqual(
    [watch.prompt, watch.bot_id, watch.project_id, watch.project_dir, watch.schedule, watch.enabled, watch.last_run_at],
    ['看下发布流程', 'research', 'miaoda', miaoda, 'every30m', 1, null],
  );
  assert.ok(watch.next_run_at >= t0 + 30 * MINUTE && watch.next_run_at <= t1 + 30 * MINUTE);
  await send('/routine add fix every2h @miaoda @eng 修一下构建');
  await send('/routine add notes daily21:30 整理 notes 里的待办');
  await send('/routine add cont daily09:00 继续整理日报');
  await send(`/routine add long every1h ${'写'.repeat(40)}`);
  assert.deepEqual(['fix', 'notes', 'cont'].map((name) => [row(name).prompt, row(name).bot_id, row(name).project_id]), [
    ['修一下构建', 'eng', 'miaoda'],
    ['整理 notes 里的待办', 'chief', 'notes'],
    ['继续整理日报', 'chief', null],
  ]);
  assert.ok(nextRunText(row('cont').next_run_at).endsWith('09:00'));
  assert.equal(
    masked(await send('/routine')),
    [
      '⏰ 定时任务（北京时间）：',
      '- cont [启用] 每天 09:00（下次 <time>） @chief 继续整理日报',
      '- fix [启用] 每 2 小时（下次 <time>） @eng @miaoda 修一下构建',
      `- long [启用] 每 1 小时（下次 <time>） @chief ${'写'.repeat(30)}…`,
      '- notes [启用] 每天 21:30（下次 <time>） @chief @notes 整理 notes 里的待办',
      '- watch [启用] 每 30 分钟（下次 <time>） @research @miaoda 看下发布流程',
    ].join('\n'),
  );
});

test('/routine add says what is wrong: a taken or bad name, an unknown schedule, a missing part', async () => {
  const db = openStateDb(join(tmp, 'add-errors.db'));
  const { send } = commands(db);
  await send('/routine add watch every30m 看下发布流程');
  assert.equal(await send('/routine add watch every5m 别的'), '⚠️ 已有名为 watch 的定时任务：先 /routine rm watch，或换个名称');
  assert.equal(db.routine('acc', 'watch')?.prompt, '看下发布流程');
  // The README's example: a Chinese name works. A leading "@" means the name was left out.
  assert.match(await send('/routine add 早报 daily09:00 汇总昨天的工作'), /^✅ 已添加定时任务 早报 \[启用\] 每天 09:00（下次 /);
  for (const name of ['@research', 'a'.repeat(25), '早'.repeat(25)]) {
    assert.equal(await send(`/routine add ${name} daily09:00 总结`), '⚠️ 名称最多 24 个字符，不能以 @ 开头', name);
  }
  assert.equal(
    await send('/routine add x 9am 总结'),
    '⚠️ 无法识别的时间：9am\n可用：daily09:00（每天，北京时间）、every30m（每 N 分钟，N ≥ 5）、every2h（每 N 小时，N ≤ 24）',
  );
  for (const text of ['/routine add x daily09:00', '/routine add x', '/routine add']) {
    assert.equal(await send(text), '⚠️ 用法：/routine add <名称> <dailyHH:MM|everyNm> <内容>', text);
  }
  assert.deepEqual(db.routines('acc').map((r) => r.name), ['watch', '早报']);
});

test('/routine off, on, run and rm manage a routine by its name, in any case', async () => {
  const db = openStateDb(join(tmp, 'manage.db'));
  const { send, kicks } = commands(db);
  const row = (name: string) => db.routine('acc', name)!;
  await send('/routine add daily daily09:00 总结昨天的任务');
  await send('/routine add poll every30m @research 看下新的报错');
  assert.equal(await send('/routine OFF Daily'), '⏸ 已停用定时任务 daily');
  assert.equal(
    masked(await send('/routine')),
    '⏰ 定时任务（北京时间）：\n- daily [停用] 每天 09:00 @chief 总结昨天的任务\n- poll [启用] 每 30 分钟（下次 <time>） @research 看下新的报错',
  );
  const before = Date.now();
  assert.match(await send('/routine on daily'), /^✅ 已启用定时任务 daily，下次 \d\d-\d\d 09:00$/);
  assert.equal(row('daily').enabled, 1);
  assert.ok(row('daily').next_run_at > before && row('daily').next_run_at <= Date.now() + 24 * HOUR);
  await send('/routine off poll');
  const t0 = Date.now();
  await send('/routine on poll');
  const t1 = Date.now();
  assert.ok(row('poll').next_run_at >= t0 + 30 * MINUTE && row('poll').next_run_at <= t1 + 30 * MINUTE, 'on counts from now');

  // run queues a task now, behind its lane's queue, and the schedule goes on.
  db.createTask('acc', 'hi');
  assert.match(await send('/routine run daily'), /^▶️ 定时任务 daily 已创建任务 #2（前面还有 1 个任务），下次 \d\d-\d\d 09:00$/);
  assert.equal(kicks.n, 1);
  const [task] = db.recentTasks('acc', 1);
  assert.deepEqual(
    [task.input, task.bot_id, task.lane, task.routine_id, task.message_id],
    ['总结昨天的任务', 'chief', 'write', row('daily').id, null],
  );
  assert.equal(await send('/routine run daily'), '⏳ 定时任务 daily 的上一个任务还在排队或运行，这次不再创建');
  assert.deepEqual([db.statusCounts('acc').queued, kicks.n], [2, 1]);
  await send('/routine off poll');
  assert.equal(await send('/routine run poll'), '▶️ 定时任务 poll 已创建任务 #3', 'its lane is free; off, it has no next run');
  assert.deepEqual([row('poll').enabled, kicks.n, db.recentTasks('acc', 1)[0].lane], [0, 2, 'read']);

  // rm deletes the routine, not a task it queued.
  assert.equal(await send('/routine rm daily'), '🗑 已删除定时任务 daily；它已创建的任务照常运行');
  assert.equal(await send('/routine rm daily'), '⚠️ 没有名为 daily 的定时任务，发送 /routine 查看');
  assert.equal(db.getTask(task.id)?.status, 'queued');
  db.finishTask(db.claimNextTask('acc', 'read')!.id, 'done');
  assert.equal(await send('/routine rm poll'), '🗑 已删除定时任务 poll');

  db.addRoutine('acc', { name: 'broken', prompt: 'p', schedule: 'cron', nextRunAt: NOW });
  for (const action of ['on', 'run']) {
    assert.equal(await send(`/routine ${action} broken`), '⚠️ 定时任务 broken 的时间无法识别：cron，请删除后重新添加', action);
  }
  const usage = '用法：/routine add <名称> <dailyHH:MM|everyNm> <内容>\n/routine rm|on|off|run <名称>：删除、启用、停用、立即运行';
  for (const text of ['/routine rm', '/routine pause poll', '/routine run']) assert.equal(await send(text), usage, text);
});
