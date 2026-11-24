// Which open task an inbound message belongs to, if any. A message that opens with a prefix ("@bot", "@project",
// "@base", "新话题") is new work and never comes here; any other one goes to one short call of a fast model, with no
// session and no tools, while the chat has open tasks.
import { defaultBot, loadBots } from './bots.js';
import { stopOneTask, type CommandContext } from './commands/handlers.js';
import { logger } from './logger.js';
import { DEFAULT_MODEL } from './model-routing.js';
import { generateText } from './opencode/provider.js';
import { clip, formatTime, joinRunningTask, taskStatusLabel } from './orchestrator.js';
import type { StateDb, TaskProject, TaskRow } from './tasks/db.js';

/** What a message does: new work, more input for one open task (attach), or the end of one (stop). */
export type Route = { action: 'new'; reason?: string } | { action: 'attach' | 'stop'; task: TaskRow };

/** The open tasks the router sees, newest first. */
const MAX_OPEN = 6;
/** Rows read to find MAX_OPEN of them: the tasks of one continued session count once. */
const OPEN_ROWS = 30;
/** A finished task stays open this long, while its session exists. */
const OPEN_MS = 24 * 60 * 60 * 1000;
const ROUTER_TIMEOUT_MS = 15_000;
const INPUT_CHARS = 150;
const SUMMARY_CHARS = 100;
const QUESTION_CHARS = 80;
const REASON_CHARS = 200;

const ROUTER_RULES = [
  '你是微信助手的消息分派器。判断用户发来的新消息属于下面哪个任务，还是一件新事。只输出一行 JSON，不要别的文字：',
  '- {"action":"attach","task":N}：消息接着、修正、缩小或回答任务 #N 的工作，或者指向它，如“继续”“不是 M5，是 M1”“那第二个呢”；任务的回复在问用户时，“M1”这样的简短回答也属于它。',
  '- {"action":"stop","task":N}：消息要停止或取消任务 #N。',
  '- {"action":"new"}：消息说的是别的事。',
  '在 attach 和 new 之间拿不准时，只有消息点名或明显接着那个任务的主题才选 attach。几个任务都说得通时，选列表里靠前的那个。',
  '例：任务 #32 运行中，输入是“去帮我完成最新一期周报，看一下我本地open claw session…”；新消息“更新一下 是11/16的我本人的okr周报 看下opncode session有周工作记录的”是在修正 #32 的要求，输出 {"action":"attach","task":32}。',
].join('\n');

/**
 * The tasks a message may belong to, newest first: running and queued ones, and those finished within OPEN_MS that
 * still have a session. Tasks that share a session, one conversation that follow-ups continued, show once, by the
 * newest of them.
 */
export function openTasks(db: StateDb, accountId: string, now: number = Date.now()): TaskRow[] {
  const open: TaskRow[] = [];
  const sessions = new Set<string>();
  for (const task of db.openTasks(accountId, now - OPEN_MS, OPEN_ROWS)) {
    if (task.session_id) {
      if (sessions.has(task.session_id)) continue;
      sessions.add(task.session_id);
    }
    open.push(task);
    if (open.length === MAX_OPEN) break;
  }
  return open;
}

function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return '刚刚';
  return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`;
}

/**
 * What a done task's reply asked the user, its end if it is long, so a short answer such as "M1" or "要" finds the
 * task it answers: the end of a reply the orchestrator reported as needs_input, which may list options after its
 * question, else a last line that ends with a question mark; '' when the reply asks nothing.
 */
function lastQuestion(task: TaskRow): string {
  if (task.status !== 'done' || !task.result) return '';
  const tail = (text: string) => (text.length > QUESTION_CHARS ? `…${text.slice(-QUESTION_CHARS)}` : text);
  if (task.outcome === 'needs_input') return tail(task.result.replace(/\s+/g, ' ').trim());
  const last = task.result.trim().split('\n').at(-1)!.trim();
  return /[?？][\s"'”’」』)）]*$/.test(last) ? tail(last) : '';
}

/** One line per task: number, status, when it last changed, bot, project, what the user asked, what it did, what it asked. */
function describeTask(task: TaskRow, now: number, defaultBotId: string): string {
  const line = [
    `#${task.seq}`,
    `[${taskStatusLabel(task)}]`,
    ago(task.finished_at ?? task.started_at ?? task.created_at, now),
    `bot:${task.bot_id ?? defaultBotId}`,
    `项目:${task.project_id ?? '无'}`,
    `输入：${clip(task.input, INPUT_CHARS)}`,
    `摘要：${task.summary ? clip(task.summary, SUMMARY_CHARS) : '无'}`,
  ];
  const question = lastQuestion(task);
  if (question) line.push(`最后问用户：${question}`);
  return line.join(' ');
}

