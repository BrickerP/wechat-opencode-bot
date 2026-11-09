import { logger } from './logger.js';

const PERMISSION_TIMEOUT = 120_000;
const GRACE_PERIOD = 15_000;
/** Asks one account may have waiting; a further ask is denied at once. */
const MAX_PENDING = 3;

export interface PendingPermission {
  toolName: string;
  toolInput: string;
  /** Names the asking task in replies, such as "任务 #3（eng）". */
  label?: string;
  /** The promise createPending returned; it also identifies the ask. */
  answer: Promise<boolean>;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type OnPermissionTimeout = (ask: PendingPermission) => void;

/**
 * Asks wait in a queue per account, so the read and write lanes can both ask: y/n answers the oldest ask,
 * the one shown first. Each ask times out on its own.
 */
export function createPermissionBroker(onTimeout?: OnPermissionTimeout) {
  const pending = new Map<string, PendingPermission[]>();
  const timedOut = new Map<string, number>(); // accountId → when its latest ask timed out

  /** Takes the ask out of its account's queue and answers it. */
  function settle(accountId: string, ask: PendingPermission, allowed: boolean): void {
    clearTimeout(ask.timer);
    const rest = (pending.get(accountId) ?? []).filter((a) => a !== ask);
    if (rest.length) pending.set(accountId, rest);
    else pending.delete(accountId);
    ask.resolve(allowed);
  }

  function createPending(accountId: string, toolName: string, toolInput: string, label?: string): Promise<boolean> {
    const asks = pending.get(accountId) ?? [];
    if (asks.length >= MAX_PENDING) {
      logger.warn('Too many pending permissions, auto-denied', { accountId, toolName, label });
      return Promise.resolve(false);
    }
    timedOut.delete(accountId); // clear any previous timeout flag
    let resolve!: (allowed: boolean) => void;
    const answer = new Promise<boolean>((r) => (resolve = r));
    const ask: PendingPermission = {
      toolName,
      toolInput,
      label,
      answer,
      resolve,
      timer: setTimeout(() => {
        logger.warn('Permission timeout, auto-denied', { accountId, toolName, label });
        timedOut.set(accountId, Date.now());
        settle(accountId, ask, false);
        onTimeout?.(ask);
      }, PERMISSION_TIMEOUT),
    };
    pending.set(accountId, [...asks, ask]);
    return answer;
  }

  /** Answers the oldest ask. */
  function resolvePermission(accountId: string, allowed: boolean): boolean {
    const ask = getPending(accountId);
    if (!ask) return false;
    settle(accountId, ask, allowed);
    logger.info('Permission resolved', { accountId, toolName: ask.toolName, label: ask.label, allowed });
    return true;
  }

  /** True for GRACE_PERIOD after an ask timed out, so a late y/n is told why nothing was waiting. */
  function isTimedOut(accountId: string): boolean {
    const at = timedOut.get(accountId);
    return at !== undefined && Date.now() - at < GRACE_PERIOD;
  }

  function clearTimedOut(accountId: string): void {
    timedOut.delete(accountId);
  }

  /** The oldest ask: the one the next y/n answers. */
  function getPending(accountId: string): PendingPermission | undefined {
    return pending.get(accountId)?.[0];
  }

  /** How many asks wait ahead of this one; -1 if it is not waiting, as when a full queue denied it. */
  function asksAhead(accountId: string, answer: Promise<boolean>): number {
    return (pending.get(accountId) ?? []).findIndex((ask) => ask.answer === answer);
  }

  /** Rejects the ask that createPending returned this answer for, or with no answer every ask of the account. */
  function rejectPending(accountId: string, answer?: Promise<boolean>): boolean {
    const asks = (pending.get(accountId) ?? []).filter((ask) => !answer || ask.answer === answer);
    for (const ask of asks) {
      settle(accountId, ask, false);
      logger.info('Permission auto-rejected', { accountId, toolName: ask.toolName, label: ask.label });
    }
    return asks.length > 0;
  }

  return { createPending, resolvePermission, rejectPending, isTimedOut, clearTimedOut, getPending, asksAhead };
}

export type PermissionBroker = ReturnType<typeof createPermissionBroker>;
