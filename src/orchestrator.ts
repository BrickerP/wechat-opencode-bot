import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { maybeAlertFailures } from './alerts.js';
import { defaultBot, loadBots, resolveBot, type Bot } from './bots.js';
import { loadConfig } from './config.js';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';
import { appendMemory, memoryPath, readMemory } from './memory.js';
import { breaker, DEFAULT_MODEL, fallbackModel, providerOf } from './model-routing.js';
import { openCodeQuery, type PermissionDecision, type PermissionRequest, type QueryResult, type Usage } from './opencode/provider.js';
import { isRealPathInside } from './projects.js';
import type { StateDb, TaskRow, TaskStatus, TaskUsage } from './tasks/db.js';

/** OpenCode agent that plans each task and delegates the work to subagent sessions. */
export const ORCHESTRATOR_AGENT = 'wechat-orchestrator';
/** The read lane's orchestrator: it can only delegate to wechat-explore, so it cannot write beside a write task. */
export const ORCHESTRATOR_READ_AGENT = 'wechat-orchestrator-read';

const RECENT_TASKS = 8;
const MAX_SUMMARY_CHARS = 100;
const MAX_ERROR_CHARS = 200;
const MAX_HANDOFF_CHARS = 1200;
/** How long a handoff stays fresh: the same 2 hours in which projects.ts still routes "继续" after the last task. */
const HANDOFF_MAX_AGE_MS = 2 * 60 * 60 * 1000;

const REPLY_MARKER = '<<<WECHAT_REPLY>>>';
const MEMORY_MARKER = '<<<WECHAT_MEMORY>>>';
const SUMMARY_MARKER = '<<<WECHAT_SUMMARY>>>';
const HANDOFF_MARKER = '<<<WECHAT_HANDOFF>>>';
const FILES_MARKER = '<<<WECHAT_FILES>>>';

/** The files a task may send after its text, and the size of each. */
const MAX_FILES = 3;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Files with these extensions go as images, those with the other allowed ones as files. */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
const FILE_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'patch', 'diff', 'csv', 'json', 'zip']);

const extension = (path: string): string => extname(path).slice(1).toLowerCase();

/** Whether a task's attachment goes as an image; the others go as files. */
export const isImageFile = (path: string): boolean => IMAGE_EXTENSIONS.has(extension(path));

/** How a task talks back to the user. --simulate prints instead of sending. */
export interface TaskIO {
  /** Reports a finished task; the daemon hands its text to the outbox, then sends a done task's files best-effort. */
  deliver(task: TaskRow): Promise<void>;
  /** The bridge's own note on a long task, sent only with OWB_PROGRESS_ENABLED; best-effort like commentary. */
  progress?(text: string): void | Promise<void>;
  /**
   * What the orchestrator says while it works, ahead of its answer. Best-effort: a failed one is dropped, never
   * queued for retry, and one still waiting to go out when the task finishes is not sent.
   */
  commentary?(text: string): void | Promise<void>;
  onPermission?(request: PermissionRequest): Promise<PermissionDecision>;
}

export const shortId = (id: string): string => id.slice(0, 6);

// User-facing times follow the user's clock, not the host timezone.
const TIME_FORMAT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** "YYYY-MM-DD HH:mm" in Asia/Shanghai. */
export const formatTime = (ms: number): string => TIME_FORMAT.format(ms);

