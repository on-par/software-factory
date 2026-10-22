import { describe, expect, it } from 'vitest';

import type { FailoverReason } from '../types/index.js';
import { ModelExecutorError } from '../router/executor-error.js';
import { HarnessError } from './index.js';
import { defaultClassifyError, failureKindForReason, providerFailureOf } from './provider-failure.js';

describe('defaultClassifyError', () => {
  it('maps every FailoverReason one way onto a kind', () => {
    const expected: Record<FailoverReason, string> = {
      usage_cap: 'usage_cap',
      rate_limit: 'rate_limit',
      schema_invalid: 'other',
      apply_failed: 'other',
      verify_failed: 'other',
      permission_denied: 'other',
      timeout: 'unavailable',
      unavailable: 'unavailable',
      empty_response: 'unavailable',
      cli_missing: 'unavailable',
      error: 'unavailable',
      unknown: 'unavailable',
      local_auth: 'unavailable',
    };
    for (const [reason, kind] of Object.entries(expected)) {
      expect(failureKindForReason(reason as FailoverReason)).toBe(kind);
    }
  });

  it('reads reason from a HarnessError and kind/resetAt from details', () => {
    const err = new HarnessError('x', 'error', { kind: 'auth', resetAt: '2026-10-20T12:00:00Z' });
    expect(defaultClassifyError(err)).toMatchObject({
      reason: 'error',
      kind: 'auth',
      resetAt: '2026-10-20T12:00:00.000Z',
    });
  });

  it('falls back to the reason map without details, or with an invalid kind or resetAt', () => {
    expect(defaultClassifyError(new HarnessError('x', 'usage_cap'))).toMatchObject({ kind: 'usage_cap' });
    const bad = new HarnessError('x', 'rate_limit', { kind: 'bogus' as never, resetAt: 'not a date' });
    const f = defaultClassifyError(bad);
    expect(f.kind).toBe('rate_limit');
    expect(f.resetAt).toBeUndefined();
  });

  it('classifies a ModelExecutorError by its reason', () => {
    expect(providerFailureOf(new ModelExecutorError('x', 'schema_invalid'))).toMatchObject({ kind: 'other' });
  });

  it('classifies a plain exec error from stderr and exit code', () => {
    const f = defaultClassifyError(Object.assign(new Error('boom'), { stderr: 'quota exceeded', exitCode: 1 }));
    expect(f).toMatchObject({ reason: 'usage_cap', kind: 'usage_cap' });
    expect(f.resetAt).toBeUndefined();
    expect(defaultClassifyError('weird').reason).toBeDefined();
  });
});

describe('rejected credential vs signed out (#3232)', () => {
  it('signed-out text stays kind unavailable while a rejected key is kind auth', () => {
    expect(
      defaultClassifyError(new HarnessError('authentication_error: invalid x-api-key', 'local_auth')),
    ).toMatchObject({
      kind: 'auth',
      reason: 'local_auth',
    });
    for (const text of ['Please run /login', 'no auth credentials found', 'missing bearer']) {
      expect(defaultClassifyError(new HarnessError(text, 'local_auth'))).toMatchObject({ kind: 'unavailable' });
    }
  });

  it('reads a rejected key from stderr, including for a plain error', () => {
    expect(defaultClassifyError(Object.assign(new Error('x'), { stderr: 'Incorrect API key provided' })).kind).toBe(
      'auth',
    );
    const err = new HarnessError('x', 'local_auth', undefined);
    expect(defaultClassifyError(Object.assign(err, { stderr: 'authentication_error' })).kind).toBe('auth');
  });

  it('an adapter-set details.kind wins', () => {
    const err = new HarnessError('invalid x-api-key', 'local_auth', { kind: 'usage_cap' });
    expect(defaultClassifyError(err).kind).toBe('usage_cap');
  });
});
