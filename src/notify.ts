import { setTimeout as sleep } from 'node:timers/promises';
import { defaultBot, loadBots } from './bots.js';
import { logger } from './logger.js';
import { isImageFile, resultText, type TaskIO } from './orchestrator.js';
import type { PermissionRequest } from './opencode/provider.js';
import type { PermissionBroker } from './permission.js';
import { openStateDb, type StateDb, type TaskRow } from './tasks/db.js';
import { loadLatestAccount } from './wechat/accounts.js';
import { WeChatApi } from './wechat/api.js';
import { createSender } from './wechat/send.js';

type Sender = ReturnType<typeof createSender>;

const MAX_MESSAGE_CHARS = 2048;
/** Pause between the chunks of one send, so WeChat keeps them in order. */
const CHUNK_GAP_MS = 200;
/** Failed-send backoff: 30s, 2m, 10m, then 1h. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000] as const;
const backoffMs = (attempts: number): number => BACKOFF_MS[Math.min(Math.max(attempts, 1) - 1, BACKOFF_MS.length - 1)];

/** WeChat caps message length; split on a line break when one is not too far back. */
export function splitMessage(text: string, maxLen: number = MAX_MESSAGE_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let at = rest.lastIndexOf('\n', maxLen);
    if (at < maxLen * 0.3) at = maxLen;
    chunks.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The task as an ask names it, such as "任务 #3（eng）"; rows from before bots went to the default bot. */
const taskLabel = (task: TaskRow): string => `任务 #${task.seq}（${task.bot_id ?? defaultBot(loadBots()).id}）`;

/** The paths of the files a done task sends after its text; [] when it has none. */
function attachments(task: TaskRow): string[] {
  try {
    const files: unknown = JSON.parse(task.files ?? '[]');
    return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : [];
  } catch {
    return [];
  }
}

/** `ahead` asks wait before this one: y/n answers them first, so the ask says so. */
function formatPermissionRequest(request: PermissionRequest, label: string, ahead: number): string {
  const lines = [`🔐 ${label}请求权限：`, `操作: ${request.action}`, `资源: ${request.resources.join(', ').slice(0, 800) || '(无)'}`];
  if (request.message) lines.push(`说明: ${request.message}`);
  lines.push('', '回复 y 允许，n 拒绝', '(120秒未回复自动拒绝)');
  if (ahead) lines.push(`⚠️ 前面还有 ${ahead} 个权限请求未回复，y/n 先回复最早的那个`);
  return lines.join('\n');
}

/**
 * Everything goes to the user's latest context token: iLink only lets the bot speak inside a
 * conversation the user opened, and every inbound message refreshes it.
 */
export function createNotifier(db: StateDb, api: WeChatApi, sender: Sender) {
  const chains = new Map<string, Promise<unknown>>();

  /** One send at a time per account keeps chunks and notices in order. */
  function serial<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
    const next = (chains.get(accountId) ?? Promise.resolve()).then(fn);
    chains.set(accountId, next.catch(() => undefined));
    return next;
  }

  async function sendChunks(accountId: string, chunks: Array<{ text: string; onSent?: () => void }>): Promise<boolean> {
    if (!chunks.length) return true;
    const user = db.getUser(accountId);
    if (!user?.context_token) return false;
    for (const [i, chunk] of chunks.entries()) {
      if (i > 0) await sleep(CHUNK_GAP_MS);
      try {
        await sender.sendText(user.wechat_user_id, user.context_token, chunk.text);
      } catch (err) {
        logger.warn('WeChat send failed', { accountId, error: String(err) });
        return false;
      }
      chunk.onSent?.();
    }
    return true;
  }

  /**
   * The outbox: queue the outcome of finished tasks not yet reported, then send due notices
   * oldest first. A failed notice gets an exponential backoff and blocks later notices, so a
   * broken token does not hot-loop the iLink API.
   */
  function flush(accountId: string): Promise<boolean> {
    return serial(accountId, async () => {
      try {
        db.queueUnnotified(accountId, (task) => splitMessage(resultText(task)));
        for (;;) {
          const notice = db.pendingHead(accountId);
          if (!notice) return true;
          // A notice in backoff blocks later notices, so chunks never overtake each other.
          if ((notice.next_at ?? 0) > Date.now()) return false;
          const delivered = await sendChunks(accountId, [
            { text: notice.text, onSent: () => db.markNoticeDelivered(notice.id) },
          ]);
          if (!delivered) {
            const attempts = (notice.attempts ?? 0) + 1;
            db.markNoticeFailed(notice.id, attempts, Date.now() + backoffMs(attempts));
            return false;
          }
        }
      } catch (err) {
        // Callers fire and forget; a database error must not become an unhandled rejection.
        logger.warn('Outbox flush failed', { accountId, error: String(err) });
        return false;
      }
    });
  }

  /** Durable send: stored before sending, so a failed send goes out with the next inbound message. */
  function send(accountId: string, text: string): Promise<boolean> {
    for (const chunk of splitMessage(text)) db.addNotice(accountId, chunk);
    return flush(accountId);
  }

  /** Best-effort send for command replies, acks and permission asks; nothing is kept for retry. */
  function reply(accountId: string, text: string): Promise<boolean> {
    return serial(accountId, () => sendChunks(accountId, splitMessage(text).map((chunk) => ({ text: chunk }))));
  }

  /**
   * A done task's files, once its text is out. Best-effort: they never go in the outbox, so a file that
   * fails to upload or send is only logged, never retried. They do not hold the per-account chain, so an
   * upload does not delay acks or permission asks, which may come between the text and the files.
   */
  async function sendFiles(accountId: string, taskId: string, files: string[]): Promise<void> {
    const user = db.getUser(accountId);
    if (!user?.context_token) return;
    for (const path of files) {
      await sleep(CHUNK_GAP_MS);
      try {
        const send = isImageFile(path) ? sender.sendImage : sender.sendFile;
        await send(user.wechat_user_id, user.context_token, path);
      } catch (err) {
        logger.warn('Attachment send failed', { accountId, taskId, path, error: String(err) });
      }
    }
  }

  /**
   * Daemon IO: outcomes go out through the outbox, then a done task's files; commentary and progress notes are
   * best-effort, queued behind what this account is already sending; permission asks wait for the user's y/n.
   */
  function taskIO(task: TaskRow, broker: PermissionBroker): TaskIO {
    const accountId = task.account_id;
    /**
     * A note on the running task, dropped if the task has finished by the time its turn comes. The outcome goes out
     * on the same per-account chain, so a note never follows it.
     */
    const note = (text: string): Promise<boolean> =>
      serial(accountId, async () => {
        if (db.getTask(task.id)?.status !== 'running') return false;
        return sendChunks(accountId, splitMessage(text).map((chunk) => ({ text: chunk })));
      });
    return {
      async deliver(finished) {
        const sent = await flush(accountId);
        const files = attachments(finished);
        if (!files.length) return;
        // A file must not come before its text: while the text waits in the outbox, the files are dropped.
        if (!sent) {
          logger.warn('Attachments not sent: the text is still pending', { accountId, taskId: finished.id, files: files.length });
          return;
        }
        await sendFiles(accountId, finished.id, files);
      },
      // Commentary and progress notes are best-effort: one that fails to send is not worth a retry.
      async commentary(text) {
        await note(text);
      },
      async progress(text) {
        await note(text);
      },
      async onPermission(request) {
        const label = taskLabel(task);
        // Register before asking so a quick answer cannot arrive ahead of the pending entry.
        const answer = broker.createPending(accountId, request.action, request.resources.join(', '), label);
        const ahead = broker.asksAhead(accountId, answer);
        // A full queue denied it already: showing it would only point the next y/n at another task's ask.
        if (ahead < 0) {
          await reply(accountId, `⚠️ ${label}的权限请求过多（已有 3 个在等），这次已自动拒绝。`);
          return 'reject';
        }
        if (!(await reply(accountId, formatPermissionRequest(request, label, ahead)))) {
          // Only this ask: the others were shown and still wait for their answers.
          broker.rejectPending(accountId, answer);
          return 'reject';
        }
        return (await answer) ? 'once' : 'reject';
      },
    };
  }

  return { flush, send, reply, taskIO };
}

export type Notifier = ReturnType<typeof createNotifier>;

/** --notify: 0 sent; 2 no_context_token and 3 send_failed keep the text pending for the next inbound message. */
export async function runNotify(text: string): Promise<number> {
  const account = loadLatestAccount();
  if (!account) {
    console.error('未找到账号，请先运行 node dist/main.js --setup');
    return 1;
  }
  const db = openStateDb();
  const api = new WeChatApi(account.botToken, account.baseUrl);
  const notifier = createNotifier(db, api, createSender(api, account.accountId));
  const hasToken = Boolean(db.getUser(account.accountId)?.context_token);

  if (await notifier.send(account.accountId, text)) {
    console.log('sent');
    return 0;
  }
  console.error(`${hasToken ? 'send_failed' : 'no_context_token'}: 已存入待发送队列，收到下一条微信消息时补发`);
  return hasToken ? 3 : 2;
}
