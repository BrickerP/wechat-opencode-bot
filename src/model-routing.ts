/** Why a turn failed. Only upstream kinds (the gateway or its model) are worth a model on another gateway. */
export type ErrorKind = 'auth' | 'quota' | 'timeout' | 'transport' | 'server' | 'bad_request' | 'unknown';

/**
 * The model routing assumes when neither the chat's /model nor the bot's model is set. Such sessions are
 * still created without a model, so the orchestrator agent's own model applies; this only tells routing its gateway.
 */
export const DEFAULT_MODEL = process.env.OPENCODE_DEFAULT_MODEL || 'oneapi/DeepSeek-V4.1-Flash';

/** Retry candidates, best first: the first one behind another gateway wins. */
const FALLBACK_CHAIN = ['oneapi-chat-gpt/gpt-6-astra', 'oneapi/DeepSeek-V4.1-Flash', 'oneapi-gemini/Gemini 4 Argon'];

const MAX_COOLDOWN_MS = 60 * 60 * 1000;

/** The gateway, i.e. the OpenCode provider, of "provider/model[#variant]". */
export const providerOf = (model: string): string => model.trim().split('/', 1)[0];

/**
 * The model to try when primary's gateway fails: OPENCODE_FALLBACK_MODEL when set, even on the same gateway,
 * otherwise the first FALLBACK_CHAIN model behind another gateway. Undefined when there is none.
 */
export function fallbackModel(primary: string): string | undefined {
  const override = process.env.OPENCODE_FALLBACK_MODEL?.trim();
  if (override) return override;
  const gateway = providerOf(primary);
  return FALLBACK_CHAIN.find((model) => providerOf(model) !== gateway);
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
