import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS_PATH, defaultBot, detectBot, isReadOnlyBot, loadBots, type Bot } from '../bots.js';
import { loadConfig, saveConfig, type PermissionMode } from '../config.js';
import { DATA_DIR } from '../constants.js';
import { logger } from '../logger.js';
import { memoryPath, memoryStats } from '../memory.js';
import { breaker } from '../model-routing.js';
import { clip, formatElapsed, formatTime, ORCHESTRATOR_AGENT, ORCHESTRATOR_READ_AGENT, STATUS_LABEL } from '../orchestrator.js';
import { formatModelRef, listAgents, listModels, openCodeInfo, resolveModelRef } from '../opencode/provider.js';
import type { PermissionBroker } from '../permission.js';
import { detectProject, isRealPathInside, loadProjects, PROJECTS_PATH, resolveProjectDir, stripProjectPrefix } from '../projects.js';
import { formatSchedule, nextRunText, parseSchedule, type Schedule } from '../routines.js';
import { STATE_DB_PATH, type RoutineRow, type StateDb, type TaskProject, type TaskRow } from '../tasks/db.js';
import type { TaskQueue } from '../tasks/queue.js';

export interface CommandContext {
  accountId: string;
  db: StateDb;
  queue: TaskQueue;
  broker: PermissionBroker;
}

type Handler = (args: string, ctx: CommandContext) => string | Promise<string>;

const DEFAULT_TASKS = 5;
const MAX_TASKS = 20;
const MAX_LS_ENTRIES = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the daemon looks for due routines, so a routine runs up to this late. */
export const ROUTINE_TICK_MS = 30_000;
/**
 * One word of up to 24 characters, Chinese included, lowercased first: a phone keyboard capitalizes the first letter.
 * A name that starts with "@" is a bot, so the name was left out.
 */
const ROUTINE_NAME = /^[^@]\S{0,23}$/u;
const ROUTINE_ADD_USAGE = '用法：/routine add <名称> <dailyHH:MM|everyNm> <内容>';
const ROUTINE_USAGE = `${ROUTINE_ADD_USAGE}\n/routine rm|on|off|run <名称>：删除、启用、停用、立即运行`;
const SCHEDULE_FORMS = 'daily09:00（每天，北京时间）、every30m（每 N 分钟，N ≥ 5）、every2h（每 N 小时，N ≤ 24）';

/** The agents config/agents installs: tasks run on the orchestrators, which delegate to the other two. */
const REQUIRED_AGENTS = [ORCHESTRATOR_AGENT, ORCHESTRATOR_READ_AGENT, 'wechat-general', 'wechat-explore'];
/** What install-agents.sh prints after a change: OpenCode only sees new agents once reloaded. */
const AGENTS_FIX = [
  '   修复: scripts/install-agents.sh --apply，再 reload：',
  `   (set -a; . ${join(DATA_DIR, 'env')}; set +a; opencode reload --server "\${OPENCODE_URL:-http://127.0.0.1:4096}")`,
].join('\n');
/** /doctor's wait for OpenCode, past the ~5 s it holds a request while its plugins load. */
const DOCTOR_TIMEOUT_MS = 8000;
/** /doctor flags a message token older than this: iLink may have expired it. */
const TOKEN_STALE_MS = 12 * 60 * 60 * 1000;
/** OpenCode's own database: /doctor reads its size, never its contents. */
const OPENCODE_DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

