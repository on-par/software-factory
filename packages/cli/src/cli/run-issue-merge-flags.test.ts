// packages/cli/src/cli/run-issue-merge-flags.test.ts — `factory run-issue --merge` usage errors (#3905)
import { describe, expect, it } from 'vitest';

import { errored, installShipHarness, runMainWith } from './test-support/ship-harness.js';

installShipHarness();

const runMain = (...args: string[]) => runMainWith(undefined, ...args);

describe('run-issue --merge usage errors (#3905)', () => {
  it.each([
    [['--admin'], '--merge-timeout/--admin need --merge'],
    [['--merge-timeout', '30m'], '--merge-timeout/--admin need --merge'],
    [['--merge', '--no-pr'], '--merge needs a PR'],
    [['--merge', '--stack'], '--merge lands one PR'],
    [['--merge', '--size-gate', 'stack'], '--merge lands one PR'],
    [['--merge', '--merge-timeout', 'soon'], '--merge-timeout must be a positive duration'],
  ])('%j exits 2', async (flags, message) => {
    const res = await runMain('run-issue', '5', ...flags);
    expect(res).toEqual({ exited: true, code: 2 });
    expect(errored()).toContain(message);
  });
});
