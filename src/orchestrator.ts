import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { DATA_DIR } from './constants.js';
import { logger } from './logger.js';
import { appendMemory, readMemory } from './memory.js';
import { openCodeQuery, type PermissionDecision, type PermissionRequest, type QueryResult } from './opencode/provider.js';
import type { StateDb, TaskRow, TaskStatus } from './tasks/db.js';

/** OpenCode agent that plans each task and delegates the work to subagent sessions. */
export const ORCHESTRATOR_AGENT = 'wechat-orchestrator';
/** A task whose model fails or goes silent gets one more attempt, in a new session, on this model. */
const FALLBACK_MODEL = process.env.OPENCODE_FALLBACK_MODEL || 'oneapi/DeepSeek-V4.1-Flash';

const RECENT_TASKS = 8;
const MAX_SUMMARY_CHARS = 100;
const MAX_ERROR_CHARS = 200;

const REPLY_MARKER = '<<<WECHAT_REPLY>>>';
const MEMORY_MARKER = '<<<WECHAT_MEMORY>>>';
const SUMMARY_MARKER = '<<<WECHAT_SUMMARY>>>';

/** How a task talks back to the user. --simulate prints instead of sending. */
export interface TaskIO {
  /** Reports a finished task; the daemon hands it to the outbox. */
  deliver(task: TaskRow): Promise<void>;
  /** Starts a typing indicator and returns the function that stops it. */
  typing?(): () => void;
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

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: '排队中',
  running: '运行中',
  done: '完成',
  failed: '失败',
  interrupted: '已中断',
};

