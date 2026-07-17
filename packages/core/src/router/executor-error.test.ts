import { describe, expect, it } from 'vitest';

import { HarnessError } from '../harness/index.js';
import { extractFailoverReason, ModelExecutorError } from './executor-error.js';

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
