import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOTS_PATH, defaultBot, loadBots, type Bot } from '../bots.js';
import { loadConfig, saveConfig, type PermissionMode } from '../config.js';
import { memoryPath, memoryStats } from '../memory.js';
import { breaker } from '../model-routing.js';
import { clip, formatElapsed, formatTime, STATUS_LABEL } from '../orchestrator.js';
import { formatModelRef, listModels, resolveModelRef } from '../opencode/provider.js';
import type { PermissionBroker } from '../permission.js';
import { isRealPathInside, loadProjects, PROJECTS_PATH } from '../projects.js';
import type { StateDb, TaskRow } from '../tasks/db.js';
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

const HELP_TEXT = `可用命令：

任务：
  /status           查看当前状态（含 24 小时统计、熔断、待补发通知和消息令牌更新时间）
  /tasks [数量]     查看最近的任务（默认 5 个）
  /stop             停止所有正在运行的任务
  /stop all         同时取消所有排队的任务

工作目录与项目：
  /cwd [路径]       查看或切换工作目录
  /ls               显示工作目录内容
  /projects         查看项目列表

Bot：
  /bots             查看 bot 列表（id、别名、回复前缀、默认 bot）

模型与权限：
  /model [模型]     查看或切换模型，所有 bot 共用（/model default 恢复默认）
  /models           查看可用模型
  /permission [模式] 查看或设置权限模式

其他：
  /help             显示帮助
  /version          查看版本

直接发送文字或图片即创建任务；任务运行时新消息会排队，按顺序执行。只读 bot（如 @research）的任务单独排队，不等其他任务。
以 @bot 别名开头指定由哪个 bot 回复，@all 交给默认 bot 统筹，不指定时由默认 bot 回复（发送 /bots 查看）。
以 @别名 开头或提到项目别名，任务就在该项目目录运行；可同时指定 bot 和项目，顺序不限，如 @research @miaoda 看下发布流程。
以“继续”这类词开头的简短追问沿用上一个任务的项目和 bot（2 小时内）；以“新话题：”开头则都不沿用，以 @base 开头则在工作目录运行。`;

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
function dayHealth(db: StateDb, accountId: string, now: number): string {
  const since = now - DAY_MS;
  const { done, failed, interrupted } = db.statusCountsSince(accountId, since);
  const line = `🩺 24小时: 完成 ${done}，失败 ${failed}，中断 ${interrupted}`;
  const last = db.lastFailure(accountId, since);
  if (!last) return line;
  // formatTime ends in "HH:mm".
  return `${line}（最近失败 ${formatTime(last.finished_at!).slice(-5)} 任务 #${last.seq}：${clip(last.error ?? '', 60)}）`;
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
    `🤖 模型: ${user?.model || '默认'}`,
    `🔒 权限模式: ${config.permissionMode ?? 'default'}`,
    `▶️ 运行中: ${running.join('；') || '无'}`,
    `⏳ 排队: ${counts.queued} 个`,
    `📊 累计: ${total} 个任务（完成 ${counts.done}，失败 ${counts.failed}，中断 ${counts.interrupted}）`,
    `🧠 记忆: ${memoryCounts(accountId, bots)}`,
    dayHealth(db, accountId, now),
    `🧯 熔断: ${gateways ? openBreakers(gateways, now) : '仅 bot 进程内可见，在微信发送 /status 查看'}`,
  ];
  const pending = db.pendingNotices(accountId);
  if (pending.length) {
    const retries = Math.max(...pending.map((n) => n.attempts));
    lines.push(`📮 待补发: ${pending.length} 条（最久 ${formatElapsed(pending[0].created_at, now)}，重试 ${retries} 次）`);
  }
  // The token's age only: the token itself is a credential.
  lines.push(`🔑 消息令牌: ${user?.context_token_at ? `${formatElapsed(user.context_token_at, now)}前` : '无'}`);
  return lines.join('\n');
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
      const notes = [bot.default ? '默认' : '', bot.prefix ? `回复前缀「${bot.prefix}」` : '无回复前缀'].filter(Boolean);
      lines.push(`- ${bot.id}: ${bot.name}（${bot.aliases.join(', ') || '无别名'}）${notes.join('，')}`);
    }
    lines.push(
      `- all: @all 或 @everyone 交给 ${defaultBot(bots).name}，按需调用各专家，只回复一次`,
      '',
      '🤖 所有 bot 共用 /model 设置的模型',
      `📝 配置: ${BOTS_PATH}`,
    );
    return lines.join('\n');
  },

  async model(args, { accountId, db }) {
    if (!args) {
      const current = db.getUser(accountId)?.model || '默认';
      return `🤖 当前模型: ${current}（所有 bot 共用）\n用法: /model <provider/model>，/model default 恢复默认\n发送 /models 查看可用模型`;
    }
    if (/^(default|reset)$/i.test(args)) {
      db.setModel(accountId, null);
      return '✅ 已恢复默认模型';
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
