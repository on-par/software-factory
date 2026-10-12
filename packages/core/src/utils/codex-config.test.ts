import { describe, expect, it, vi } from 'vitest';
import { hasCodexLoginEvidence } from './codex-config.js';

describe('hasCodexLoginEvidence', () => {
  it('returns true for a non-empty CODEX_API_KEY without running anything', () => {
    const exec = vi.fn();
    expect(hasCodexLoginEvidence({ env: { CODEX_API_KEY: 'sk-test' }, exec })).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it('ignores a whitespace-only CODEX_API_KEY and falls through to login status', () => {
    const exec = vi.fn();
    expect(hasCodexLoginEvidence({ env: { CODEX_API_KEY: '   ' }, exec })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('runs only `codex login status` and never codex exec', () => {
    const exec = vi.fn();
    expect(hasCodexLoginEvidence({ env: {}, exec })).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('codex', ['login', 'status']);
    expect(exec.mock.calls.some(([, args]) => (args as string[]).includes('exec'))).toBe(false);
  });

  it('returns false when the command throws (non-zero exit or not found)', () => {
    const exec = vi.fn(() => {
      throw new Error('exit 1');
    });
    expect(hasCodexLoginEvidence({ env: {}, exec })).toBe(false);
  });

  it('does not throw with real defaults', () => {
    expect(typeof hasCodexLoginEvidence({ env: {} })).toBe('boolean');
  });
});
