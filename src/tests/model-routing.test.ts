// Model routing: the fallback the owner configured, checked against the server's model list, and the per-gateway
// circuit breaker.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { breaker, configuredFallback, decideFallback, providerOf, resetModelRouting } from '../model-routing.js';
import type { ProviderModel } from '../opencode/provider.js';

const MINUTE = 60 * 1000;

beforeEach(() => {
  resetModelRouting();
  delete process.env.OPENCODE_FALLBACK_MODEL;
  delete process.env.OWB_BREAKER_THRESHOLD;
  delete process.env.OWB_BREAKER_COOLDOWN_MS;
});

/** Fail the gateway until its breaker opens, with the default threshold of 3. */
function open(provider: string, now: number): void {
  assert.equal(breaker.recordFailure(provider, now), false);
  assert.equal(breaker.recordFailure(provider, now), false);
  assert.equal(breaker.recordFailure(provider, now), true, 'the third failure opens it');
}

/** What the server lists, as listModels returns it. */
const LISTED: ProviderModel[] = [
  { id: 'DeepSeek-V4.1-Flash', modelID: 'DeepSeek-V4.1-Flash', providerID: 'oneapi', name: 'DeepSeek', variants: [] },
  { id: 'Claude Sonnet 5.5', modelID: 'Claude Sonnet 5.5', providerID: 'oneapi-claude', name: 'Sonnet', variants: ['low', 'max'] },
];

test('the fallback is OPENCODE_FALLBACK_MODEL and nothing else; blank means none', () => {
  assert.equal(providerOf('oneapi-claude/Claude Sonnet 5.5#high'), 'oneapi-claude');
  assert.equal(configuredFallback(), undefined, 'no built-in model stands in');
  process.env.OPENCODE_FALLBACK_MODEL = '  ';
  assert.equal(configuredFallback(), undefined);
  process.env.OPENCODE_FALLBACK_MODEL = ' oneapi/DeepSeek-V4.1-Flash ';
  assert.equal(configuredFallback(), 'oneapi/DeepSeek-V4.1-Flash', 'even on the primary gateway');
});

test('a configured fallback is used only if the server lists it, in its canonical form', () => {
  assert.deepEqual(decideFallback(undefined, LISTED), { state: 'unset' });
  assert.deepEqual(decideFallback('oneapi-claude/Claude Sonnet 5.5', LISTED), { state: 'ok', model: 'oneapi-claude/Claude Sonnet 5.5' });
  assert.deepEqual(decideFallback('Claude Sonnet 5.5', LISTED), { state: 'ok', model: 'oneapi-claude/Claude Sonnet 5.5' }, 'a bare id');
  assert.deepEqual(decideFallback('oneapi-claude/Claude Sonnet 5.5#max', LISTED), {
    state: 'ok',
    model: 'oneapi-claude/Claude Sonnet 5.5#max',
  });
  const missing = { state: 'missing', reason: '不在 OpenCode 的模型列表里' };
  assert.deepEqual(decideFallback('oneapi-claude/Claude Sonnet 5.5#huge', LISTED), { ...missing, configured: 'oneapi-claude/Claude Sonnet 5.5#huge' });
  // The model the retry of 2026-11-22 went to, after it had been removed from the server.
  assert.deepEqual(decideFallback('oneapi-chat-gpt/gpt-6-astra', LISTED), { ...missing, configured: 'oneapi-chat-gpt/gpt-6-astra' });
});

test('a fallback the server could not be asked about is not used, and the reason says why', () => {
  const check = decideFallback('oneapi/DeepSeek-V4.1-Flash', new Error('GET /api/model -> HTTP 503: Location plugins did not finish activating'));
  assert.equal(check.state, 'missing');
  assert.match(check.state === 'missing' ? check.reason : '', /^无法读取 OpenCode 的模型列表（GET \/api\/model -> HTTP 503/);
});

test('three failures in a row open the breaker, until the cooldown is over', () => {
  const now = Date.now();
  open('oneapi', now);
  assert.equal(breaker.isOpen('oneapi', now + 10 * MINUTE - 1), true);
  assert.equal(breaker.isOpen('oneapi-chat-gpt', now), false, 'other gateways stay closed');
  assert.equal(breaker.isOpen('oneapi', now + 10 * MINUTE), false, 'half-open: tasks may try the gateway again');
  assert.deepEqual(breaker.snapshot(), [{ provider: 'oneapi', failures: 3, openUntil: now + 10 * MINUTE, cooldownMs: 10 * MINUTE }]);
});

test('a failure while open doubles the cooldown, up to an hour', () => {
  let now = Date.now();
  open('oneapi', now);
  for (const minutes of [20, 40, 60, 60]) {
    now = breaker.snapshot()[0].openUntil;
    assert.equal(breaker.recordFailure('oneapi', now), false, 'only the closed-to-open transition reports true');
    assert.equal(breaker.snapshot()[0].cooldownMs, minutes * MINUTE);
    assert.equal(breaker.isOpen('oneapi', now + minutes * MINUTE - 1), true);
    assert.equal(breaker.isOpen('oneapi', now + minutes * MINUTE), false);
  }
});

test('a success closes the breaker and starts the count over', () => {
  const now = Date.now();
  open('oneapi', now);
  breaker.recordSuccess('oneapi');
  assert.equal(breaker.isOpen('oneapi', now), false);
  assert.deepEqual(breaker.snapshot(), []);
  open('oneapi', now);
});

test('OWB_BREAKER_THRESHOLD and OWB_BREAKER_COOLDOWN_MS tune the breaker', () => {
  process.env.OWB_BREAKER_THRESHOLD = '1';
  process.env.OWB_BREAKER_COOLDOWN_MS = '1000';
  const now = Date.now();
  assert.equal(breaker.threshold, 1);
  assert.equal(breaker.recordFailure('oneapi', now), true);
  assert.equal(breaker.isOpen('oneapi', now + 999), true);
  assert.equal(breaker.isOpen('oneapi', now + 1000), false);
});
