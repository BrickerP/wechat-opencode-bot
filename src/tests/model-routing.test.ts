// Model routing: the cross-gateway fallback and the per-gateway circuit breaker.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { breaker, fallbackModel, providerOf, resetModelRouting } from '../model-routing.js';

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

test('the fallback model is behind another gateway', () => {
  assert.equal(providerOf('oneapi-claude/Claude Sonnet 5.5#high'), 'oneapi-claude');
  assert.equal(fallbackModel('oneapi/DeepSeek-V4.1-Flash'), 'oneapi-chat-gpt/gpt-6-astra');
  assert.equal(fallbackModel('oneapi-chat-gpt/gpt-6-astra'), 'oneapi/DeepSeek-V4.1-Flash');
  const fallback = fallbackModel('oneapi-chat/Opus 5.5');
  assert.ok(fallback);
  assert.notEqual(providerOf(fallback), 'oneapi-chat');
});

test('OPENCODE_FALLBACK_MODEL wins, even on the same gateway', () => {
  try {
    process.env.OPENCODE_FALLBACK_MODEL = ' ';
    assert.equal(fallbackModel('oneapi/DeepSeek-V4.1-Flash'), 'oneapi-chat-gpt/gpt-6-astra', 'a blank override is ignored');
    process.env.OPENCODE_FALLBACK_MODEL = 'oneapi/DeepSeek-V4.1-Flash';
    assert.equal(fallbackModel('oneapi/DeepSeek-V4.1-Flash'), 'oneapi/DeepSeek-V4.1-Flash');
  } finally {
    delete process.env.OPENCODE_FALLBACK_MODEL;
  }
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
