import { logger } from './logger.js';

const PERMISSION_TIMEOUT = 120_000;
const GRACE_PERIOD = 15_000;

export interface PendingPermission {
  toolName: string;
  toolInput: string;
  resolve: (allowed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type OnPermissionTimeout = () => void;

export function createPermissionBroker(onTimeout?: OnPermissionTimeout) {
  const pending = new Map<string, PendingPermission>();
  const timedOut = new Map<string, number>(); // accountId → timestamp

  function createPending(accountId: string, toolName: string, toolInput: string): Promise<boolean> {
    // Clear any existing pending permission for this account to prevent timer leak
    const existing = pending.get(accountId);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(accountId);
      existing.resolve(false);
      logger.warn('Replaced existing pending permission', { accountId, toolName: existing.toolName });
    }

    timedOut.delete(accountId); // clear any previous timeout flag
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn('Permission timeout, auto-denied', { accountId, toolName });
        pending.delete(accountId);
        timedOut.set(accountId, Date.now());
        // Clean up grace period entry after GRACE_PERIOD
        setTimeout(() => timedOut.delete(accountId), GRACE_PERIOD);
        resolve(false);
        onTimeout?.();
      }, PERMISSION_TIMEOUT);

      pending.set(accountId, { toolName, toolInput, resolve, timer });
    });
  }

  function resolvePermission(accountId: string, allowed: boolean): boolean {
    const perm = pending.get(accountId);
    if (!perm) return false;
    clearTimeout(perm.timer);
    pending.delete(accountId);
    perm.resolve(allowed);
    logger.info('Permission resolved', { accountId, toolName: perm.toolName, allowed });
    return true;
  }

  function isTimedOut(accountId: string): boolean {
    return timedOut.has(accountId);
  }

  function clearTimedOut(accountId: string): void {
    timedOut.delete(accountId);
  }

  function getPending(accountId: string): PendingPermission | undefined {
    return pending.get(accountId);
  }

  function rejectPending(accountId: string): boolean {
    const perm = pending.get(accountId);
    if (!perm) return false;
    clearTimeout(perm.timer);
    pending.delete(accountId);
    perm.resolve(false);
    logger.info('Permission auto-rejected', { accountId, toolName: perm.toolName });
    return true;
  }

  return { createPending, resolvePermission, rejectPending, isTimedOut, clearTimedOut, getPending };
}

export type PermissionBroker = ReturnType<typeof createPermissionBroker>;
