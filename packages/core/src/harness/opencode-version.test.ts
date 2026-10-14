import { describe, expect, it, vi } from 'vitest';

import { parseOpenCodeMajor, probeOpenCodeMajor } from './opencode-version.js';

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
