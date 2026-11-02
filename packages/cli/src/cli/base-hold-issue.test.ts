import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createTempDirs } from '@on-par/factory-core/testing';

import { type BaseHold, formatBaseHoldStatus, readBaseHold, writeBaseHold } from './base-hold.js';

const hold: BaseHold = {
  repo: 'on-par/software-factory',
  baseSha: 'abc1234567890def',
  failingChecks: ['tests', 'lint'],
  since: '2026-01-01T00:00:00.000Z',
};

describe('base hold issue (#3851)', () => {
  const tempDirs = createTempDirs();
  afterEach(async () => {
    await tempDirs.cleanup();
  });

  it('issue round-trips through write/read; a non-integer is dropped (#3851)', async () => {
    const file = join(await tempDirs.make('factory-base-hold-issue-'), 'state', 'base-hold.json');
    writeBaseHold(file, { ...hold, issue: 5 });
    expect(readBaseHold(file)?.issue).toBe(5);
    for (const bad of [1.5, 0, -2, '5']) {
      writeFileSync(file, JSON.stringify({ ...hold, issue: bad }));
      expect(readBaseHold(file)?.issue).toBeUndefined();
    }
    writeBaseHold(file, { ...hold, issue: 2.5 });
    expect(readBaseHold(file)?.issue).toBeUndefined();
  });

  it('formatBaseHoldStatus names the waiting issue, base SHA and failing checks (#3851)', () => {
    expect(formatBaseHoldStatus({ ...hold, baseSha: 'abc1234567890def', issue: 7 })).toContain(
      '  waiting: #7 is waiting on red base abc12345 (tests, lint)',
    );
    expect(formatBaseHoldStatus(hold).some((l) => l.includes('waiting:'))).toBe(false);
  });
});
