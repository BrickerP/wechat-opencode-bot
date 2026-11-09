import { setTimeout as sleep } from 'node:timers/promises';
import { logger } from './logger.js';
import { resultText, type TaskIO } from './orchestrator.js';
import type { PermissionRequest } from './opencode/provider.js';
import type { PermissionBroker } from './permission.js';
import { openStateDb, type StateDb } from './tasks/db.js';
import { loadLatestAccount } from './wechat/accounts.js';
import { WeChatApi } from './wechat/api.js';
import { createSender } from './wechat/send.js';

type Sender = ReturnType<typeof createSender>;

const MAX_MESSAGE_CHARS = 2048;
/** Pause between the chunks of one send, so WeChat keeps them in order. */
const CHUNK_GAP_MS = 200;
const TYPING_KEEPALIVE_MS = 5000;
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

function formatPermissionRequest(request: PermissionRequest): string {
  const lines = ['🔧 权限请求', '', `操作: ${request.action}`, `资源: ${request.resources.join(', ').slice(0, 800) || '(无)'}`];
  if (request.message) lines.push(`说明: ${request.message}`);
  lines.push('', '回复 y 允许，n 拒绝', '(120秒未回复自动拒绝)');
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

  /** Best-effort typing indicator; returns the function that stops it. */
  function typing(accountId: string): () => void {
    const user = db.getUser(accountId);
    if (!user?.context_token) return () => {};
    const toUserId = user.wechat_user_id;
    let stopped = false;
    let ticket: string | undefined;
    let clientId: string | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;

    const stop = () => {
      clearInterval(keepalive);
      if (ticket && clientId) sender.stopTyping(toUserId, ticket, clientId).catch(() => {});
    };
    api
      .getConfig(toUserId, user.context_token)
      .then(async (config) => {
        if (stopped || !config.typing_ticket) return;
        ticket = config.typing_ticket;
        clientId = await sender.sendTyping(toUserId, ticket);
        if (stopped) return stop();
        keepalive = setInterval(() => {
          sender.sendTyping(toUserId, ticket!).catch(() => {});
        }, TYPING_KEEPALIVE_MS);
      })
      .catch((err) => logger.warn('Typing indicator failed', { error: String(err) }));

    return () => {
      stopped = true;
      stop();
    };
  }

  /** Daemon IO: outcomes go out through the outbox, permission asks wait for the user's y/n. */
  function taskIO(accountId: string, broker: PermissionBroker): TaskIO {
    return {
      async deliver() {
        await flush(accountId);
      },
      typing: () => typing(accountId),
      // Progress notes are best-effort replies: one that fails to send is not worth a retry.
      async progress(text) {
        await reply(accountId, text);
      },
      async onPermission(request) {
        // Register before asking so a quick answer cannot arrive ahead of the pending entry.
        const answer = broker.createPending(accountId, request.action, request.resources.join(', '));
        if (!(await reply(accountId, formatPermissionRequest(request)))) {
          broker.rejectPending(accountId);
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
