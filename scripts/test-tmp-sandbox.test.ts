import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import setup, { findLeakedTempEntries, formatTempLeakMessage } from './test-tmp-sandbox.js';

describe('findLeakedTempEntries', () => {
  it('reports new prefixed entries by prefix and ignores pre-existing and unprefixed ones', () => {
    const before = new Set(['feedback-old']);
    const after = ['feedback-old', 'feedback-a', 'feedback-b', 'factory-cli-x', 'unrelated', 'filing-1'];
    expect(findLeakedTempEntries(before, after)).toEqual([
      { prefix: 'factory-', entries: ['factory-cli-x'] },
      { prefix: 'feedback-', entries: ['feedback-a', 'feedback-b'] },
      { prefix: 'filing-', entries: ['filing-1'] },
    ]);
  });

  it('ignores factory lane runtime prefixes but still reports other factory- names (#3173)', () => {
    const after = [
      'factory-claude-prompt-a',
      'factory-codex-a',
      'factory-codex-out-b',
      'factory-pi-prompt-c',
      'factory-other-d',
    ];
    expect(findLeakedTempEntries(new Set(), after)).toEqual([{ prefix: 'factory-', entries: ['factory-other-d'] }]);
  });

  it('returns nothing when nothing leaked', () => {
    expect(findLeakedTempEntries(new Set(), ['unrelated'])).toEqual([]);
  });
});

describe('formatTempLeakMessage', () => {
  it('names each prefix and caps the listed names', () => {
    const entries = Array.from({ length: 7 }, (_, i) => `feedback-${i}`);
    const message = formatTempLeakMessage([
      { prefix: 'feedback-', entries },
      { prefix: 'filing-', entries: ['filing-1'] },
    ]);
    expect(message).toContain('leaked 8 temp entries');
    expect(message).toContain('feedback- (7: feedback-0, feedback-1, feedback-2, feedback-3, feedback-4, …)');
    expect(message).not.toContain('feedback-5');
    expect(message).toContain('filing- (1: filing-1)');
    expect(formatTempLeakMessage([{ prefix: 'filing-', entries: ['filing-1'] }])).toContain('1 temp entry');
  });
});

describe('setup', () => {
  let scratch: string;
  const saved = { TMPDIR: process.env.TMPDIR, guard: process.env.FACTORY_TMP_LEAK_GUARD };

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-test-')));
    process.env.TMPDIR = scratch;
  });

  afterEach(() => {
    process.env.TMPDIR = saved.TMPDIR;
    if (saved.guard === undefined) delete process.env.FACTORY_TMP_LEAK_GUARD;
    else process.env.FACTORY_TMP_LEAK_GUARD = saved.guard;
    rmSync(scratch, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function start() {
    const provide = vi.fn();
    const teardown = setup({ provide });
    const sandbox = String(provide.mock.calls[0]?.[1]);
    return { provide, teardown, sandbox };
  }

  it('teardown removes the sandbox and throws naming leaked prefixes', async () => {
    const { provide, teardown, sandbox } = start();
    expect(provide).toHaveBeenCalledWith('factoryTmpSandbox', sandbox);
    expect(sandbox.startsWith(scratch)).toBe(true);
    expect(existsSync(sandbox)).toBe(true);
    mkdirSync(join(scratch, 'feedback-leak1'));
    await expect(teardown()).rejects.toThrow('feedback-');
    expect(existsSync(sandbox)).toBe(false);
  });

  it('only warns when FACTORY_TMP_LEAK_GUARD=0', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FACTORY_TMP_LEAK_GUARD = '0';
    const { teardown } = start();
    mkdirSync(join(scratch, 'filing-leak'));
    await expect(teardown()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('filing-'));
  });

  it('resolves when nothing leaked', async () => {
    const { teardown, sandbox } = start();
    await expect(teardown()).resolves.toBeUndefined();
    expect(existsSync(sandbox)).toBe(false);
  });

  it('ignores prompt dirs a concurrent factory process creates during the run', async () => {
    const { teardown } = start();
    for (const name of ['factory-claude-prompt-x', 'factory-codex-x', 'factory-codex-out-y', 'factory-pi-prompt-z']) {
      execFileSync(process.execPath, ['-e', 'require("node:fs").mkdirSync(process.argv[1])', join(scratch, name)]);
    }
    await expect(teardown()).resolves.toBeUndefined();
  });

  it('still throws on a same-run factory- leak', async () => {
    const { teardown } = start();
    mkdirSync(join(scratch, 'factory-leaked-z'));
    await expect(teardown()).rejects.toThrow('factory-leaked-z');
  });
});