const HELP_TEXT = `可用命令：

任务：
  /status           查看当前状态（含 24 小时统计、熔断、待补发通知和消息令牌更新时间）
  /tasks [数量]     查看最近的任务（默认 5 个）
  /stop             停止所有正在运行的任务
  /stop all         同时取消所有排队的任务
  /panic            紧急停止：停止并取消所有任务，权限切到 plan，停用所有定时任务

定时任务（北京时间）：
  /routine          查看定时任务
  /routine add <名称> <时间> <内容>  时间如 daily09:00、every30m、every2h
  /routine rm|on|off|run <名称>  删除、启用、停用、立即运行

工作目录与项目：
  /cwd [路径]       查看或切换工作目录
  /ls               显示工作目录内容
  /projects         查看项目列表

Bot：
  /bots             查看 bot 列表（id、别名、回复前缀、模型、默认 bot）

模型与权限：
  /model [模型]     查看或切换模型，覆盖所有 bot（/model default 恢复各 bot 自己的 model，未设则用默认）
  /models           查看可用模型
  /permission [模式] 查看或设置权限模式

其他：
  /doctor           自检：OpenCode 与 agent、消息令牌、待补发、数据库、熔断和定时任务
  /help             显示帮助
  /version          查看版本

直接发送文字或图片即创建任务；任务运行时新消息会排队，按顺序执行。只读 bot（如 @research）的任务单独排队，不等其他任务；它们只读不改，要改文件请发给其他 bot（如 @eng）。
以 @bot 别名开头指定由哪个 bot 回复，@all 交给默认 bot 统筹，不指定时由默认 bot 回复（发送 /bots 查看）。
以 @别名 开头或提到项目别名，任务就在该项目目录运行；可同时指定 bot 和项目，顺序不限，如 @research @miaoda 看下发布流程。
以“继续”这类词开头的简短追问沿用上一个任务的项目和 bot（2 小时内）；以“新话题：”开头则都不沿用，以 @base 开头则在工作目录运行。
定时任务到点创建普通任务，内容可以带 @bot 和 @项目；它的上一个任务还没结束就跳过这次，bot 停机期间错过的只补一次。结果发不出去时，会在你下一条消息后补发。`;

const PERMISSION_MODES: Record<PermissionMode, string> = {
  default: '需要审批的操作发到微信，回复 y/n',
  acceptEdits: '自动批准文件编辑，其他需审批',
  plan: '拒绝所有需要审批的操作',
  auto: '自动批准所有需要审批的操作（危险模式）',
};

function workspaceOf(db: StateDb, accountId: string): string {
  return db.getUser(accountId)?.workspace || loadConfig().workingDirectory;
}

/** The input as the user sent it: the stored text has its "@bot" and "@alias" stripped. */
const taskInput = (t: TaskRow, max: number, defaultBotId: string): string =>
  `${t.bot_id && t.bot_id !== defaultBotId ? `@${t.bot_id} ` : ''}${t.project_id ? `@${t.project_id} ` : ''}${clip(t.input, max)}`;

/** The project of the latest task; a follow-up such as "继续" soon after it stays there. */
function lastProject(db: StateDb, accountId: string): string {
  const [last] = db.recentTasks(accountId, 1);
  return last ? `${last.project_id ?? '工作目录'}（#${last.seq}）` : '无';
}

/** The bot of the latest task; rows from before bots went to the default bot. */
function lastBot(db: StateDb, accountId: string, defaultBotId: string): string {
  const [last] = db.recentTasks(accountId, 1);
  return last ? `${last.bot_id ?? defaultBotId}（#${last.seq}）` : '无';
}

/** The shared memory, then each other bot's own memory that holds any facts. */
function memoryCounts(accountId: string, bots: Bot[]): string {
  const counts = [`共享 ${memoryStats(memoryPath(accountId)).bullets} 条`];
  for (const bot of bots.filter((b) => !b.default)) {
    const { bullets } = memoryStats(memoryPath(accountId, bot));
    if (bullets) counts.push(`${bot.id} ${bullets} 条`);
  }
  return counts.join('，');
}

/** Tasks that finished in the last 24 hours by outcome, and the latest failure among them. */
function dayHealth(db: StateDb, accountId: string, now: number): { failed: number; text: string } {
  const since = now - DAY_MS;
  const { done, failed, interrupted } = db.statusCountsSince(accountId, since);
  const text = `24小时: 完成 ${done}，失败 ${failed}，中断 ${interrupted}`;
  const last = db.lastFailure(accountId, since);
  if (!last) return { failed, text };
  // formatTime ends in "HH:mm".
  return { failed, text: `${text}（最近失败 ${formatTime(last.finished_at!).slice(-5)} 任务 #${last.seq}：${clip(last.error ?? '', 60)}）` };
}