/** "42秒", "5分钟", "1小时3分". */
export function formatElapsed(since: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

/** One line, at most max characters. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// ── attachments ──────────────────────────────────────────────────────────

const ATTACHMENTS_ROOT = join(DATA_DIR, 'attachments');
const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** An image sent right before a text message is usually what the text asks about. */
const CARRY_OVER_MS = 10 * 60 * 1000;
export const IMAGE_ONLY_INPUT = '[图片]';

export interface Attachments {
  paths: string[];
  /** The images came with the previous message, not this one. */
  carried: boolean;
}

/** Store an inbound image under its task so subagents can open it by path. */
export function saveAttachment(taskId: string, dataUri: string): void {
  const match = /^data:image\/([\w.+-]+);base64,(.+)$/.exec(dataUri);
  if (!match) return;
  const dir = join(ATTACHMENTS_ROOT, taskId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  writeFileSync(join(dir, `image-1.${ext}`), Buffer.from(match[2], 'base64'), { mode: 0o600 });
}

function attachmentPaths(taskId: string): string[] {
  const dir = join(ATTACHMENTS_ROOT, taskId);
  return existsSync(dir) ? readdirSync(dir).sort().map((name) => join(dir, name)) : [];
}

function resolveAttachments(db: StateDb, task: TaskRow): Attachments {
  const own = attachmentPaths(task.id);
  if (own.length) return { paths: own, carried: false };
  const [previous] = db.recentTasks(task.account_id, 1, task.id);
  if (previous && task.created_at - previous.created_at <= CARRY_OVER_MS) {
    const paths = attachmentPaths(previous.id);
    if (paths.length) return { paths, carried: true };
  }
  return { paths: [], carried: false };
}

/** Attachments only matter to their own task and the one right after it. */
function pruneAttachments(now: number = Date.now()): void {
  if (!existsSync(ATTACHMENTS_ROOT)) return;
  for (const name of readdirSync(ATTACHMENTS_ROOT)) {
    const dir = join(ATTACHMENTS_ROOT, name);
    const stat = statSync(dir, { throwIfNoEntry: false });
    if (stat && now - stat.mtimeMs > ATTACHMENT_TTL_MS) rmSync(dir, { recursive: true, force: true });
  }
}

// ── prompt ───────────────────────────────────────────────────────────────

const MAX_INPUT_CHARS = 200;
const MAX_REPLY_CHARS = 1200;
/** Only the latest replies are quoted; older tasks keep just their summary. */
const REPLY_EXCERPTS = 2;
const PROJECT_PRECEDENCE =
  "The repository's AGENTS.md and project config are loaded by OpenCode and take precedence over <memory> and <recent_tasks>.";
const PERSONA_PRECEDENCE =
  "The repository's AGENTS.md and opencode.json take precedence over this persona role, <memory> and <recent_tasks>.";
const ALL_GUIDANCE =
  'The user addressed everyone (@all): give independent parts to the specialists, at most 3 subagents at once, then merge them into one reply.';
const SHARED_MEMORY_GUIDANCE =
  'Your WECHAT_MEMORY bullets go to the shared memory that every persona reads: keep cross-persona user preferences there. Never store repo instructions.';

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  done: '完成',
  failed: '失败',
  interrupted: '已中断',
};

/** Oldest first. */
function formatRecentTasks(tasks: TaskRow[], defaultBotId: string): string {
  if (!tasks.length) return '(暂无)';
  return tasks
    .map((t, i) => {
      // The stored input has its "@alias" stripped; the project id keeps that part of the message.
      const project = t.project_id ? ` @${t.project_id}` : '';
      // Rows from before bots, like messages that named none, went to the default bot.
      const to = t.bot_id && t.bot_id !== defaultBotId ? `（对 ${t.bot_id}）` : '';
      const lines = [`#${t.seq} ${formatTime(t.created_at)} [${STATUS_LABEL[t.status]}]${project} 用户${to}: ${clip(t.input, MAX_INPUT_CHARS)}`];
      if (t.summary) lines.push(`摘要: ${t.summary}`);
      if (t.error) lines.push(`错误: ${clip(t.error, MAX_ERROR_CHARS)}`);
      if (t.result && i >= tasks.length - REPLY_EXCERPTS) lines.push(`回复: ${clip(t.result, MAX_REPLY_CHARS)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/** Who answers: the routed bot's role and, for the default bot, the specialists it can brief subagents as. */
function formatPersona(bots: Bot[], bot: Bot, all: boolean): string {
  const lines = [`id: ${bot.id}`, `name: ${bot.name}`, `role: ${bot.role}`];
  if (bot.subagent) lines.push(`subagent: prefer ${bot.subagent} for this role's work`);
  lines.push(`You are speaking as ${bot.name}. Match this role. ${PERSONA_PRECEDENCE}`);
  const specialists = bot.default ? bots.filter((b) => b.id !== bot.id) : [];
  if (specialists.length) {
    lines.push(
      'specialists (brief a subagent in the matching role):',
      ...specialists.map((b) => `- ${b.id} (${b.name}): ${b.role}${b.subagent ? `; ${b.subagent}` : ''}`),
    );
    if (all) lines.push(ALL_GUIDANCE);
  }
  lines.push(
    bot.default
      ? SHARED_MEMORY_GUIDANCE
      : `Your WECHAT_MEMORY bullets are kept for ${bot.name} only, under "${bot.name} 的记忆" in <memory>: keep facts about this role and its projects there. Never store repo instructions.`,
  );
  return `<persona>\n${lines.join('\n')}\n</persona>`;
}

/**
 * The notes the task right before this one left, while fresh, so a follow-up such as "继续" picks up where it
 * stopped. A routine's task starts afresh: like its routing, it never follows the last task.
 */
function lastHandoff(task: TaskRow, previous: TaskRow | undefined): string[] {
  if (task.routine_id || !previous?.handoff || previous.finished_at === null) return [];
  if (task.created_at - previous.finished_at > HANDOFF_MAX_AGE_MS) return [];
  return [`<last_handoff>\ntask: #${previous.seq}\n${previous.handoff}\n</last_handoff>`];
}

/**
 * Each orchestrator session starts empty: everything it knows about the chat comes from this prompt.
 * retry: an earlier session for this task gave up, possibly after its subagents had changed something.
 */
export function composePrompt(db: StateDb, task: TaskRow, workspace: string, attachments: Attachments, retry = false): string {
  const bots = loadBots();
  const { bot, all } = resolveBot(task.bot_id, bots);
  const context = [`workspace: ${workspace}`, `time: ${formatTime(Date.now())} (Asia/Shanghai)`, `task: #${task.seq}`];
  if (retry) {
    context.push('retry: an earlier attempt at this task stopped midway and may have made changes; check the current state before redoing anything that writes');
  }
  if (attachments.paths.length) {
    context.push(
      `attachments${attachments.carried ? ' (from the previous message)' : ''}:`,
      ...attachments.paths.map((path) => `- ${path}`),
    );
  }
  const recent = db.recentTasks(task.account_id, RECENT_TASKS, task.id).reverse();
  const input = task.input === IMAGE_ONLY_INPUT ? `${IMAGE_ONLY_INPUT} 请分析这张图片` : task.input;
  // The repo's own instructions reach the session through OpenCode, never through this prompt.
  const project = task.project_id
    ? [`<project>\nid: ${task.project_id}\ndir: ${task.project_dir}\n${PROJECT_PRECEDENCE}\n</project>`]
    : [];
  // Every bot reads the shared memory; any other bot's own facts follow, seen only by that bot.
  const shared = readMemory(memoryPath(task.account_id)) || '(暂无)';
  const own = bot.default ? '' : `\n\n${bot.name} 的记忆:\n${readMemory(memoryPath(task.account_id, bot)) || '(暂无)'}`;
  return [
    `<context>\n${context.join('\n')}\n</context>`,
    formatPersona(bots, bot, all),
    ...project,
    `<memory>\n${shared}${own}\n</memory>`,
    `<recent_tasks>\n${formatRecentTasks(recent, defaultBot(bots).id)}\n</recent_tasks>`,
    ...lastHandoff(task, recent.at(-1)),
    `<user_message>\n${input}\n</user_message>`,
  ].join('\n\n');
}

/**
 * What /steer sends into a running task's session. The session has the task's prompt already; the frame tells
 * the orchestrator that this changes that task, and that the answer keeps its format.
 */
export function composeSteer(text: string): string {
  return [
    `<user_correction>\n${text}\n</user_correction>`,
    'The user sent this correction while the task runs. It changes the task in <user_message>: apply it from here on, ' +
      'and check work already done or delegated where it matters. End the run with the four markers as usual.',
  ].join('\n\n');
}

// ── output ───────────────────────────────────────────────────────────────

export interface OrchestratorOutput {
  reply: string;
  memory: string[];
  summary: string;
  /** Notes for the next task, never part of the reply; '' when there are none. */
  handoff: string;
  /** Paths to send after the reply, as listed and not yet checked (checkTaskFiles); [] when there are none. */
  files: string[];
}

/** Text from start up to the next marker position after it, or the end. */
function section(body: string, start: number, ...markers: number[]): string {
  return body.slice(start, Math.min(body.length, ...markers.filter((at) => at >= start)));
}

const trimmedLines = (text: string): string[] => text.split('\n').map((line) => line.trim());

/** The handoff's lines, trimmed and without blank ones; "-", "无" or "- 无" means there is none. */
function cleanHandoff(text: string): string {
  const handoff = trimmedLines(text).filter(Boolean).join('\n').slice(0, MAX_HANDOFF_CHARS).trim();
  return /^(?:-\s*)?(?:无)?$/.test(handoff) ? '' : handoff;
}

/** One path per line, without a "-" bullet or backticks; "-" or "无" means there are none. A repeated path counts once. */
function cleanFiles(text: string): string[] {
  const paths = trimmedLines(text).map((line) => line.replace(/^[-*]\s+/, '').replace(/^`(.+)`$/, '$1').trim());
  return [...new Set(paths.filter((path) => path && path !== '-' && path !== '无'))];
}

/** A DeepSeek tool-call tag, as "<｜｜DSML｜｜invoke name=…>" or "</｜｜DSML｜｜ parameter>". */
const DSML_TAG = /<\/?[｜|]{1,2}DSML[｜|]{1,2}[^>]*>/g;
/** A whole tool call, from its opening tag to the closing tag of the same name. */
const DSML_BLOCK = /<[｜|]{1,2}DSML[｜|]{1,2}\s*([\w-]+)[^>]*>[\s\S]*?<\/[｜|]{1,2}DSML[｜|]{1,2}\s*\1\s*>/g;
/** Any piece of that markup, a tag cut off before its ">" too. */
const DSML_MARK = /[｜|]{1,2}DSML[｜|]{1,2}/;
const ANY_MARKER = /<<<WECHAT_[A-Z]+>>>/g;

/**
 * The text without the DeepSeek tool-call markup that can leak into an answer: whole calls first, then any tag
 * left on its own, then the blank lines they leave behind. Text without that markup only comes back trimmed.
 */
export function stripToolMarkup(text: string): string {
  if (!text.match(DSML_TAG)) return text.trim();
  return text
    .replace(DSML_BLOCK, '')
    .replace(DSML_TAG, '')
    .replace(/(?:[ \t]*\n){3,}/g, '\n\n')
    .trim();
}

/** Where the sections of an answer start: the first memory and summary markers, the last handoff marker and the files marker after them. */
function sectionStarts(body: string) {
  const memoryAt = body.indexOf(MEMORY_MARKER);
  const summaryAt = body.indexOf(SUMMARY_MARKER);
  // The handoff ends the required sections, so its last marker counts: one the reply quotes cannot cut the reply short.
  const handoffAt = body.lastIndexOf(HANDOFF_MARKER);
  // The files come after every other section and run to the end; a files marker before one of them is quoted.
  const lastFilesAt = body.lastIndexOf(FILES_MARKER);
  const filesAt = lastFilesAt > Math.max(memoryAt, summaryAt, handoffAt) ? lastFilesAt : -1;
  return { memoryAt, summaryAt, handoffAt, filesAt };
}

/** The reply part of an answer body: its text up to the first section marker. */
function replyOf(body: string): string {
  const { memoryAt, summaryAt, handoffAt, filesAt } = sectionStarts(body);
  return section(body, 0, memoryAt, summaryAt, handoffAt, filesAt);
}

/** Where each reply marker starts, first to last. */
function replyMarkers(text: string): number[] {
  const at: number[] = [];
  for (let i = text.indexOf(REPLY_MARKER); i !== -1; i = text.indexOf(REPLY_MARKER, i + REPLY_MARKER.length)) at.push(i);
  return at;
}

/**
 * Split the orchestrator's answer into the WeChat reply, new memory facts, a one-line summary, the handoff and the
 * files. The sections follow the last reply marker, so a marker quoted in a draft cannot cut the answer. The reply
 * is the last reply marker's text that is not empty, each running to the next marker; when every one is empty, the
 * model wrote its answer before the markers, and the text before the first one is the reply. No marker: the whole
 * text is the reply. DeepSeek tool-call markup is stripped from every field but the files.
 */
export function parseOrchestratorOutput(text: string): OrchestratorOutput {
  const stripped = new Set<string>();
  const clean = (field: string, raw: string): string => {
    const out = stripToolMarkup(raw);
    if (out !== raw.trim()) stripped.add(field);
    return out;
  };

  const markers = replyMarkers(text);
  const body = markers.length ? text.slice(markers.at(-1)! + REPLY_MARKER.length) : text;
  const { memoryAt, summaryAt, handoffAt, filesAt } = sectionStarts(body);

  let reply = '';
  for (let i = markers.length - 1; i >= 0 && !reply; i--) {
    reply = clean('reply', replyOf(text.slice(markers[i] + REPLY_MARKER.length, markers[i + 1] ?? text.length)));
  }
  if (!markers.length) reply = clean('reply', replyOf(text));
  else if (!reply) {
    reply = clean('reply', text.slice(0, markers[0]).replace(ANY_MARKER, ''));
    if (reply) logger.warn('Reply markers misplaced; using the text before the marker', { length: reply.length });
  }

  const memory =
    memoryAt === -1
      ? []
      : trimmedLines(clean('memory', section(body, memoryAt + MEMORY_MARKER.length, summaryAt, handoffAt, filesAt)))
          .map((line) => /^[-*]\s+(.+)$/.exec(line)?.[1].trim() ?? '')
          .filter(Boolean);
  const summary =
    summaryAt === -1
      ? ''
      : (trimmedLines(clean('summary', section(body, summaryAt + SUMMARY_MARKER.length, memoryAt, handoffAt, filesAt))).find(Boolean) ?? '');
  const handoff =
    handoffAt === -1 ? '' : cleanHandoff(clean('handoff', section(body, handoffAt + HANDOFF_MARKER.length, memoryAt, summaryAt, filesAt)));
  const files = filesAt === -1 ? [] : cleanFiles(body.slice(filesAt + FILES_MARKER.length));
  if (stripped.size) logger.warn('Stripped tool markup', { fields: [...stripped] });
  return { reply, memory, summary: clip(summary || reply, MAX_SUMMARY_CHARS), handoff, files };
}

/** The attachments a task may send, and the listed paths it may not, each with the reason. */
export interface CheckedFiles {
  files: string[];
  dropped: Array<{ path: string; reason: string }>;
}

/** Why a listed path cannot be sent, or undefined when it can. Never throws: runTask calls it before finishTask. */
function attachmentProblem(path: string, workspace: string): string | undefined {
  if (!isAbsolute(path)) return 'not an absolute path';
  const ext = extension(path);
  if (!IMAGE_EXTENSIONS.has(ext) && !FILE_EXTENSIONS.has(ext)) return 'type not allowed';
  let stat: Stats;
  try {
    // lstat, so a symlink does not pass as the file it points to.
    stat = lstatSync(path);
  } catch {
    return 'not found';
  }
  if (!stat.isFile()) return 'not a regular file';
  if (stat.size > MAX_FILE_BYTES) return 'over 20 MB';
  // Real paths, so neither ".." nor a symlinked directory leads out of the workspace.
  if (!isRealPathInside(workspace, path)) return 'outside the workspace';
  return undefined;
}

/**
 * The attachments a task listed that it may send: absolute paths of regular files, not symlinks, whose real
 * path is inside the workspace, of an allowed type and at most 20 MB. The first MAX_FILES valid ones are kept.
 */
export function checkTaskFiles(paths: string[], workspace: string): CheckedFiles {
  const files: string[] = [];
  const dropped: CheckedFiles['dropped'] = [];
  for (const path of paths) {
    const reason = attachmentProblem(path, workspace) ?? (files.length < MAX_FILES ? undefined : `more than ${MAX_FILES}`);
    if (reason) dropped.push({ path, reason });
    else files.push(path);
  }
  return { files, dropped };
}

// ── run ──────────────────────────────────────────────────────────────────

const EDIT_ACTION = /edit|write|patch/i;

/** The bridge's progress notes are diagnostics, sent only when OWB_PROGRESS_ENABLED is "true". Read on use. */
const progressEnabled = (): boolean => process.env.OWB_PROGRESS_ENABLED?.trim().toLowerCase() === 'true';
/** A long task gets its first progress note once an attempt has run this long. */
const PROGRESS_FIRST_MS = Number(process.env.OWB_PROGRESS_FIRST_MS) || 20_000;
/** Progress notes are at least this far apart. */
const PROGRESS_MIN_GAP_MS = Number(process.env.OWB_PROGRESS_MIN_GAP_MS) || 90_000;
/** After the first note, only new subagent sessions or this much time bring another. */
const PROGRESS_EVERY_MS = Number(process.env.OWB_PROGRESS_EVERY_MS) || 300_000;
/** Progress notes per task, over all its attempts; 0 sends none. */
const PROGRESS_MAX = /^\d+$/.test(process.env.OWB_PROGRESS_MAX ?? '') ? Number(process.env.OWB_PROGRESS_MAX) : 4;
/** A note names this many of the running tools at most. */
const PROGRESS_NOTE_TOOLS = 3;
/** What the orchestrator says while it works reaches the user this many times per task, over all its attempts. */
const COMMENTARY_MAX = 3;
/** Longer commentary is cut to this many characters. */
const COMMENTARY_MAX_CHARS = 800;
/** Prompt tokens, cache included, from which a task counts as costly: logged, and flagged in /tasks. Read on use. */
export const taskWarnTokens = (): number => Number(process.env.OWB_TASK_WARN_TOKENS) || 500_000;

/** The mode is read per request so /permission applies to a task that is already running. */
async function decidePermission(request: PermissionRequest, io: TaskIO): Promise<PermissionDecision> {
  const mode = loadConfig().permissionMode ?? 'default';
  if (mode === 'auto') return 'once';
  if (mode === 'plan') return 'reject';
  if (mode === 'acceptEdits' && EDIT_ACTION.test(request.action)) return 'once';
  return io.onPermission ? io.onPermission(request) : 'reject';
}

/** What the user is told when a task finishes. */
export function resultText(task: TaskRow): string {
  const label = `任务 #${task.seq}`;
  // The bridge, not the model, says which bot is speaking.
  if (task.status === 'done') return task.result ? `${resolveBot(task.bot_id).bot.prefix}${task.result}` : 'ℹ️ 没有可回复的内容';
  if (task.status === 'failed') return `⚠️ ${label} 失败：${clip(task.error || '未知错误', MAX_ERROR_CHARS)}`;
  const reason = task.error ? `：${clip(task.error, MAX_ERROR_CHARS)}` : '';
  return `⏹ ${label} 已中断${reason}，需要的话请重新发送`;
}

/** The ack for a task that has to wait. The ETA is the median run time of recent tasks, once per task ahead. */
export function formatQueueAck(seq: number, ahead: number, durations: number[]): string {
  const ack = `⏳ 已排队：任务 #${seq}（前面还有 ${ahead} 个任务）`;
  if (!durations.length) return ack;
  const sorted = [...durations].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const eta = median * ahead;
  return `${ack}，${eta < 60_000 ? '预计不到 1 分钟' : `预计约 ${Math.round(eta / 60_000)} 分钟`}`;
}

/**
 * The onProgress handler of one task, shared by its attempts so the limits hold for the whole task: a note
 * once an attempt has run PROGRESS_FIRST_MS, then on new subagent sessions or every PROGRESS_EVERY_MS. A note
 * names the tools running at the time and counts the subagent sessions. runTask uses it only with OWB_PROGRESS_ENABLED.
 * Notes go out through io.progress, never the outbox, and a failed one is only logged.
 */
function progressNotes(task: TaskRow, io: TaskIO, running: () => boolean) {
  const startedAt = task.started_at ?? Date.now();
  let sent = 0;
  let lastSent = 0;
  let lastChildren = 0;
  return ({ elapsedMs, children, tools }: { elapsedMs: number; children: number; tools: string[] }): void => {
    const now = Date.now();
    if (!io.progress || sent >= PROGRESS_MAX || elapsedMs < PROGRESS_FIRST_MS || now - lastSent < PROGRESS_MIN_GAP_MS) return;
    if (children <= lastChildren && now - lastSent < PROGRESS_EVERY_MS) return;
    if (!running()) return;
    sent++;
    lastSent = now;
    lastChildren = children;
    const doing = tools.length ? `，正在 ${tools.slice(0, PROGRESS_NOTE_TOOLS).join('、')}` : '';
    const delegated = children > 0 ? `，已派出 ${children} 个子任务` : '';
    const text = `⏳ 任务 #${task.seq} 运行中（${formatElapsed(startedAt, now)}）${doing}${delegated}`;
    Promise.resolve()
      .then(() => (running() ? io.progress?.(text) : undefined))
      .catch((err) => logger.debug('Progress note failed', { taskId: task.id, error: String(err) }));
  };
}

/**
 * The onAssistantText handler of one task, shared by its attempts: the orchestrator's own words on a step that
 * calls a tool, in its bot's voice, at most COMMENTARY_MAX times and COMMENTARY_MAX_CHARS each. Text with a WECHAT
 * marker is answer text and stays with the result. Text with any tool-call markup is dropped whole, since stripping
 * the tags would leave what the call carried. Words the task has already said (a retry repeating them) are not sent
 * again. The task must still be running when a note is handed to io.commentary, not only when it is chosen.
 * Commentary never goes to the outbox, and a failed one is only logged.
 */
function commentaryNotes(task: TaskRow, io: TaskIO, running: () => boolean) {
  const said = new Set<string>();
  return ({ messageId, text }: { messageId: string; text: string }): void => {
    const note = text.trim();
    if (!io.commentary || !note || note.match(ANY_MARKER) || DSML_MARK.test(note)) return;
    const bounded = note.length > COMMENTARY_MAX_CHARS ? `${note.slice(0, COMMENTARY_MAX_CHARS).trimEnd()}…` : note;
    if (said.size >= COMMENTARY_MAX || said.has(bounded) || !running()) return;
    said.add(bounded);
    Promise.resolve()
      .then(() => (running() ? io.commentary?.(`${resolveBot(task.bot_id).bot.prefix}${bounded}`) : undefined))
      .catch((err) => logger.debug('Commentary failed', { taskId: task.id, messageId, error: String(err) }));
  };
}

/**
 * Run one task in a fresh orchestrator session and report the outcome. The task runs on the chat's /model,
 * else its bot's model, else the orchestrator agent's own. A model whose gateway fails or goes silent gets
 * one retry on fallbackModel, behind another gateway, and the user hears only the final outcome.
 * Repeated upstream failures open that gateway's breaker: later tasks start on the fallback until the
 * cooldown is over, and the user gets one notice when that begins. While it runs, what the orchestrator writes on
 * a step that calls a tool reaches the user best-effort (commentaryNotes); the bridge's own progress notes
 * (progressNotes) are diagnostics behind OWB_PROGRESS_ENABLED.
 * A task that was finished elsewhere meanwhile (/stop, restart) is not reported again.
 */
export async function runTask(db: StateDb, task: TaskRow, io: TaskIO, signal: AbortSignal): Promise<void> {
  let result: QueryResult;
  // The last attempt's model; undefined runs the orchestrator agent's own model, taken to be DEFAULT_MODEL.
  let model: string | undefined;
  let attempts = 0;
  let usedFallback = false;
  let notice = '';
  // What the sessions of every attempt used; undefined while OpenCode has reported nothing.
  let usage: TaskUsage | undefined;
  /** The prompt counts its cache reads and writes, the completion its reasoning. */
  const addUsage = (u: Usage | undefined): void => {
    if (!u) return;
    const sum = usage ?? { input: 0, output: 0, cost: 0 };
    usage = {
      input: sum.input + u.input + u.cacheRead + u.cacheWrite,
      output: sum.output + u.output + u.reasoning,
      cost: sum.cost + u.cost,
    };
  };
  // Where the task runs, and so where the files it sends must be.
  let workspace = '';
  try {
    pruneAttachments();
    const user = db.getUser(task.account_id);
    // A project task opens at the repo root, so OpenCode loads that repo's AGENTS.md and opencode.json.
    workspace = task.project_dir || user?.workspace || loadConfig().workingDirectory;
    const attachments = resolveAttachments(db, task);
    // /stop and restarts finish the task elsewhere; only a failing or silent model is worth a second try.
    const running = () => !signal.aborted && db.getTask(task.id)?.status === 'running';
    const onProgress = progressEnabled() ? progressNotes(task, io, running) : undefined;
    const onAssistantText = commentaryNotes(task, io, running);
    const attempt = async (next: string | undefined, retry: boolean): Promise<QueryResult> => {
      model = next;
      attempts++;
      const out = await openCodeQuery({
        prompt: composePrompt(db, task, workspace, attachments, retry),
        cwd: workspace,
        agent: task.lane === 'read' ? ORCHESTRATOR_READ_AGENT : ORCHESTRATOR_AGENT,
        model: next,
        title: `微信 #${task.seq}${retry ? ' 重试' : ''}: ${clip(task.input, 20)}`,
        files: attachments.paths,
        signal,
        onPermission: (request) => decidePermission(request, io),
        onSession: (sessionId) => db.setTaskSession(task.id, sessionId),
        onProgress,
        onAssistantText,
      });
      addUsage(out.usage);
      return out;
    };
    /** Counts the last attempt's upstream failure against its gateway; true when that opens the breaker. */
    const recordFailure = (): boolean => {
      const provider = providerOf(model ?? DEFAULT_MODEL);
      const opened = breaker.recordFailure(provider);
      if (opened) {
        logger.warn('Gateway breaker opened', { taskId: task.id, seq: task.seq, provider, threshold: breaker.threshold });
      }
      return opened;
    };

    // /model overrides every bot; with neither, the session gets no model and routing assumes DEFAULT_MODEL.
    const primary = user?.model ?? resolveBot(task.bot_id).bot.model;
    const primaryProvider = providerOf(primary ?? DEFAULT_MODEL);
    const fallback = fallbackModel(primary ?? DEFAULT_MODEL);
    // While the primary's breaker is open, tasks start on the fallback; after the cooldown they try the primary again.
    usedFallback = fallback !== undefined && breaker.isOpen(primaryProvider);
    if (usedFallback) {
      logger.warn('Gateway breaker open, skipping primary model', {
        taskId: task.id,
        seq: task.seq,
        provider: primaryProvider,
        model: fallback,
      });
    }
    result = await attempt(usedFallback ? fallback : primary, false);
    if (result.upstream && running()) {
      const opened = recordFailure();
      if (!usedFallback && fallback) {
        logger.warn('retry with fallback model', {
          taskId: task.id,
          seq: task.seq,
          sessionId: result.sessionId,
          model: fallback,
          errorKind: result.errorKind,
          error: result.error,
        });
        // Only the failure that opens the breaker carries the notice, so the user hears it once per outage.
        if (opened) notice = `⚠️ ${primaryProvider} 连续 ${breaker.threshold} 次失败，已切到备用模型 ${fallback}（后续任务自动跳过该网关，稍后自动恢复）`;
        usedFallback = true;
        result = await attempt(fallback, true);
        if (result.upstream && running()) recordFailure();
        if (result.error && !result.interrupted) result.error = `备用模型重试后仍失败：${result.error}`;
      }
    }
    if (!result.error) breaker.recordSuccess(providerOf(model ?? DEFAULT_MODEL));
  } catch (err) {
    // openCodeQuery reports its own failures; this covers preparing the prompt.
    result = { text: '', sessionId: '', error: err instanceof Error ? err.message : String(err) };
  }

  const threshold = taskWarnTokens();
  if (usage && usage.input >= threshold) {
    logger.warn('Task input tokens high', { taskId: task.id, seq: task.seq, input: usage.input, threshold });
  }

  // Queued ahead of the outcome, so the user reads the notice before the answer.
  if (notice) db.addNotice(task.account_id, notice);
  if (result.interrupted) {
    if (!db.finishTask(task.id, 'interrupted', { error: result.error, usage })) return;
  } else if (result.error) {
    if (!db.finishTask(task.id, 'failed', { error: clip(result.error, MAX_ERROR_CHARS), usage })) return;
    // Also ahead of the outcome, so the flush in deliver sends it now.
    maybeAlertFailures(db, task.account_id);
  } else {
    const output = parseOrchestratorOutput(result.text);
    const { files, dropped } = checkTaskFiles(output.files, workspace);
    for (const { path, reason } of dropped) logger.warn('Attachment dropped', { taskId: task.id, path, reason });
    // The user hears how many did not come; the log says which and why.
    const note = dropped.length ? `（有 ${dropped.length} 个附件未发送：路径不在工作区、类型/大小不支持或超过 ${MAX_FILES} 个）` : '';
    const reply = [output.reply, note].filter(Boolean).join('\n');
    if (!db.finishTask(task.id, 'done', { result: reply, summary: output.summary, handoff: output.handoff, files, usage })) return;
    try {
      appendMemory(memoryPath(task.account_id, resolveBot(task.bot_id).bot), output.memory);
    } catch (err) {
      logger.warn('Failed to update memory', { taskId: task.id, error: String(err) });
    }
  }

  const finished = db.getTask(task.id)!;
  logger.info('Task finished', {
    taskId: task.id,
    seq: task.seq,
    bot: task.bot_id,
    status: finished.status,
    sessionId: result.sessionId,
    model: model ?? DEFAULT_MODEL,
    attempts,
    fallback: usedFallback,
    errorKind: result.errorKind,
    usage,
  });
  await io.deliver(finished);
}
