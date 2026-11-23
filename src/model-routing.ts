import { findModelRef, formatModelRef, listModels, type ProviderModel } from './opencode/provider.js';

/** Why a turn failed. Only upstream kinds (the gateway or its model) are worth a model on another gateway. */
export type ErrorKind = 'auth' | 'quota' | 'timeout' | 'transport' | 'server' | 'bad_request' | 'unknown';

/**
 * The model routing assumes when neither the chat's /model nor the bot's model is set. Such sessions are
 * still created without a model, so the orchestrator agent's own model applies; this only tells routing its gateway.
 */
export const DEFAULT_MODEL = process.env.OPENCODE_DEFAULT_MODEL || 'oneapi/DeepSeek-V4.1-Flash';

const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/** The gateway, i.e. the OpenCode provider, of "provider/model[#variant]". */
export const providerOf = (model: string): string => model.trim().split('/', 1)[0];

/**
 * The model the owner chose for the one retry after an upstream failure: OPENCODE_FALLBACK_MODEL, even on the
 * primary's gateway. Read on every call. Undefined when unset or blank: upstream failures are then not retried.
 */
export function configuredFallback(): string | undefined {
  return process.env.OPENCODE_FALLBACK_MODEL?.trim() || undefined;
}

/** Whether the configured fallback can be used now, and if not, why. */
export type FallbackCheck =
  | { state: 'unset' }
  | { state: 'ok'; model: string }
  | { state: 'missing'; configured: string; reason: string };

/**
 * The configured fallback against the server's model list (or the error listing it failed with). A listed model
 * comes back in its canonical "provider/model[#variant]" form, as /model stores it.
 */
export function decideFallback(configured: string | undefined, models: ProviderModel[] | Error): FallbackCheck {
  if (!configured) return { state: 'unset' };
  if (models instanceof Error) return { state: 'missing', configured, reason: `无法读取 OpenCode 的模型列表（${models.message.slice(0, 80)}）` };
  const ref = findModelRef(models, configured);
  return ref ? { state: 'ok', model: formatModelRef(ref) } : { state: 'missing', configured, reason: '不在 OpenCode 的模型列表里' };
}

/**
 * The fallback as it stands now: models get removed from the server while the bot runs (on 2026-11-22 a retry
 * went to one that was gone), so this asks the server each time a fallback is about to be used. Never throws.
 */
export async function checkFallback(signal?: AbortSignal): Promise<FallbackCheck> {
  const configured = configuredFallback();
  if (!configured) return { state: 'unset' };
  const models = await listModels(signal).catch((err: unknown) => (err instanceof Error ? err : new Error(String(err))));
  return decideFallback(configured, models);
}

/**
 * checkFallback at startup, while the server may still answer 503 for a few seconds as its plugins activate:
 * a failed listing is tried again until about waitMs have passed. Never throws.
 */
export async function checkFallbackAtStartup(waitMs = 30_000, pauseMs = 2_000): Promise<FallbackCheck> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const check = await checkFallback();
    const listingFailed = check.state === 'missing' && check.reason.startsWith('无法读取');
    if (!listingFailed || Date.now() + pauseMs > deadline) return check;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
}

// ── circuit breaker ──────────────────────────────────────────────────────

interface GatewayState {
  /** Upstream failures since the gateway last answered. */
  failures: number;
  /** New tasks skip the gateway until then; 0 while it has not opened. */
  openUntil: number;
  cooldownMs: number;
}

const gateways = new Map<string, GatewayState>();

// Read on every call, like OPENCODE_FALLBACK_MODEL, so tests can change them between tasks.
const threshold = (): number => Number(process.env.OWB_BREAKER_THRESHOLD) || 3;
const cooldown = (): number => Number(process.env.OWB_BREAKER_COOLDOWN_MS) || 10 * 60 * 1000;

/**
 * Per-gateway circuit breaker, in memory only. threshold() upstream failures in a row open it for cooldown().
 * After that it is half-open: tasks try the gateway again, a success closes it, and another failure opens
 * it again for twice as long, up to MAX_COOLDOWN_MS.
 */
export const breaker = {
  /** Failures in a row that open a gateway's breaker. */
  get threshold(): number {
    return threshold();
  },

  isOpen: (provider: string, now: number = Date.now()): boolean => now < (gateways.get(provider)?.openUntil ?? 0),

  recordSuccess(provider: string): void {
    gateways.delete(provider);
  },

  /** True only when this failure opens a closed breaker. */
  recordFailure(provider: string, now: number = Date.now()): boolean {
    const state = gateways.get(provider) ?? { failures: 0, openUntil: 0, cooldownMs: 0 };
    gateways.set(provider, state);
    state.failures++;
    if (state.openUntil) {
      // A failed probe, or a task that was already on the gateway when the breaker opened.
      state.cooldownMs = Math.min(state.cooldownMs * 2, MAX_COOLDOWN_MS);
      state.openUntil = now + state.cooldownMs;
      return false;
    }
    if (state.failures < threshold()) return false;
    state.cooldownMs = cooldown();
    state.openUntil = now + state.cooldownMs;
    return true;
  },

  snapshot: (): Array<{ provider: string } & GatewayState> =>
    [...gateways].map(([provider, state]) => ({ provider, ...state })),
};

/** Tests only: forget every gateway's state. */
export function resetModelRouting(): void {
  gateways.clear();
}