/** The outbox backlog: how many notices, the oldest's age, the most retries; null when it is empty. */
function outboxBacklog(db: StateDb, accountId: string, now: number): string | null {
  const pending = db.pendingNotices(accountId);
  if (!pending.length) return null;
  const retries = Math.max(...pending.map((n) => n.attempts));
  return `${pending.length} 条（最久 ${formatElapsed(pending[0].created_at, now)}，重试 ${retries} 次）`;
}

/** A gateway as breaker.snapshot() reports it. */
interface Gateway {
  provider: string;
  openUntil: number;
}

/** The gateways whose breaker is still open, with the minutes left. */
function openBreakers(gateways: Gateway[], now: number): string {
  const open = gateways
    .filter((g) => g.openUntil > now)
    .map((g) => `${g.provider}（剩 ${Math.ceil((g.openUntil - now) / 60_000)} 分钟）`);
  return open.join('，') || '无';
}

/**
 * Shared by /status and --status. The breakers live in the bot's memory: /status passes breaker.snapshot(),
 * and --status, a process of its own, has none to pass.
 */
export function formatStatus(db: StateDb, accountId: string, gateways?: Gateway[]): string {
  const config = loadConfig();
  const user = db.getUser(accountId);
  const counts = db.statusCounts(accountId);
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const bots = loadBots();
  const primary = defaultBot(bots);
  const now = Date.now();
  const running = db
    .runningTasks(accountId)
    .map((t) => `#${t.seq} ${taskInput(t, 30, primary.id)}（${t.lane}，已运行 ${formatElapsed(t.started_at ?? t.created_at, now)}）`);
  const lines = [
    `📂 工作目录: ${user?.workspace || config.workingDirectory}`,
    `📁 最近项目: ${lastProject(db, accountId)}`,
    `🎭 默认 bot: ${primary.id}（${primary.name}）`,
    `💬 最近 bot: ${lastBot(db, accountId, primary.id)}`,
    `🤖 模型: ${user?.model ? `${user.model}（覆盖各 bot）` : '各 bot 自己的 model（/bots 查看）'}`,
    `🔒 权限模式: ${config.permissionMode ?? 'default'}`,
    `▶️ 运行中: ${running.join('；') || '无'}`,
    `⏳ 排队: ${counts.queued} 个`,
    `📊 累计: ${total} 个任务（完成 ${counts.done}，失败 ${counts.failed}，中断 ${counts.interrupted}）`,
    `🧠 记忆: ${memoryCounts(accountId, bots)}`,
    `🩺 ${dayHealth(db, accountId, now).text}`,
    `🧯 熔断: ${gateways ? openBreakers(gateways, now) : '仅 bot 进程内可见，在微信发送 /status 查看'}`,
  ];
  const backlog = outboxBacklog(db, accountId, now);
  if (backlog) lines.push(`📮 待补发: ${backlog}`);
  // The token's age only: the token itself is a credential.
  lines.push(`🔑 消息令牌: ${user?.context_token_at ? `${formatElapsed(user.context_token_at, now)}前` : '无'}`);
  return lines.join('\n');
}

/** What /doctor learns outside state.db. The handler gathers it, so tests can pass their own. */
export interface DoctorProbe {
  /** openCodeInfo(): GET /api/info. */
  server: PromiseSettledResult<{ version?: string }>;
  /** listAgents(): GET /api/agent. */
  agents: PromiseSettledResult<Array<{ id: string }>>;
  /** breaker.snapshot(): the breakers live in the daemon's memory. */
  gateways: Gateway[];
  /** How long the daemon has been up. */
  uptimeMs: number;
}

type Check = ['✅' | '⚠️' | '❌', string];

/** 7708422144 → "7.2 GB", in units of 1024 as du -h counts. */
function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unit = 0;
  for (; size >= 1024 && unit < units.length - 1; unit++) size /= 1024;
  return unit ? `${size.toFixed(1)} ${units[unit]}` : `${size} B`;
}

/** Why a request to OpenCode failed, in a few words: fetch puts the reason in err.cause. */
function requestError(err: unknown): string {
  if (!(err instanceof Error)) return clip(String(err), 80);
  if (err.name === 'TimeoutError') return `${DOCTOR_TIMEOUT_MS / 1000} 秒无响应`;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return clip(code ? `${err.message} (${code})` : err.message, 80);
}

