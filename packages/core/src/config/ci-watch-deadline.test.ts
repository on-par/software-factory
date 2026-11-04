import { describe, expect, it } from 'vitest';

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadFactoryConfigForRepo, resolveCiWatchDeadlineMs } from './index.js';

describe('resolveCiWatchDeadlineMs', () => {
  it('defaults to 10 minutes and reads ci.watchMinutes', () => {
    expect(resolveCiWatchDeadlineMs({})).toBe(600_000);
    expect(resolveCiWatchDeadlineMs({ ci: {} })).toBe(600_000);
    expect(resolveCiWatchDeadlineMs({ ci: { watchMinutes: 25 } })).toBe(1_500_000);
    expect(resolveCiWatchDeadlineMs({ ci: { watchMinutes: 12.5 } })).toBe(750_000);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])('falls back to the default for %s', (watchMinutes) => {
    expect(resolveCiWatchDeadlineMs({ ci: { watchMinutes } })).toBe(600_000);
  });

  it('reads ship.ciWatchMinutes ahead of ci.watchMinutes', () => {
    expect(resolveCiWatchDeadlineMs({ ship: { ciWatchMinutes: 25 }, ci: { watchMinutes: 5 } })).toBe(1_500_000);
    expect(resolveCiWatchDeadlineMs({ ship: { ciWatchMinutes: 0 }, ci: { watchMinutes: 5 } })).toBe(300_000);
    expect(resolveCiWatchDeadlineMs({ ship: {}, ci: { watchMinutes: 5 } })).toBe(300_000);
  });

  it('loads ship.ciWatchMinutes from the repo config file', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-ship-cfg-'));
    mkdirSync(join(root, '.factory'));
    const path = join(root, '.factory', 'config.yaml');
    writeFileSync(path, 'version: 2\nship:\n  ciWatchMinutes: 25\n');
    expect(resolveCiWatchDeadlineMs(loadFactoryConfigForRepo(path))).toBe(1_500_000);
  });
});