/** The router's prompt: the rules, the time, the open tasks newest first, then the message. */
export function composeRouterPrompt(message: string, tasks: TaskRow[], now: number = Date.now()): string {
  const defaultBotId = defaultBot(loadBots()).id;
  return [
    ROUTER_RULES,
    `现在：${formatTime(now)}（北京时间）`,
    `任务（最新的在前）：\n${tasks.map((task) => describeTask(task, now, defaultBotId)).join('\n')}`,
    `新消息：\n<message>\n${message}\n</message>`,
  ].join('\n\n');
}

/** The route in the model's answer: its first JSON object, naming an open task for attach and stop; anything else is new work, with the reason. */
export function parseRoute(text: string, open: TaskRow[]): Route {
  const json = /\{[^{}]*\}/.exec(text)?.[0];
  if (!json) return { action: 'new', reason: 'no JSON in the answer' };
  let out: { action?: unknown; task?: unknown };
  try {
    out = JSON.parse(json);
  } catch {
    return { action: 'new', reason: 'unparseable JSON' };
  }
  if (out.action === 'new') return { action: 'new' };
  const task = open.find((t) => t.seq === Number(out.task));
  if (out.action === 'attach' && task) return { action: 'attach', task };
  if (out.action === 'stop' && task) return { action: 'stop', task };
  return { action: 'new', reason: out.action === 'attach' || out.action === 'stop' ? 'the task is not open' : 'unknown action' };
}

/**
 * Where a message that no prefix settled goes. Without open tasks it is new work, and nothing is called; otherwise
 * DEFAULT_MODEL decides in one call. A failed call, a timeout or an answer that names no open task is new work too.
 * message is the input its task would get: "[图片]" for an image, "[语音] …" for a voice message. Every decision is
 * logged with its latency, never with the message.
 */
export async function routeToTask(db: StateDb, accountId: string, message: string, timeoutMs = ROUTER_TIMEOUT_MS): Promise<Route> {
  const open = openTasks(db, accountId);
  if (!open.length) return { action: 'new' };
  const startedAt = Date.now();
  let route: Route;
  try {
    const answer = await generateText(composeRouterPrompt(message, open, startedAt), DEFAULT_MODEL, AbortSignal.timeout(timeoutMs));
    route = parseRoute(answer, open);
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    route = { action: 'new', reason: timedOut ? `no answer in ${timeoutMs} ms` : clip(String(err), REASON_CHARS) };
  }
  const fields = { action: route.action, task: route.action === 'new' ? undefined : route.task.seq, open: open.length, latencyMs: Date.now() - startedAt };
  if (route.action === 'new' && route.reason) logger.warn('Message router undecided; new task', { ...fields, reason: route.reason });
  else logger.info('Message routed', fields);
  return route;
}

/** The task to create for a message: where it runs and who answers, and the session it continues, if any. */
export interface NewTask {
  project?: TaskProject;
  botId?: string;
  continues?: string;
}

/** A follow-up runs where the conversation started, once its session is free. */
export function followUpOf(task: TaskRow): NewTask {
  return {
    project: task.project_id && task.project_dir ? { id: task.project_id, dir: task.project_dir } : undefined,
    botId: task.bot_id ?? undefined,
    continues: task.session_id ?? undefined,
  };
}

/** A message as routeMessage and the daemon read it. */
export interface Inbound {
  /** The input its task gets. */
  input: string;
  /** It carries an image, which needs a task of its own. */
  image: boolean;
  /** What routeMessage found in its text. */
  routed: { project?: TaskProject; botId: string; prefixed: boolean };
}

/** Where a message goes: settled by a reply (merged, handed over, stopped), or a task to create. */
export type Placement = { reply: string } | { task: NewTask };

/**
 * Place an inbound message. Stop ends the task it names (stopOneTask). Attach puts the words into the task while it
 * is open, merged into its input while it waits and handed to it while it runs; both are synchronous, so the task
 * cannot start or close in between. Otherwise, an image included, attach makes a task that follows it (followUpOf).
 * New work runs where routeMessage said.
 */
export async function placeMessage(ctx: CommandContext, { input, image, routed }: Inbound): Promise<Placement> {
  const { db, accountId } = ctx;
  const route: Route = routed.prefixed ? { action: 'new' } : await routeToTask(db, accountId, input);
  if (route.action === 'stop') return { reply: stopOneTask(ctx, route.task.seq) };
  const target = route.action === 'attach' ? db.getTask(route.task.id) : undefined;
  if (!target) return { task: { project: routed.project, botId: routed.botId } };
  if (!image) {
    if (db.appendTaskInput(target.id, input, ['queued'])) {
      logger.info('Message merged into a queued task', { taskId: target.id, seq: target.seq });
      return { reply: `↪️ 已合并到排队中的任务 #${target.seq}` };
    }
    if (joinRunningTask(target.id, input)) {
      db.appendTaskInput(target.id, input, ['running']);
      logger.info('Message handed to a running task', { taskId: target.id, seq: target.seq });
      return { reply: `↪️ 已追加到正在运行的任务 #${target.seq}，它会在下一个步骤采纳` };
    }
  }
  // Read again: a task that started meanwhile has a session now.
  return { task: followUpOf(db.getTask(target.id) ?? target) };
}