/**
 * /doctor: one line per thing the daemon depends on, ✅ fine, ⚠️ worth a look, ❌ broken, then how many need
 * attention. The token shows by its age only.
 */
export function formatDoctor(db: StateDb, accountId: string, probe: DoctorProbe, now: number = Date.now()): string {
  const { server, agents, gateways, uptimeMs } = probe;
  const checks: Check[] = [
    server.status === 'fulfilled'
      ? ['✅', `OpenCode: 已连接${server.value.version ? `（v${server.value.version}）` : ''}`]
      : ['❌', `OpenCode: 无法连接（${requestError(server.reason)}）`],
  ];
  if (agents.status === 'rejected') checks.push(['❌', `Agent: 无法获取（${requestError(agents.reason)}）`]);
  else {
    const ids = new Set(agents.value.map((a) => a.id));
    const missing = REQUIRED_AGENTS.filter((id) => !ids.has(id));
    checks.push(missing.length ? ['❌', `Agent: 缺少 ${missing.join('、')}\n${AGENTS_FIX}`] : ['✅', `Agent: ${REQUIRED_AGENTS.length} 个已就绪`]);
  }
  const tokenAt = db.getUser(accountId)?.context_token_at;
  checks.push(
    !tokenAt
      ? ['❌', '消息令牌: 无（结果会等你的下一条消息再发）']
      : now - tokenAt > TOKEN_STALE_MS
        ? ['⚠️', `消息令牌: ${formatElapsed(tokenAt, now)}前（超过 12 小时，可能已失效）`]
        : ['✅', `消息令牌: ${formatElapsed(tokenAt, now)}前`],
  );
  const backlog = outboxBacklog(db, accountId, now);
  checks.push(backlog ? ['⚠️', `待补发: ${backlog}`] : ['✅', '待补发: 无']);
  const stateDb = statSync(STATE_DB_PATH, { throwIfNoEntry: false });
  checks.push(stateDb ? ['✅', `state.db: ${formatSize(stateDb.size)}`] : ['❌', `state.db: 未找到 ${STATE_DB_PATH}`]);
  const openCodeDb = statSync(OPENCODE_DB_PATH, { throwIfNoEntry: false });
  if (openCodeDb) checks.push(['✅', `opencode.db: ${formatSize(openCodeDb.size)}（OpenCode 的会话库）`]);
  checks.push([gateways.some((g) => g.openUntil > now) ? '⚠️' : '✅', `熔断: ${openBreakers(gateways, now)}`]);
  const day = dayHealth(db, accountId, now);
  checks.push([day.failed ? '⚠️' : '✅', day.text]);
  const routines = db.routines(accountId);
  const enabled = routines.filter((r) => r.enabled).sort((a, b) => a.next_run_at - b.next_run_at);
  const nextRun = enabled.length ? `，下次 ${nextRunText(enabled[0].next_run_at)}（${enabled[0].name}）` : '';
  checks.push(['✅', `定时任务: ${routines.length ? `${routines.length} 个，启用 ${enabled.length} 个${nextRun}` : '无'}`]);
  checks.push(['✅', `运行时长: ${formatElapsed(now - uptimeMs, now)}`]);
  const issues = checks.filter(([mark]) => mark !== '✅').length;
  return ['🩺 自检：', ...checks.map(([mark, text]) => `${mark} ${text}`), `总体: ${issues ? `有 ${issues} 项需要注意` : '正常'}`].join('\n');
}

/** Shared by /tasks and --tasks. Newest first. */
export function formatTasks(db: StateDb, accountId: string, limit: number): string {
  const tasks = db.recentTasks(accountId, limit);
  if (!tasks.length) return '暂无任务';
  const defaultBotId = defaultBot(loadBots()).id;
  return tasks
    .map((t) => {
      const head = `#${t.seq} ${formatTime(t.created_at)} [${STATUS_LABEL[t.status]}] ${taskInput(t, 40, defaultBotId)}`;
      const detail = t.summary || t.error;
      return detail ? `${head}\n    ${clip(detail, 80)}` : head;
    })
    .join('\n');
}

