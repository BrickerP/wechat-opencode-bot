import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, type Stats } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maybeAlertFailures } from './alerts.js';
import { saveMemories, searchMemories, type Memory } from './agentmemory.js';
import { defaultBot, isReadOnlyBot, loadBots, resolveBot, type Bot } from './bots.js';
import { loadConfig } from './config.js';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';
import { breaker, checkFallback, DEFAULT_MODEL, providerOf, type FallbackCheck } from './model-routing.js';
import { openCodeQuery, type FollowUps, type PermissionDecision, type PermissionRequest, type QueryResult, type Usage } from './opencode/provider.js';
import { isRealPathInside } from './projects.js';
import { maxTasks, type StateDb, type TaskRow, type TaskStatus, type TaskUsage } from './tasks/db.js';
import { prepareWorkspace } from './tasks/worktree.js';

/** OpenCode agent that plans each task and delegates the work to subagent sessions. */
export const ORCHESTRATOR_AGENT = 'wechat-orchestrator';
/** A read-only bot can delegate only to wechat-explore. */
export const ORCHESTRATOR_READ_AGENT = 'wechat-orchestrator-read';

const RECENT_TASKS = 8;
const MAX_SUMMARY_CHARS = 100;
const MAX_ERROR_CHARS = 200;


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
   * What the orchestrator tells the user while it works (its wechat_reply calls), ahead of its answer. Best-effort: a
   * failed one is dropped, never queued for retry, and one still waiting to go out when the task finishes is not sent.
   */
  commentary?(text: string): void | Promise<void>;
  onPermission?(request: PermissionRequest): Promise<PermissionDecision>;
  /** The task reads memories but saves none: --simulate, so smoke tests and evaluations leave the owner's store alone. */
  readOnlyMemory?: boolean;
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

/**
 * The task's own images, or with carry and none of its own those of the task right before it, when that came
 * within CARRY_OVER_MS. A task that continues a session does not carry: that session has seen them already.
 */
function resolveAttachments(db: StateDb, task: TaskRow, carry = true): Attachments {
  const own = attachmentPaths(task.id);
  if (own.length || !carry) return { paths: own, carried: false };
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
/**
 * The work-activity collector beside this build: scripts/ next to dist/, in a checkout and in an installed release.
 * <context> gives its absolute path, since a task's session opens in the user's workspace, not here.
 */
export const WORK_ACTIVITY_COLLECTOR = fileURLToPath(new URL('../scripts/collect-work-activity.mjs', import.meta.url));
/**
 * This build's CLI: `node <it> --session <id>` prints a session's last answer and its subagents' reports, read only.
 * <context> gives it as session-reader, so a follow-up can open an earlier task's session by the id <recent_tasks> shows.
 */
export const SESSION_READER = fileURLToPath(new URL('./main.js', import.meta.url));

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  done: '完成',
  failed: '失败',
  interrupted: '已中断',
};

/** How the orchestrator said a done task ended, when it was not plain done (wechat_report's status). */
const OUTCOME_LABEL: Record<string, string> = { needs_input: '等你回复', blocked: '受阻', failed: '没做成' };

/** The task's status as /tasks, <recent_tasks> and the task router show it: "完成·等你回复" for a done task that asked. */
export const taskStatusLabel = (task: TaskRow): string =>
  task.status === 'done' && task.outcome && OUTCOME_LABEL[task.outcome]
    ? `${STATUS_LABEL.done}·${OUTCOME_LABEL[task.outcome]}`
    : STATUS_LABEL[task.status];

