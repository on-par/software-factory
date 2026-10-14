import { describe, expect, it, vi } from 'vitest';

import {
  isOpenCodeVersionSupported,
  OPENCODE_PINNED_INSTALL,
  OPENCODE_PINNED_VERSION,
  OPENCODE_SUPPORTED_RANGE,
  parseOpenCodeMajor,
  parseOpenCodeVersion,
  probeOpenCodeMajor,
} from './opencode-version.js';

describe('parseOpenCodeVersion', () => {
  it.each([
    ['1.18.28', [1, 18, 28]],
    ['opencode 2.0.29\n', [2, 0, 29]],
    ['v1.18.28-beta.1', [1, 18, 28]],
    ['', undefined],
    ['dev', undefined],
  ])('parses %j -> %j', (stdout, expected) => {
    expect(parseOpenCodeVersion(stdout)).toEqual(expected);
  });
});

describe('isOpenCodeVersionSupported', () => {
  it.each([
    [[1, 18, 0], true],
    [[1, 17, 99], false],
    [[1, 18, 28], true],
    [[2, 0, 99], true],
    [[2, 1, 0], false],
    [[3, 0, 1], false],
    [[0, 9, 1], false],
  ] as const)('%j -> %s', (v, expected) => {
    expect(isOpenCodeVersionSupported(v)).toBe(expected);
  });

  it('exposes the range, pin and install command', () => {
    expect(OPENCODE_SUPPORTED_RANGE).toBe('>=1.18.0 <2.1.0');
    expect(OPENCODE_PINNED_VERSION).toBe('1.18.28');
    expect(OPENCODE_PINNED_INSTALL).toBe('npm install -g opencode-ai@1.18.28');
  });
});

describe('parseOpenCodeMajor', () => {
  it.each([
    ['1.18.28', 1],
    ['2.0.29\n', 2],
    ['opencode 2.0.29', 2],
    ['v2.0.29', 2],
    ['0.9.1', 0],
    ['', undefined],
    ['opencode output', undefined],
  ])('parses %j -> %s', (stdout, expected) => {
    expect(parseOpenCodeMajor(stdout)).toBe(expected);
  });
});

describe('probeOpenCodeMajor', () => {
  it('runs `opencode --version` and returns the parsed major', async () => {
    const execFn = vi.fn(async (_cmd: string) => ({ stdout: '2.0.29\n', stderr: '' }));
    await expect(probeOpenCodeMajor(execFn)).resolves.toBe(2);
    expect(execFn).toHaveBeenCalledTimes(1);
    expect(execFn.mock.calls[0]?.[0]).toBe('opencode --version');
  });

  it('resolves undefined when the exec throws', async () => {
    const execFn = vi.fn(async () => {
      throw new Error('ENOENT');
    });
    await expect(probeOpenCodeMajor(execFn)).resolves.toBeUndefined();
  });
});