export function parseTaskLimit(args: string): number {
  const n = Number.parseInt(args, 10);
  return n > 0 ? Math.min(n, MAX_TASKS) : DEFAULT_TASKS;
}

/** One routine as /routine shows it: name, on or off, schedule and next run, then its input as the user wrote it. */
function describeRoutine(r: RoutineRow, defaultBotId: string): string {
  const when = r.enabled ? `${formatSchedule(r.schedule)}（下次 ${nextRunText(r.next_run_at)}）` : formatSchedule(r.schedule);
  const input = `@${r.bot_id ?? defaultBotId} ${r.project_id ? `@${r.project_id} ` : ''}${clip(r.prompt, 30)}`;
  return `${r.name} [${r.enabled ? '启用' : '停用'}] ${when} ${input}`;
}

/**
 * The routine's project as the registry has it now, so a project that moved runs at its new path. One that was
 * unregistered, or whose directory is gone, runs where a message without a project would. The row stays as it was.
 */
function routineProject(routine: RoutineRow, bots: Bot[]): TaskProject | undefined {
  if (!routine.project_id) return undefined;
  const base = loadConfig().workingDirectory;
  const project = loadProjects(base, PROJECTS_PATH, bots).find((p) => p.id === routine.project_id);
  if (project) return { id: project.id, dir: resolveProjectDir(base, project) };
  logger.warn('Routine project missing', { routineId: routine.id, name: routine.name, projectId: routine.project_id });
  return undefined;
}

/**
 * Queue the routine's task the way its message would have been: its bot, its project, the bot's lane. The
 * routine then counts as run at now. Shared by the scheduler and /routine run.
 */
function queueRoutine(db: StateDb, routine: RoutineRow, schedule: Schedule, now: number): { task: TaskRow; nextRunAt: number } {
  const bots = loadBots();
  const project = routineProject(routine, bots);
  const lane = isReadOnlyBot(routine.bot_id, bots) ? 'read' : 'write';
  const { task } = db.createTask(routine.account_id, routine.prompt, null, project, routine.bot_id ?? undefined, lane, routine.id);
  const nextRunAt = schedule.nextRunAt(now, routine.next_run_at);
  db.markRoutineRun(routine.id, nextRunAt, now);
  // Not the prompt: it is the user's, like a message.
  logger.info('Routine queued', { routineId: routine.id, name: routine.name, taskId: task.id, seq: task.seq, lane });
  return { task, nextRunAt };
}

/**
 * The scheduler, which the daemon runs every ROUTINE_TICK_MS: queue a task for each of the account's due
 * routines, unless the routine's last task is still queued or running. Either way the routine moves on to its
 * next slot, so neither a long task nor a stopped bot piles runs up. Never throws; returns the tasks it queued.
 */
export function tickRoutines(db: StateDb, accountId: string, kick: () => void, now: number = Date.now()): TaskRow[] {
  const queued: TaskRow[] = [];
  try {
    // The queue runs the daemon's account only. One bad routine must not hold up the rest.
    for (const routine of db.dueRoutines(now).filter((r) => r.account_id === accountId)) {
      const fields = { routineId: routine.id, name: routine.name };
      try {
        const schedule = parseSchedule(routine.schedule);
        if (!schedule) {
          // Only a hand edit stores one /routine add rejects; due on every tick, it would never run.
          db.setRoutineEnabled(routine.id, false);
          logger.warn('Routine disabled: unknown schedule', { ...fields, schedule: routine.schedule });
          continue;
        }
        if (db.hasOpenRoutineTask(routine.id)) {
          db.markRoutineRun(routine.id, schedule.nextRunAt(now, routine.next_run_at), routine.last_run_at);
          logger.info('Routine skipped: its last task is still open', fields);
          continue;
        }
        queued.push(queueRoutine(db, routine, schedule, now).task);
        kick();
      } catch (err) {
        logger.warn('Routine skipped after an error', { ...fields, error: String(err) });
      }
    }
  } catch (err) {
    logger.warn('Routine tick failed', { error: String(err) });
  }
  return queued;
}

/** The first word and the rest, both trimmed; the rest keeps its line breaks. */
function splitWord(text: string): [string, string] {
  const [, word, rest] = /^(\S*)\s*([\s\S]*)$/.exec(text.trim())!;
  return [word, rest];
}

