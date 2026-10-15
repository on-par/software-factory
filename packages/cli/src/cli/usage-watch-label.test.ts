// packages/cli/src/cli/usage-watch-label.test.ts — usageWatchSourceLabel names the loaded repo config file (#2570)

import { describe, expect, it } from 'vitest';

import { usageWatchSourceLabel } from './index.js';

describe('usageWatchSourceLabel', () => {
  it('names the loaded repo config file for the repo source', () => {
    expect(usageWatchSourceLabel('repo', true, '.factory/config.yaml')).toBe(
      '.factory/config.yaml: budget.watchdog.watch',
    );
  });
});