/** Oldest first. */
function formatRecentTasks(tasks: TaskRow[], defaultBotId: string): string {
  if (!tasks.length) return '(暂无)';
  return tasks
    .map((t, i) => {
      // The stored input has its "@alias" stripped; the project id keeps that part of the message.
      const project = t.project_id ? ` @${t.project_id}` : '';
      // An id the orchestrator can have the session reader open, to recall what the task did.
      const session = t.session_id ? `（会话 ${t.session_id}）` : '';
      // Rows from before bots, like messages that named none, went to the default bot.
      const to = t.bot_id && t.bot_id !== defaultBotId ? `（对 ${t.bot_id}）` : '';
      const lines = [
        `#${t.seq} ${formatTime(t.created_at)} [${taskStatusLabel(t)}]${project}${session} 用户${to}: ${clip(t.input, MAX_INPUT_CHARS)}`,
      ];
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
  return `<persona>\n${lines.join('\n')}\n</persona>`;
}

/** The owner's memories that matched the message, best first, each with the id an update names and its date. */
function formatMemories(memories: Memory[]): string {
  if (!memories.length) return '(暂无)';
  return memories.map((m) => `- [${m.id}${m.date ? ` ${m.date}` : ''}] ${m.text}`).join('\n');
}

/** The task's message as the prompt gives it: an image alone comes with the request to look at it. */
const messageText = (task: TaskRow): string => (task.input === IMAGE_ONLY_INPUT ? `${IMAGE_ONLY_INPUT} 请分析这张图片` : task.input);

/** The attachment lines of <context>. */
const attachmentLines = (attachments: Attachments): string[] =>
  attachments.paths.length
    ? [`attachments${attachments.carried ? ' (from the previous message)' : ''}:`, ...attachments.paths.map((path) => `- ${path}`)]
    : [];

/** What composePrompt adds to the chat's own context. */
export interface PromptOptions {
  /** An earlier session for this task gave up, possibly after its subagents had changed something. */
  retry?: boolean;
  /** The owner's memories that matched the message; every attempt of a task shows the same ones. */
  memories?: Memory[];
}

/** A new orchestrator session starts empty: everything it knows about the chat comes from this prompt. */
export function composePrompt(
  db: StateDb,
  task: TaskRow,
  workspace: string,
  attachments: Attachments,
  { retry = false, memories = [] }: PromptOptions = {},
): string {
  const bots = loadBots();
  const { bot, all } = resolveBot(task.bot_id, bots);
  const context = [`workspace: ${workspace}`, `time: ${formatTime(Date.now())} (Asia/Shanghai)`, `task: #${task.seq}`];
  if (task.worktree_dir) {
    const peer = task.workspace_peer && db.getTask(task.workspace_peer);
    context.push(`worktree: ${workspace}. Another task${peer ? ` #${peer.seq}` : ''} used the original checkout (${task.project_dir}). ` +
      `Keep all work here; never change the original checkout. HEAD starts detached: before editing run git switch -c wechat-${task.seq} ` +
      'if still detached, commit changes on your branch, and name the branch in your reply.');
  }
  if (existsSync(WORK_ACTIVITY_COLLECTOR)) context.push(`collector: ${WORK_ACTIVITY_COLLECTOR}`);
  if (existsSync(SESSION_READER)) context.push(`session-reader: node ${SESSION_READER} --session`);
  if (retry) {
    context.push('retry: an earlier attempt at this task stopped midway and may have made changes; check the current state before redoing anything that writes');
  }
  context.push(...attachmentLines(attachments));
  const recent = db.recentTasks(task.account_id, RECENT_TASKS, task.id).reverse();
  // The repo's own instructions reach the session through OpenCode, never through this prompt.
  const project = task.project_id
    ? [`<project>\nid: ${task.project_id}\ndir: ${task.worktree_dir ?? task.project_dir}\n${PROJECT_PRECEDENCE}\n</project>`]
    : [];
  return [
    `<context>\n${context.join('\n')}\n</context>`,
    formatPersona(bots, bot, all),
    ...project,
    `<memory>\n${formatMemories(memories)}\n</memory>`,
    `<recent_tasks>\n${formatRecentTasks(recent, defaultBot(bots).id)}\n</recent_tasks>`,
    `<user_message>\n${messageText(task)}\n</user_message>`,
  ].join('\n\n');
}

/**
 * The next turn of a session for a follow-up of the task that ran there. The session holds that work, its persona
 * and project included, so only what is new comes: the time and task number, the attachments, the memories that
 * match the new message, and the message.
 */
export function composeContinuation(task: TaskRow, attachments: Attachments, memories: Memory[] = []): string {
  const context = [`time: ${formatTime(Date.now())} (Asia/Shanghai)`, `task: #${task.seq}`, ...attachmentLines(attachments)];
  return [
    `<context>\n${context.join('\n')}\n</context>`,
    `<memory>\n${formatMemories(memories)}\n</memory>`,
    `<user_message>\n${messageText(task)}\n</user_message>`,
    'This message follows up on the work in this session. End your turn with wechat_report, as before.',
  ].join('\n\n');
}

/** The next turn of a session after an attempt that stopped: what stopped it, and to check before redoing anything. */
export function composeRetry(error: string): string {
  return [
    `<retry>\nYour previous attempt stopped: ${clip(error, MAX_ERROR_CHARS)}\n</retry>`,
    'It may already have changed files or started work, and its last step may be cut off. Check the current state, ' +
      'then continue from where it stopped instead of starting over. End your turn with wechat_report, as before.',
  ].join('\n\n');
}

/** One more turn for a turn that ended without wechat_report, the only answer that reaches the user. */
const REPORT_NUDGE =
  'Your turn ended without calling wechat_report, so the user got nothing. Call wechat_report now, once, with your ' +
  'whole answer for the user, and end the turn.';

/**
 * What a follow-up or /steer sends into a running task's session. The session has the task's prompt already; the
 * frame tells the orchestrator that this changes that task, and that only its last answer reaches the user.
 */
export function composeSteer(text: string): string {
  return [
    `<user_correction>\n${text}\n</user_correction>`,
    'The user sent this while the task runs. It changes the task in <user_message>: apply it from here on, ' +
      'and check work already done or delegated where it matters. Only your last wechat_report reaches the user, so if you ' +
      'have already reported, call wechat_report again with the whole answer.',
  ].join('\n\n');
}

// ── output ───────────────────────────────────────────────────────────────

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
/** The orchestrator's wechat_reply calls reach the user this many times per task, over all its attempts. */
const COMMENTARY_MAX = 3;
/** A longer one is cut to this many characters. */
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
  const eta = median * Math.max(1, Math.floor(ahead / maxTasks()));
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
 * The onReply handler of one task, shared by its attempts and turns: each note the orchestrator sends with
 * wechat_reply reaches the user once, in its bot's voice, at most COMMENTARY_MAX times and
 * COMMENTARY_MAX_CHARS each. Words the task has already said (a retry repeating them) are not sent again. The task must
 * still be running when a note is handed to io.commentary, not only when it is chosen. Commentary never goes to the
 * outbox, and a failed one is only logged.
 */
function commentaryNotes(task: TaskRow, io: TaskIO, running: () => boolean) {
  const said = new Set<string>();
  return ({ id, text }: { id: string; text: string }): void => {
    const note = text.trim();
    if (!io.commentary || !note) return;
    const bounded = note.length > COMMENTARY_MAX_CHARS ? `${note.slice(0, COMMENTARY_MAX_CHARS).trimEnd()}…` : note;
    if (said.size >= COMMENTARY_MAX || said.has(bounded) || !running()) return;
    said.add(bounded);
    Promise.resolve()
      .then(() => (running() ? io.commentary?.(`${resolveBot(task.bot_id).bot.prefix}${bounded}`) : undefined))
      .catch((err) => logger.debug('Commentary failed', { taskId: task.id, callId: id, error: String(err) }));
  };
}

/** The follow-ups waiting for the open tasks of this process, by task id; see joinRunningTask. */
const openTasks = new Map<string, string[]>();

/**
 * Hand a follow-up or a /steer correction to a task this process is running. The task steers it into its session at
 * the next poll, or gives it a turn of its own once the current turn has answered, so the task's one answer covers
 * it. False once the task has closed: its answer is final, and the text needs a task of its own.
 */
export function joinRunningTask(taskId: string, text: string): boolean {
  const waiting = openTasks.get(taskId);
  if (!waiting) return false;
  waiting.push(composeSteer(text));
  return true;
}

/**
 * Run one task and report the outcome. The task runs in a new orchestrator session, or, when it was created with
 * the session of the task it follows up on, as that session's next turn; a session that is gone gets replaced by a
 * new one. It runs on the chat's /model, else its bot's model, else the orchestrator agent's own. A model whose
 * gateway fails or goes silent gets one retry on OPENCODE_FALLBACK_MODEL, if the server lists it at that moment:
 * the same session switches to it and continues from where the attempt stopped, and the user hears only the final
 * outcome. Repeated upstream failures open that gateway's breaker: later tasks start on the fallback until the
 * cooldown is over, and the user gets one notice when that begins. Follow-ups that join the task while it runs
 * (joinRunningTask) go into its session. The answer is the last turn's wechat_report, whose reply, summary, files
 * and status the task records; while it runs, the orchestrator's wechat_reply notes reach the user best-effort
 * (commentaryNotes), and the bridge's own progress notes (progressNotes) are diagnostics behind OWB_PROGRESS_ENABLED.
 * Memory lives in the owner's agentmemory engine: the memories that match the message go into the task's prompt,
 * and a done task's reported memory facts are saved there, unless io.readOnlyMemory (agentmemory.ts).
 * A task that was finished elsewhere meanwhile (/stop, restart) is not reported again.
 */
export async function runTask(db: StateDb, task: TaskRow, io: TaskIO, signal: AbortSignal): Promise<void> {
  // Open for follow-ups from the start: nothing is awaited before this, so none falls between the claim and here.
  const waiting: string[] = [];
  openTasks.set(task.id, waiting);
  const followUps: FollowUps = {
    take: () => waiting.splice(0),
    close: () => {
      if (waiting.length) return false;
      openTasks.delete(task.id);
      return true;
    },
  };
  try {
    if (task.workspace_peer && !await prepareWorkspace(db, task)) return;
    if (!signal.aborted && db.getTask(task.id)?.status === 'running') await runOpenTask(db, db.getTask(task.id)!, io, signal, followUps);
  } finally {
    openTasks.delete(task.id);
  }
}

async function runOpenTask(db: StateDb, task: TaskRow, io: TaskIO, signal: AbortSignal, followUps: FollowUps): Promise<void> {
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
  // The owner's memories the prompt shows, searched once before the first attempt.
  let memories: Memory[] = [];
  try {
    pruneAttachments();
    const user = db.getUser(task.account_id);
    // A project task opens at the repo root, so OpenCode loads that repo's AGENTS.md and opencode.json.
    workspace = task.worktree_dir || task.project_dir || user?.workspace || loadConfig().workingDirectory;
    // The session the work runs in: the one this task continues, if any, then the one its last attempt ran in.
    let sessionId = task.session_id ?? undefined;
    const attachments = resolveAttachments(db, task, sessionId === undefined);
    // An image alone has no words to search with.
    memories = await searchMemories(task.input === IMAGE_ONLY_INPUT ? '' : task.input);
    // /stop and restarts finish the task elsewhere; only a failing or silent model is worth a second try.
    const running = () => !signal.aborted && db.getTask(task.id)?.status === 'running';
    const onProgress = progressEnabled() ? progressNotes(task, io, running) : undefined;
    const onReply = commentaryNotes(task, io, running);
    const query = (prompt: string, next: string | undefined, session: string | undefined, retry: boolean) =>
      openCodeQuery({
        prompt,
        cwd: workspace,
        agent: isReadOnlyBot(task.bot_id) ? ORCHESTRATOR_READ_AGENT : ORCHESTRATOR_AGENT,
        // A continued session switches to this attempt's model; the agent's own counts as DEFAULT_MODEL there.
        model: session ? next ?? DEFAULT_MODEL : next,
        sessionId: session,
        title: `微信 #${task.seq}${retry ? ' 重试' : ''}: ${clip(task.input, 20)}`,
        // A retry's session has the attachments already.
        files: session && retry ? undefined : attachments.paths,
        signal,
        onPermission: (request) => decidePermission(request, io),
        onSession: (id) => db.setTaskSession(task.id, id),
        onProgress,
        onReply,
        followUps,
        reportNudge: REPORT_NUDGE,
      });
    /**
     * One attempt on model next. A retry (failed set) continues the failed attempt's session and a follow-up task the
     * session it was created with, each with a short prompt; without a session to continue, or when it is gone, a new
     * session gets the whole prompt.
     */
    const attempt = async (next: string | undefined, failed?: QueryResult): Promise<QueryResult> => {
      model = next;
      attempts++;
      if (sessionId) {
        const prompt = failed ? composeRetry(failed.error ?? '') : composeContinuation(task, attachments, memories);
        const out = await query(prompt, next, sessionId, Boolean(failed));
        addUsage(out.usage);
        if (!out.gone) return out;
        logger.warn('Session to continue is gone; starting a new one', { taskId: task.id, seq: task.seq, sessionId });
      }
      // The row as it is now: its input has the follow-ups that joined it, so the ones still waiting to be steered in
      // are dropped rather than sent twice.
      followUps.take();
      const current = db.getTask(task.id) ?? task;
      const out = await query(composePrompt(db, current, workspace, attachments, { retry: Boolean(failed), memories }), next, undefined, Boolean(failed));
      sessionId = out.sessionId || undefined;
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
    /** The fallback as the server lists it now; a configured one it does not list is logged. */
    const checkNow = async (): Promise<FallbackCheck> => {
      const check = await checkFallback();
      if (check.state === 'missing') {
        logger.warn('Fallback model unavailable', { taskId: task.id, seq: task.seq, model: check.configured, reason: check.reason });
      }
      return check;
    };
    // While the primary's breaker is open, tasks start on the fallback; after the cooldown they try the primary
    // again. Without a usable fallback they stay on the primary: an open breaker must not send them nowhere.
    const opening = breaker.isOpen(primaryProvider) ? await checkNow() : undefined;
    let fallback = opening?.state === 'ok' ? opening.model : undefined;
    usedFallback = fallback !== undefined;
    if (usedFallback) {
      logger.warn('Gateway breaker open, skipping primary model', {
        taskId: task.id,
        seq: task.seq,
        provider: primaryProvider,
        model: fallback,
      });
    }
    result = await attempt(usedFallback ? fallback : primary);
    if (result.upstream && running()) {
      const opened = recordFailure();
      const check = usedFallback ? undefined : await checkNow();
      fallback = check?.state === 'ok' ? check.model : undefined;
      if (fallback) {
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
        result = await attempt(fallback, result);
        if (result.upstream && running()) recordFailure();
        if (result.error && !result.interrupted) result.error = `备用模型重试后仍失败：${result.error}`;
      } else if (check?.state === 'missing' && result.error && !result.interrupted) {
        // Up front, so the clipped error still says why there was no retry.
        result.error = `未重试：备用模型 ${check.configured} ${check.reason}，请更新 OPENCODE_FALLBACK_MODEL。${result.error}`;
      }
    }
    if (!result.error) breaker.recordSuccess(providerOf(model ?? DEFAULT_MODEL));
  } catch (err) {
    // openCodeQuery reports its own failures; this covers preparing the prompt.
    result = { sessionId: '', error: err instanceof Error ? err.message : String(err) };
  }

  const threshold = taskWarnTokens();
  if (usage && usage.input >= threshold) {
    logger.warn('Task input tokens high', { taskId: task.id, seq: task.seq, input: usage.input, threshold });
  }

  // Queued ahead of the outcome, so the user reads the notice before the answer.
  if (notice) db.addNotice(task.account_id, notice);
  let saving: Promise<void> | undefined;
  if (result.interrupted) {
    if (!db.finishTask(task.id, 'interrupted', { error: result.error, usage })) return;
  } else if (result.error) {
    if (!db.finishTask(task.id, 'failed', { error: clip(result.error, MAX_ERROR_CHARS), usage })) return;
    // Also ahead of the outcome, so the flush in deliver sends it now.
    maybeAlertFailures(db, task.account_id);
  } else {
    // openCodeQuery gives every query that did not fail the report of its last turn.
    const report = result.report!;
    const { files, dropped } = checkTaskFiles(report.files, workspace);
    for (const { path, reason } of dropped) logger.warn('Attachment dropped', { taskId: task.id, path, reason });
    // The user hears how many did not come; the log says which and why.
    const note = dropped.length ? `（有 ${dropped.length} 个附件未发送：路径不在工作区、类型/大小不支持或超过 ${MAX_FILES} 个）` : '';
    const reply = [report.reply, note].filter(Boolean).join('\n');
    const summary = clip(report.summary || report.reply, MAX_SUMMARY_CHARS);
    if (!db.finishTask(task.id, 'done', { result: reply, summary, files, usage, outcome: report.status })) return;
    if (!io.readOnlyMemory) {
      // Only a memory the prompt showed whole may be replaced. The writes run beside the delivery, so the reply never
      // waits for the memory engine.
      const updatable = new Set(memories.filter((m) => m.full).map((m) => m.id));
      saving = saveMemories(report.memory, updatable).then((writes) => {
        if (writes.saved || writes.updated || writes.failed) logger.info('Memory written', { taskId: task.id, seq: task.seq, ...writes });
      });
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
  try {
    await io.deliver(finished);
  } finally {
    await saving;
  }
}