/** /routine add <name> <schedule> <prompt>. The prompt is routed like a message, except that it never follows the last task. */
function createRoutine(db: StateDb, accountId: string, args: string, now: number): string {
  const [word, tail] = splitWord(args);
  const [when, text] = splitWord(tail);
  const name = word.toLowerCase();
  if (!name || !when || !text) return `⚠️ ${ROUTINE_ADD_USAGE}`;
  if (!ROUTINE_NAME.test(name)) return '⚠️ 名称最多 24 个字符，不能以 @ 开头';
  const schedule = parseSchedule(when);
  if (!schedule) return `⚠️ 无法识别的时间：${when}\n可用：${SCHEDULE_FORMS}`;
  const bots = loadBots();
  const defaultBotId = defaultBot(bots).id;
  const first = detectBot(text, bots);
  // As with a message, a prompt that no "@bot" opened may name its bot after "@project".
  const opened = first.botId !== defaultBotId || first.input !== text;
  const base = loadConfig().workingDirectory;
  const project = detectProject(first.input, loadProjects(base, PROJECTS_PATH, bots), null);
  const rest = project ? stripProjectPrefix(first.input, project) : first.input;
  const { botId, input } = opened ? { botId: first.botId, input: rest } : detectBot(rest, bots);
  const added = db.addRoutine(accountId, {
    name,
    prompt: input,
    schedule: schedule.spec,
    nextRunAt: schedule.nextRunAt(now),
    botId,
    project: project ? { id: project.id, dir: resolveProjectDir(base, project) } : undefined,
  });
  if (!added) return `⚠️ 已有名为 ${name} 的定时任务：先 /routine rm ${name}，或换个名称`;
  return `✅ 已添加定时任务 ${describeRoutine(added, defaultBotId)}\n💡 结果发不出去时会进入待发队列，在你下一条消息后补发`;
}

const version: Handler = () => {
  try {
    const pkg = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'package.json');
    return `wechat-opencode-bot v${JSON.parse(readFileSync(pkg, 'utf-8')).version}`;
  } catch {
    return 'wechat-opencode-bot (version unknown)';
  }
};

