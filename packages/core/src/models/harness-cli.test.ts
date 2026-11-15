import { describe, expect, it } from 'vitest';

import { isHarnessCliPresent, runHarnessProbe } from './index.js';

describe('runHarnessProbe', () => {
  it('returns null on exit 0', () => {
    expect(runHarnessProbe('true')).toBeNull();
  });

  it('returns the exit code on failure', () => {
    expect(runHarnessProbe('exit 3')).toBe('exit 3');
  });

  it('includes the first stderr line', () => {
    expect(runHarnessProbe('echo boom >&2; exit 2')).toContain('boom');
  });
});

describe('isHarnessCliPresent', () => {
  it('is true for harnesses with no CLI probe even when no command is available', () => {
    expect(isHarnessCliPresent('ollama-http', () => false)).toBe(true);
    expect(isHarnessCliPresent('my-declared-harness', () => false)).toBe(true);
    expect(isHarnessCliPresent(undefined, () => false)).toBe(true);
  });

  it('follows the injected probe for CLI harnesses', () => {
    expect(isHarnessCliPresent('claude-cli', (cmd) => cmd !== 'claude')).toBe(false);
    expect(isHarnessCliPresent('claude-cli', (cmd) => cmd === 'claude')).toBe(true);
  });
});
