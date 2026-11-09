import { logger } from './logger.js';
import type { StateDb } from './tasks/db.js';

// Read on every call, like the breaker's settings, so tests can change them.
const threshold = (): number => Number(process.env.OWB_FAILURE_ALERT_COUNT) || 3;
const windowMs = (): number => Number(process.env.OWB_FAILURE_ALERT_WINDOW_MS) || 30 * 60 * 1000;
const cooldownMs = (): number => Number(process.env.OWB_FAILURE_ALERT_COOLDOWN_MS) || 30 * 60 * 1000;

/** When each account was last alerted. In memory only, so a restart may alert again. */
const lastAlert = new Map<string, number>();

/**
 * Called after a task failed. Once threshold() tasks have failed within windowMs(), queue one alert in the
 * account's outbox, then stay quiet for cooldownMs(). Returns true when it queued one. Never throws: the alert
 * must not break the report of the task that failed.
 */
export function maybeAlertFailures(db: StateDb, accountId: string, now: number = Date.now()): boolean {
  try {
    const last = lastAlert.get(accountId);
    if (last !== undefined && now - last < cooldownMs()) return false;
    const span = windowMs();
    const { failed } = db.statusCountsSince(accountId, now - span);
    if (failed < threshold()) return false;
    db.addNotice(
      accountId,
      `🚨 最近 ${Math.ceil(span / 60_000)} 分钟有 ${failed} 个任务失败，发送 /status 查看；网关故障会自动切换备用模型。`,
    );
    lastAlert.set(accountId, now);
    logger.warn('Failure alert queued', { accountId, failed, windowMs: span });
    return true;
  } catch (err) {
    logger.warn('Failure alert failed', { accountId, error: String(err) });
    return false;
  }
}

/** Tests only: forget when each account was alerted. */
export function resetAlerts(): void {
  lastAlert.clear();
}
