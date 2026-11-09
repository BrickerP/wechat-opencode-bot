// classifyIdleError: which failed turns are worth a model behind another gateway. The provider.* shapes
// follow OpenCode's own error mapping and the failures seen in its session database.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ErrorKind } from '../model-routing.js';
import { classifyIdleError } from '../opencode/provider.js';

function check(error: unknown, kind: ErrorKind, upstream: boolean): void {
  const result = classifyIdleError(error);
  assert.deepEqual({ kind: result.kind, upstream: result.upstream }, { kind, upstream }, JSON.stringify(error));
}

test('provider errors are upstream, except auth', () => {
  check({ type: 'provider.auth', status: 403, message: 'Upstream request failed (HTTP 403); the attempt budget has ended.' }, 'auth', false);
  check({ type: 'provider.quota', message: 'quota exceeded' }, 'quota', true);
  check({ type: 'provider.rate-limit', status: 429, message: 'TPM limit reached' }, 'quota', true);
  check({ type: 'provider.budget-limit', message: 'budget exhausted' }, 'quota', true);
  check({ type: 'provider.timeout', message: 'request timed out' }, 'timeout', true);
  check({ type: 'provider.transport', message: 'socket hang up' }, 'transport', true);
  check({ type: 'provider.internal', status: 503, message: 'upstream error: do request failed' }, 'server', true);
  check({ type: 'provider.content-filter', message: 'Please select a different model' }, 'server', true);
  check({ type: 'provider.auth.expired', message: 'token expired' }, 'auth', false);
  check({ type: 'provider.context-limit', message: 'prompt is too long' }, 'server', true);
});

test('other errors are judged by their text', () => {
  check({ message: 'do request failed: HTTP 502 Bad Gateway' }, 'server', true);
  check({ message: 'HTTP 429 Too Many Requests' }, 'quota', true);
  check({ type: 'unknown', message: 'gateway said no', status: 503 }, 'server', true);
  check({ type: 'unknown', message: 'fetch failed' }, 'transport', true);
  check({ type: 'unknown', message: 'connect ETIMEDOUT 10.0.0.1:443' }, 'timeout', true);
  check({ message: 'HTTP 400 invalid model' }, 'bad_request', false);
  check({ message: 'HTTP 400 invalid parameter: timeout' }, 'bad_request', false);
  check({ type: 'tool.execution', message: 'exit code 1' }, 'unknown', false);
  check(undefined, 'unknown', false);
});

test('a rejected permission is never upstream, whatever its feedback says', () => {
  check({ type: 'permission.rejected', message: 'timeout 了，别再试' }, 'unknown', false);
});

test('the message keeps the OpenCode error format', () => {
  assert.equal(classifyIdleError({ type: 'permission.rejected', message: 'rejected' }).message, 'OpenCode 执行失败: permission.rejected: rejected');
  assert.equal(classifyIdleError(undefined).message, 'OpenCode 执行失败: unknown error');
});