export const handlers: Record<string, Handler> = {
  help: () => HELP_TEXT,

  status: (_args, { accountId, db }) => formatStatus(db, accountId, breaker.snapshot()),

  async doctor(_args, { accountId, db }) {
    // Bounded: messages are handled one at a time, so a hung OpenCode would hold up every later one.
    const signal = AbortSignal.timeout(DOCTOR_TIMEOUT_MS);
    const [server, agents] = await Promise.allSettled([openCodeInfo(signal), listAgents(signal)]);
    return formatDoctor(db, accountId, { server, agents, gateways: breaker.snapshot(), uptimeMs: process.uptime() * 1000 });
  },

  tasks: (args, { accountId, db }) => formatTasks(db, accountId, parseTaskLimit(args)),

  stop(args, { accountId, db, queue, broker }) {
    const all = args.toLowerCase() === 'all';
    const lines: string[] = [];
    // Finish the rows first: the runners then see their tasks already finished and stay quiet.
    // This reply is the user's notice, so the outbox skips the tasks.
    const stopped = db
      .runningTasks(accountId)
      .filter((t) => db.finishTask(t.id, 'interrupted', { error: '用户停止', notified: true }));
    if (stopped.length) {
      broker.rejectPending(accountId);
      queue.stop(accountId);
      lines.push(`⏹ 已停止：任务 ${stopped.map((t) => `#${t.seq}`).join('、')}`);
    }
    if (all) {
      const cancelled = db.cancelQueued(accountId, '用户取消');
      if (cancelled) lines.push(`🗑 已取消 ${cancelled} 个排队任务`);
    }
    if (lines.length) return lines.join('\n');
    return all ? '没有运行中或排队的任务' : '没有运行中的任务';
  },

  /** The kill switch: /stop all, every ask denied, plan mode and every routine off, in one command. */
  panic(_args, { accountId, db, queue, broker }) {
    const error = '用户 panic';
    // As /stop: the rows first, so the runners stay quiet, and this reply is the user's notice.
    const stopped = db.runningTasks(accountId).filter((t) => db.finishTask(t.id, 'interrupted', { error, notified: true }));
    broker.rejectPending(accountId);
    queue.stop(accountId);
    const cancelled = db.cancelQueued(accountId, error);
    saveConfig({ ...loadConfig(), permissionMode: 'plan' });
    const routines = db.disableAllRoutines(accountId);
    logger.warn('Panic', { stopped: stopped.length, cancelled, routines });
    return `🛑 已 panic：停止 ${stopped.length} 个任务、取消 ${cancelled} 个排队、权限切到 plan、停用 ${routines} 个定时任务。恢复：/permission default；/routine on <名称>`;
  },

  routine(args, { accountId, db, queue }) {
    const [word, rest] = splitWord(args);
    const action = word.toLowerCase() || 'list';
    const now = Date.now();
    if (action === 'add') return createRoutine(db, accountId, rest, now);
    if (action === 'list') {
      const routines = db.routines(accountId);
      if (!routines.length) return `还没有定时任务。${ROUTINE_ADD_USAGE}`;
      const defaultBotId = defaultBot(loadBots()).id;
      return ['⏰ 定时任务（北京时间）：', ...routines.map((r) => `- ${describeRoutine(r, defaultBotId)}`)].join('\n');
    }
    const name = splitWord(rest)[0].toLowerCase();
    if (!name || !['rm', 'on', 'off', 'run'].includes(action)) return ROUTINE_USAGE;
    const found = db.routine(accountId, name);
    if (!found) return `⚠️ 没有名为 ${name} 的定时任务，发送 /routine 查看`;
    if (action === 'rm') {
      db.removeRoutine(found.id);
      return `🗑 已删除定时任务 ${name}${db.hasOpenRoutineTask(found.id) ? '；它已创建的任务照常运行' : ''}`;
    }
    if (action === 'off') {
      db.setRoutineEnabled(found.id, false);
      return `⏸ 已停用定时任务 ${name}`;
    }
    const schedule = parseSchedule(found.schedule);
    if (!schedule) return `⚠️ 定时任务 ${name} 的时间无法识别：${found.schedule}，请删除后重新添加`;
    if (action === 'on') {
      const next = schedule.nextRunAt(now);
      db.setRoutineEnabled(found.id, true, next);
      return `✅ 已启用定时任务 ${name}，下次 ${nextRunText(next)}`;
    }
    // run: one task at a time, as on schedule.
    if (db.hasOpenRoutineTask(found.id)) return `⏳ 定时任务 ${name} 的上一个任务还在排队或运行，这次不再创建`;
    const { task, nextRunAt } = queueRoutine(db, found, schedule, now);
    const ahead = db.countAhead(accountId, task.id);
    queue.kick(accountId);
    const waiting = ahead ? `（前面还有 ${ahead} 个任务）` : '';
    return `▶️ 定时任务 ${name} 已创建任务 #${task.seq}${waiting}${found.enabled ? `，下次 ${nextRunText(nextRunAt)}` : ''}`;
  },

  cwd(args, { accountId, db }) {
    const base = loadConfig().workingDirectory;
    const current = workspaceOf(db, accountId);
    if (!args) return `当前工作目录: ${current}\n用法: /cwd <路径>`;
    const target = resolve(current, args);
    if (!statSync(target, { throwIfNoEntry: false })?.isDirectory()) return `⚠️ 目录不存在: ${target}`;
    if (!isRealPathInside(base, target)) return `⚠️ 目标目录超出允许范围\n允许范围: ${base}\n目标目录: ${target}`;
    db.setWorkspace(accountId, target);
    return `✅ 工作目录已切换为: ${target}`;
  },
  ls(_args, { accountId, db }) {
    const dir = workspaceOf(db, accountId);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return `⚠️ 无法读取目录: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!entries.length) return `${dir}\n(空目录)`;
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const lines = entries.slice(0, MAX_LS_ENTRIES).map((e) => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
    if (entries.length > MAX_LS_ENTRIES) lines.push(`… 还有 ${entries.length - MAX_LS_ENTRIES} 项`);
    return `${dir}\n${lines.join('\n')}`;
  },

  projects(_args, { accountId, db }) {
    const base = loadConfig().workingDirectory;
    const projects = loadProjects(base);
    const lines = projects.length
      ? ['📁 项目（以 @别名 开头指定项目）：', ...projects.map((p) => `- ${p.id}: ${p.dir}（${p.aliases.join(', ')}）`)]
      : ['⚠️ 没有可用的项目'];
    lines.push('', `📌 上个任务: ${lastProject(db, accountId)}`, `📂 基础目录: ${base}`, `📝 配置: ${PROJECTS_PATH}`);
    return lines.join('\n');
  },

  bots() {
    const bots = loadBots();
    const lines = ['🎭 Bot（以 @别名 开头指定由谁回复）：'];
    for (const bot of bots) {
      const notes = [
        bot.default ? '默认' : '',
        bot.prefix ? `回复前缀「${bot.prefix}」` : '无回复前缀',
        `model=${bot.model ?? '默认'}`,
      ].filter(Boolean);
      lines.push(`- ${bot.id}: ${bot.name}（${bot.aliases.join(', ') || '无别名'}）${notes.join('，')}`);
    }
    lines.push(
      `- all: @all 或 @everyone 交给 ${defaultBot(bots).name}，按需调用各专家，只回复一次`,
      '',
      '🤖 /model 设置的模型优先于各 bot 的 model；都没设时用默认模型',
      `📝 配置: ${BOTS_PATH}`,
    );
    return lines.join('\n');
  },

  async model(args, { accountId, db }) {
    if (!args) {
      const current = db.getUser(accountId)?.model;
      const scope = current ? `${current}（覆盖所有 bot）` : '默认（各 bot 用自己的 model，发送 /bots 查看）';
      return `🤖 当前模型: ${scope}\n用法: /model <provider/model>，/model default 恢复默认\n发送 /models 查看可用模型`;
    }
    if (/^(default|reset)$/i.test(args)) {
      db.setModel(accountId, null);
      return '✅ 已恢复默认：各 bot 用自己的 model，未设则用默认模型';
    }
    const ref = await resolveModelRef(args);
    if (!ref) return `⚠️ 未找到模型: ${args}\n发送 /models 查看可用模型`;
    const model = formatModelRef(ref);
    db.setModel(accountId, model);
    return `✅ 模型已切换为: ${model}\n从下一个任务开始生效`;
  },

  async models(_args, { accountId, db }) {
    let models;
    try {
      models = await listModels();
    } catch (err) {
      return `⚠️ 获取模型列表失败: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (!models.length) return '⚠️ 未找到可用的模型提供商';
    const byProvider = new Map<string, string[]>();
    for (const m of models) byProvider.set(m.providerID, [...(byProvider.get(m.providerID) ?? []), m.id]);
    const lines = ['📋 可用模型（使用 /model <provider/model> 切换）：'];
    for (const [provider, ids] of byProvider) lines.push('', `【${provider}】`, ...ids.map((id) => `  - ${id}`));
    lines.push('', `当前模型: ${db.getUser(accountId)?.model || '默认'}`, '💡 示例: /model oneapi/DeepSeek-V4.1-Flash');
    return lines.join('\n');
  },
  permission(args) {
    const config = loadConfig();
    const modes = Object.keys(PERMISSION_MODES) as PermissionMode[];
    if (!args) {
      return [
        `🔒 当前权限模式: ${config.permissionMode ?? 'default'}`,
        '',
        '可用模式:',
        ...modes.map((m) => `  ${m} — ${PERMISSION_MODES[m]}`),
        '',
        '用法: /permission <模式>',
      ].join('\n');
    }
    const mode = modes.find((m) => m.toLowerCase() === args.toLowerCase());
    if (!mode) return `未知模式: ${args}\n可用: ${modes.join(', ')}`;
    saveConfig({ ...config, permissionMode: mode });
    const warning = mode === 'auto' ? '\n\n⚠️ 已开启危险模式：所有需要审批的操作将自动批准，无需手动确认。' : '';
    return `✅ 权限模式已切换为: ${mode}\n${PERMISSION_MODES[mode]}${warning}`;
  },

  version,
  v: version,
};