/** Oldest first. */
function formatRecentTasks(tasks: TaskRow[]): string {
  if (!tasks.length) return '(暂无)';
  return tasks
    .map((t, i) => {
      // The stored input has its "@alias" stripped; the project id keeps that part of the message.
      const project = t.project_id ? ` @${t.project_id}` : '';
      const lines = [`#${t.seq} ${formatTime(t.created_at)} [${STATUS_LABEL[t.status]}]${project} 用户: ${clip(t.input, MAX_INPUT_CHARS)}`];
      if (t.summary) lines.push(`摘要: ${t.summary}`);
      if (t.error) lines.push(`错误: ${clip(t.error, MAX_ERROR_CHARS)}`);
      if (t.result && i >= tasks.length - REPLY_EXCERPTS) lines.push(`回复: ${clip(t.result, MAX_REPLY_CHARS)}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

/**
 * Each orchestrator session starts empty: everything it knows about the chat comes from this prompt.
 * retry: an earlier session for this task gave up, possibly after its subagents had changed something.
 */
export function composePrompt(db: StateDb, task: TaskRow, workspace: string, attachments: Attachments, retry = false): string {
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
  return [
    `<context>\n${context.join('\n')}\n</context>`,
    ...project,
    `<memory>\n${readMemory(task.account_id) || '(暂无)'}\n</memory>`,
    `<recent_tasks>\n${formatRecentTasks(recent)}\n</recent_tasks>`,
    `<user_message>\n${input}\n</user_message>`,
  ].join('\n\n');
}

// ── output ───────────────────────────────────────────────────────────────

export interface OrchestratorOutput {
  reply: string;
  memory: string[];
  summary: string;
}

/** Text from start up to the next marker position after it, or the end. */
function section(body: string, start: number, ...markers: number[]): string {
  return body.slice(start, Math.min(body.length, ...markers.filter((at) => at >= start)));
}

const trimmedLines = (text: string): string[] => text.split('\n').map((line) => line.trim());

/** Split the orchestrator's answer into the WeChat reply, new memory facts and a one-line summary. */
export function parseOrchestratorOutput(text: string): OrchestratorOutput {
  // Drafts may quote the marker; the last one starts the answer. No marker: the whole text is the reply.
  const replyAt = text.lastIndexOf(REPLY_MARKER);
  const body = replyAt === -1 ? text : text.slice(replyAt + REPLY_MARKER.length);
  const memoryAt = body.indexOf(MEMORY_MARKER);
  const summaryAt = body.indexOf(SUMMARY_MARKER);

  const reply = section(body, 0, memoryAt, summaryAt).trim();
  const memory =
    memoryAt === -1
      ? []
      : trimmedLines(section(body, memoryAt + MEMORY_MARKER.length, summaryAt))
          .map((line) => /^[-*]\s+(.+)$/.exec(line)?.[1].trim() ?? '')
          .filter(Boolean);
  const summary =
    summaryAt === -1
      ? ''
      : (trimmedLines(section(body, summaryAt + SUMMARY_MARKER.length, memoryAt)).find(Boolean) ?? '');
  return { reply, memory, summary: clip(summary || reply, MAX_SUMMARY_CHARS) };
}

// ── run ──────────────────────────────────────────────────────────────────

const EDIT_ACTION = /edit|write|patch/i;

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
  if (task.status === 'done') return task.result || 'ℹ️ 没有可回复的内容';
  if (task.status === 'failed') return `⚠️ ${label} 失败：${clip(task.error || '未知错误', MAX_ERROR_CHARS)}`;
  const reason = task.error ? `：${clip(task.error, MAX_ERROR_CHARS)}` : '';
  return `⏹ ${label} 已中断${reason}，需要的话请重新发送`;
}

/**
 * Run one task in a fresh orchestrator session and report the outcome. A model that fails or goes
 * silent gets one retry on FALLBACK_MODEL, and the user hears only the final outcome.
 * A task that was finished elsewhere meanwhile (/stop, restart) is not reported again.
 */
export async function runTask(db: StateDb, task: TaskRow, io: TaskIO, signal: AbortSignal): Promise<void> {
  const stopTyping = io.typing?.();
  let result: QueryResult;
  try {
    pruneAttachments();
    const user = db.getUser(task.account_id);
    // A project task opens at the repo root, so OpenCode loads that repo's AGENTS.md and opencode.json.
    const workspace = task.project_dir || user?.workspace || loadConfig().workingDirectory;
    const attachments = resolveAttachments(db, task);
    const attempt = (model: string | undefined, retry: boolean) =>
      openCodeQuery({
        prompt: composePrompt(db, task, workspace, attachments, retry),
        cwd: workspace,
        agent: ORCHESTRATOR_AGENT,
        model,
        title: `微信 #${task.seq}${retry ? ' 重试' : ''}: ${clip(task.input, 20)}`,
        files: attachments.paths,
        signal,
        onPermission: (request) => decidePermission(request, io),
        onSession: (sessionId) => db.setTaskSession(task.id, sessionId),
      });
    result = await attempt(user?.model ?? undefined, false);
    // /stop and restarts finish the task elsewhere; only a failing or silent model is worth a second try.
    if (result.upstream && !signal.aborted && db.getTask(task.id)?.status === 'running') {
      logger.warn('retry with fallback model', {
        taskId: task.id,
        seq: task.seq,
        sessionId: result.sessionId,
        model: FALLBACK_MODEL,
        error: result.error,
      });
      result = await attempt(FALLBACK_MODEL, true);
      if (result.error && !result.interrupted) result.error = `备用模型重试后仍失败：${result.error}`;
    }
  } catch (err) {
    // openCodeQuery reports its own failures; this covers preparing the prompt.
    result = { text: '', sessionId: '', error: err instanceof Error ? err.message : String(err) };
  } finally {
    stopTyping?.();
  }

  if (result.interrupted) {
    if (!db.finishTask(task.id, 'interrupted', { error: result.error })) return;
  } else if (result.error) {
    if (!db.finishTask(task.id, 'failed', { error: clip(result.error, MAX_ERROR_CHARS) })) return;
  } else {
    const output = parseOrchestratorOutput(result.text);
    if (!db.finishTask(task.id, 'done', { result: output.reply, summary: output.summary })) return;
    try {
      appendMemory(task.account_id, output.memory);
    } catch (err) {
      logger.warn('Failed to update memory', { taskId: task.id, error: String(err) });
    }
  }

  const finished = db.getTask(task.id)!;
  logger.info('Task finished', { taskId: task.id, seq: task.seq, status: finished.status, sessionId: result.sessionId });
  await io.deliver(finished);
}
