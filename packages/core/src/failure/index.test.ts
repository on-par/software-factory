import { describe, expect, it } from 'vitest';

import { captureFailure, fingerprintFailure, normalizeFailureMessage } from './index.js';

describe('normalizeFailureMessage', () => {
  it('replaces ISO-8601 timestamps with <ts>', () => {
    expect(normalizeFailureMessage('failed at 2026-07-20T11:53:56.123Z')).toContain('<ts>');
    expect(normalizeFailureMessage('failed at 2026-07-20 11:53:56')).toContain('<ts>');
  });

  it('replaces absolute / worktree / temp-dir paths with <path>', () => {
    expect(normalizeFailureMessage('in /tmp/foo-bar/baz')).toContain('<path>');
    expect(normalizeFailureMessage('in /Users/x/software-factory-a-101/worktree')).toContain('<path>');
  });

  it('replaces issue references with <issue>', () => {
    expect(normalizeFailureMessage('see issue #123')).toContain('<issue>');
    expect(normalizeFailureMessage('see #123')).toContain('<issue>');
    expect(normalizeFailureMessage('see issue-123')).toContain('<issue>');
  });

  it('replaces PIDs with <pid>', () => {
    expect(normalizeFailureMessage('pid 12345 died')).toContain('<pid>');
    expect(normalizeFailureMessage('PID: 12345 died')).toContain('<pid>');
  });

  it('replaces long hex blobs with <hash>', () => {
    expect(normalizeFailureMessage('commit a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toContain('<hash>');
  });

  it('replaces bare standalone numbers with <n>', () => {
    expect(normalizeFailureMessage('retried 4321 times')).toContain('<n>');
  });

  it('is idempotent', () => {
    const message = 'failed at 2026-07-20T11:53:56Z in /tmp/x-372 issue #372 pid 12345';
    const once = normalizeFailureMessage(message);
    expect(normalizeFailureMessage(once)).toBe(once);
  });

  it('is safe for empty and undefined input', () => {
    expect(normalizeFailureMessage('')).toBe('');
    expect(normalizeFailureMessage(undefined as unknown as string)).toBe('');
  });
});

describe('fingerprintFailure', () => {
  it('AC-1: identical fault (same phase/component/origin/reason) produces the identical fingerprint despite volatile differences', () => {
    const a = fingerprintFailure({
      phase: 'build',
      component: 'codex-cli',
      origin: 'factory-internal',
      reason: 'timeout',
      message: 'issue #101 failed at 2026-07-19T10:00:00Z in /Users/x/software-factory-a-101/worktree',
    });
    const b = fingerprintFailure({
      phase: 'build',
      component: 'codex-cli',
      origin: 'factory-internal',
      reason: 'timeout',
      message: 'issue #372 failed at 2026-07-20T11:53:56Z in /Users/y/software-factory-b-372/worktree',
    });

    expect(a).toBe(b);
    expect(a).toMatch(/^ff_/);
  });

  it('AC-2: a different phase produces a different fingerprint', () => {
    const base = {
      component: 'codex-cli',
      origin: 'factory-internal' as const,
      reason: 'timeout' as const,
      message: 'boom',
    };
    expect(fingerprintFailure({ ...base, phase: 'build' })).not.toBe(fingerprintFailure({ ...base, phase: 'check' }));
  });

  it('AC-2: a different component produces a different fingerprint', () => {
    const base = {
      phase: 'build' as const,
      origin: 'factory-internal' as const,
      reason: 'timeout' as const,
      message: 'boom',
    };
    expect(fingerprintFailure({ ...base, component: 'codex-cli' })).not.toBe(
      fingerprintFailure({ ...base, component: 'claude-cli' }),
    );
  });

  it('AC-2: a different reason produces a different fingerprint', () => {
    const base = {
      phase: 'build' as const,
      component: 'codex-cli',
      origin: 'factory-internal' as const,
      message: 'boom',
    };
    expect(fingerprintFailure({ ...base, reason: 'timeout' })).not.toBe(
      fingerprintFailure({ ...base, reason: 'rate_limit' }),
    );
  });

  it('AC-2: a different origin produces a different fingerprint', () => {
    const base = { phase: 'build' as const, component: 'codex-cli', reason: 'timeout' as const, message: 'boom' };
    expect(fingerprintFailure({ ...base, origin: 'factory-internal' })).not.toBe(
      fingerprintFailure({ ...base, origin: 'product' }),
    );
  });
});

describe('captureFailure', () => {
  const baseInput = {
    phase: 'check' as const,
    component: 'check:tests',
    origin: 'product' as const,
    reason: 'verify_failed' as const,
    message: '  test suite failed with 3 failures  ',
    repo: 'on-par/software-factory',
    issue: '372',
    model: 'claude-sonnet-5',
    logPath: '/Users/x/software-factory-x-372/.factory/events.ndjson',
  };

  it('AC-3: returns a fingerprint and a fully-populated evidence pack', () => {
    const result = captureFailure(baseInput);

    expect(result.fingerprint).toMatch(/^ff_/);
    expect(result.fingerprint).toBe(fingerprintFailure(baseInput));
    expect(result.evidence).toEqual({
      repo: baseInput.repo,
      issue: baseInput.issue,
      phase: baseInput.phase,
      model: baseInput.model,
      reason: baseInput.reason,
      component: baseInput.component,
      origin: baseInput.origin,
      eventExcerpt: 'test suite failed with 3 failures',
      logPath: baseInput.logPath,
    });
  });

  it('truncates the event excerpt at the default 600-char limit', () => {
    const longMessage = 'x'.repeat(1000);
    const result = captureFailure({ ...baseInput, message: longMessage });

    expect(result.evidence.eventExcerpt).toHaveLength(600);
  });

  it('truncates the event excerpt at a custom excerptLimit', () => {
    const result = captureFailure({ ...baseInput, message: 'x'.repeat(1000), excerptLimit: 10 });

    expect(result.evidence.eventExcerpt).toHaveLength(10);
  });

  it('is stable across two calls with the same input', () => {
    const first = captureFailure(baseInput);
    const second = captureFailure(baseInput);

    expect(first.fingerprint).toBe(second.fingerprint);
  });
});
