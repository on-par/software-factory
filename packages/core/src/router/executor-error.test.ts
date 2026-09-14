import { describe, expect, it } from 'vitest';

import { HarnessError } from '../harness/index.js';
import {
  extractFailoverReason,
  ModelExecutorError,
  ModelRouterError,
  routerFailureOf,
  type RouterAttempt,
} from './executor-error.js';

describe('ModelExecutorError', () => {
  it('sets name, message, reason, and details', () => {
    const err = new ModelExecutorError('boom', 'usage_cap', { tracePath: '/tmp/t.json' });

    expect(err.name).toBe('ModelExecutorError');
    expect(err.message).toBe('boom');
    expect(err.reason).toBe('usage_cap');
    expect(err.details).toEqual({ tracePath: '/tmp/t.json' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ModelRouterError', () => {
  it('sets name, message, reason, and attempts', () => {
    const attempts: RouterAttempt[] = [{ model: 'codex', reason: 'usage_cap', ok: false }];
    const err = new ModelRouterError('all models failed', 'usage_cap', attempts);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ModelRouterError');
    expect(err.message).toBe('all models failed');
    expect(err.reason).toBe('usage_cap');
    expect(err.attempts).toBe(attempts);
  });
});

describe('routerFailureOf', () => {
  const attempts: RouterAttempt[] = [{ model: 'codex', reason: 'usage_cap', ok: false }];

  it('returns the payload for a ModelRouterError', () => {
    expect(routerFailureOf(new ModelRouterError('all models failed', 'usage_cap', attempts))).toEqual({
      reason: 'usage_cap',
      attempts,
    });
  });

  it('returns the payload for a compatible foreign error', () => {
    const err = Object.assign(new Error('foreign'), { reason: 'timeout', attempts });

    expect(routerFailureOf(err)).toEqual({ reason: 'timeout', attempts });
  });

  it.each([new Error('plain'), null, 'boom', { reason: 'timeout' }, { attempts }, { reason: 1, attempts }])(
    'returns undefined for a plain or malformed error',
    (err) => {
      expect(routerFailureOf(err)).toBeUndefined();
    },
  );
});

describe('extractFailoverReason', () => {
  it('returns the reason for a ModelExecutorError', () => {
    const err = new ModelExecutorError('boom', 'timeout');

    expect(extractFailoverReason(err)).toBe('timeout');
  });

  it('returns the reason for a HarnessError', () => {
    const err = new HarnessError('x', 'timeout');

    expect(extractFailoverReason(err)).toBe('timeout');
  });

  it('returns undefined for a plain Error', () => {
    expect(extractFailoverReason(new Error('boom'))).toBeUndefined();
  });

  it('returns undefined for an Error with a bolted-on reason property (duck-typing is dead)', () => {
    const err = Object.assign(new Error('boom'), { reason: 'rate_limit' });

    expect(extractFailoverReason(err)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(extractFailoverReason(null)).toBeUndefined();
  });

  it('returns undefined for a string', () => {
    expect(extractFailoverReason('boom')).toBeUndefined();
  });
});
